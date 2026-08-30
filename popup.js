// Popup: загружает текущие настройки, даёт изменить и сохранить.
// Также управляет списком тикеров: поиск + пометки interesting/hidden.

const FIELDS_NUM = ['thresholdPct', 'windowSec', 'cooldownSec', 'ttlSec'];
const FIELDS_BOOL = ['filterImoex', 'filterShares', 'filterFutures', 'soundEnabled'];

let currentSettings = null;
let allInstruments = [];   // [{ figi, ticker, name }]
let searchQuery = '';
let listExpanded = false;

document.addEventListener('DOMContentLoaded', () => {
  bind();
  load();
});

function bind() {
  document.getElementById('save').addEventListener('click', save);
  document.getElementById('test').addEventListener('click', testAlert);
  document.getElementById('clear').addEventListener('click', clearAlerts);

  document.getElementById('tickers-toggle').addEventListener('click', () => {
    listExpanded = !listExpanded;
    document.getElementById('tickers-pane').hidden = !listExpanded;
    document.getElementById('tickers-toggle').textContent = listExpanded ? 'Скрыть' : 'Показать';
    if (listExpanded) refreshTickerList();
  });

  document.getElementById('tickers-search').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderTickerList();
  });

  document.getElementById('interestingOnly').addEventListener('change', (e) => {
    chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      patch: { interestingOnly: !!e.target.checked }
    }, (resp) => {
      if (resp?.settings) {
        currentSettings = resp.settings;
        renderTickerList();
      }
    });
  });

  document.getElementById('export-prefs').addEventListener('click', exportPrefs);
  document.getElementById('import-prefs').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', importPrefs);
}

