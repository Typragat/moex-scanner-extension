// MOEX Price Scanner — service worker (Manifest V3).
//
// В этой архитектуре основная логика скана живёт в content.js (он всегда жив,
// пока открыта вкладка терминала). Background отвечает только за:
// - инициализацию settings по умолчанию
// - роутинг сообщений между popup ↔ content ↔ storage
// - тестовый алерт по кнопке из popup

const DEFAULT_SETTINGS = {
  token: '',
  thresholdPct: 0.5,
  windowSec: 60,
  cooldownSec: 30,
  filterShares: false,
  filterFutures: false,
  filterImoex: true,
  soundEnabled: true,
  ttlSec: 300,
  hiddenTickers: [],          // тикеры, которые исключаются из скана
  interestingTickers: [],     // тикеры, отмеченные как интересные
  interestingOnly: false      // если true — сканируем только interestingTickers
};

// Поля, которые зеркалируются в chrome.storage.sync (для бэкапа через Google
// аккаунт и восстановления после переустановки/смены устройства). Сюда НЕ
// попадает token — чувствительные данные хранятся только локально.
const SYNCED_FIELDS = ['hiddenTickers', 'interestingTickers', 'interestingOnly'];

function fetchErrorCode(error) {
  const message = String(error?.message || error || '');
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
    return 'NETWORK_OR_CERTIFICATE';
  }
  return message || 'TRANSPORT_FAILED';
}

function pickSynced(s) {
  const out = {};
  for (const k of SYNCED_FIELDS) if (k in s) out[k] = s[k];
  return out;
}

async function mirrorToSync(settings) {
  try {
    await chrome.storage.sync.set({ prefs: pickSynced(settings) });
  } catch (e) {
    // sync может быть недоступен (например, выключена синхронизация Chrome) —
    // это не критично, продолжаем работать только с local
    console.warn('[moex-scanner] sync mirror failed:', e?.message);
  }
}

