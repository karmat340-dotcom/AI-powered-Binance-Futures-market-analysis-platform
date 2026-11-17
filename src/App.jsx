import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Activity,Bell,CandlestickChart,Crosshair,Gauge,Layers3,RefreshCw,Search,ShieldCheck,Star,TrendingUp,Zap} from 'lucide-react';
import {createChart,CandlestickSeries,ColorType,CrosshairMode} from 'lightweight-charts';
import {scanMarkets} from './scanner.js';

const API='https://fapi.binance.com';
const FRAMES=['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];
const WATCH=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','LINKUSDT'];
const fmt=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:Number(n)<1?8:2});
function ema(v,p){let x=v[0],k=2/(p+1);for(let i=1;i<v.length;i++)x=v[i]*k+x*(1-k);return x}
function rsi(v){let g=0,l=0;for(let i=v.length-14;i<v.length;i++){let d=v[i]-v[i-1];if(d>0)g+=d;else l-=d}return l===0?100:100-100/(1+g/Math.max(l,1e-9))}

function marginReturn(entry,level,side,leverage){
  const move=side==='LONG'?(level-entry)/entry*100:(entry-level)/entry*100;
  return move*Number(leverage);
}
function makeTrade(side,symbol,frame,entry,bars){
  const recent=bars.slice(-14);
  const avgRange=recent.length?recent.reduce((s,b)=>s+(b.high-b.low),0)/recent.length:entry*0.003;
  const risk=Math.max(entry*0.003,avgRange*1.5);
  const sign=side==='LONG'?1:-1;
  return {id:Date.now(),symbol,frame,side,entry,sl:entry-sign*risk,tp1:entry+sign*risk,tp2:entry+sign*risk*2,tp3:entry+sign*risk*3,status:'ACTIVE',openedAt:new Date().toISOString()};
}
function readSavedTrade(){
  try{return JSON.parse(localStorage.getItem('tradeai-active-trade')||'null')}catch{return null}
}

function PriceChart({bars,livePrice,symbol,frame}){
  const host=useRef(null),chartRef=useRef(null),seriesRef=useRef(null),lineRef=useRef(null);
  const [hover,setHover]=useState(null);
  useEffect(()=>{
    if(!host.current)return;
    const chart=createChart(host.current,{
      width:host.current.clientWidth,height:340,
      layout:{background:{type:ColorType.Solid,color:'#0d1625'},textColor:'#8b9bb0',fontFamily:'DM Sans, sans-serif'},
      grid:{vertLines:{color:'#172438'},horzLines:{color:'#172438'}},
      rightPriceScale:{borderColor:'#26364b',autoScale:true},
      timeScale:{borderColor:'#26364b',timeVisible:true,secondsVisible:false,rightOffset:5},
      crosshair:{mode:CrosshairMode.Normal,vertLine:{color:'#6e829c',width:1,style:2},horzLine:{color:'#6e829c',width:1,style:2}}
    });
    const series=chart.addSeries(CandlestickSeries,{
      upColor:'#39c99a',downColor:'#e66e7d',borderVisible:false,
      wickUpColor:'#39c99a',wickDownColor:'#e66e7d',
      priceLineVisible:true,lastValueVisible:true
    });
    chartRef.current=chart;seriesRef.current=series;
    const observer=new ResizeObserver(entries=>{if(entries[0])chart.applyOptions({width:Math.max(320,Math.floor(entries[0].contentRect.width))})});
    observer.observe(host.current);
    chart.subscribeCrosshairMove(param=>{
      const candle=param.seriesData.get(series);
      setHover(candle?{open:candle.open,high:candle.high,low:candle.low,close:candle.close}:null);
    });
    return ()=>{observer.disconnect();chart.remove();chartRef.current=null;seriesRef.current=null;lineRef.current=null};
  },[]);
  useEffect(()=>{
    const series=seriesRef.current;
    if(!series||!bars.length)return;
    const data=bars.map((b,i)=>({time:Math.floor(b.time/1000),open:b.open,high:b.high,low:b.low,close:b.close}));
    const last=data[data.length-1];
    if(livePrice>0&&last){
      last.high=Math.max(last.high,livePrice);
      last.low=Math.min(last.low,livePrice);
      last.close=livePrice;
    }
    series.setData(data);
    const precision=livePrice<1?6:livePrice<100?4:2;
    series.applyOptions({priceFormat:{type:'price',precision,minMove:1/Math.pow(10,precision)}});
    if(lineRef.current)series.removePriceLine(lineRef.current);
    if(livePrice>0)lineRef.current=series.createPriceLine({price:livePrice,color:'#53dcb4',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:'LIVE'});
    chartRef.current?.timeScale().fitContent();
  },[bars,livePrice,symbol,frame]);
  const shown=hover;
  return <div className="pro-chart-wrap">
    <div className="chart-ohlc">
      {shown?<><span>O <b>{fmt(shown.open)}</b></span><span>H <b className="green">{fmt(shown.high)}</b></span><span>L <b className="red">{fmt(shown.low)}</b></span><span>C <b>{fmt(shown.close)}</b></span></>:<><span>{symbol} · {frame}</span><span>LIVE <b className="green">{livePrice?fmt(livePrice):'—'}</b></span></>}
    </div>
    <div ref={host} className="light-chart"/>
  </div>;
}

