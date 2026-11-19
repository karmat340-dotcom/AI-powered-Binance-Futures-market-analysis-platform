# TRADE AI ML backend

This service trains two Random Forest classifiers from Binance USD-M Futures historical candles:
- scalp: 1-minute candles, five-candle forward horizon
- normal: 5-minute candles, six-candle forward horizon

## Local setup
```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python train.py
uvicorn app:app --host 0.0.0.0 --port 8000
```

## Render
Create a Python Web Service from this repository with Root Directory `ml_backend`.
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn app:app --host 0.0.0.0 --port $PORT`

After first deploy, use the Render Shell to run `python train.py`. Training downloads public historical candles and creates `models/model_scalp.joblib` and `models/model_normal.joblib`. The Render filesystem may be ephemeral on free instances, so retrain after a restart/redeploy or attach persistent storage if available.

## API
- `GET /health`
- `GET /predict?symbol=BTCUSDT&mode=scalp`
- `GET /predict?symbol=BTCUSDT&mode=normal`

Predictions are not trade guarantees. Validate the chronological holdout metrics and paper-trade before using real funds. This starter model uses public candle data only and does not model funding, fees, spread, liquidation, or order-book depth.
