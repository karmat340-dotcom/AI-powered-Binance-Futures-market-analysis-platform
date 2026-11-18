import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Activity,Bell,CandlestickChart,Crosshair,Gauge,Layers3,RefreshCw,Search,ShieldCheck,Star,TrendingUp,Zap} from 'lucide-react';
import {createChart,CandlestickSeries,ColorType,CrosshairMode} from 'lightweight-charts';
import {scanMarkets} from './scanner.js';
import {analyseMarket,buildTradeLevels,getDirectionalBias} from './analysis.js';

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
  const levels=buildTradeLevels(bars,side,entry);
  if(!levels)return null;
  return {id:Date.now(),symbol,frame,side,entry,...levels,status:'ACTIVE',openedAt:new Date().toISOString()};
}
function readSavedTrade(){
  try{return JSON.parse(localStorage.getItem('tradeai-active-trade')||'null')}catch{return null}
}

function CryptoIcon({symbol,size=28}){
  const base=String(symbol||'').replace(/USDT$|BUSD$|USD$/,'').toLowerCase();
  const [failed,setFailed]=useState(false);
  return <span className="crypto-icon" style={{width:size,height:size,fontSize:Math.max(10,size*.38)}}>
    {!failed&&<img src={`https://assets.coincap.io/assets/icons/${base}@2x.png`} alt="" onError={()=>setFailed(true)}/>}
    {failed&&base.slice(0,1).toUpperCase()}
  </span>;
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
  const [liveStreamPrice,setLiveStreamPrice]=useState(0),[streamConnected,setStreamConnected]=useState(false);
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
    try{
      const saved=JSON.parse(localStorage.getItem('tradeai-scanner-trades')||'{}');
      return Object.fromEntries(Object.entries(saved).filter(([,trade])=>trade.analysisVersion===2));
    }catch{return {}}
  });
  const [scannerBusy,setScannerBusy]=useState(false);
  const [scannerMode,setScannerMode]=useState(()=>localStorage.getItem('tradeai-scanner-mode')||'normal');
  useEffect(()=>{localStorage.setItem('tradeai-scanner-mode',scannerMode)},[scannerMode]);
  const [earlySetups,setEarlySetups]=useState([]);
  const [potentialSetups,setPotentialSetups]=useState([]);
  const [leverage,setLeverage]=useState(()=>localStorage.getItem('tradeai-leverage')||'5');
  useEffect(()=>{localStorage.setItem('tradeai-leverage',leverage)},[leverage]);
  const [scannerError,setScannerError]=useState('');
  const [scanStats,setScanStats]=useState(null);
  const [consensus,setConsensus]=useState(null);
  const [scanUpdated,setScanUpdated]=useState('');
  const tickerRef=useRef([]);
  const scannerStartedRef=useRef(false);
  const requestRef=useRef(0);
  const scannerSectionRef=useRef(null),watchSectionRef=useRef(null),strategySectionRef=useRef(null);
  const [activeSection,setActiveSection]=useState('overview');
  const [notificationPermission,setNotificationPermission]=useState(()=>('Notification' in window?Notification.permission:'unsupported'));
  async function enableNotifications(){
    if(!('Notification' in window)){window.alert('This browser does not support desktop notifications.');return;}
    const permission=await Notification.requestPermission();
    setNotificationPermission(permission);
    if(permission==='granted')new Notification('TRADE AI alerts enabled',{body:'You will be notified when a confirmed trade setup opens.'});
  }
  function notifyTradeOpen(trade,source){
    if(!('Notification' in window)||Notification.permission!=='granted')return;
    try{
      new Notification('TRADE OPENED · '+trade.symbol,{
        body:source+' · '+trade.side+'\nEntry: '+fmt(trade.entry)+' | SL: '+fmt(trade.sl)+' | TP1: '+fmt(trade.tp1),
        tag:'tradeai-open-'+trade.symbol+'-'+trade.side,
        requireInteraction:true
      });
    }catch{}
  }
  const sectionNames={overview:'Market overview',scanner:'Signal scanner',watchlist:'Watchlist',strategy:'Strategy lab'};
  function navigateTo(section){
    setActiveSection(section);
    if(section==='overview'){window.scrollTo({top:0,behavior:'smooth'});return;}
    const target=section==='scanner'?scannerSectionRef.current:section==='watchlist'?watchSectionRef.current:strategySectionRef.current;
    target?.scrollIntoView({behavior:'smooth',block:'start'});
  }
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
      setBars(data[0].map(x=>({time:x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5]})));
      setTickers(data[1].filter(x=>x.symbol.endsWith('USDT')).sort((a,b)=>+b.quoteVolume- +a.quoteVolume));
      setLoadedKey(requestKey);
      setUpdated(new Date().toLocaleTimeString());
    }catch(e){if(requestId===requestRef.current)setError(e.message+' Check your connection and refresh.')}
    finally{if(requestId===requestRef.current)setBusy(false)}
  }
  useEffect(()=>{setBars([]);setLoadedKey('');load();const id=setInterval(load,20000);return()=>{clearInterval(id);requestRef.current++}},[symbol,frame]);
  useEffect(()=>{tickerRef.current=tickers},[tickers]);
  // Binance Futures WebSocket: update the selected candle and live price between REST refreshes.
  useEffect(()=>{
    let socket=null,retryTimer=null,closed=false,retryDelay=1000;
    const connect=()=>{
      if(closed)return;
      const streams=`${symbol.toLowerCase()}@kline_${frame}/${symbol.toLowerCase()}@markPrice@1s/!ticker@arr`;
      socket=new WebSocket('wss://fstream.binance.com/stream?streams='+streams);
      socket.onopen=()=>{retryDelay=1000;setStreamConnected(true)};
      socket.onmessage=event=>{
        try{
          const packet=JSON.parse(event.data);
          const data=packet.data||packet;
          if(Array.isArray(data)){
            setTickers(data.filter(item=>item.s?.endsWith('USDT')).map(item=>({symbol:item.s,lastPrice:item.c,priceChangePercent:item.P,quoteVolume:item.q})));
            return;
          }
          if(data.e==='markPriceUpdate'&&data.s===symbol){
            const price=Number(data.p);
            if(price>0)setLiveStreamPrice(price);
          }
          if(data.e==='kline'&&data.s===symbol&&data.k){
            const k=data.k;
            const candle={time:Number(k.t),open:Number(k.o),high:Number(k.h),low:Number(k.l),close:Number(k.c),volume:Number(k.v)};
            setBars(current=>{
              const next=current.slice();
              const index=next.findIndex(item=>item.time===candle.time);
              if(index>=0)next[index]=candle;
              else next.push(candle);
              return next.slice(-120);
            });
            setUpdated(new Date().toLocaleTimeString());
          }
        }catch{}
      };
      socket.onerror=()=>socket?.close();
      socket.onclose=()=>{
        setStreamConnected(false);
        if(!closed){retryTimer=setTimeout(connect,retryDelay);retryDelay=Math.min(retryDelay*2,30000)}
      };
    };
    setLiveStreamPrice(0);
    connect();
    return ()=>{
      closed=true;clearTimeout(retryTimer);
      if(socket){socket.onclose=null;socket.close()}
      setStreamConnected(false);
    };
  },[symbol,frame]);
  useEffect(()=>{
    scannerStartedRef.current=false;
    let cancelled=false, running=false;
    const runScan=async()=>{
      const current=tickerRef.current;
      if(!current.length||running)return;
      running=true;
      setScannerBusy(true);
      setScannerError('');
      try{
        const scan=await scanMarkets(current,{limit:40,mode:scannerMode});
        const results=scan.results;
        if(!cancelled){
          setScanStats(scan.stats);
          const confirmedResults=results.filter(item=>item.status==='STRONG'||item.status==='MODERATE'||item.status==='SCALP');
          setEarlySetups(results.filter(item=>item.status==='EARLY'));
          setPotentialSetups(results.filter(item=>item.status==='POTENTIAL'));
          setScannerTrades(existing=>{
            const next={...existing};
            confirmedResults.forEach(item=>{
              if(next[item.symbol])return;
              const key='tradeai-scanner-last-signal-'+item.symbol;
              if(localStorage.getItem(key)===item.side)return;
              next[item.symbol]={...item,analysisVersion:2,id:Date.now()+'-'+item.symbol,status:'ACTIVE',openedAt:new Date().toISOString()};
              notifyTradeOpen(next[item.symbol],'Automatic market scanner');
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
    const interval=setInterval(runScan,45000);
    return ()=>{cancelled=true;clearInterval(first);clearInterval(interval)};
  },[scannerMode]);
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
          // Allow a fresh setup in the same direction after this scanner trade closes.
          localStorage.removeItem('tradeai-scanner-last-signal-'+tradeSymbol);
          changed=true;
        }
      });
      if(changed)localStorage.setItem('tradeai-scanner-trades',JSON.stringify(next));
      return changed?next:current;
    });
  },[tickers]);
  const dataReady=loadedKey===symbol+'|'+frame;
  const ticker=tickers.find(x=>x.symbol===symbol),closes=dataReady?bars.map(x=>x.close):[],last=liveStreamPrice||Number(ticker?.lastPrice)||closes.at(-1)||0;
  const ind=useMemo(()=>closes.length>30?{e9:ema(closes.slice(-60),9),e21:ema(closes.slice(-80),21),e50:ema(closes.slice(-120),50),rsi:rsi(closes)}:null,[bars]);
  useEffect(()=>{
    let cancelled=false, running=false;
    const checkConsensus=async()=>{
      if(running||!symbol)return;
      running=true;
      try{
        const frames=await Promise.all(['5m','15m','1h'].map(async interval=>{
          const response=await fetch(API+'/fapi/v1/klines?symbol='+symbol+'&interval='+interval+'&limit=100');
          if(!response.ok)throw new Error('Unable to load multi-timeframe data');
          return analyseMarket(await response.json(),last);
        }));
        if(cancelled)return;
        const sides=frames.map(item=>item?.side||'WAIT');
        const aligned=sides[0]!=='WAIT'&&sides.every(side=>side===sides[0]);
        const bias15m=getDirectionalBias(frames[1]);
        const bias1h=getDirectionalBias(frames[2]);
        const higherDirection=bias15m&&bias15m===bias1h?bias15m:null;
        const five=frames[0];
        const fiveSupports=higherDirection==='LONG'?five?.falseEntry==='CLEAR'&&five?.momentum!=='BEARISH'&&five?.trend!=='DOWNTREND':higherDirection==='SHORT'?five?.falseEntry==='CLEAR'&&five?.momentum!=='BULLISH'&&five?.trend!=='UPTREND':false;
        // Flexible moderate setup: remove the extra 15m breakout-confirmation gate,
        // while retaining higher-timeframe alignment and false-entry protection.
        const moderate=!aligned&&!!higherDirection&&frames[1]?.falseEntry==='CLEAR'&&frames[2]?.falseEntry==='CLEAR'&&fiveSupports;
        const side=aligned?sides[0]:moderate?higherDirection:'WAIT';
        const earlyLongCount=frames.filter(item=>item?.earlySide==='LONG').length;
        const earlyShortCount=frames.filter(item=>item?.earlySide==='SHORT').length;
        const earlySide=side==='WAIT'?(earlyLongCount>=2?'LONG':earlyShortCount>=2?'SHORT':null):null;
        const signalTier=aligned?'STRONG':moderate?'MODERATE':earlySide?'EARLY':'WAIT';
        const reasons=[];
        if(!aligned)reasons.push('5m, 15m and 1h do not all confirm the same direction');
        frames.forEach((item,index)=>{
          if(item?.reasons?.length&&sides[index]==='WAIT')reasons.push(['5m','15m','1h'][index]+': '+item.reasons[0]);
        });
        const representative=frames[1]||frames[0]||null;
        setConsensus({
          symbol,
          analysis:representative?{
            ...representative,
            side,
            earlySide,
            score:Math.round(frames.reduce((sum,item)=>sum+(item?.score||0),0)/3),
            trend:frames[2]?.trend||'MIXED',
            momentum:frames[0]?.momentum||'WEAK / MIXED',
            confirmation:aligned?'STRONG · 3/3':moderate?'MODERATE · 15m + 1h':'WAITING',
            signalTier,
            consolidation:frames.some(item=>item?.consolidation==='YES')?'YES':'NO',
            falseEntry:frames.some(item=>item?.falseEntry==='BLOCKED')?'BLOCKED':'CLEAR',
            reasons
          }:null
        });
      }catch{
        if(!cancelled)setConsensus({symbol,analysis:null});
      }finally{running=false}
    };
    checkConsensus();
    const interval=setInterval(checkConsensus,20000);
    return ()=>{cancelled=true;clearInterval(interval)};
  },[symbol,last]);
  const analysis=consensus?.symbol===symbol?consensus.analysis:null;
  const signal=analysis?.side||'WAIT';
  const signalDisplay=signal==='WAIT'&&analysis?.earlySide?'EARLY '+analysis.earlySide:signal!=='WAIT'&&analysis?.signalTier==='MODERATE'?'MODERATE '+signal:signal!=='WAIT'&&analysis?.signalTier==='STRONG'?'STRONG '+signal:signal;
  const score=analysis?.score||0;
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
      const trade=makeTrade(signal,symbol,frame,last,bars);
      if(trade)notifyTradeOpen(trade,'Main signal analysis');
      return trade?{...current,[symbol]:trade}:current;
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
      <div className="side-label">WORKSPACE</div>
      <button className={'nav '+(activeSection==='overview'?'active':'')} onClick={()=>navigateTo('overview')}><CandlestickChart/> Market overview</button>
      <button className={'nav '+(activeSection==='scanner'?'active':'')} onClick={()=>navigateTo('scanner')}><Crosshair/> Signal scanner <i>LIVE</i></button>
      <button className={'nav '+(activeSection==='watchlist'?'active':'')} onClick={()=>navigateTo('watchlist')}><Star/> Watchlist</button>
      <button className={'nav '+(activeSection==='strategy'?'active':'')} onClick={()=>navigateTo('strategy')}><Layers3/> Strategy lab</button>
      <div className="side-label second">MARKETS</div><div className="watch-head">Your watchlist <span>★</span></div>
      {WATCH.map(s=><button className={'watch-row '+(s===symbol?'chosen':'')} onClick={()=>setSymbol(s)} key={s}><CryptoIcon symbol={s} size={27}/><span>{s.replace('USDT','')}<small>USDT Perpetual</small></span></button>)}
      <div className="sidebar-bottom"><div className="secure"><ShieldCheck/><span>Read-only market data<small>No exchange keys connected</small></span></div><small className="version">TRADE AI · EARLY ACCESS</small></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="crumb">Workspace <span>/</span> <b>{sectionNames[activeSection]}</b></div><div className="top-actions"><div className="live-pill"><i/> BINANCE FUTURES · {streamConnected?"STREAM LIVE":"RECONNECTING"}</div><button className={'icon-btn notification-btn '+(notificationPermission==='granted'?'notifications-on':'')} onClick={enableNotifications} title={notificationPermission==='granted'?'Trade notifications enabled':'Enable trade notifications'} aria-label="Enable trade notifications"><Bell/></button><div className="avatar">T</div></div></header>
      <section className="welcome"><div><div className="eyebrow"><span/> LIVE MARKET TERMINAL</div><h1>Market <em>overview</em></h1><p>Track the futures market. Find structure. Plan your next move.</p></div><button className="refresh" onClick={load}><RefreshCw/> Refresh data</button></section>
      <section className="market-strip"><div className="strip-label">SELECTED MARKET</div><div className="pair"><CryptoIcon symbol={symbol} size={31}/><div><b>{symbol.replace('USDT','')} <span>/ USDT</span></b><small>USDT-M PERPETUAL</small></div><span className="perp">PERP</span></div><div className="price-block"><small>LAST PRICE</small><b>{last?fmt(last):'—'}</b></div><div className="price-block"><small>24H CHANGE</small><b className={+(ticker?.priceChangePercent||0)>=0?'green':'red'}>{ticker?(+ticker.priceChangePercent>=0?'+':'')+(+ticker.priceChangePercent).toFixed(2)+'%':'—'}</b></div><div className="price-block hide-mobile"><small>24H HIGH</small><b>{ticker?fmt(ticker.highPrice):'—'}</b></div><div className="price-block hide-mobile"><small>24H VOLUME</small><b>{ticker?(ticker.quoteVolume/1e6).toFixed(1)+'M':'—'}</b></div></section>
      <div className="grid">
        <section className="panel chart-panel"><div className="panel-head"><div><h2><CandlestickChart/> Price action</h2><small>Live Binance Futures candlesticks · hover for OHLC</small></div><div className="frame-select">{FRAMES.map(f=><button key={f} className={frame===f?'selected':''} onClick={()=>setFrame(f)}>{f}</button>)}</div></div>
          <div className="chart-legend"><span><i className="dot up"/> Bullish</span><span><i className="dot down"/> Bearish</span><span className="chart-note">LIVE PRICE · RIGHT SCALE</span></div>
          {bars.length>0?<PriceChart bars={bars} livePrice={last} symbol={symbol} frame={frame}/>:<div className="empty-chart">{busy?'Loading live candles…':'No chart data available'}</div>}
          <div className="chart-footer"><span><i className="pulse"/> {busy?'Updating market data':'Market data connected'}</span><span>Updated {updated||'—'}</span></div>{error&&<div className="error">{error}</div>}
        </section>
        <section className="panel signal-panel"><div className="panel-head"><div><h2><Zap/> AI signal analysis</h2><small>Shared 5m + 15m + 1h confirmation · same rules as scanner</small></div><span className="beta">BETA</span></div><div className={'signal-box '+(signalDisplay.startsWith('EARLY')?'wait':signal.toLowerCase())}><div className="signal-top"><span>MARKET BIAS</span><span className="signal-dot"/></div><div className="signal-word">{signalDisplay}</div><p>{signalDisplay.startsWith('EARLY')?'Directional setup forming. Watch only — full entry confirmation is still missing.':signal==='WAIT'?(analysis?.reasons?.[0]||'Waiting for matching 5m, 15m and 1h confirmation.'):signal==='LONG'?(analysis?.signalTier==='MODERATE'?'15m and 1h confirm LONG; 5m supports direction.':'All three timeframes confirm LONG.'):(analysis?.signalTier==='MODERATE'?'15m and 1h confirm SHORT; 5m supports direction.':'All three timeframes confirm SHORT.')}</p></div>{analysis&&<div className="analysis-checks"><div><span>Trend direction</span><b className={analysis.trend==='UPTREND'?'green':analysis.trend==='DOWNTREND'?'red':'neutral'}>{analysis.trend}</b></div><div><span>Momentum strength</span><b>{analysis.momentum}</b></div><div><span>Entry confirmation</span><b className={analysis.confirmation==='CONFIRMED'?'green':'neutral'}>{analysis.confirmation}</b></div><div><span>Consolidation</span><b className={analysis.consolidation==='YES'?'red':'green'}>{analysis.consolidation}</b></div><div><span>False-entry filter</span><b className={analysis.falseEntry==='CLEAR'?'green':'red'}>{analysis.falseEntry}</b></div><div><span>Decision</span><b className={signal==='WAIT'?'neutral':signal==='LONG'?'green':'red'}>{signal==='WAIT'?(analysis.earlySide?'EARLY '+analysis.earlySide+' · confirmation pending':'WAIT · '+analysis.reasons[0]):signal}</b></div></div>}{signalConflict&&<div className="trade-warning"><b>⚠ SIGNAL CONFLICT</b><span>Active {displayTrade.side} trade, but the latest market bias is {signal}. Review the position; no automatic action is taken.</span></div>}<div className="confidence"><div><span>Confluence score</span><b>{score||'—'}<small>/100</small></b></div><div className="meter"><i style={{width:score+'%'}}/></div><small className="disclaimer">Heuristic score — not a probability of profit.</small></div><div className="levels"><div><span>{displayTrade?'ACTIVE '+displayTrade.side+' · '+displayTrade.symbol:'Selected market entry'}</span><b>{displayTrade?fmt(displayTrade.entry):(last?fmt(last):'—')}</b></div><div><span>Live P/L · {displayTrade?'since entry':'no active position'}</span><b className={tradePnl>=0?'green':'red'}>{displayTrade?(tradePnl>=0?'+':'')+tradePnl.toFixed(2)+'%':'—'}</b></div><div><span>Stop loss · {displayTrade?.stopMethod||'ATR + swing structure'}</span><b className="red">{displayTrade?fmt(displayTrade.sl):'Await confirmation'}</b></div><div><span>Risk : Reward · TP1 / TP2 / TP3</span><b>{displayTrade?'1:1.5 / 1:2 / 1:3':'Await confirmation'}</b></div><div><span>Take profit 1 / 2 / 3</span><b className="green">{displayTrade?[displayTrade.tp1,displayTrade.tp2,displayTrade.tp3].map(fmt).join(' / '):'Await confirmation'}</b></div><div><span>Trade status · ${activeTradeCount} active across coins</span><b>{displayTrade?'ACTIVE · '+displayTrade.frame:'No active trade for this coin'}</b></div></div><div className="signal-foot"><ShieldCheck/> No orders are placed. Analysis only.</div></section>
        <section className="panel indicators"><div className="panel-head"><div><h2><Gauge/> Technical indicators</h2><small>Based on the same multi-timeframe confirmation</small></div></div><div className="indicator-grid"><div><small>RSI (14)</small><b>{ind?ind.rsi.toFixed(1):'—'}</b><span className={ind?(ind.rsi>70?'red':ind.rsi<30?'green':'neutral'):'neutral'}>{ind?(ind.rsi>70?'Overbought':ind.rsi<30?'Oversold':'Neutral'):'Waiting for data'}</span></div><div><small>EMA 9</small><b>{ind?fmt(ind.e9):'—'}</b><span>Short-term trend</span></div><div><small>EMA 21</small><b>{ind?fmt(ind.e21):'—'}</b><span>Trend direction</span></div><div><small>EMA 50</small><b>{ind?fmt(ind.e50):'—'}</b><span>Market structure</span></div></div></section>
        <section ref={scannerSectionRef} className="panel scanner-panel"><div className="panel-head"><div><h2><Zap/> Automatic market scanner</h2><small>{scannerMode==='scalp'?'1m + 5m + 15m · short-term scalp setups':'Top 40 USDT pairs · 5m + 15m + 1h setups'}</small></div><div className="scanner-controls"><div className="mode-toggle"><button className={scannerMode==='normal'?'selected':''} onClick={()=>setScannerMode('normal')}>NORMAL</button><button className={scannerMode==='scalp'?'selected':''} onClick={()=>setScannerMode('scalp')}>SCALP</button></div><label htmlFor="leverage-select">LEVERAGE</label><select id="leverage-select" value={leverage} onChange={e=>setLeverage(e.target.value)}>{[1,2,3,5,10,20,50,100,125].map(x=><option key={x} value={x}>{x}x</option>)}</select><span className="beta">{scannerBusy?'SCANNING':'AUTO SCAN'}</span></div></div>
          <div className="scanner-meta"><span>{scannerBusy?'Checking market setups…':Object.keys(scannerTrades).length+' active setups'}</span><span>Updated {scanUpdated||'—'} · refreshes every 45s</span></div>{scanStats&&<div className="scanner-meta"><span>DIAGNOSTICS · {scanStats.analysed}/{scanStats.attempted} markets analysed · {scanStats.dataErrors} data errors</span><span>{scannerMode==='scalp'?`Scalp ${scanStats.scalp||0} · Scalp watch ${scanStats.scalpWatch||0}`:`Strong ${scanStats.strong} · Moderate ${scanStats.moderate} · Early ${scanStats.early} · Potential ${scanStats.potential}`}</span></div>}
          {scannerError&&<div className="error">{scannerError}</div>}
          {Object.keys(scannerTrades).length>0?<div className="scanner-list">{Object.values(scannerTrades).map(item=><button className="scanner-row scanner-trade-row" key={item.id} onClick={()=>setSymbol(item.symbol)}><span className="scanner-pair"><CryptoIcon symbol={item.symbol} size={27}/><span>{item.symbol.replace('USDT','')}<small>USDT PERP</small></span></span><b className={item.side==='LONG'?'green':'red'}>{item.mode==='scalp'?'SCALP':'SETUP'} {item.side}</b><span className="scanner-score">Score <b>{item.score}/100</b></span><span className="scanner-price">Entry {fmt(item.entry)}</span><span className="scanner-confirm">{leverage}x leverage</span><span className="scanner-levels"><i>SL {fmt(item.sl)}</i><i>TP1 {fmt(item.tp1)}</i><i>TP2 {fmt(item.tp2)}</i><i>TP3 {fmt(item.tp3)}</i><i>R:R 1:1.5 · 1:2 · 1:3</i></span><span className="scanner-margin-roi"><i>Est. margin impact at {leverage}x</i><b className="red">SL {marginReturn(item.entry,item.sl,item.side,leverage).toFixed(1)}%</b><b className="green">TP1 +{marginReturn(item.entry,item.tp1,item.side,leverage).toFixed(1)}%</b><b className="green">TP2 +{marginReturn(item.entry,item.tp2,item.side,leverage).toFixed(1)}%</b><b className="green">TP3 +{marginReturn(item.entry,item.tp3,item.side,leverage).toFixed(1)}%</b></span></button>)}</div>:<div className="scanner-empty">{scannerBusy?'Scanning the highest-volume contracts. This may take a little while.':'No active scanner setups. New confirmed setups will appear here.'}</div>}
          {potentialSetups.length>0&&<><div className="scanner-meta"><b>POTENTIAL SETUPS · WATCH ONLY</b><span>15m + 1h directional clues · entry not confirmed</span></div><div className="scanner-list">{potentialSetups.map(item=><button className="scanner-row scanner-trade-row" key={'potential-'+item.symbol} onClick={()=>setSymbol(item.symbol)}><span className="scanner-pair"><CryptoIcon symbol={item.symbol} size={27}/><span>{item.symbol.replace('USDT','')}<small>USDT PERP</small></span></span><b className={item.side==='LONG'?'green':'red'}>POTENTIAL {item.side}</b><span className="scanner-score">Score <b>{item.score}/100</b></span><span className="scanner-price">Watch {fmt(item.entry)}</span><span className="scanner-confirm">NOT CONFIRMED</span><span className="scanner-levels"><i>Potential SL {fmt(item.sl)}</i><i>Potential TP1 {fmt(item.tp1)}</i><i>Potential TP2 {fmt(item.tp2)}</i><i>Potential TP3 {fmt(item.tp3)}</i></span><span className="scanner-margin-roi"><i>Checks still missing</i>{(item.missing?.length?item.missing:['Waiting for entry confirmation']).slice(0,5).map((reason,index)=><b key={index}>{reason}</b>)}</span></button>)}</div></>}
          {earlySetups.length>0&&<><div className="scanner-meta"><b>EARLY SETUPS · WATCH ONLY</b><span>Awaiting full entry confirmation · not active trades</span></div><div className="scanner-list">{earlySetups.map(item=><button className="scanner-row scanner-trade-row" key={'early-'+item.symbol} onClick={()=>setSymbol(item.symbol)}><span className="scanner-pair"><CryptoIcon symbol={item.symbol} size={27}/><span>{item.symbol.replace('USDT','')}<small>USDT PERP</small></span></span><b className={item.side==='LONG'?'green':'red'}>EARLY {item.side}</b><span className="scanner-score">Score <b>{item.score}/100</b></span><span className="scanner-price">Watch {fmt(item.entry)}</span><span className="scanner-confirm">NOT CONFIRMED</span><span className="scanner-levels"><i>Potential SL {fmt(item.sl)}</i><i>Potential TP1 {fmt(item.tp1)}</i><i>Potential TP2 {fmt(item.tp2)}</i><i>Potential TP3 {fmt(item.tp3)}</i></span><span className="scanner-margin-roi"><i>What is missing · {item.missing?.length||0} checks</i>{(item.missing?.length?item.missing:['Waiting for full timeframe agreement']).map((reason,index)=><b key={index}>{reason}</b>)}</span></button>)}</div></>}
          {earlySetups.length===0&&<div className="scanner-empty early-empty">No early directional candidates yet. The scanner will list watch-only setups when at least 2 of 3 timeframes show the same directional bias.</div>}
          <div className="scanner-foot">Scalp targets are shorter and may be consumed by fees, spread and slippage. Estimated margin P/L = market-price move × selected leverage, before fees and funding; actual results vary with margin mode and exchange rules. {Number(leverage)>=20?'⚠ High leverage: even a small adverse move can cause a large loss or liquidation.':'Use low leverage and check liquidation price on your exchange.'} These estimates do not change the market-based levels or place orders.</div>
        </section>
        <section ref={watchSectionRef} className="panel watch-panel"><div className="panel-head"><div><h2><TrendingUp/> Market watch</h2><small>Top 50 USDT perpetual pairs · 24h volume ranking</small></div><div className="searchbox"><Search/><input placeholder="Search any pair" value={query} onChange={e=>setQuery(e.target.value)}/></div></div><div className="table"><div className="table-row table-head"><span>CONTRACT</span><span>LAST PRICE</span><span>24H CHANGE</span></div>{filtered.map(t=><button className="table-row" key={t.symbol} onClick={()=>setSymbol(t.symbol)}><span className="table-coin"><CryptoIcon symbol={t.symbol} size={23}/><span>{t.symbol.replace('USDT','')} <small>USDT</small></span></span><b>{fmt(t.lastPrice)}</b><strong className={+t.priceChangePercent>=0?'green':'red'}>{+t.priceChangePercent>=0?'+':''}{(+t.priceChangePercent).toFixed(2)}%</strong></button>)}</div></section>
      </div>
      <section ref={strategySectionRef} className="panel strategy-panel">
        <div className="panel-head"><div><h2><Layers3/> Strategy lab</h2><small>Understand how TRADE AI evaluates a possible futures setup</small></div><span className="beta">RULE-BASED</span></div>
        <div className="strategy-grid">
          <article><b>01 · Direction</b><p>EMA 9, EMA 21 and EMA 50 help classify the market as an uptrend, downtrend or mixed.</p></article>
          <article><b>02 · Momentum</b><p>RSI and recent candle movement check whether bullish or bearish momentum is supporting the setup.</p></article>
          <article><b>03 · Entry confirmation</b><p>A completed-candle breakout, candle body and relative volume are checked before a confirmed entry.</p></article>
          <article><b>04 · Risk management</b><p>Stop loss uses ATR and recent swing structure. Targets are planned at 1.5R, 2R and 3R.</p></article>
          <article><b>05 · Early setup watch</b><p>Early LONG and SHORT candidates are shown separately while full confirmation is still pending. They are watch-only, not confirmed trades.</p></article>
          <article><b>06 · Multi-timeframe filter</b><p>The scanner compares 5m, 15m and 1h conditions. Mixed or weak conditions can remain WAIT.</p></article>
        </div>
        <div className="strategy-note"><ShieldCheck/><span>TRADE AI uses technical rules and public market data. Scores are not win probabilities, and this tool does not place orders. Always verify levels and manage risk yourself.</span></div>
      </section>
      <footer>TRADE AI <span>·</span> Binance public Futures market data <span>·</span> Educational use only. Not financial advice.</footer>
    </main>
  </div>;
}