import os
from pathlib import Path
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

BASE = Path(__file__).resolve().parent
MODEL_DIR = BASE / "models"
API = "https://fapi.binance.com"
FEATURES = ["ret1", "ret3", "ret5", "ema_gap_9_21", "ema_gap_21_50", "rsi14", "atr_pct", "volume_ratio", "body_ratio", "range_pct", "close_location"]

app = FastAPI(title="TRADE AI Machine Learning API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

def feature_frame(raw):
    cols = ["open_time", "open", "high", "low", "close", "volume"]
    df = pd.DataFrame(raw, columns=["t","o","h","l","c","v","ct","q","n","tb","tq","i"])
    for c in ["o","h","l","c","v"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    close, high, low, op, vol = df.c, df.h, df.l, df.o, df.v
    ema9, ema21, ema50 = close.ewm(span=9, adjust=False).mean(), close.ewm(span=21, adjust=False).mean(), close.ewm(span=50, adjust=False).mean()
    delta = close.diff()
    gain, loss = delta.clip(lower=0).rolling(14).mean(), (-delta.clip(upper=0)).rolling(14).mean()
    rsi = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    prev = close.shift(1)
    tr = pd.concat([(high-low), (high-prev).abs(), (low-prev).abs()], axis=1).max(axis=1)
    atr = tr.rolling(14).mean()
    avgvol = vol.rolling(20).mean()
    rng = (high-low).replace(0, np.nan)
    out = pd.DataFrame({
        "ret1": close.pct_change(), "ret3": close.pct_change(3), "ret5": close.pct_change(5),
        "ema_gap_9_21": (ema9-ema21)/close, "ema_gap_21_50": (ema21-ema50)/close,
        "rsi14": rsi/100, "atr_pct": atr/close, "volume_ratio": vol/avgvol,
        "body_ratio": (close-op).abs()/rng, "range_pct": (high-low)/close,
        "close_location": (close-low)/rng
    })
    return out.replace([np.inf, -np.inf], np.nan)

def get_model(mode):
    path = MODEL_DIR / f"model_{mode}.joblib"
    if not path.exists():
        raise HTTPException(503, f"The {mode} model has not been trained yet. Train it before requesting signals.")
    try:
        return joblib.load(path)
    except Exception as exc:
        raise HTTPException(500, f"Could not load model: {exc}")

@app.get("/health")
def health():
    return {"status": "online", "service": "TRADE AI ML", "models": {m: (MODEL_DIR / f"model_{m}.joblib").exists() for m in ["scalp", "normal"]}}

@app.get("/predict")
def predict(symbol: str = Query("BTCUSDT", pattern=r"^[A-Z0-9]{3,20}USDT$"), mode: str = Query("normal", pattern="^(scalp|normal)$")):
    model = get_model(mode)
    interval = "1m" if mode == "scalp" else "5m"
    try:
        try:
            response = requests.get(f"{API}/fapi/v1/klines", params={"symbol": symbol, "interval": interval, "limit": 180}, timeout=12)
            response.raise_for_status()
            raw = response.json()
            source = "Binance USD-M Futures public candles"
        except requests.RequestException as binance_error:
            # Regional restrictions can return HTTP 451 from Binance. Use Bybit's
            # equivalent linear-perpetual candles so the prediction endpoint remains usable.
            bybit_interval = "1" if interval == "1m" else "5"
            response = requests.get(
                "https://api.bybit.com/v5/market/kline",
                params={"category": "linear", "symbol": symbol, "interval": bybit_interval, "limit": 180},
                timeout=12
            )
            response.raise_for_status()
            payload = response.json()
            if payload.get("retCode") != 0:
                raise RuntimeError(f"Binance unavailable ({binance_error}); Bybit error: {payload.get('retMsg', 'unknown')}")
            interval_ms = 60_000 if interval == "1m" else 300_000
            candles = payload.get("result", {}).get("list", [])
            candles.sort(key=lambda c: int(c[0]))
            raw = [[int(c[0]), c[1], c[2], c[3], c[4], c[5],
                    int(c[0]) + interval_ms - 1, c[6], 0, 0, 0, 0] for c in candles]
            source = "Bybit linear-perpetual public candles (Binance fallback)"
        if not raw:
            raise ValueError("Market-data provider returned no candles")
        # Exclude the still-forming candle from the model input.
        features = feature_frame(raw[:-1]).dropna()
        if features.empty:
            raise ValueError("Not enough completed candle data")
        row = features[FEATURES].iloc[[-1]]
        probabilities = model["model"].predict_proba(row)[0]
        classes = list(model["model"].classes_)
        probs = {str(k): round(float(v), 4) for k, v in zip(classes, probabilities)}
        side = max(probs, key=probs.get)
        confidence = probs[side]
        # Require the model to beat the HOLD class by a meaningful margin.
        if side == "HOLD" or confidence < float(model.get("min_confidence", 0.48)):
            side = "WAIT"
        return {
            "symbol": symbol, "mode": mode, "interval": interval, "side": side,
            "confidence": confidence, "class_probabilities": probs,
            "model_trained_at": model.get("trained_at"),
            "test_metrics": model.get("metrics", {}),
            "candle_time": int(raw[-2][0]), "source": source,
            "note": "Model prediction, not a guaranteed win probability. Confirm risk and execution costs."
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"Prediction failed: {exc}")
