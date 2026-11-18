import { analyseMarket, buildTradeLevels, getDirectionalBias } from './analysis.js';

const API = 'https://fapi.binance.com';

async function fetchFrame(symbol, interval) {
  const response = await fetch(`${API}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=100`);
  if (!response.ok) throw new Error(`Market data request failed (${response.status})`);
  return response.json();
}


function buildScalpLevels(raw, side, entry) {
  const candles = (raw || []).slice(0, -1).map(c => Array.isArray(c)
    ? { high:+c[2], low:+c[3], close:+c[4] }
    : { high:+c.high, low:+c.low, close:+c.close });
  if (candles.length < 20 || !Number.isFinite(entry) || entry <= 0) return null;
  const recent = candles.slice(-14);
  const ranges = recent.map((c, i) => {
    const previous = candles[candles.length - recent.length + i - 1]?.close;
    return previous == null ? c.high - c.low : Math.max(c.high-c.low, Math.abs(c.high-previous), Math.abs(c.low-previous));
  });
  const atr = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const risk = Math.min(entry * 0.003, Math.max(atr * 1.5, entry * 0.0008));
  const direction = side === 'LONG' ? 1 : -1;
  return {
    sl: entry - direction * risk, tp1: entry + direction * risk,
    tp2: entry + direction * risk * 1.4, tp3: entry + direction * risk * 1.8,
    riskDistance: risk, atr, stopDistancePercent: risk / entry * 100,
    stopMethod: '1m ATR scalp stop', riskReward: { tp1:'1:1', tp2:'1:1.4', tp3:'1:1.8' }
  };
}

