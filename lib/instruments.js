// Состав индекса IMOEX через ISS API Мосбиржи.
// Анонимный — токен не нужен, но нужен fetch с прокси через background
// (CORS страницы www.tbank.ru/terminal не разрешает iss.moex.com).

const ISS_IMOEX_COMPOSITION =
  'https://iss.moex.com/iss/statistics/engines/stock/markets/index/analytics/IMOEX.json';

export async function getImoexTickers(transport) {
  const url = ISS_IMOEX_COMPOSITION + '?iss.json=extended&iss.meta=off';
  const res = await transport(url, { method: 'GET' });
  if (!res.ok) throw new Error(`ISS_${res.status}`);
  const json = await res.json();
  const block = Array.isArray(json) ? json.find(x => x && x.analytics) : null;
  const rows = block?.analytics || [];
  return rows.map(r => r.ticker).filter(Boolean);
}

export function filterToImoex(shares, imoexTickers) {
  const set = new Set(imoexTickers);
  return shares.filter(s => set.has(s.ticker));
}
