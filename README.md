# LaminarDB Console

An operator and development console for LaminarDB. This branch is reviewed against LaminarDB `0.30.0` at pre-merge engine branch `feature/cluster-subscriptions`, commit `f905741c3730bdf4733fd3b0501e45ab31518d89` (based on `main` commit `fb88ca9190bbcd6cf8c25242502facfba723c213`).

The console provides:

- health, readiness, pipeline lifecycle, cluster membership, leader, and exact vnode-assignment views;
- HTTP SQL execution plus browser WebSocket subscriptions, including checkpoint-committed cluster aggregate streams;
- source, sink, stream, materialized-view, connector, and lineage inspection;
- current checkpoint status, manual checkpoints, managed-state accounting, and checkpoint latency views;
- a raw Prometheus browser and charts built only from metrics registered by the pinned engine;
- lossless handling of Rust `u64` values and Arrow integer/decimal JSON;
- session-scoped bearer credentials, explicit mutation confirmations, secret-aware SQL/config display, keyboard-safe dialogs, reduced-motion support, and accessible status/table/chart summaries.

The complete implementation-derived compatibility record is [docs/laminardb-v0.30-console-contract.md](docs/laminardb-v0.30-console-contract.md). Read it before using this console with a different `0.30.0` build or later engine commit.

## Requirements

- A current Node.js release supported by Vite 8 and npm.
- A LaminarDB server whose HTTP listener is reachable by the browser. The server default is `127.0.0.1:8080`.
- For a separately hosted console, a matching `[server].console_cors_allowed_origins` entry.
- The `[server].console_token`, if the server configures one.

Example server boundary:

```toml
[server]
bind = "127.0.0.1:8080"
console_token = "replace-with-a-secret"
console_cors_allowed_origins = ["http://localhost:5173"]
```

Leaving `console_token` unset makes the control plane unauthenticated; the engine documents that as loopback/development behaviour. Leaving `console_cors_allowed_origins` unset enables its legacy permissive CORS policy.

## Develop

```bash
npm ci
npm run dev
```

Open `http://localhost:5173`, then use Settings to enter the LaminarDB base URL and optional console token. The base URL is persisted locally; the token is held only in browser session storage. Browser WebSocket authentication necessarily places the token in the upgrade query string because the WebSocket API cannot set an Authorization header.

## Verify and build

```bash
npm test
npm run lint
npm run build
npm audit
```

`npm run build` produces static assets in `dist/`. Serve them from any static host whose origin is allowed by the LaminarDB server.

## Important boundaries

- `/health`, `/ready`, and `/metrics` are public server routes. Other console routes are bearer-protected when `console_token` is configured.
- `Stopped` is a reachable server state even though `/health` returns HTTP 503 and `/ready` is not ready.
- Browser subscriptions use only `/ws/{name}`. They accept protocol control frames from the client, not application messages.
- Local `SUBSCRIBE` accepts resolved streams and materialized views and keeps retained history in memory. Cluster `SUBSCRIBE` admits only named, non-windowed managed keyed aggregate streams with planner-certified vnode distribution; MVs and other stream shapes fail closed.
- Cluster delivery becomes visible only after whole-cluster checkpoint commits. Data is ordered only within each output partition; gateway interleaving is not a global, arrival, event-time, or SQL order.
- Cluster `AS OF EPOCH` resumes from every partition's exclusive committed frontier using byte-bounded durable checkpoint segments. It is checkpoint-granular replay—not a named consumer acknowledgement—so a partly consumed interval can be delivered again.
- Cluster WebSocket data carries all four of `stream_generation`, `partition`, `partition_sequence`, and `committed_epoch` (the fields are absent together on local frames); the console uses this durable identity for replay deduplication. Resume tokens are not exposed by the current WebSocket query contract.
- Cluster start/stop peer fan-out is fire-and-forget. Success proves the local operation, not cluster-wide convergence.
- `/api/v1/cluster/checkpoints` reports one current row, not checkpoint history. Manual `RESTORE FROM CHECKPOINT` is not implemented.
- The schema-versioned local cluster diagnostic routes are intentionally outside console CORS and are not rendered by this SPA.
- Connector discovery reports compiled streaming roles and option metadata, not delivery or cluster-admission guarantees.

## Updating the engine pin

Do not update only the version label. Once the engine feature merges, fetch `main`, record the merge SHA, diff it against the feature pin above, and update together:

- `src/contract.ts`;
- `docs/laminardb-v0.30-console-contract.md` (or the next-version contract);
- the SHA-pinned protocol fixture suites.
