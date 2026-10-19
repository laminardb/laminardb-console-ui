import json, random, sys, time
from datetime import datetime, timezone
random.seed(7)
prices = {"AAPL": 189.5, "MSFT": 411.2, "NVDA": 121.4}
while True:
    sym = random.choice(list(prices))
    prices[sym] = round(prices[sym] * (1 + random.uniform(-0.002, 0.002)), 2)
    row = {"symbol": sym, "price": prices[sym], "volume": random.randint(1, 200),
           "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}
    sys.stdout.write(json.dumps(row) + "\n"); sys.stdout.flush()
    time.sleep(0.25)
