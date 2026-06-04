# LaminarDB Console

The official administrative and operator web console for LaminarDB. Designed as a systems-grade, high-fidelity single-page application (SPA) to author, observe, and manage streaming SQL pipelines.

## Features

- **Interactive SQL Worksheet**: Author and execute streaming DDL/DML. Support for both snapshot query execution and live real-time subscription tailing over WebSockets.
- **Dependency & Lineage DAG**: Interactive visual topology diagram showing relationships and active streams from Sources to Sinks and Materialized Views.
- **Catalog Schema Browser**: Detailed introspection of catalog metadata including sources, sinks, streams, materialized views, and available ingestion/emission connector options.
- **Cluster & Partition Monitor**: Live node discovery status, coordinator leader lease tracking, rebalance events, and a 256-partition virtual node (vnode) lease assignment heatmap.
- **Performance Telemetry**: Active performance dials for CPU utilization, resident memory (RSS) footprint, real-time event ingestion/emission rates (throughput per second), and coordinator node uptime.
- **Secure Control Plane Access**: Full support for gated REST routes and WebSocket upgrade tokens matching LaminarDB server's authentication protocols.

## Tech Stack & Architecture

- **Core**: React 19, TypeScript, and Vite.
- **Styling**: Systems-grade dark theme matching `laminardb.io` (`#0a0a0a` base, `#111111` card surfaces, solid `#1e1e1e` borders, and high-readability cyan `#00b4d8` highlights). Built without bloating utility CSS frameworks for maximum flexibility and performance.
- **Network**: Communictes directly with the Axum HTTP REST and WebSocket control-plane API exposed by the `laminar-server` node.

## Quick Start

### 1. Prerequisites
Ensure you have Node.js (v18+) and npm installed, and a running LaminarDB coordinator server.

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Development Server
Start the client server locally:
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 4. Build for Production
Generate the static assets bundle under `dist/` ready to be served by any static host:
```bash
npm run build
```

## Configuring Server Connection

Upon opening the console, toggle the **Settings** drawer to configure:
1. **LaminarDB API URL**: The base coordinator bind address (e.g. `http://localhost:8000`).
2. **Console Bearer Token**: The security token configured under `[server].console_token` in your server's `laminardb.toml`.
