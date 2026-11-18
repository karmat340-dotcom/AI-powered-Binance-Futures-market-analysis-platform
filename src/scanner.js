import { analyseMarket, buildTradeLevels, getDirectionalBias } from './analysis.js';

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
      analysed++;
      const price = Number(ticker.lastPrice);
      const frames = [
        analyseMarket(raw5m, price),
        analyseMarket(raw15m, price),
        analyseMarket(raw1h, price)
      ];
      if (frames.some(frame => !frame)) return null;
      const score = Math.round(frames.reduce((total, frame) => total + frame.score, 0) / frames.length);
      const strong = frames.every(frame => frame.side !== 'WAIT' && frame.side === frames[0].side);
      const bias15m = getDirectionalBias(frames[1]);
      const bias1h = getDirectionalBias(frames[2]);
      const higherDirection = bias15m && bias15m === bias1h ? bias15m : null;
      const fiveSupports = higherDirection === 'LONG'
        ? frames[0].falseEntry === 'CLEAR' && frames[0].momentum !== 'BEARISH' && frames[0].trend !== 'DOWNTREND'
        : higherDirection === 'SHORT'
          ? frames[0].falseEntry === 'CLEAR' && frames[0].momentum !== 'BULLISH' && frames[0].trend !== 'UPTREND'
          : false;
      // Flexible moderate setup: 15m and 1h trend/momentum must agree.
      // Removed the extra 15m breakout-confirmation requirement to reduce unnecessary WAITs.
      // Keep false-entry protection and require 5m not to strongly oppose the direction.
      const moderate = !strong && !!higherDirection &&
        frames[1].falseEntry === 'CLEAR' &&
        frames[2].falseEntry === 'CLEAR' &&
        fiveSupports;
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
        if (!side || score < 35) {
          // Looser higher-timeframe alignment is a potential setup, never a trade entry.
          const higherLong = ['UPTREND','BULLISH'].filter((_, index) => {
            const frame = frames[index + 1];
            return frame.trend === 'UPTREND' || frame.momentum === 'BULLISH';
          }).length;
          const higherShort = frames.slice(1).filter(frame =>
            frame.trend === 'DOWNTREND' || frame.momentum === 'BEARISH'
          ).length;
          side = higherLong >= 2 ? 'LONG' : higherShort >= 2 ? 'SHORT' : null;
          if (!side || score < 25) return null;
          status = 'POTENTIAL';
        } else {
          status = 'EARLY';
        }
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
        confirmation: strong ? 'STRONG · 3/3 CONFIRMED' : moderate ? 'MODERATE · 15m + 1h CONFIRMED' : (status === 'POTENTIAL' ? 'POTENTIAL · WATCH ONLY' : 'EARLY · NOT CONFIRMED'),
        consolidation: frames.some(frame => frame.consolidation === 'YES') ? 'YES' : 'NO',
        falseEntry: caution ? 'CAUTION' : 'CLEAR',
        price, change: Number(ticker.priceChangePercent),
        volume: Number(ticker.quoteVolume),
        rsi5m: frames[0].rsi, rsi15m: frames[1].rsi, rsi1h: frames[2].rsi,
        confirmedAt: new Date().toISOString()
      };
    } catch {
      dataErrors++;
      return null;
    }
  });
  const results = [];
  let analysed = 0;
  let dataErrors = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(4, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      const result = await tasks[index]();
      if (result) results.push(result);
    }
  });
  await Promise.all(workers);
  const rank = { STRONG: 0, MODERATE: 1, EARLY: 2, POTENTIAL: 3 };
  const sorted = results.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.score - a.score)).slice(0, 20);
  return { results: sorted, stats: { attempted: candidates.length, analysed, dataErrors, strong: results.filter(x => x.status === 'STRONG').length, moderate: results.filter(x => x.status === 'MODERATE').length, early: results.filter(x => x.status === 'EARLY').length, potential: results.filter(x => x.status === 'POTENTIAL').length } };
}