function exportPrefs() {
  const s = currentSettings || {};
  const payload = {
    schema: 'moex-scanner-prefs/v1',
    exportedAt: new Date().toISOString(),
    interestingTickers: s.interestingTickers || [],
    hiddenTickers: s.hiddenTickers || [],
    interestingOnly: !!s.interestingOnly
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  a.download = `moex-scanner-prefs-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash('Экспортировано');
}

function importPrefs(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const patch = {};
      if (Array.isArray(data.interestingTickers)) patch.interestingTickers = data.interestingTickers;
      if (Array.isArray(data.hiddenTickers)) patch.hiddenTickers = data.hiddenTickers;
      if (typeof data.interestingOnly === 'boolean') patch.interestingOnly = data.interestingOnly;
      if (Object.keys(patch).length === 0) {
        flash('Нет данных');
        return;
      }
      chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch }, (resp) => {
        if (resp?.ok) {
          currentSettings = resp.settings;
          renderTickerList();
          flash(`Импорт: ★${patch.interestingTickers?.length || 0} ⊘${patch.hiddenTickers?.length || 0}`);
        } else {
          flash('Ошибка');
        }
      });
    } catch (err) {
      console.error('[moex-scanner] import error', err);
      flash('Невалидный JSON');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

function load() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      setStatus({ ok: false, error: 'BG_OFFLINE' });
      return;
    }
    currentSettings = resp.settings || {};
    const s = currentSettings;
    document.getElementById('token').value = s.token || '';
    for (const f of FIELDS_NUM) {
      const el = document.getElementById(f);
      if (el && s[f] !== undefined) el.value = String(s[f]);
    }
    for (const f of FIELDS_BOOL) {
      const el = document.getElementById(f);
      if (el) el.checked = !!s[f];
    }
    document.getElementById('interestingOnly').checked = !!s.interestingOnly;
    setStatus(resp.status);
  });
}

function save() {
  const patch = {
    token: document.getElementById('token').value.trim()
  };
  for (const f of FIELDS_NUM) {
    const el = document.getElementById(f);
    if (el) patch[f] = Number(el.value);
  }
  for (const f of FIELDS_BOOL) {
    const el = document.getElementById(f);
    if (el) patch[f] = el.checked;
  }
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch }, (resp) => {
    if (resp?.ok) {
      flash('Сохранено');
      currentSettings = resp.settings;
      setTimeout(load, 200);
    } else {
      flash('Ошибка');
    }
  });
}

function testAlert() {
  chrome.runtime.sendMessage({ type: 'TEST_ALERT' }, (resp) => {
    flash(resp?.ok ? 'Тест отправлен' : 'Ошибка');
  });
}

function clearAlerts() {
  chrome.runtime.sendMessage({ type: 'CLEAR_ALERTS' }, () => {
    flash('Очищено');
  });
}

function setStatus(status) {
  const el = document.getElementById('status');
  if (!el || !status) return;
  if (status.ok) {
    el.textContent = `${status.activeCount || 0} тикеров`;
    el.className = 'status ok';
    el.title = 'Соединение с T-Invest API работает';
  } else {
    el.textContent = errorLabel(status.error);
    el.className = 'status err';
    el.title = errorHelp(status.error);
  }
}

function errorLabel(code) {
  switch (code) {
    case 'NO_TOKEN': return 'нет токена';
    case 'TOKEN_INVALID': return 'токен невалиден';
    case 'ACCESS_DENIED': return 'доступ запрещён';
    case 'NO_INSTRUMENTS': return 'нет инструментов';
    case 'RATE_LIMITED': return 'rate limit';
    case 'NETWORK_OR_CERTIFICATE': return 'сеть/сертификат';
    case 'API_ERROR': return 'ошибка API';
    case 'BG_OFFLINE': return 'background не отвечает';
    case 'NOT_STARTED': return 'инициализация…';
    default: return 'ошибка';
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

function flash(text) {
  const btn = document.getElementById('save');
  const prev = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = prev; }, 900);
}

// ============================================================
// Список тикеров
// ============================================================

async function refreshTickerList() {
  const cache = await chrome.storage.local.get(['instrumentsCache', 'instrumentsCacheAt']);
  allInstruments = Array.isArray(cache.instrumentsCache) ? cache.instrumentsCache : [];
  renderTickerList();
}

function renderTickerList() {
  const list = document.getElementById('tickers-list');
  const counts = document.getElementById('tickers-counts');
  if (!list) return;

  if (allInstruments.length === 0) {
    list.innerHTML = '<div class="tickers-empty">Список загрузится после первого скана. Откройте терминал и подождите 5 секунд.</div>';
    counts.textContent = '';
    return;
  }

  const hidden = new Set((currentSettings?.hiddenTickers || []).map(t => String(t).toUpperCase()));
  const interesting = new Set((currentSettings?.interestingTickers || []).map(t => String(t).toUpperCase()));

  const q = searchQuery;
  const filtered = q
    ? allInstruments.filter(i =>
        String(i.ticker || '').toLowerCase().includes(q) ||
        String(i.name || '').toLowerCase().includes(q))
    : allInstruments.slice();

  // сортировка: interesting → neutral → hidden, внутри по ticker
  filtered.sort((a, b) => {
    const ta = String(a.ticker || '').toUpperCase();
    const tb = String(b.ticker || '').toUpperCase();
    const wa = hidden.has(ta) ? 2 : interesting.has(ta) ? 0 : 1;
    const wb = hidden.has(tb) ? 2 : interesting.has(tb) ? 0 : 1;
    if (wa !== wb) return wa - wb;
    return ta.localeCompare(tb);
  });

  list.innerHTML = filtered.map(i => renderTickerRow(i, hidden, interesting)).join('');

  counts.textContent = `★ ${interesting.size} · ⊘ ${hidden.size} · всего ${allInstruments.length}`;

  list.querySelectorAll('button.act').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.ticker-row');
      if (!row) return;
      const ticker = row.dataset.ticker;
      const act = btn.dataset.act;
      const type = act === 'hide' ? 'TOGGLE_HIDDEN' : 'TOGGLE_INTERESTING';
      chrome.runtime.sendMessage({ type, ticker }, (resp) => {
        if (resp?.settings) {
          currentSettings = resp.settings;
          renderTickerList();
        }
      });
    });
  });

  // Клик на саму строку тикера → активировать в терминале
  list.querySelectorAll('.ticker-row').forEach(row => {
    row.addEventListener('click', () => {
      const ticker = row.dataset.ticker;
      if (!ticker) return;
      chrome.runtime.sendMessage({ type: 'ACTIVATE_TICKER', ticker }, (resp) => {
        if (resp?.ok) {
          // popup закрывается, чтобы пользователь сразу увидел терминал
          window.close();
        } else {
          flash(resp?.error === 'NO_TERMINAL_TAB' ? 'нет вкладки терминала' : 'не найден');
        }
      });
    });
  });
}

function renderTickerRow(i, hidden, interesting) {
  const t = String(i.ticker || '').toUpperCase();
  const isHidden = hidden.has(t);
  const isInteresting = interesting.has(t);
  const cls = ['ticker-row'];
  if (isHidden) cls.push('is-hidden');
  if (isInteresting) cls.push('is-interesting');
  return `
    <div class="${cls.join(' ')}" data-ticker="${escapeHtml(t)}">
      <span class="tk">${escapeHtml(i.ticker || '')}</span>
      <span class="nm" title="${escapeHtml(i.name || '')}">${escapeHtml(i.name || '')}</span>
      <span class="acts">
        <button class="act ${isInteresting ? 'on' : ''}" data-act="star" title="${isInteresting ? 'Снять отметку' : 'Отметить интересным'}">★</button>
        <button class="act ${isHidden ? 'hide-on' : ''}" data-act="hide" title="${isHidden ? 'Вернуть в скан' : 'Скрыть из скана'}">⊘</button>
      </span>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Реагируем на изменения settings извне (если кто-то открыл popup и параллельно
// нажал кнопку в виджете) — перерисуем список
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    currentSettings = changes.settings.newValue;
    if (listExpanded) renderTickerList();
  }
});