export async function scanMarkets(tickers, options = {}) {
  const limit = options.limit || 40;
  const mode = ['scalp','five'].includes(options.mode) ? options.mode : 'normal';
  const candidates = tickers.filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .sort((a,b) => Number(b.quoteVolume) - Number(a.quoteVolume)).slice(0,limit);
  const tasks = candidates.map(ticker => async () => {
    try {
      const intervals = mode === 'normal' ? ['5m','15m','1h'] : ['1m','5m','15m'];
      const rawFrames = await Promise.all(intervals.map(interval => fetchFrame(ticker.symbol,interval)));
      analysed++;
      const price = Number(ticker.lastPrice);
      const frames = rawFrames.map(raw => analyseMarket(raw,price));
      if (frames.some(frame => !frame)) return null;
      const score = Math.round(frames.reduce((sum,frame) => sum + frame.score,0) / 3);
      let side = null, status = 'EARLY', missing = [], caution = false, levels = null;
      if (mode === 'scalp') {
        const [one,five,fifteen] = frames;
        const fiveBias = getDirectionalBias(five);
        const fifteenOpposesLong = fifteen.trend === 'DOWNTREND' && fifteen.momentum === 'BEARISH';
        const fifteenOpposesShort = fifteen.trend === 'UPTREND' && fifteen.momentum === 'BULLISH';
        const oneLong = one.momentum === 'BULLISH' && one.falseEntry === 'CLEAR' && !one.consolidation &&
          (one.checks.breakout || (one.checks.candleBody && one.volumeRatio >= 0.9));
        const oneShort = one.momentum === 'BEARISH' && one.falseEntry === 'CLEAR' && !one.consolidation &&
          (one.checks.breakout || (one.checks.candleBody && one.volumeRatio >= 0.9));
        if (fiveBias === 'LONG' && oneLong && !fifteenOpposesLong) side = 'LONG';
        if (fiveBias === 'SHORT' && oneShort && !fifteenOpposesShort) side = 'SHORT';
        if (side) status = 'SCALP';
        else {
          const longClues = [one.momentum === 'BULLISH', five.trend === 'UPTREND' || five.momentum === 'BULLISH', fifteen.trend === 'UPTREND' || fifteen.momentum === 'BULLISH'].filter(Boolean).length;
          const shortClues = [one.momentum === 'BEARISH', five.trend === 'DOWNTREND' || five.momentum === 'BEARISH', fifteen.trend === 'DOWNTREND' || fifteen.momentum === 'BEARISH'].filter(Boolean).length;
          side = longClues >= 2 && longClues > shortClues ? 'LONG' : shortClues >= 2 && shortClues > longClues ? 'SHORT' : null;
          if (!side) return null;
          status = 'SCALP WATCH';
          missing = ['Watch only — 1m entry trigger is not confirmed'];
          if (fiveBias !== side) missing.push('5m trend and momentum need to align');
          if (one.falseEntry !== 'CLEAR') missing.push('1m false-entry filter warning');
          if (one.consolidation) missing.push('1m price is consolidating');
          if (side === 'LONG' ? fifteenOpposesLong : fifteenOpposesShort) missing.push('15m direction is opposing');
        }
        caution = frames.some(frame => frame.falseEntry === 'BLOCKED');
        levels = buildScalpLevels(rawFrames[0],side,price);
      } else if (mode === 'five') {
        const [one,five,fifteen] = frames;
        const bias = getDirectionalBias(five);
        const opposing = bias === 'LONG'
          ? fifteen.trend === 'DOWNTREND' && fifteen.momentum === 'BEARISH'
          : bias === 'SHORT' ? fifteen.trend === 'UPTREND' && fifteen.momentum === 'BULLISH' : false;
        const trigger = five.falseEntry === 'CLEAR' && !five.consolidation &&
          (five.checks.breakout || (five.checks.candleBody && five.volumeRatio >= 0.8));
        if (bias && trigger && !opposing) { side = bias; status = 'SCALP'; }
        else {
          const longClues = [five.trend === 'UPTREND',five.momentum === 'BULLISH',one.momentum === 'BULLISH'].filter(Boolean).length;
          const shortClues = [five.trend === 'DOWNTREND',five.momentum === 'BEARISH',one.momentum === 'BEARISH'].filter(Boolean).length;
          side = longClues >= 2 && longClues > shortClues ? 'LONG' : shortClues >= 2 && shortClues > longClues ? 'SHORT' : null;
          if (!side) return null;
          status = 'SCALP WATCH';
          missing = ['Watch only — waiting for a completed 5m entry trigger'];
          if (!bias) missing.push('5m trend and momentum need to align');
          if (five.consolidation) missing.push('5m price is consolidating');
          if (five.falseEntry !== 'CLEAR') missing.push('5m false-entry filter warning');
          if (opposing) missing.push('15m direction is strongly opposing');
        }
        caution = five.falseEntry === 'BLOCKED' || opposing;
        levels = buildTradeLevels(rawFrames[1],side,price);
      } else {
        const strong = frames.every(frame => frame.side !== 'WAIT' && frame.side === frames[0].side);
        const bias15m = getDirectionalBias(frames[1]), bias1h = getDirectionalBias(frames[2]);
        const higherDirection = bias15m && bias15m === bias1h ? bias15m : null;
        const fiveSupports = higherDirection === 'LONG'
          ? frames[0].falseEntry === 'CLEAR' && frames[0].momentum !== 'BEARISH' && frames[0].trend !== 'DOWNTREND'
          : higherDirection === 'SHORT'
            ? frames[0].falseEntry === 'CLEAR' && frames[0].momentum !== 'BULLISH' && frames[0].trend !== 'UPTREND' : false;
        const moderate = !strong && !!higherDirection && frames[1].falseEntry === 'CLEAR' && frames[2].falseEntry === 'CLEAR' && fiveSupports;
        side = strong ? frames[0].side : moderate ? higherDirection : null;
        status = strong ? 'STRONG' : moderate ? 'MODERATE' : 'EARLY';
        if (!strong && !moderate) {
          const votes = frames.map(frame => {
            if (frame.trend === 'UPTREND' && frame.momentum !== 'BEARISH') return 'LONG';
            if (frame.trend === 'DOWNTREND' && frame.momentum !== 'BULLISH') return 'SHORT';
            if (frame.momentum === 'BULLISH' && frame.trend !== 'DOWNTREND') return 'LONG';
            if (frame.momentum === 'BEARISH' && frame.trend !== 'UPTREND') return 'SHORT';
            return null;
          });
          const longCount = votes.filter(value => value === 'LONG').length, shortCount = votes.filter(value => value === 'SHORT').length;
          side = longCount >= 2 ? 'LONG' : shortCount >= 2 ? 'SHORT' : null;
          if (!side || score < 35) {
            const higherLong = frames.slice(1).filter(frame => frame.trend === 'UPTREND' || frame.momentum === 'BULLISH').length;
            const higherShort = frames.slice(1).filter(frame => frame.trend === 'DOWNTREND' || frame.momentum === 'BEARISH').length;
            side = higherLong >= 2 ? 'LONG' : higherShort >= 2 ? 'SHORT' : null;
            if (!side || score < 25) return null;
            status = 'POTENTIAL';
          } else status = 'EARLY';
          caution = frames.some(frame => frame.falseEntry === 'BLOCKED');
          frames.forEach((frame,index) => {
            const tf = ['5m','15m','1h'][index], checks = frame.checks || {};
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
        levels = buildTradeLevels(rawFrames[0],side,price);
      }
      if (!levels) return null;
      const confirmed = mode === 'normal' ? status === 'STRONG' || status === 'MODERATE' : status === 'SCALP';
      return {
        symbol:ticker.symbol, side, status, mode, entry:price, ...levels, missing, score,
        trend:frames[mode === 'normal' ? 2 : 1].trend, momentum:frames[mode === 'normal' ? 0 : 1].momentum,
        confirmation:confirmed ? (mode === 'scalp' ? 'SCALP · 1m ENTRY + 5m BIAS' : mode === 'five' ? '5m SCALP · 5m ENTRY + 15m CONTEXT' : status + ' · CONFIRMED') :
          (status === 'SCALP WATCH' ? (mode === 'five' ? '5m SCALP WATCH · NOT CONFIRMED' : 'SCALP WATCH · NOT CONFIRMED') : status === 'POTENTIAL' ? 'POTENTIAL · WATCH ONLY' : 'EARLY · NOT CONFIRMED'),
        consolidation:frames.some(frame => frame.consolidation === 'YES') ? 'YES' : 'NO',
        falseEntry:caution ? 'CAUTION' : 'CLEAR', price, change:Number(ticker.priceChangePercent),
        volume:Number(ticker.quoteVolume), rsi5m:frames[mode === 'normal' ? 0 : 1].rsi,
        rsi15m:frames[mode === 'normal' ? 1 : 2].rsi, confirmedAt:new Date().toISOString()
      };
    } catch { dataErrors++; return null; }
  });
  const results = [];
  let analysed = 0, dataErrors = 0, next = 0;
  const workers = Array.from({length:Math.min(4,tasks.length)},async()=>{
    while(next < tasks.length){const index=next++;const result=await tasks[index]();if(result)results.push(result);}
  });
  await Promise.all(workers);
  const rank = mode === 'scalp' ? {'SCALP':0,'SCALP WATCH':1} : {STRONG:0,MODERATE:1,EARLY:2,POTENTIAL:3};
  const sorted = results.sort((a,b)=>(rank[a.status]-rank[b.status])||(b.score-a.score)).slice(0,20);
  return {results:sorted,stats:{attempted:candidates.length,analysed,dataErrors,strong:results.filter(x=>x.status==='STRONG').length,moderate:results.filter(x=>x.status==='MODERATE').length,early:results.filter(x=>x.status==='EARLY').length,potential:results.filter(x=>x.status==='POTENTIAL').length,scalp:results.filter(x=>x.status==='SCALP').length,scalpWatch:results.filter(x=>x.status==='SCALP WATCH').length}};
}
