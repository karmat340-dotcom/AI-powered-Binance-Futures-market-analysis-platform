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
      const [raw15m, raw1h] = await Promise.all([
        fetchFrame(ticker.symbol, '15m'),
        fetchFrame(ticker.symbol, '1h')
      ]);
      const price = Number(ticker.lastPrice);
      const shortFrame = analyseCandles(raw15m, price);
      const longFrame = analyseCandles(raw1h, price);
      if (!shortFrame || !longFrame || shortFrame.side === 'WAIT' || shortFrame.side !== longFrame.side) return null;
      return {
        symbol: ticker.symbol,
        side: shortFrame.side,
        score: Math.round((shortFrame.score + longFrame.score) / 2),
        price,
        change: Number(ticker.priceChangePercent),
        volume: Number(ticker.quoteVolume),
        rsi15m: shortFrame.rsi,
        rsi1h: longFrame.rsi,
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
