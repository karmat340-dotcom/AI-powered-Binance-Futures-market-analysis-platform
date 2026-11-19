import time
from pathlib import Path
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
import requests
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.metrics import accuracy_score, balanced_accuracy_score, classification_report
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline

API = "https://fapi.binance.com"
ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"
FEATURES = ["ret1", "ret3", "ret5", "ema_gap_9_21", "ema_gap_21_50", "rsi14", "atr_pct", "volume_ratio", "body_ratio", "range_pct", "close_location"]
SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT"]

def fetch_history(symbol, interval, limit=8000):
    rows, end_time = [], None
    while len(rows) < limit:
        params = {"symbol": symbol, "interval": interval, "limit": min(1000, limit-len(rows))}
        if end_time is not None:
            params["endTime"] = end_time
        response = requests.get(f"{API}/fapi/v1/klines", params=params, timeout=25)
        response.raise_for_status()
        batch = response.json()
        if not batch:
            break
        rows = batch + rows
        end_time = int(batch[0][0]) - 1
        if len(batch) < params["limit"]:
            break
        time.sleep(0.12)
    return rows[-limit:]

def make_features(raw):
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
    x = pd.DataFrame({
        "ret1": close.pct_change(), "ret3": close.pct_change(3), "ret5": close.pct_change(5),
        "ema_gap_9_21": (ema9-ema21)/close, "ema_gap_21_50": (ema21-ema50)/close,
        "rsi14": rsi/100, "atr_pct": atr/close, "volume_ratio": vol/avgvol,
        "body_ratio": (close-op).abs()/rng, "range_pct": (high-low)/close,
        "close_location": (close-low)/rng
    }).replace([np.inf, -np.inf], np.nan)
    return x

def build_dataset(mode):
    interval, horizon, threshold = ("1m", 5, 0.0020) if mode == "scalp" else ("5m", 6, 0.0035)
    chunks = []
    for symbol in SYMBOLS:
        print(f"Downloading {symbol} {interval} history...", flush=True)
        raw = fetch_history(symbol, interval, 8000)
        # Last candle may still be open; remove it.
        raw = raw[:-1]
        x = make_features(raw)
        closes = pd.Series([float(c[4]) for c in raw])
        forward = closes.shift(-horizon) / closes - 1
        y = np.where(forward > threshold, "LONG", np.where(forward < -threshold, "SHORT", "HOLD"))
        frame = x.copy()
        frame["target"] = y
        frame["symbol"] = symbol
        frame = frame.iloc[:-horizon].dropna(subset=FEATURES)
        chunks.append(frame)
    return pd.concat(chunks, ignore_index=True)

def train(mode):
    data = build_dataset(mode)
    if len(data) < 3000:
        raise RuntimeError(f"Not enough clean training rows: {len(data)}")
    x = data[FEATURES].astype(float)
    y = data.target
    split = int(len(data) * 0.8)
    # Chronological holdout; do not randomly shuffle future observations into training.
    x_train, x_test = x.iloc[:split], x.iloc[split:]
    y_train, y_test = y.iloc[:split], y.iloc[split:]
    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("model", RandomForestClassifier(
            n_estimators=350, max_depth=9, min_samples_leaf=12,
            class_weight="balanced_subsample", n_jobs=-1, random_state=42
        ))
    ])
    pipeline.fit(x_train, y_train)
    pred = pipeline.predict(x_test)
    metrics = {
        "rows": int(len(data)), "train_rows": int(len(x_train)), "test_rows": int(len(x_test)),
        "accuracy": round(float(accuracy_score(y_test, pred)), 4),
        "balanced_accuracy": round(float(balanced_accuracy_score(y_test, pred)), 4),
        "report": classification_report(y_test, pred, output_dict=True, zero_division=0)
    }
    print(mode, metrics, flush=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump({
        "model": pipeline, "trained_at": datetime.now(timezone.utc).isoformat(),
        "metrics": metrics, "min_confidence": 0.48, "symbols": SYMBOLS,
        "interval": "1m" if mode == "scalp" else "5m",
        "horizon_candles": 5 if mode == "scalp" else 6
    }, MODEL_DIR / f"model_{mode}.joblib")
    print(f"Saved {MODEL_DIR / f'model_{mode}.joblib'}", flush=True)

if __name__ == "__main__":
    train("scalp")
    train("normal")