export default function App(){
  const [symbol,setSymbol]=useState('BTCUSDT'),[frame,setFrame]=useState('15m'),[bars,setBars]=useState([]),[tickers,setTickers]=useState([]),[busy,setBusy]=useState(true),[error,setError]=useState(''),[query,setQuery]=useState(''),[updated,setUpdated]=useState('');
  const [activeTrades,setActiveTrades]=useState(()=>{
    try{
      const saved=JSON.parse(localStorage.getItem('tradeai-active-trades')||'{}');
      if(Object.keys(saved).length)return saved;
      const legacy=readSavedTrade();
      return legacy?{[legacy.symbol]:legacy}:{};
    }catch{return {}}
  });
  const [loadedKey,setLoadedKey]=useState('');
  const [scannerTrades,setScannerTrades]=useState(()=>{
    try{return JSON.parse(localStorage.getItem('tradeai-scanner-trades')||'{}')}catch{return {}}
  });
  const [scannerBusy,setScannerBusy]=useState(false);
  const [leverage,setLeverage]=useState(()=>localStorage.getItem('tradeai-leverage')||'5');
  useEffect(()=>{localStorage.setItem('tradeai-leverage',leverage)},[leverage]);
  const [scannerError,setScannerError]=useState('');
  const [scanUpdated,setScanUpdated]=useState('');
  const tickerRef=useRef([]);
  const scannerStartedRef=useRef(false);
  const requestRef=useRef(0);
  async function load(){
    const requestId=++requestRef.current;
    const requestKey=symbol+'|'+frame;
    setBusy(true);setError('');
    try{
      const responses=await Promise.all([
        fetch(API+'/fapi/v1/klines?symbol='+symbol+'&interval='+frame+'&limit=120'),
        fetch(API+'/fapi/v1/ticker/24hr')
      ]);
      if(!responses[0].ok||!responses[1].ok)throw Error('Binance market data is temporarily unavailable.');
      const data=await Promise.all(responses.map(x=>x.json()));
      if(requestId!==requestRef.current)return;
      setBars(data[0].map(x=>({time:x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4]})));
      setTickers(data[1].filter(x=>x.symbol.endsWith('USDT')).sort((a,b)=>+b.quoteVolume- +a.quoteVolume));
      setLoadedKey(requestKey);
      setUpdated(new Date().toLocaleTimeString());
    }catch(e){if(requestId===requestRef.current)setError(e.message+' Check your connection and refresh.')}
    finally{if(requestId===requestRef.current)setBusy(false)}
  }
  useEffect(()=>{setBars([]);setLoadedKey('');load();const id=setInterval(load,20000);return()=>{clearInterval(id);requestRef.current++}},[symbol,frame]);
  useEffect(()=>{tickerRef.current=tickers},[tickers]);
  useEffect(()=>{
    let cancelled=false, running=false;
    const runScan=async()=>{
      const current=tickerRef.current;
      if(!current.length||running)return;
      running=true;
      setScannerBusy(true);
      setScannerError('');
      try{
        const results=await scanMarkets(current,{limit:40});
        if(!cancelled){
          setScannerTrades(existing=>{
            const next={...existing};
            results.forEach(item=>{
              if(next[item.symbol])return;
              const key='tradeai-scanner-last-signal-'+item.symbol;
              if(localStorage.getItem(key)===item.side)return;
              next[item.symbol]={...item,id:Date.now()+'-'+item.symbol,status:'ACTIVE',openedAt:new Date().toISOString()};
              localStorage.setItem(key,item.side);
            });
            localStorage.setItem('tradeai-scanner-trades',JSON.stringify(next));
            return next;
          });
          setScanUpdated(new Date().toLocaleTimeString());
        }
      }catch(e){
        if(!cancelled)setScannerError('Scanner temporarily unavailable. Existing market data is unaffected.');
      }finally{
        running=false;
        if(!cancelled)setScannerBusy(false);
      }
    };
    const first=setInterval(()=>{
      if(!scannerStartedRef.current&&tickerRef.current.length){
        scannerStartedRef.current=true;
        runScan();
      }
    },1500);
    const interval=setInterval(runScan,90000);
    return ()=>{cancelled=true;clearInterval(first);clearInterval(interval)};
  },[]);
  useEffect(()=>{
    if(!tickers.length)return;
    setScannerTrades(current=>{
      let changed=false;
      const next={...current};
      Object.entries(current).forEach(([tradeSymbol,trade])=>{
        const market=tickers.find(t=>t.symbol===tradeSymbol);
        const price=Number(market?.lastPrice);
        if(!price)return;
        const hitSL=trade.side==='LONG'?price<=trade.sl:price>=trade.sl;
        const hitTP3=trade.side==='LONG'?price>=trade.tp3:price<=trade.tp3;
        if(hitSL||hitTP3){
          delete next[tradeSymbol];
          changed=true;
        }
      });
      if(changed)localStorage.setItem('tradeai-scanner-trades',JSON.stringify(next));
      return changed?next:current;
    });
  },[tickers]);
  const dataReady=loadedKey===symbol+'|'+frame;
  const ticker=tickers.find(x=>x.symbol===symbol),closes=dataReady?bars.map(x=>x.close):[],last=Number(ticker?.lastPrice)||closes.at(-1)||0;
  const ind=useMemo(()=>closes.length>30?{e9:ema(closes.slice(-60),9),e21:ema(closes.slice(-80),21),e50:ema(closes.slice(-120),50),rsi:rsi(closes)}:null,[bars]);
  const signal=ind?(last>ind.e9&&ind.e9>ind.e21&&ind.rsi<70?'LONG':last<ind.e9&&ind.e9<ind.e21&&ind.rsi>30?'SHORT':'WAIT'):'WAIT';
  const score=ind?Math.min(92,Math.round(48+Math.abs(ind.e9-ind.e21)/Math.max(last,1e-9)*15000+Math.abs(ind.rsi-50)*.35)):0;
  useEffect(()=>{localStorage.setItem('tradeai-active-trades',JSON.stringify(activeTrades))},[activeTrades]);
  useEffect(()=>{
    if(!tickers.length)return;
    setActiveTrades(current=>{
      let changed=false;
      const next={...current};
      Object.entries(current).forEach(([tradeSymbol,trade])=>{
        const market=tickers.find(t=>t.symbol===tradeSymbol);
        const price=Number(market?.lastPrice);
        if(!price)return;
        const hitSL=trade.side==='LONG'?price<=trade.sl:price>=trade.sl;
        const hitTP=trade.side==='LONG'?price>=trade.tp3:price<=trade.tp3;
        if(hitSL||hitTP){
          const closed={...trade,status:hitTP?'TP3 HIT':'STOP LOSS HIT',exitPrice:price,closedAt:new Date().toISOString()};
          localStorage.setItem('tradeai-last-closed-'+tradeSymbol,JSON.stringify(closed));
          delete next[tradeSymbol];
          changed=true;
        }
      });
      return changed?next:current;
    });
  },[tickers]);
  useEffect(()=>{
    if(!dataReady||signal==='WAIT'||!last||bars.length<=30||activeTrades[symbol])return;
    const key='tradeai-last-signal-'+symbol;
    const previous=localStorage.getItem(key);
    localStorage.setItem(key,signal);
    if(previous===signal)return;
    setActiveTrades(current=>{
      if(current[symbol])return current;
      return {...current,[symbol]:makeTrade(signal,symbol,frame,last,bars)};
    });
  },[signal,activeTrades,symbol,frame,last,bars,dataReady]);
  useEffect(()=>{
    if(signal==='WAIT')localStorage.setItem('tradeai-last-signal-'+symbol,'WAIT');
  },[signal,symbol]);
  const displayTrade=activeTrades[symbol]||null;
  const tradePnl=displayTrade&&last?((displayTrade.side==='LONG'?last-displayTrade.entry:displayTrade.entry-last)/displayTrade.entry)*100:0;
  const signalConflict=!!displayTrade&&signal!=='WAIT'&&signal!==displayTrade.side;
  const activeTradeCount=Object.keys(activeTrades).length;
  const filtered=tickers.filter(x=>x.symbol.includes(query.toUpperCase())).slice(0,50);
  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Activity/></div><div><b>TRADE<span>AI</span></b><small>MARKET INTELLIGENCE</small></div></div>
      <div className="side-label">WORKSPACE</div><div className="nav active"><CandlestickChart/> Market overview</div><div className="nav"><Crosshair/> Signal scanner <i>LIVE</i></div><div className="nav"><Star/> Watchlist</div><div className="nav"><Layers3/> Strategy lab</div>
      <div className="side-label second">MARKETS</div><div className="watch-head">Your watchlist <span>★</span></div>
      {WATCH.map(s=><button className={'watch-row '+(s===symbol?'chosen':'')} onClick={()=>setSymbol(s)} key={s}><b className="coin">{s[0]}</b><span>{s.replace('USDT','')}<small>USDT Perpetual</small></span></button>)}
      <div className="sidebar-bottom"><div className="secure"><ShieldCheck/><span>Read-only market data<small>No exchange keys connected</small></span></div><small className="version">TRADE AI · EARLY ACCESS</small></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="crumb">Workspace <span>/</span> <b>Market overview</b></div><div className="top-actions"><div className="live-pill"><i/> BINANCE FUTURES</div><button className="icon-btn"><Bell/></button><div className="avatar">T</div></div></header>
      <section className="welcome"><div><div className="eyebrow"><span/> LIVE MARKET TERMINAL</div><h1>Market <em>overview</em></h1><p>Track the futures market. Find structure. Plan your next move.</p></div><button className="refresh" onClick={load}><RefreshCw/> Refresh data</button></section>
      <section className="market-strip"><div className="strip-label">SELECTED MARKET</div><div className="pair"><div className="pair-icon">{symbol[0]}</div><div><b>{symbol.replace('USDT','')} <span>/ USDT</span></b><small>USDT-M PERPETUAL</small></div><span className="perp">PERP</span></div><div className="price-block"><small>LAST PRICE</small><b>{last?fmt(last):'—'}</b></div><div className="price-block"><small>24H CHANGE</small><b className={+(ticker?.priceChangePercent||0)>=0?'green':'red'}>{ticker?(+ticker.priceChangePercent>=0?'+':'')+(+ticker.priceChangePercent).toFixed(2)+'%':'—'}</b></div><div className="price-block hide-mobile"><small>24H HIGH</small><b>{ticker?fmt(ticker.highPrice):'—'}</b></div><div className="price-block hide-mobile"><small>24H VOLUME</small><b>{ticker?(ticker.quoteVolume/1e6).toFixed(1)+'M':'—'}</b></div></section>
      <div className="grid">
        <section className="panel chart-panel"><div className="panel-head"><div><h2><CandlestickChart/> Price action</h2><small>Live Binance Futures candlesticks · hover for OHLC</small></div><div className="frame-select">{FRAMES.map(f=><button key={f} className={frame===f?'selected':''} onClick={()=>setFrame(f)}>{f}</button>)}</div></div>
          <div className="chart-legend"><span><i className="dot up"/> Bullish</span><span><i className="dot down"/> Bearish</span><span className="chart-note">LIVE PRICE · RIGHT SCALE</span></div>
          {bars.length>0?<PriceChart bars={bars} livePrice={last} symbol={symbol} frame={frame}/>:<div className="empty-chart">{busy?'Loading live candles…':'No chart data available'}</div>}
          <div className="chart-footer"><span><i className="pulse"/> {busy?'Updating market data':'Market data connected'}</span><span>Updated {updated||'—'}</span></div>{error&&<div className="error">{error}</div>}
        </section>
        <section className="panel signal-panel"><div className="panel-head"><div><h2><Zap/> AI signal analysis</h2><small>Rule-based technical confluence</small></div><span className="beta">BETA</span></div><div className={'signal-box '+signal.toLowerCase()}><div className="signal-top"><span>MARKET BIAS</span><span className="signal-dot"/></div><div className="signal-word">{signal}</div><p>{signal==='WAIT'?'Conditions are mixed. Wait for stronger confirmation.':signal==='LONG'?'Bullish momentum alignment detected. Look for a confirmed entry.':'Bearish momentum alignment detected. Look for a confirmed entry.'}</p></div>{signalConflict&&<div className="trade-warning"><b>⚠ SIGNAL CONFLICT</b><span>Active {displayTrade.side} trade, but the latest market bias is {signal}. Review the position; no automatic action is taken.</span></div>}<div className="confidence"><div><span>Confluence score</span><b>{score||'—'}<small>/100</small></b></div><div className="meter"><i style={{width:score+'%'}}/></div><small className="disclaimer">Heuristic score — not a probability of profit.</small></div><div className="levels"><div><span>{displayTrade?'ACTIVE '+displayTrade.side+' · '+displayTrade.symbol:'Selected market entry'}</span><b>{displayTrade?fmt(displayTrade.entry):(last?fmt(last):'—')}</b></div><div><span>Live P/L · {displayTrade?'since entry':'no active position'}</span><b className={tradePnl>=0?'green':'red'}>{displayTrade?(tradePnl>=0?'+':'')+tradePnl.toFixed(2)+'%':'—'}</b></div><div><span>Stop loss</span><b className="red">{displayTrade?fmt(displayTrade.sl):'Await confirmation'}</b></div><div><span>Take profit 1 / 2 / 3</span><b className="green">{displayTrade?[displayTrade.tp1,displayTrade.tp2,displayTrade.tp3].map(fmt).join(' / '):'Await confirmation'}</b></div><div><span>Trade status · ${activeTradeCount} active across coins</span><b>{displayTrade?'ACTIVE · '+displayTrade.frame:'No active trade for this coin'}</b></div></div><div className="signal-foot"><ShieldCheck/> No orders are placed. Analysis only.</div></section>
        <section className="panel indicators"><div className="panel-head"><div><h2><Gauge/> Technical indicators</h2><small>Calculated from selected timeframe</small></div></div><div className="indicator-grid"><div><small>RSI (14)</small><b>{ind?ind.rsi.toFixed(1):'—'}</b><span className={ind?(ind.rsi>70?'red':ind.rsi<30?'green':'neutral'):'neutral'}>{ind?(ind.rsi>70?'Overbought':ind.rsi<30?'Oversold':'Neutral'):'Waiting for data'}</span></div><div><small>EMA 9</small><b>{ind?fmt(ind.e9):'—'}</b><span>Short-term trend</span></div><div><small>EMA 21</small><b>{ind?fmt(ind.e21):'—'}</b><span>Trend direction</span></div><div><small>EMA 50</small><b>{ind?fmt(ind.e50):'—'}</b><span>Market structure</span></div></div></section>
        <section className="panel scanner-panel"><div className="panel-head"><div><h2><Zap/> Automatic market scanner</h2><small>Top 40 USDT pairs · 5m + 15m + 1h trend agreement</small></div><div className="scanner-controls"><label htmlFor="leverage-select">LEVERAGE</label><select id="leverage-select" value={leverage} onChange={e=>setLeverage(e.target.value)}>{[1,2,3,5,10,20,50,100,125].map(x=><option key={x} value={x}>{x}x</option>)}</select><span className="beta">{scannerBusy?'SCANNING':'AUTO SCAN'}</span></div></div>
          <div className="scanner-meta"><span>{scannerBusy?'Checking market setups…':Object.keys(scannerTrades).length+' active setups'}</span><span>Updated {scanUpdated||'—'} · refreshes every 90s</span></div>
          {scannerError&&<div className="error">{scannerError}</div>}
          {Object.keys(scannerTrades).length>0?<div className="scanner-list">{Object.values(scannerTrades).map(item=><button className="scanner-row scanner-trade-row" key={item.id} onClick={()=>setSymbol(item.symbol)}><span className="scanner-pair">{item.symbol.replace('USDT','')}<small>USDT PERP</small></span><b className={item.side==='LONG'?'green':'red'}>{item.side}</b><span className="scanner-score">Score <b>{item.score}/100</b></span><span className="scanner-price">Entry {fmt(item.entry)}</span><span className="scanner-confirm">{leverage}x leverage</span><span className="scanner-levels"><i>SL {fmt(item.sl)}</i><i>TP1 {fmt(item.tp1)}</i><i>TP2 {fmt(item.tp2)}</i><i>TP3 {fmt(item.tp3)}</i></span><span className="scanner-margin-roi"><i>Est. margin impact at {leverage}x</i><b className="red">SL {marginReturn(item.entry,item.sl,item.side,leverage).toFixed(1)}%</b><b className="green">TP1 +{marginReturn(item.entry,item.tp1,item.side,leverage).toFixed(1)}%</b><b className="green">TP2 +{marginReturn(item.entry,item.tp2,item.side,leverage).toFixed(1)}%</b><b className="green">TP3 +{marginReturn(item.entry,item.tp3,item.side,leverage).toFixed(1)}%</b></span></button>)}</div>:<div className="scanner-empty">{scannerBusy?'Scanning the highest-volume contracts. This may take a little while.':'No active scanner setups. New confirmed setups will appear here.'}</div>}
          <div className="scanner-foot">Estimated margin P/L = market-price move × selected leverage, before fees and funding; actual results vary with margin mode and exchange rules. {Number(leverage)>=20?'⚠ High leverage: even a small adverse move can cause a large loss or liquidation.':'Use low leverage and check liquidation price on your exchange.'} These estimates do not change the market-based levels or place orders.</div>
        </section>
        <section className="panel watch-panel"><div className="panel-head"><div><h2><TrendingUp/> Market watch</h2><small>Top 50 USDT perpetual pairs · 24h volume ranking</small></div><div className="searchbox"><Search/><input placeholder="Search any pair" value={query} onChange={e=>setQuery(e.target.value)}/></div></div><div className="table"><div className="table-row table-head"><span>CONTRACT</span><span>LAST PRICE</span><span>24H CHANGE</span></div>{filtered.map(t=><button className="table-row" key={t.symbol} onClick={()=>setSymbol(t.symbol)}><span className="table-coin">{t.symbol.replace('USDT','')} <small>USDT</small></span><b>{fmt(t.lastPrice)}</b><strong className={+t.priceChangePercent>=0?'green':'red'}>{+t.priceChangePercent>=0?'+':''}{(+t.priceChangePercent).toFixed(2)}%</strong></button>)}</div></section>
      </div>
      <footer>TRADE AI <span>·</span> Binance public Futures market data <span>·</span> Educational use only. Not financial advice.</footer>
    </main>
  </div>;
}