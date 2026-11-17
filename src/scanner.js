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
      if (frames.some(frame => !frame)) return null;
      const score = Math.round(frames.reduce((total, frame) => total + frame.score, 0) / frames.length);
      const confirmed = frames.every(frame => frame.side !== 'WAIT' && frame.side === frames[0].side);
      let side = confirmed ? frames[0].side : null;
      let status = 'CONFIRMED';
      let missing = [];
      let caution = false;
      if (!confirmed) {
        // Broader directional votes are for watch-only candidates, never confirmed entries.
        const votes = frames.map(frame => {
          if (frame.trend === 'UPTREND' && frame.momentum !== 'BEARISH') return 'LONG';
          if (frame.trend === 'DOWNTREND' && frame.momentum !== 'BULLISH') return 'SHORT';
          if (frame.momentum === 'BULLISH' && frame.trend !== 'DOWNTREND') return 'LONG';
          if (frame.momentum === 'BEARISH' && frame.trend !== 'UPTREND') return 'SHORT';
          return null;
        });
        const longCount = votes.filter(value => value === 'LONG').length;
        const shortCount = votes.filter(value => value === 'SHORT').length;
        side = longCount >= 2 ? 'LONG' : shortCount >= 2 ? 'SHORT' : null;
        if (!side || score < 35) return null;
        status = 'EARLY';
        caution = frames.some(frame => frame.falseEntry === 'BLOCKED');
        missing = frames.flatMap((frame, index) => {
          const notes = [];
          if (votes[index] !== side) notes.push(['5m','15m','1h'][index] + ': directional agreement pending');
          if (frame.reasons?.length) notes.push(['5m','15m','1h'][index] + ': ' + frame.reasons[0]);
          return notes;
        });
        if (caution) missing.unshift('Caution: a timeframe triggered a false-entry filter');
      }
      const levels = buildTradeLevels(raw5m, side, price);
      if (!levels) return null;
      return {
        symbol: ticker.symbol, side, status, entry: price,
        ...levels, missing,
        score,
        trend: frames[2].trend, momentum: frames[0].momentum,
        confirmation: confirmed ? 'CONFIRMED' : 'EARLY · NOT CONFIRMED',
        consolidation: frames.some(frame => frame.consolidation === 'YES') ? 'YES' : 'NO',
        falseEntry: caution ? 'CAUTION' : 'CLEAR',
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
  return results.sort((a, b) => (a.status === b.status ? b.score - a.score : a.status === 'CONFIRMED' ? -1 : 1)).slice(0, 20);
}
