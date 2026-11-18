function ema(values, period) {
  if (values.length < period) return null;
  let value = values[0], k = 2 / (period + 1);
  for (let i = 1; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}
function rsi(values) {
  if (values.length < 15) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - 14; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / Math.max(losses, 1e-9));
}
function candleParts(c) {
  return Array.isArray(c)
    ? { open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }
    : { open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+(c.volume || 0) };
}
export function analyseMarket(raw, livePrice) {
  if (!raw || raw.length < 60) return null;
  const candles = raw.map(candleParts);
  // Use only fully closed candles for confirmation to reduce intrabar false signals.
  const completed = candles.slice(0, -1);
  if (completed.length < 60) return null;
  const closes = completed.map(c => c.close);
  const price = Number(livePrice) || closes.at(-1);
  const e9 = ema(closes.slice(-60), 9), e21 = ema(closes.slice(-60), 21), e50 = ema(closes.slice(-80), 50);
  if (!e9 || !e21 || !e50 || !price) return null;
  const strength = rsi(closes);
  const recent = completed.slice(-14);
  const atr = recent.reduce((s,c)=>s+(c.high-c.low),0)/recent.length;
  const recent12 = completed.slice(-13,-1);
  const rangeHigh = Math.max(...recent12.map(c=>c.high));
  const rangeLow = Math.min(...recent12.map(c=>c.low));
  const range12 = rangeHigh - rangeLow;
  const avgVolume = completed.slice(-21,-1).reduce((s,c)=>s+c.volume,0)/20;
  const last = completed.at(-1);
  const volumeRatio = avgVolume > 0 ? last.volume/avgVolume : 1;
  const body = Math.abs(last.close-last.open);
  const fullRange = Math.max(last.high-last.low, 1e-12);
  const bodyRatio = body/fullRange;
  const bullishTrend = price > e9 && e9 > e21 && e21 > e50;
  const bearishTrend = price < e9 && e9 < e21 && e21 < e50;
  const trend = bullishTrend ? 'UPTREND' : bearishTrend ? 'DOWNTREND' : 'MIXED';
  const bullishMomentum = strength >= 52 && strength < 72 && closes.at(-1) > closes.at(-4);
  const bearishMomentum = strength <= 48 && strength > 28 && closes.at(-1) < closes.at(-4);
  const momentum = bullishMomentum ? 'BULLISH' : bearishMomentum ? 'BEARISH' : 'WEAK / MIXED';
  const consolidation = atr > 0 && range12 < atr * 3.2;
  const longBreakout = last.close > rangeHigh;
  const shortBreakout = last.close < rangeLow;
  const confirmation = (longBreakout || shortBreakout) && bodyRatio >= 0.4 && volumeRatio >= 1.05;
  const distanceFromFast = Math.abs(price-e9);
  const overextended = atr > 0 && distanceFromFast > atr*1.8;
  const weakVolume = avgVolume > 0 && volumeRatio < 0.65;
  const rejection = bodyRatio < 0.22;
  const falseEntry = overextended || weakVolume || rejection;
  const reasons = [];
  if (trend === 'MIXED') reasons.push('Trend direction is unclear');
  if (momentum === 'WEAK / MIXED') reasons.push('Momentum is not strong enough');
  if (consolidation) reasons.push('Price is consolidating');
  if (!confirmation) reasons.push('Waiting for breakout and candle/volume confirmation');
  if (falseEntry) reasons.push(overextended ? 'Price is overextended from EMA 9' : weakVolume ? 'Breakout volume is too weak' : 'Candle has a weak body / rejection');
  const longReady = bullishTrend && bullishMomentum && !consolidation && longBreakout && confirmation && !falseEntry;
  const shortReady = bearishTrend && bearishMomentum && !consolidation && shortBreakout && confirmation && !falseEntry;
  const side = longReady ? 'LONG' : shortReady ? 'SHORT' : 'WAIT';
  // Early setups identify directional conditions before the strict breakout trigger.
  // They are watch candidates only, never confirmed entries.
  const earlyLong = !falseEntry && bullishMomentum &&
    (bullishTrend || (longBreakout && trend !== 'DOWNTREND'));
  const earlyShort = !falseEntry && bearishMomentum &&
    (bearishTrend || (shortBreakout && trend !== 'UPTREND'));
  const earlySide = side !== 'WAIT' ? null :
    earlyLong && !earlyShort ? 'LONG' :
    earlyShort && !earlyLong ? 'SHORT' : null;
  const score = Math.min(98, Math.round(
    (trend !== 'MIXED' ? 20 : 0) +
    (momentum !== 'WEAK / MIXED' ? 20 : 0) +
    (!consolidation ? 15 : 0) +
    (confirmation ? 25 : 0) +
    (!falseEntry ? 20 : 0)
  ));
  return {
    side, earlySide, score, rsi:strength, trend, momentum,
    confirmation: confirmation ? 'CONFIRMED' : 'WAITING',
    consolidation: consolidation ? 'YES' : 'NO',
    falseEntry: falseEntry ? 'BLOCKED' : 'CLEAR',
    reasons, volumeRatio, bodyRatio, atr,
    checks: {
      trend: trend === (bullishMomentum ? 'UPTREND' : bearishMomentum ? 'DOWNTREND' : 'MIXED'),
      trendAligned: bullishTrend || bearishTrend,
      momentumAligned: bullishMomentum || bearishMomentum,
      breakout: longBreakout || shortBreakout,
      candleBody: bodyRatio >= 0.4,
      volume: volumeRatio >= 1.05,
      consolidation,
      falseEntry
    }
  };
}

export function buildTradeLevels(raw, side, entry) {
  const candles = (raw || []).map(candleParts).slice(0, -1);
  if (candles.length < 20 || !Number.isFinite(entry) || entry <= 0) return null;
  const recent = candles.slice(-14);
  const atr = recent.reduce((sum, c, i) => {
    const prev = candles[candles.length - recent.length + i - 1]?.close;
    const tr = prev == null ? c.high - c.low : Math.max(c.high-c.low, Math.abs(c.high-prev), Math.abs(c.low-prev));
    return sum + tr;
  }, 0) / recent.length;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const structure = candles.slice(-21, -1);
  const swingLow = Math.min(...structure.map(c => c.low));
  const swingHigh = Math.max(...structure.map(c => c.high));
  const buffer = atr * 0.15;
  const isLong = side === 'LONG';
  const structureDistance = isLong ? entry - swingLow + buffer : swingHigh - entry + buffer;
  const risk = Math.min(atr * 2.5, Math.max(atr * 1.5, structureDistance));
  const direction = isLong ? 1 : -1;
  return {
    sl: entry - direction * risk,
    tp1: entry + direction * risk * 1.5,
    tp2: entry + direction * risk * 2,
    tp3: entry + direction * risk * 3,
    riskDistance: risk,
    atr,
    stopDistancePercent: risk / entry * 100,
    stopMethod: 'ATR + recent swing structure',
    riskReward: { tp1: '1:1.5', tp2: '1:2', tp3: '1:3' }
  };
}

export function getDirectionalBias(frame) {
  if (!frame) return null;
  if (frame.trend === 'UPTREND' && frame.momentum === 'BULLISH') return 'LONG';
  if (frame.trend === 'DOWNTREND' && frame.momentum === 'BEARISH') return 'SHORT';
  return null;
}