async function restoreFromSync(local) {
  try {
    const { prefs } = await chrome.storage.sync.get('prefs');
    if (!prefs) return local;
    const merged = { ...local };
    let restored = 0;
    for (const k of SYNCED_FIELDS) {
      if (prefs[k] !== undefined &&
          (local[k] === undefined ||
           (Array.isArray(local[k]) && local[k].length === 0))) {
        merged[k] = prefs[k];
        restored++;
      }
    }
    if (restored > 0) {
      console.log(`[moex-scanner] восстановлено из sync: ${restored} полей`);
      await chrome.storage.local.set({ settings: merged });
    }
    return merged;
  } catch (e) {
    console.warn('[moex-scanner] sync restore failed:', e?.message);
    return local;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get('settings');
  let settings = cur.settings;
  if (!settings) {
    // Свежая установка / первый запуск: пробуем достать пометки из sync
    const restored = await restoreFromSync({});
    settings = { ...DEFAULT_SETTINGS, ...restored };
    await chrome.storage.local.set({ settings });
  } else {
    // Обновление: подтягиваем из sync если в local пусто (например,
    // sync прилетел от другого устройства)
    settings = await restoreFromSync(settings);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'GET_STATE') {
        const [{ settings }, sess] = await Promise.all([
          chrome.storage.local.get('settings'),
          chrome.storage.session.get(['alerts', 'status'])
        ]);
        sendResponse({
          settings: settings || DEFAULT_SETTINGS,
          alerts: sess.alerts || [],
          status: sess.status || { ok: false, error: 'NOT_STARTED' }
        });
      } else if (msg?.type === 'UPDATE_SETTINGS') {
        const { settings } = await chrome.storage.local.get('settings');
        const next = { ...DEFAULT_SETTINGS, ...settings, ...msg.patch };
        await chrome.storage.local.set({ settings: next });
        // если в patch затронуты sync-поля — обновляем зеркало
        if (SYNCED_FIELDS.some(k => k in (msg.patch || {}))) {
          mirrorToSync(next);
        }
        // broadcast в content scripts чтобы они подхватили новые настройки
        const tabs = await chrome.tabs.query({
          url: ['https://www.tbank.ru/terminal/*', 'https://www.tinkoff.ru/terminal/*']
        });
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_UPDATED', settings: next }).catch(() => {});
        }
        sendResponse({ ok: true, settings: next });
      } else if (msg?.type === 'CLEAR_ALERTS') {
        await chrome.storage.session.set({ alerts: [] });
        const tabs = await chrome.tabs.query({
          url: ['https://www.tbank.ru/terminal/*', 'https://www.tinkoff.ru/terminal/*']
        });
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, { type: 'CLEAR_ALERTS' }).catch(() => {});
        }
        sendResponse({ ok: true });
      } else if (msg?.type === 'TEST_ALERT') {
        const tabs = await chrome.tabs.query({
          url: ['https://www.tbank.ru/terminal/*', 'https://www.tinkoff.ru/terminal/*']
        });
        if (tabs.length === 0) {
          sendResponse({ ok: false, error: 'NO_TERMINAL_TAB' });
          return;
        }
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, { type: 'TEST_ALERT' }).catch(() => {});
        }
        sendResponse({ ok: true });
      } else if (msg?.type === 'ACTIVATE_TICKER') {
        // пересылаем в первую открытую вкладку терминала
        const tabs = await chrome.tabs.query({
          url: ['https://www.tbank.ru/terminal/*', 'https://www.tinkoff.ru/terminal/*']
        });
        if (tabs.length === 0) {
          sendResponse({ ok: false, error: 'NO_TERMINAL_TAB' });
          return;
        }
        // Берём активную вкладку терминала, если такая есть; иначе первую.
        const target = tabs.find(t => t.active) || tabs[0];
        try {
          const resp = await chrome.tabs.sendMessage(target.id, {
            type: 'ACTIVATE_TICKER',
            ticker: msg.ticker
          });
          // фокусим эту вкладку чтобы пользователь увидел эффект
          if (resp?.ok) {
            try { await chrome.tabs.update(target.id, { active: true }); } catch {}
            try { await chrome.windows.update(target.windowId, { focused: true }); } catch {}
          }
          sendResponse(resp || { ok: false, error: 'NO_RESPONSE' });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      } else if (msg?.type === 'TOGGLE_HIDDEN' || msg?.type === 'TOGGLE_INTERESTING') {
        const ticker = String(msg.ticker || '').trim().toUpperCase();
        if (!ticker) { sendResponse({ ok: false, error: 'NO_TICKER' }); return; }
        const { settings } = await chrome.storage.local.get('settings');
        const cur = { ...DEFAULT_SETTINGS, ...(settings || {}) };
        const field = msg.type === 'TOGGLE_HIDDEN' ? 'hiddenTickers' : 'interestingTickers';
        const list = new Set(cur[field] || []);
        const explicit = msg.value;
        let nowOn;
        if (explicit === true) { list.add(ticker); nowOn = true; }
        else if (explicit === false) { list.delete(ticker); nowOn = false; }
        else if (list.has(ticker)) { list.delete(ticker); nowOn = false; }
        else { list.add(ticker); nowOn = true; }
        cur[field] = [...list].sort();
        // Если тикер стал hidden — снимаем с него interesting (и наоборот, добавляя в interesting,
        // снимаем hidden — две метки взаимоисключающие).
        if (nowOn) {
          const otherField = msg.type === 'TOGGLE_HIDDEN' ? 'interestingTickers' : 'hiddenTickers';
          const other = new Set(cur[otherField] || []);
          if (other.delete(ticker)) cur[otherField] = [...other].sort();
        }
        await chrome.storage.local.set({ settings: cur });
        // зеркалируем в sync (для бэкапа через Google аккаунт)
        mirrorToSync(cur);
        const tabs = await chrome.tabs.query({
          url: ['https://www.tbank.ru/terminal/*', 'https://www.tinkoff.ru/terminal/*']
        });
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_UPDATED', settings: cur }).catch(() => {});
        }
        sendResponse({ ok: true, settings: cur, ticker, on: nowOn });
      } else if (msg?.type === 'API_FETCH') {
        // прокси fetch для content script (обходим CORS терминала)
        const { url, init } = msg;
        try {
          const r = await fetch(url, init);
          const text = await r.text();
          sendResponse({
            ok: true,
            response: {
              status: r.status,
              ok: r.ok,
              statusText: r.statusText,
              body: text
            }
          });
        } catch (e) {
          const error = fetchErrorCode(e);
          let origin = 'unknown';
          try { origin = new URL(url).origin; } catch {}
          console.warn('[moex-scanner] API_FETCH failed:', origin, error);
          sendResponse({ ok: false, error });
        }
      } else if (msg?.type === 'STATUS_UPDATE' && sender.tab) {
        // content script сообщает статус — кладём в session storage для popup
        await chrome.storage.session.set({ status: msg.status });
        sendResponse({ ok: true });
      } else if (msg?.type === 'ALERTS_UPDATE' && sender.tab) {
        // content script сообщает свежий список алертов
        await chrome.storage.session.set({ alerts: msg.alerts });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'UNKNOWN_MESSAGE' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
