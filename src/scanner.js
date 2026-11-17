const API = 'https://fapi.binance.com';

function ema(values, period) {
  if (values.length < period) return null;
  let value = values[0];
  const k = 2 / (period + 1);
  for (let i = 1; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function rsi(values) {
  if (values.length < 15) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - 14; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / Math.max(losses, 1e-9));
}

function analyseCandles(raw, livePrice) {
  const closes = raw.map(c => Number(c[4]));
  if (closes.length < 60) return null;
  const price = Number(livePrice) || closes.at(-1);
  const e9 = ema(closes.slice(-60), 9);
  const e21 = ema(closes.slice(-80), 21);
  const strength = rsi(closes);
  if (!e9 || !e21 || strength === null) return null;
  const side = price > e9 && e9 > e21 && strength < 70
    ? 'LONG'
    : price < e9 && e9 < e21 && strength > 30 ? 'SHORT' : 'WAIT';
  const score = Math.min(92, Math.round(48 + Math.abs(e9 - e21) / Math.max(price, 1e-9) * 15000 + Math.abs(strength - 50) * 0.35));
  return { side, score, rsi: strength };
}

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
      const frame5m = analyseCandles(raw5m, price);
      const frame15m = analyseCandles(raw15m, price);
      const frame1h = analyseCandles(raw1h, price);
      const frames = [frame5m, frame15m, frame1h];
      if (frames.some(frame => !frame || frame.side === 'WAIT')) return null;
      if (!frames.every(frame => frame.side === frames[0].side)) return null;
      const recentRanges = raw5m.slice(-14).map(c => Number(c[2]) - Number(c[3]));
      const averageRange = recentRanges.reduce((sum, value) => sum + value, 0) / Math.max(1, recentRanges.length);
      const risk = Math.max(price * 0.003, averageRange * 1.5);
      const direction = frames[0].side === 'LONG' ? 1 : -1;
      return {
        symbol: ticker.symbol,
        side: frames[0].side,
        entry: price,
        sl: price - direction * risk,
        tp1: price + direction * risk,
        tp2: price + direction * risk * 2,
        tp3: price + direction * risk * 3,
        score: Math.round(frames.reduce((total, frame) => total + frame.score, 0) / frames.length),
        price,
        change: Number(ticker.priceChangePercent),
        volume: Number(ticker.quoteVolume),
        rsi5m: frame5m.rsi,
        rsi15m: frame15m.rsi,
        rsi1h: frame1h.rsi,
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
