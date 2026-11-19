import React,{useEffect,useMemo,useState} from 'react';
import {Play,Square,Wallet,History,TrendingUp,TrendingDown} from 'lucide-react';

const money=n=>Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const priceFmt=n=>Number(n||0).toLocaleString('en-US',{maximumFractionDigits:Number(n)<1?8:2});
const read=(key,fallback)=>{try{const v=JSON.parse(localStorage.getItem(key));return v??fallback}catch{return fallback}};

export default function DemoTrading({symbol,price,tickers=[]}){
  const [balance,setBalance]=useState(()=>read('tradeai-demo-balance',10000));
  const [positions,setPositions]=useState(()=>read('tradeai-demo-positions',[]));
  const [history,setHistory]=useState(()=>read('tradeai-demo-history',[]));
  const [margin,setMargin]=useState('100');
  const [leverage,setLeverage]=useState('1');
  const [stop,setStop]=useState('');
  const [target,setTarget]=useState('');
  const [notice,setNotice]=useState('');
  const prices=useMemo(()=>Object.fromEntries(tickers.map(t=>[t.symbol,Number(t.lastPrice)])),[tickers]);
  const liveFor=p=>p.symbol===symbol&&price>0?price:(prices[p.symbol]||p.entry);
  const used=positions.reduce((s,p)=>s+p.margin,0);
  const unrealized=positions.reduce((s,p)=>s+pnl(p,liveFor(p)),0);
  function pnl(p,current){return (p.side==='LONG'?current-p.entry:p.entry-current)/p.entry*p.margin*p.leverage}
  useEffect(()=>{localStorage.setItem('tradeai-demo-balance',JSON.stringify(balance))},[balance]);
  useEffect(()=>{localStorage.setItem('tradeai-demo-positions',JSON.stringify(positions))},[positions]);
  useEffect(()=>{localStorage.setItem('tradeai-demo-history',JSON.stringify(history))},[history]);
  useEffect(()=>{
    if(!tickers.length)return;
    setPositions(current=>{
      let changed=false;const keep=[];
      current.forEach(p=>{
        const currentPrice=p.symbol===symbol&&price>0?price:(prices[p.symbol]||0);
        if(!currentPrice){keep.push(p);return}
        const hitStop=p.stop>0&&(p.side==='LONG'?currentPrice<=p.stop:currentPrice>=p.stop);
        const hitTarget=p.target>0&&(p.side==='LONG'?currentPrice>=p.target:currentPrice<=p.target);
        if(hitStop||hitTarget){
          const result=pnl(p,currentPrice);
          setBalance(b=>Math.max(0,b+p.margin+result));
          setHistory(h=>[{...p,exit:currentPrice,pnl:result,closedAt:new Date().toISOString(),reason:hitStop?'STOP LOSS':'TAKE PROFIT'},...h].slice(0,30));
          changed=true;
        }else keep.push(p);
      });
      return changed?keep:current;
    });
  },[tickers,price,symbol]);
  function open(side){
    const m=Number(margin),lev=Number(leverage),entry=Number(price);
    if(!entry||!Number.isFinite(entry)){setNotice('Live price is not ready yet.');return}
    if(!Number.isFinite(m)||m<=0||m>balance){setNotice('Enter a margin amount within your available demo balance.');return}
    if(positions.some(p=>p.symbol===symbol)){setNotice('Only one open demo position per coin is allowed.');return}
    const sl=Number(stop)||0,tp=Number(target)||0;
    if(sl>0&&(side==='LONG'?sl>=entry:sl<=entry)){setNotice('Stop loss must be below entry for LONG and above entry for SHORT.');return}
    if(tp>0&&(side==='LONG'?tp<=entry:tp>=entry)){setNotice('Take profit must be above entry for LONG and below entry for SHORT.');return}
    const p={id:Date.now(),symbol,side,entry,margin:m,leverage:lev,stop:sl,target:tp,openedAt:new Date().toISOString()};
    setBalance(b=>b-m);setPositions(v=>[...v,p]);setNotice('Demo '+side+' position opened at '+priceFmt(entry)+'.');
  }
  function close(p){
    const exit=liveFor(p),result=pnl(p,exit);
    setBalance(b=>Math.max(0,b+p.margin+result));
    setPositions(v=>v.filter(x=>x.id!==p.id));
    setHistory(h=>[{...p,exit,pnl:result,closedAt:new Date().toISOString(),reason:'MANUAL CLOSE'},...h].slice(0,30));
    setNotice(p.symbol+' demo position closed.');
  }
  const equity=balance+used+unrealized;
  return <section className="panel demo-panel">
    <div className="panel-head"><div><h2><Wallet/> Demo trading</h2><small>Practice with virtual USDT · no exchange connection · no real orders</small></div><span className="demo-badge">PAPER MODE</span></div>
    <div className="demo-account">
      <div><small>WALLET BALANCE</small><b>{money(balance)} USDT</b></div>
      <div><small>ACCOUNT EQUITY</small><b>{money(equity)} USDT</b></div>
      <div><small>UNREALIZED P/L</small><b className={unrealized>=0?'green':'red'}>{unrealized>=0?'+':''}{money(unrealized)} USDT</b></div>
      <div><small>USED MARGIN</small><b>{money(used)} USDT</b></div>
    </div>
    <div className="demo-form">
      <div className="demo-form-head"><b>OPEN A POSITION</b><span>{symbol} · LIVE {price?priceFmt(price):'—'}</span></div>
      <label>Margin (USDT)<input type="number" min="1" step="1" value={margin} onChange={e=>setMargin(e.target.value)}/></label>
      <label>Leverage<select value={leverage} onChange={e=>setLeverage(e.target.value)}>{[1,2,3,5,10,20].map(x=><option key={x} value={x}>{x}x</option>)}</select></label>
      <label>Stop loss (optional)<input type="number" min="0" placeholder="Price" value={stop} onChange={e=>setStop(e.target.value)}/></label>
      <label>Take profit (optional)<input type="number" min="0" placeholder="Price" value={target} onChange={e=>setTarget(e.target.value)}/></label>
      <div className="demo-buttons"><button className="demo-long" onClick={()=>open('LONG')}><TrendingUp/> Demo LONG</button><button className="demo-short" onClick={()=>open('SHORT')}><TrendingDown/> Demo SHORT</button></div>
    </div>
    {notice&&<div className="demo-notice">{notice}</div>}
    <div className="demo-subhead"><b>OPEN POSITIONS ({positions.length})</b><span>Mark-to-market P/L</span></div>
    {positions.length?<div className="demo-positions">{positions.map(p=>{const current=liveFor(p),result=pnl(p,current);return <article key={p.id}><div><b>{p.symbol}</b><strong className={p.side==='LONG'?'green':'red'}>{p.side} · {p.leverage}x</strong></div><div><small>Entry / Mark</small><b>{priceFmt(p.entry)} / {priceFmt(current)}</b></div><div><small>Margin</small><b>{money(p.margin)} USDT</b></div><div><small>Unrealized P/L</small><b className={result>=0?'green':'red'}>{result>=0?'+':''}{money(result)} USDT</b></div><div><small>SL / TP</small><b>{p.stop?priceFmt(p.stop):'—'} / {p.target?priceFmt(p.target):'—'}</b></div><button onClick={()=>close(p)}><Square/> Close</button></article>})}</div>:<div className="scanner-empty">No open demo positions. Choose LONG or SHORT to start practising.</div>}
    <div className="demo-subhead"><b><History/> RECENT DEMO HISTORY</b><span>{history.length} closed</span></div>
    {history.length?<div className="demo-history">{history.slice(0,8).map(p=><div key={p.id}><span>{p.symbol} · {p.side} · {p.reason}</span><b className={p.pnl>=0?'green':'red'}>{p.pnl>=0?'+':''}{money(p.pnl)} USDT</b></div>)}</div>:<div className="demo-history-empty">Closed demo trades will appear here.</div>}
    <div className="scanner-foot">Virtual starting balance: 10,000 USDT. P/L is an estimate and excludes trading fees, funding and slippage. Demo mode is separate from live signals and cannot place real trades.</div>
  </section>;
}
