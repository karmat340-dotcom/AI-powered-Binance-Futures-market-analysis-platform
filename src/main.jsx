import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.jsx';
import './style.css';

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('TRADE AI crashed while rendering:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <main style={{minHeight:'100vh',background:'#080d18',color:'#e9eef8',padding:'32px',fontFamily:'Arial,sans-serif'}}>
          <h1 style={{color:'#ff7887'}}>TRADE AI encountered an error</h1>
          <p>The app is no longer showing a blank screen. This error message can identify what needs fixing.</p>
          <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',background:'#111c2c',padding:'16px',borderRadius:'8px',color:'#ffd0d5'}}>{String(this.state.error?.stack || this.state.error)}</pre>
          <button onClick={() => window.location.reload()} style={{padding:'10px 16px',border:0,borderRadius:'6px',cursor:'pointer'}}>Reload app</button>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (root) createRoot(root).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>
);
