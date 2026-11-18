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
      const strong = frames.every(frame => frame.side !== 'WAIT' && frame.side === frames[0].side);
      const higherDirection = frames[1].side !== 'WAIT' && frames[1].side === frames[2].side ? frames[1].side : null;
      const fiveSupports = higherDirection === 'LONG'
        ? frames[0].falseEntry === 'CLEAR' && frames[0].momentum !== 'BEARISH' && frames[0].trend !== 'DOWNTREND'
        : higherDirection === 'SHORT'
          ? frames[0].falseEntry === 'CLEAR' && frames[0].momentum !== 'BULLISH' && frames[0].trend !== 'UPTREND'
          : false;
      const moderate = !strong && !!higherDirection && fiveSupports && frames.every(frame => frame.falseEntry === 'CLEAR');
      let side = strong ? frames[0].side : moderate ? higherDirection : null;
      let status = strong ? 'STRONG' : moderate ? 'MODERATE' : 'EARLY';
      let missing = [];
      let caution = false;
      if (!strong && !moderate) {
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
        missing = [];
        frames.forEach((frame, index) => {
          const tf = ['5m','15m','1h'][index];
          const checks = frame.checks || {};
          if (votes[index] !== side) missing.push(tf + ': direction does not yet align');
          if (!checks.trendAligned) missing.push(tf + ': trend alignment needed');
          if (!checks.momentumAligned) missing.push(tf + ': momentum confirmation needed');
          if (!checks.breakout) missing.push(tf + ': breakout not confirmed');
          if (!checks.candleBody) missing.push(tf + ': stronger candle body needed');
          if (!checks.volume) missing.push(tf + ': volume confirmation needed');
          if (checks.consolidation) missing.push(tf + ': price still consolidating');
          if (checks.falseEntry) missing.push(tf + ': false-entry filter warning');
        });
        missing = [...new Set(missing)];
        if (caution) missing.unshift('Caution: at least one timeframe triggered a false-entry filter');
      }
      const levels = buildTradeLevels(raw5m, side, price);
      if (!levels) return null;
      return {
        symbol: ticker.symbol, side, status, entry: price,
        ...levels, missing,
        score,
        trend: frames[2].trend, momentum: frames[0].momentum,
        confirmation: strong ? 'STRONG · 3/3 CONFIRMED' : moderate ? 'MODERATE · 15m + 1h CONFIRMED' : 'EARLY · NOT CONFIRMED',
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
  const rank = { STRONG: 0, MODERATE: 1, EARLY: 2 };
  return results.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.score - a.score)).slice(0, 20);
}
