# Screenshot provenance

`console-lineage.png` is an unedited capture of this Console connected to a real LaminarDB server.
The data is a demonstration fixture, not a benchmark.

| Item | Value |
| --- | --- |
| Console | branch `feat/channel-identity` (based on `de90132`), Vite dev server on `http://127.0.0.1:5173` |
| Server | `laminardb/laminardb-server:0.32.0` (image revision `907d3dfa`) with [`fixture/laminardb.toml`](fixture/laminardb.toml) |
| Data | `apache/kafka:4.1.1` topic `trades`, fed by [`fixture/produce_trades.py`](fixture/produce_trades.py) (seeded random trades for three symbols), plus the built-in `generator` source |
| View | Lineage tab, first node selected, light theme (the Console has no dark theme) |
| Viewport | 1440 × 900 CSS pixels, device scale factor 1, Chrome 155 headless, `--disable-lcd-text` |
| Captured | 2026-10-18 |

To reproduce: start Kafka as `ldb-kafka` on a Docker network, create the `trades` and
`minute-volume` topics, run the server on that network with the fixture file mounted at
`/etc/laminardb/laminardb.toml` and `LAMINAR_CONSOLE_TOKEN` set, pipe `produce_trades.py` into
`kafka-console-producer.sh`, then open the Console, enter `http://127.0.0.1:8080` and the token, and
select the Lineage tab.
