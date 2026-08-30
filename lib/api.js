// T-Invest REST API client.
// Docs: https://developer.tbank.ru/invest/api
//
// Все функции принимают `transport` — функцию (url, init) => Promise<Response>.
// В background транспорт делает прямой fetch (имеет права расширения).
// В content script транспорт идёт через chrome.runtime.sendMessage в background,
// потому что Chrome 99+ применяет CORS страницы к fetch из content script'а.

const BASE = 'https://invest-public-api.tbank.ru/rest';

function normalizeTransportError(error) {
  const message = String(error?.message || error || '');
  if (
    message === 'NETWORK_OR_CERTIFICATE' ||
    /failed to fetch|networkerror|network request failed|load failed/i.test(message)
  ) {
    return new Error('NETWORK_OR_CERTIFICATE');
  }
  return error instanceof Error ? error : new Error(message || 'TRANSPORT_FAILED');
}

async function call(transport, method, body, token) {
  if (!token) throw new Error('NO_TOKEN');
  let res;
  try {
    res = await transport(`${BASE}/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body || {})
    });
  } catch (error) {
    throw normalizeTransportError(error);
  }
  if (res.status === 401) throw new Error('TOKEN_INVALID');
  if (res.status === 403) throw new Error('ACCESS_DENIED');
  if (res.status === 429) throw new Error('RATE_LIMITED');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API_${res.status}:${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function getShares(transport, token) {
  const data = await call(
    transport,
    'tinkoff.public.invest.api.contract.v1.InstrumentsService/Shares',
    { instrumentStatus: 'INSTRUMENT_STATUS_ALL' },
    token
  );
  const all = data.instruments || [];
  // Фильтр: рубли + MOEX в exchange. apiTradeAvailableFlag НЕ требуем —
  // для чтения цен он не нужен (нужен только для отправки заявок), и у
  // непрофи-аккаунтов он часто false для большинства бумаг.
  // Принимаем все варианты MOEX*: основная MOEX, MOEX_PLUS, MOEX_EVENING_WEEKEND,
  // MOEX_WEEKEND. Не дедуплицируем — pricing layer (scanner.js) сам выберет
  // активную площадку для каждого тикера на каждом тике, по самой свежей
  // `time` в lastPrice. Это совпадает с тем что делает основной график
  // терминала: показывает цену текущей активной сессии.
  const filtered = all.filter(s => {
    const cur = String(s.currency || '').toLowerCase();
    const ex = String(s.exchange || '').toUpperCase();
    return cur === 'rub' && ex.includes('MOEX');
  });
  // Уникальное число тикеров для статистики
  const uniqTickers = new Set(filtered.map(s => s.ticker)).size;
  console.log(
    `[moex-scanner] Shares: всего ${all.length}, MOEX*: ${filtered.length} figi (${uniqTickers} уникальных тикеров)`
  );
  // Диагностика: какие площадки доступны для популярных тикеров
  const debugTickers = ['GAZP', 'SBER', 'LKOH', 'YNDX', 'MAGN'];
  for (const tk of debugTickers) {
    const variants = filtered.filter(s => s.ticker === tk);
    if (variants.length > 0) {
      console.log(
        `[moex-scanner] площадки ${tk}: ` +
        variants.map(s => `${s.exchange}`).join(', ')
      );
    }
  }
  return filtered.map(s => ({
    figi: s.figi,
    ticker: s.ticker,
    name: s.name,
    lot: s.lot,
    currency: s.currency,
    exchange: s.exchange
  }));
}

export async function getFutures(transport, token) {
  const data = await call(
    transport,
    'tinkoff.public.invest.api.contract.v1.InstrumentsService/Futures',
    { instrumentStatus: 'INSTRUMENT_STATUS_ALL' },
    token
  );
  const all = data.instruments || [];
  const filtered = all.filter(f => {
    const ex = String(f.exchange || '').toUpperCase();
    return ex.includes('FORTS') || ex.includes('MOEX');
  });
  // Не дедуплицируем — scanner выберет активный figi на каждом тике
  const uniq = new Set(filtered.map(f => f.ticker)).size;
  console.log(
    `[moex-scanner] Futures: всего ${all.length}, MOEX/FORTS: ${filtered.length} figi (${uniq} уникальных тикеров)`
  );
  return filtered.map(f => ({
    figi: f.figi,
    ticker: f.ticker,
    name: f.name,
    lot: f.lot,
    currency: f.currency,
    exchange: f.exchange,
    expirationDate: f.expirationDate
  }));
}

export async function getCandles(transport, instrumentId, fromIso, toIso, interval, token) {
  const data = await call(
    transport,
    'tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles',
    { instrumentId, from: fromIso, to: toIso, interval },
    token
  );
  return (data.candles || []).map(c => ({
    open: quotationToNum(c.open),
    high: quotationToNum(c.high),
    low: quotationToNum(c.low),
    close: quotationToNum(c.close),
    volume: Number(c.volume || 0),
    time: c.time,
    isComplete: c.isComplete
  }));
}

export async function getLastPrices(transport, instrumentIds, token) {
  const data = await call(
    transport,
    'tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices',
    { instrumentId: instrumentIds },
    token
  );
  return (data.lastPrices || []).map(p => ({
    figi: p.figi,
    price: quotationToNum(p.price),
    time: p.time
  }));
}

function quotationToNum(q) {
  if (!q) return 0;
  const units = Number(q.units || 0);
  const nano = Number(q.nano || 0) / 1e9;
  return units + nano;
}
