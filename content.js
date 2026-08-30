// Content script: монтирует overlay-виджет «Сканер цены MOEX» И ведёт основной
// цикл polling'а T-Invest API. Логика тут (а не в service worker), потому что
// MV3 worker засыпает через ~30 сек, а content script жив пока открыта вкладка.

(async function () {
  if (window.__moexScannerMounted) return;
  window.__moexScannerMounted = true;

  // Динамический импорт модулей (они в web_accessible_resources)
  const apiUrl = chrome.runtime.getURL('lib/api.js');
  const instrUrl = chrome.runtime.getURL('lib/instruments.js');
  const scannerUrl = chrome.runtime.getURL('lib/scanner.js');
  const [api, instr, scanner] = await Promise.all([
    import(apiUrl),
    import(instrUrl),
    import(scannerUrl)
  ]);

  // Транспорт: проксируем fetch через background, чтобы обойти CORS страницы
  // www.tbank.ru/terminal. Возвращаем объект, совместимый с интерфейсом Response,
  // достаточным для api.js (status/ok/text/json).
  const transport = (url, init) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'API_FETCH', url, init },
      (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp?.ok) {
          reject(new Error(resp?.error || 'TRANSPORT_FAILED'));
          return;
        }
        const r = resp.response;
        resolve({
          status: r.status,
          ok: r.ok,
          statusText: r.statusText,
          text: () => Promise.resolve(r.body),
          json: () => Promise.resolve(JSON.parse(r.body))
        });
      }
    );
  });

  const POLL_MS = 3000;             // период скана: 3 сек
  const INSTRUMENTS_TTL_MS = 12 * 60 * 60 * 1000; // 12ч
  const MAX_FIGIS_PER_BATCH = 200;
  const MAX_ALERTS_KEPT = 200;

  let settings = await loadSettings();
  let instruments = [];
  let alerts = [];
  let pollTimer = null;
  let inFlight = false;
  let lastInstrumentsAt = 0;
  let lastInstrumentsKey = '';
  let status = { ok: false, error: 'NOT_STARTED' };

  // ============================================================
  // UI: монтирование виджета
  // ============================================================

  const ROOT_ID = 'moex-scanner-root';

  function mount() {
    if (document.getElementById(ROOT_ID)) return;
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'mscan-root mscan-pos-tr';
    root.innerHTML = `
      <div class="mscan-header" data-drag-handle>
        <span class="mscan-dot"></span>
        <span class="mscan-title">Сканер цены MOEX</span>
        <span class="mscan-status" id="mscan-status">…</span>
        <button class="mscan-btn" id="mscan-clear" title="Очистить">⌧</button>
        <button class="mscan-btn" id="mscan-collapse" title="Свернуть">_</button>
      </div>
      <div class="mscan-body">
        <table class="mscan-table">
          <thead>
            <tr>
              <th class="mscan-col-ticker">Тикер</th>
              <th class="mscan-col-delta">Изменение</th>
              <th class="mscan-col-price">Цена</th>
              <th class="mscan-col-time">Время</th>
              <th class="mscan-col-actions"></th>
            </tr>
          </thead>
          <tbody id="mscan-tbody">
            <tr class="mscan-empty"><td colspan="5">Ожидание импульсов…</td></tr>
          </tbody>
        </table>
      </div>
    `;
    document.body.appendChild(root);

    document.getElementById('mscan-clear').addEventListener('click', () => {
      alerts = [];
      renderAlerts();
      chrome.runtime.sendMessage({ type: 'ALERTS_UPDATE', alerts: [] }).catch(() => {});
    });

    document.getElementById('mscan-collapse').addEventListener('click', () => {
      root.classList.toggle('mscan-collapsed');
    });

    enableDrag(root);
  }

  function renderAlerts() {
    const tbody = document.getElementById('mscan-tbody');
    if (!tbody) return;
    if (!alerts.length) {
      tbody.innerHTML = '<tr class="mscan-empty"><td colspan="5">Ожидание импульсов…</td></tr>';
      bindRowActions();
      return;
    }
    const interesting = new Set((settings.interestingTickers || []).map(t => String(t).toUpperCase()));
    tbody.innerHTML = alerts.map(a => renderRow(a, interesting)).join('');
    bindRowActions();
  }

  function renderRow(a, interestingSet) {
    const sign = a.deltaPct >= 0 ? '+' : '';
    const cls = a.deltaPct >= 0 ? 'mscan-up' : 'mscan-down';
    const wm = formatWindowMinutes(a.windowSec);
    const time = formatTime(a.ts);
    const range = formatRange(a.priceLow, a.priceHigh);
    const tickerUp = String(a.ticker || '').toUpperCase();
    const isInteresting = interestingSet?.has(tickerUp);
    const starCls = isInteresting ? 'mscan-act-on' : '';
    return `
      <tr class="mscan-row ${cls}" data-ticker="${escapeHtml(tickerUp)}">
        <td class="mscan-col-ticker">${escapeHtml(a.ticker)}</td>
        <td class="mscan-col-delta">${sign}${a.deltaPct.toFixed(2)}% за ${wm}</td>
        <td class="mscan-col-price">${range}</td>
        <td class="mscan-col-time">${time}</td>
        <td class="mscan-col-actions">
          <button class="mscan-act ${starCls}" data-act="star" title="${isInteresting ? 'Снять отметку' : 'Отметить интересным'}">★</button>
          <button class="mscan-act mscan-act-hide" data-act="hide" title="Скрыть тикер">✕</button>
        </td>
      </tr>
    `;
  }

  // ============================================================
  // Активация тикера в терминале — многоуровневая стратегия
  //
  // 1) Direct: клик по [data-row-id="<TICKER>"] — мгновенно и без UI-мерцания,
  //    но работает только если строка сейчас в DOM (виджет Инструменты
  //    виртуализирует таблицу — видимы только ~30 строк).
  //
  // 2) Search-flow: эмулируем работу пользователя со встроенным поиском
  //    виджета Стакан (или любого виджета с иконкой поиска):
  //      — клик по [data-qa-icon="search-small"]
  //      — ввод тикера в input[name="search"] с native input/change events
  //      — клик по найденному элементу в выпадающем списке
  //    Работает для ЛЮБОГО тикера, не зависит от виртуализации.
  //
  // 3) Text-search: legacy fallback для случаев когда оба верхних не
  //    сработали — поиск text node === тикер и клик по ближайшему предку.
  // ============================================================

  // ----- Strategy 1: direct selector ---------------------------
  function findTickerDirect(ticker) {
    const target = String(ticker || '').trim().toUpperCase();
    if (!target) return null;
    const ourRoot = document.getElementById(ROOT_ID);
    try {
      const esc = CSS.escape(target);
      const escLow = CSS.escape(target.toLowerCase());
      const el = document.querySelector(
        `[data-row-id="${esc}"], [data-row-id="${escLow}"], ` +
        `[data-symbol="${esc}"], [data-ticker="${esc}"]`
      );
      if (el && (!ourRoot || !ourRoot.contains(el))) return el;
    } catch {}
    return null;
  }

  // ----- Strategy 3 (legacy fallback): text-node search --------
  function findTickerByText(ticker) {
    const target = String(ticker || '').trim().toUpperCase();
    if (!target) return null;
    const ourRoot = document.getElementById(ROOT_ID);
    const matches = [];
    function walk(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.parentElement) return NodeFilter.FILTER_REJECT;
          if (ourRoot && ourRoot.contains(n)) return NodeFilter.FILTER_REJECT;
          const raw = n.nodeValue || '';
          if (!raw) return NodeFilter.FILTER_SKIP;
          const trimmed = raw.trim().toUpperCase();
          if (trimmed === target) {
            matches.push(n);
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      });
      while (walker.nextNode()) { /* push в acceptNode */ }
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
    }
    walk(document.body);
    if (matches.length === 0) return null;
    // Поднимаемся до ближайшего «кликабельного» предка
    for (const tn of matches) {
      let el = tn.parentElement;
      let depth = 0;
      while (el && el !== document.body && depth < 8) {
        try {
          if (getComputedStyle(el).cursor === 'pointer') return el;
        } catch {}
        const role = el.getAttribute && el.getAttribute('role');
        if (role === 'button' || role === 'link' || role === 'row') return el;
        if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'TR') return el;
        el = el.parentElement;
        depth++;
      }
    }
    return matches[0].parentElement || null;
  }

  // ----- Strategy 2: терминальный поиск ------------------------
  // Открывает встроенный поиск (виджет Стакан / График / другой), вводит
  // тикер, кликает по результату в выпадающем списке. Работает даже когда
  // строка тикера не отрисована в DOM (виртуализация).
  //
  // Структура результата (выяснено через Chrome DevTools MCP):
  //   <a class="pro-menu-item ... pro-popover-dismiss" data-qa-tag="menu-item">
  //     <span> ... <span class="...Tag-Tag-content...">SHU6</span> ... </span>
  //   </a>
  // Кликаем именно по <a> — он несёт onClick и сам закрывает поповер.
  async function activateViaTerminalSearch(ticker) {
    const target = String(ticker || '').trim().toUpperCase();
    if (!target) throw new Error('NO_TICKER');

    const iconSearch = document.querySelector('[data-qa-icon="search-small"]');
    const btn = iconSearch ? iconSearch.closest('button') : null;
    if (!btn) throw new Error('NO_SEARCH_BUTTON');
    btn.click();

    const input = await waitFor(
      () => document.querySelector('input[name="search"]'),
      1500
    );
    if (!input) throw new Error('NO_INPUT');

    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input), 'value'
    )?.set;
    if (setter) setter.call(input, target);
    else input.value = target;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Ищем СТРОГО строку результата в дропдауне. Раньше использовали
    // `[class*="Tag-Tag-content"]`, но этот же класс носят чипы тикера
    // в шапке каждого виджета (Tag-Tag-content под текущий symbol). Когда
    // виджет уже показывал искомый тикер, селектор находил чип в шапке
    // первым (он раньше в DOM), поднимался до его BUTTON и кликал в
    // пустоту вместо строки результата. Фикс — анкор в дропдауне.
    const link = await waitFor(() => {
      const links = document.querySelectorAll('a.pro-menu-item[data-qa-tag="menu-item"]');
      for (const a of links) {
        const tag = a.querySelector('[class*="Tag-Tag-content"]');
        if (tag && (tag.textContent || '').trim().toUpperCase() === target) return a;
      }
      return null;
    }, 2000);
    if (!link) {
      try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch {}
      throw new Error('NO_RESULT');
    }

    dispatchClick(link);
    return true;
  }

  function waitFor(check, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let v = null;
        try { v = check(); } catch {}
        if (v) return resolve(v);
        if (Date.now() - start >= timeoutMs) return resolve(null);
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  function dispatchClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
    try { if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } catch {}
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const opts = {
      bubbles: true, cancelable: true, view: window,
      button: 0, buttons: 1,
      clientX: cx, clientY: cy, screenX: cx, screenY: cy
    };
    try {
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    } catch {}
    try {
      if (typeof PointerEvent !== 'undefined') {
        const p = { ...opts, pointerType: 'mouse', isPrimary: true, pointerId: 1 };
        el.dispatchEvent(new PointerEvent('pointerover', p));
        el.dispatchEvent(new PointerEvent('pointerdown', p));
        el.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0 }));
      }
    } catch {}
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
    try { if (typeof el.click === 'function') el.click(); } catch {}
    return true;
  }

  // ----- Композитная стратегия ---------------------------------
  async function activateTicker(ticker) {
    const target = String(ticker || '').trim().toUpperCase();
    if (!target) return false;

    // Strategy 1: direct selector — самый быстрый и без UI-мерцания
    const direct = findTickerDirect(target);
    if (direct) {
      console.log(`[moex-scanner] activate "${target}": strategy=direct (data-row-id)`);
      dispatchClick(direct);
      showToast(`«${target}» активирован`, 'ok');
      return true;
    }

    // Strategy 2: терминальный поиск — работает для любого тикера
    try {
      console.log(`[moex-scanner] activate "${target}": strategy=search`);
      await activateViaTerminalSearch(target);
      showToast(`«${target}» активирован через поиск`, 'ok');
      return true;
    } catch (e) {
      console.warn(`[moex-scanner] strategy=search failed: ${e.message}`);
    }

    // Strategy 3: text-node fallback
    const byText = findTickerByText(target);
    if (byText) {
      console.log(`[moex-scanner] activate "${target}": strategy=text`);
      dispatchClick(byText);
      showToast(`«${target}» активирован`, 'ok');
      return true;
    }

    showToast(`«${target}» не удалось активировать`, 'err');
    return false;
  }

  // ============================================================
  // Toast (мини-уведомление в виджете)
  // ============================================================

  let toastTimer = null;
  function showToast(text, kind) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    let toast = root.querySelector('.mscan-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'mscan-toast';
      root.appendChild(toast);
    }
    toast.textContent = text;
    toast.dataset.kind = kind || '';
    toast.classList.add('mscan-toast-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('mscan-toast-show');
    }, 1500);
  }

  function bindRowActions() {
    const tbody = document.getElementById('mscan-tbody');
    if (!tbody) return;
    tbody.querySelectorAll('button.mscan-act').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr');
        if (!tr) return;
        const ticker = tr.dataset.ticker;
        if (!ticker || ticker === 'TEST') return;
        const act = btn.dataset.act;
        const type = act === 'hide' ? 'TOGGLE_HIDDEN' : 'TOGGLE_INTERESTING';
        chrome.runtime.sendMessage({ type, ticker }).catch(() => {});
      });
    });
    // Клик на ячейку тикера → активировать его в терминале
    tbody.querySelectorAll('td.mscan-col-ticker').forEach(cell => {
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        const tr = cell.closest('tr');
        if (!tr) return;
        const ticker = tr.dataset.ticker;
        if (!ticker || ticker === 'TEST') return;
        activateTicker(ticker);
      });
    });
  }

  function renderStatus() {
    const el = document.getElementById('mscan-status');
    if (!el) return;
    if (status.ok) {
      el.textContent = `${status.activeCount || 0} тикеров`;
      el.className = 'mscan-status mscan-ok';
      el.title = 'Соединение с T-Invest API работает';
    } else {
      el.textContent = errorLabel(status.error);
      el.className = 'mscan-status mscan-err';
      el.title = errorHelp(status.error);
    }
  }

  function errorLabel(code) {
    switch (code) {
      case 'NO_TOKEN': return 'нет токена';
      case 'TOKEN_INVALID': return 'токен невалиден';
      case 'ACCESS_DENIED': return 'доступ запрещён';
      case 'NO_INSTRUMENTS': return 'нет инструментов (включите фильтр)';
      case 'RATE_LIMITED': return 'rate limit';
      case 'NETWORK_OR_CERTIFICATE': return 'сеть/сертификат';
      case 'API_ERROR': return 'ошибка API';
      case 'NOT_STARTED': return 'инициализация…';
      default: return code ? `ошибка: ${code}` : 'ошибка';
    }
  }

  function errorHelp(code) {
    switch (code) {
      case 'NETWORK_OR_CERTIFICATE':
        return 'Нет HTTPS-соединения с T-Invest API. Проверьте сертификаты НУЦ Минцифры, сеть и VPN.';
      case 'TOKEN_INVALID':
        return 'T-Invest API отклонил токен. Создайте новый токен только для чтения.';
      case 'ACCESS_DENIED':
        return 'T-Invest API запретил доступ. Проверьте права и состояние токена.';
      case 'RATE_LIMITED':
        return 'Превышен лимит запросов T-Invest API. Подождите и повторите.';
      default:
        return errorLabel(code);
    }
  }

  function statusErrorCode(error) {
    const code = String(error?.message || error || 'UNKNOWN_ERROR');
    const known = new Set([
      'NO_TOKEN',
      'TOKEN_INVALID',
      'ACCESS_DENIED',
      'RATE_LIMITED',
      'NETWORK_OR_CERTIFICATE'
    ]);
    if (known.has(code)) return code;
    if (code.startsWith('API_')) return 'API_ERROR';
    return code.slice(0, 60);
  }

  function formatWindowMinutes(sec) {
    return `${Math.round(sec / 60)} мин.`;
  }
  function formatTime(ts) {
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(x => String(x).padStart(2, '0')).join(':');
  }
  function formatRange(lo, hi) {
    const f = (x) => Number(x).toLocaleString('ru-RU', { maximumFractionDigits: 4 });
    if (Math.abs(hi - lo) < 1e-9) return f(hi);
    return `${f(lo)}–${f(hi)}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function enableDrag(root) {
    const handle = root.querySelector('[data-drag-handle]');
    if (!handle) return;
    let dragging = false, startX = 0, startY = 0, baseX = 0, baseY = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      baseX = rect.left; baseY = rect.top;
      root.classList.remove('mscan-pos-tr');
      root.style.left = baseX + 'px';
      root.style.top = baseY + 'px';
      root.style.right = 'auto';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      root.style.left = (baseX + e.clientX - startX) + 'px';
      root.style.top = (baseY + e.clientY - startY) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  // ============================================================
  // Звук
  // ============================================================
  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch {}
  }

  // ============================================================
  // Settings + instruments
  // ============================================================

  async function loadSettings() {
    const { settings: s } = await chrome.storage.local.get('settings');
    return s || {};
  }

  function instrumentsFilterKey(s) {
    return JSON.stringify({
      shares: !!s.filterShares,
      fut: !!s.filterFutures,
      imoex: !!s.filterImoex,
      hidden: [...(s.hiddenTickers || [])].sort(),
      interesting: [...(s.interestingTickers || [])].sort(),
      onlyInteresting: !!s.interestingOnly
    });
  }

  async function ensureInstruments() {
    const key = instrumentsFilterKey(settings);
    const fresh = lastInstrumentsAt && Date.now() - lastInstrumentsAt < INSTRUMENTS_TTL_MS;
    if (fresh && lastInstrumentsKey === key && instruments.length > 0) return instruments;

    if (!settings.token) {
      setStatus({ ok: false, error: 'NO_TOKEN' });
      return [];
    }

    console.log('[moex-scanner] загружаю инструменты, фильтры:', {
      shares: !!settings.filterShares,
      futures: !!settings.filterFutures,
      imoex: !!settings.filterImoex
    });

    const merged = [];
    const seen = new Set();

    if (settings.filterShares || settings.filterImoex) {
      const shares = await api.getShares(transport, settings.token);
      if (settings.filterImoex) {
        const tickers = await instr.getImoexTickers(transport).catch(e => {
          console.warn('[moex-scanner] IMOEX list failed', e);
          return [];
        });
        console.log(`[moex-scanner] IMOEX состав: ${tickers.length} тикеров`);
        const imoex = instr.filterToImoex(shares, tickers);
        console.log(`[moex-scanner] IMOEX ∩ Shares: ${imoex.length}`);
        for (const s of imoex) if (!seen.has(s.figi)) { seen.add(s.figi); merged.push(s); }
      }
      if (settings.filterShares) {
        for (const s of shares) if (!seen.has(s.figi)) { seen.add(s.figi); merged.push(s); }
      }
    }
    if (settings.filterFutures) {
      const fut = await api.getFutures(transport, settings.token);
      for (const f of fut) if (!seen.has(f.figi)) { seen.add(f.figi); merged.push(f); }
    }

    // Сохраняем уникальные тикеры в storage.local для popup
    // (merged может содержать несколько figi на тикер — для popup это шум)
    {
      const seenT = new Set();
      const cacheItems = [];
      for (const i of merged) {
        if (!seenT.has(i.ticker)) {
          seenT.add(i.ticker);
          cacheItems.push({ ticker: i.ticker, name: i.name });
        }
      }
      chrome.storage.local.set({
        instrumentsCache: cacheItems,
        instrumentsCacheAt: Date.now()
      }).catch(() => {});
    }

    // Применяем пользовательские пометки: hidden исключаем; если interestingOnly — оставляем только interesting
    const hidden = new Set((settings.hiddenTickers || []).map(t => String(t).toUpperCase()));
    const interesting = new Set((settings.interestingTickers || []).map(t => String(t).toUpperCase()));
    const onlyInteresting = !!settings.interestingOnly;

    const afterUserFilter = merged.filter(i => {
      const t = String(i.ticker || '').toUpperCase();
      if (hidden.has(t)) return false;
      if (onlyInteresting && !interesting.has(t)) return false;
      return true;
    });

    console.log(`[moex-scanner] итого инструментов в скане: ${afterUserFilter.length} (из ${merged.length} после hidden/interesting)`);
    if (afterUserFilter.length > 0) {
      console.log('[moex-scanner] примеры:', afterUserFilter.slice(0, 5).map(x => `${x.ticker} (${x.exchange})`));
    }

    instruments = afterUserFilter;
    lastInstrumentsAt = Date.now();
    lastInstrumentsKey = key;

    scanner.unregisterAll();
    for (const i of instruments) scanner.registerInstrument(i);

    return instruments;
  }

  // ============================================================
  // Tick: основной цикл скана
  // ============================================================

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      if (!settings.token) {
        setStatus({ ok: false, error: 'NO_TOKEN' });
        return;
      }
      const list = await ensureInstruments();
      if (list.length === 0) {
        setStatus({ ok: false, error: 'NO_INSTRUMENTS' });
        return;
      }
      const figis = scanner.getActiveFigis();
      const allPrices = [];
      for (let i = 0; i < figis.length; i += MAX_FIGIS_PER_BATCH) {
        const batch = figis.slice(i, i + MAX_FIGIS_PER_BATCH);
        try {
          const prices = await api.getLastPrices(transport, batch, settings.token);
          allPrices.push(...prices);
        } catch (e) {
          const error = statusErrorCode(e);
          console.warn('[moex-scanner] batch failed', error);
          setStatus({ ok: false, error });
          return;
        }
      }

      const fired = scanner.pushLastPricesAndDetect(allPrices, {
        windowSec: settings.windowSec,
        thresholdPct: settings.thresholdPct,
        cooldownMs: settings.cooldownSec * 1000
      });

      if (fired.length > 0) {
        // обрезаем по TTL и MAX
        const cutoff = Date.now() - settings.ttlSec * 1000;
        alerts = [...fired, ...alerts].filter(a => a.ts >= cutoff).slice(0, MAX_ALERTS_KEPT);
        renderAlerts();
        if (settings.soundEnabled) beep();
        chrome.runtime.sendMessage({ type: 'ALERTS_UPDATE', alerts }).catch(() => {});
      } else {
        // даже без новых — обрезаем устаревшие
        const cutoff = Date.now() - settings.ttlSec * 1000;
        const filtered = alerts.filter(a => a.ts >= cutoff);
        if (filtered.length !== alerts.length) {
          alerts = filtered;
          renderAlerts();
        }
      }

      setStatus({
        ok: true,
        activeCount: figis.length,
        pricesCount: allPrices.length,
        lastTickAt: Date.now()
      });
    } catch (e) {
      console.error('[moex-scanner] tick error', e);
      setStatus({ ok: false, error: statusErrorCode(e) });
    } finally {
      inFlight = false;
    }
  }

  function setStatus(s) {
    status = s;
    renderStatus();
    chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: s }).catch(() => {});
  }

  // ============================================================
  // Сообщения от popup / background
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    (async () => {
      if (msg?.type === 'SETTINGS_UPDATED') {
        settings = msg.settings;
        // сбрасываем кеш инструментов — фильтры могли поменяться
        lastInstrumentsAt = 0;
        scanner.unregisterAll();
        instruments = [];
        // выкидываем из таблицы строки тикеров, которые стали hidden или
        // (при interestingOnly) не входят в interesting
        const hidden = new Set((settings.hiddenTickers || []).map(t => String(t).toUpperCase()));
        const interesting = new Set((settings.interestingTickers || []).map(t => String(t).toUpperCase()));
        const onlyInteresting = !!settings.interestingOnly;
        const before = alerts.length;
        alerts = alerts.filter(a => {
          const t = String(a.ticker || '').toUpperCase();
          if (t === 'TEST') return true;
          if (hidden.has(t)) return false;
          if (onlyInteresting && !interesting.has(t)) return false;
          return true;
        });
        if (alerts.length !== before) {
          chrome.runtime.sendMessage({ type: 'ALERTS_UPDATE', alerts }).catch(() => {});
        }
        renderAlerts();
        // прогоняем тик сразу для быстрого фидбека
        tick();
      } else if (msg?.type === 'CLEAR_ALERTS') {
        alerts = [];
        renderAlerts();
      } else if (msg?.type === 'ACTIVATE_TICKER') {
        const ok = await activateTicker(msg.ticker);
        sendResponse?.({ ok });
        return;
      } else if (msg?.type === 'TEST_ALERT') {
        const fake = {
          ticker: 'TEST',
          figi: 'test_figi',
          deltaPct: 0.77,
          priceLow: 100,
          priceHigh: 100.77,
          currentPrice: 100.77,
          ts: Date.now(),
          windowSec: settings.windowSec || 60
        };
        alerts = [fake, ...alerts].slice(0, MAX_ALERTS_KEPT);
        renderAlerts();
        if (settings.soundEnabled) beep();
        chrome.runtime.sendMessage({ type: 'ALERTS_UPDATE', alerts }).catch(() => {});
      }
      sendResponse?.({ ok: true });
    })();
    return true;
  });

  // ============================================================
  // Bootstrap
  // ============================================================

  function start() {
    mount();
    renderStatus();
    if (pollTimer) clearInterval(pollTimer);
    tick();
    pollTimer = setInterval(tick, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
