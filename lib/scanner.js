// Scanner core: per-figi rolling buffers, активный figi выбирается на каждом
// тике по самой свежей `time` в lastPrice. Δ% считается ТОЛЬКО внутри ring
// активного figi — никогда не смешиваем цены с разных площадок (это ключевая
// защита от фантомных дельт, когда одна и та же бумага на разных площадках
// торгуется с разной ценой).
//
// Cooldown — по тикеру (одна точка в выдаче на тикер за интервал), даже если
// на разных площадках одного тикера сработали бы независимо.

const PRICE_BUFFER_TTL_MS = 6 * 60 * 1000;          // 6 мин истории на figi
const STALE_PRICE_MAX_MS = 60 * 60 * 1000;          // > часа — площадка спит
const DEFAULT_COOLDOWN_MS = 30_000;

const buffersByFigi = new Map();   // figi → { ring: [{ts, price}], lot }
const figiToInstr = new Map();     // figi → { ticker, exchange, lot }
const lastFiredAt = new Map();     // ticker → epoch_ms

export function registerInstrument(inst) {
  if (!inst || !inst.figi || !inst.ticker) return;
  figiToInstr.set(inst.figi, {
    ticker: inst.ticker,
    exchange: inst.exchange || '',
    lot: inst.lot || 1
  });
  if (!buffersByFigi.has(inst.figi)) {
    buffersByFigi.set(inst.figi, { ring: [], lot: inst.lot || 1 });
  }
}

export function unregisterAll() {
  buffersByFigi.clear();
  figiToInstr.clear();
  lastFiredAt.clear();
}

export function getActiveFigis() {
  return [...figiToInstr.keys()];
}

export function pushLastPricesAndDetect(prices, opts) {
  const { windowSec, thresholdPct, cooldownMs = DEFAULT_COOLDOWN_MS } = opts;
  const now = Date.now();
  const cutoff = now - PRICE_BUFFER_TTL_MS;
  const fired = [];

  // 1. Пушим КАЖДУЮ цену в ring её собственного figi (per-figi history)
  for (const p of prices) {
    if (!p || !p.figi || !Number.isFinite(p.price) || p.price <= 0) continue;
    const buf = buffersByFigi.get(p.figi);
    if (!buf) continue;
    buf.ring.push({ ts: now, price: p.price, time: p.time });
    while (buf.ring.length > 0 && buf.ring[0].ts < cutoff) buf.ring.shift();
  }

  // 2. Группируем по ticker — определяем активный figi (макс time в lastPrice)
  const byTicker = new Map(); // ticker → array of {price, time, figi, exchange}
  for (const p of prices) {
    if (!p || !p.figi || !Number.isFinite(p.price) || p.price <= 0) continue;
    const inst = figiToInstr.get(p.figi);
    if (!inst) continue;
    if (!byTicker.has(inst.ticker)) byTicker.set(inst.ticker, []);
    byTicker.get(inst.ticker).push({
      price: p.price,
      time: p.time,
      figi: p.figi,
      exchange: inst.exchange
    });
  }

  // 3. Для каждого тикера: выбрать активный figi и посчитать Δ% по его ring
  for (const [ticker, variants] of byTicker) {
    variants.sort((a, b) => String(b.time).localeCompare(String(a.time)));
    const active = variants[0];
    if (!active) continue;
    const activeTimeMs = active.time ? Date.parse(active.time) : 0;
    if (activeTimeMs && now - activeTimeMs > STALE_PRICE_MAX_MS) continue;

    const buf = buffersByFigi.get(active.figi);
    if (!buf || buf.ring.length === 0) continue;

    // Δ% — ТОЛЬКО по ring активного figi (никаких смешений площадок)
    const targetTs = now - windowSec * 1000;
    const past = findClosest(buf.ring, targetTs);
    if (!past) continue;
    if (Math.abs(past.ts - targetTs) > windowSec * 1500) continue;

    const deltaPct = ((active.price - past.price) / past.price) * 100;
    if (Math.abs(deltaPct) < thresholdPct) continue;

    // cooldown по тикеру
    const lastFired = lastFiredAt.get(ticker) || 0;
    if (now - lastFired < cooldownMs) continue;
    lastFiredAt.set(ticker, now);

    const inWindow = buf.ring.filter(r => r.ts >= targetTs);
    const lo = Math.min(...inWindow.map(r => r.price));
    const hi = Math.max(...inWindow.map(r => r.price));

    const alert = {
      ticker,
      figi: active.figi,
      exchange: active.exchange,
      deltaPct: round2(deltaPct),
      priceLow: lo,
      priceHigh: hi,
      pastPrice: past.price,
      pastTs: past.ts,
      currentPrice: active.price,
      ts: now,
      windowSec
    };
    console.log(
      `[moex-scanner] FIRED ${ticker} (active figi=${active.figi}, ex=${active.exchange}): ` +
      `${past.price} (${formatTs(past.ts)}) → ${active.price} (${formatTs(now)}) = ${round2(deltaPct)}%, ` +
      `window ${windowSec}s, total figi for ticker: ${variants.length}`
    );
    fired.push(alert);
  }

  return fired;
}

function formatTs(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
}

function findClosest(ring, targetTs) {
  if (ring.length === 0) return null;
  let lo = 0, hi = ring.length - 1;
  if (ring[hi].ts <= targetTs) return ring[hi];
  if (ring[0].ts >= targetTs) return ring[0];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ring[mid].ts < targetTs) lo = mid + 1;
    else hi = mid;
  }
  const a = ring[Math.max(0, lo - 1)];
  const b = ring[lo];
  return Math.abs(a.ts - targetTs) < Math.abs(b.ts - targetTs) ? a : b;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
