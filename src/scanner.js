import { analyseMarket, buildTradeLevels } from './analysis.js';

const API = 'https://fapi.binance.com';

async function fetchFrame(symbol, interval) {
  const response = await fetch(`${API}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=100`);
  if (!response.ok) throw new Error(`Market data request failed (${response.status})`);
  return response.json();
}

export async function scanMarkets(tickers, options = {}) {
  const limit = options.limit || 40;
  const candidates = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, limit);
  const tasks = candidates.map(ticker => async () => {
    try {
      const [raw5m, raw15m, raw1h] = await Promise.all([
        fetchFrame(ticker.symbol, '5m'),
        fetchFrame(ticker.symbol, '15m'),
        fetchFrame(ticker.symbol, '1h')
      ]);
      const price = Number(ticker.lastPrice);
      const frames = [
        analyseMarket(raw5m, price),
        analyseMarket(raw15m, price),
        analyseMarket(raw1h, price)
      ];
      if (frames.some(frame => !frame || frame.side === 'WAIT')) return null;
      if (!frames.every(frame => frame.side === frames[0].side)) return null;
      const levels = buildTradeLevels(raw5m, frames[0].side, price);
      if (!levels) return null;
      return {
        symbol: ticker.symbol, side: frames[0].side, entry: price,
        ...levels,
        score: Math.round(frames.reduce((total, frame) => total + frame.score, 0) / frames.length),
        trend: frames[2].trend, momentum: frames[0].momentum,
        confirmation: 'CONFIRMED', consolidation: 'NO', falseEntry: 'CLEAR',
        price, change: Number(ticker.priceChangePercent),
        volume: Number(ticker.quoteVolume),
        rsi5m: frames[0].rsi, rsi15m: frames[1].rsi, rsi1h: frames[2].rsi,
        confirmedAt: new Date().toISOString()
      };
    } catch {
      return null;
    }
  });
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(4, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      const result = await tasks[index]();
      if (result) results.push(result);
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => b.score - a.score).slice(0, 12);
}
