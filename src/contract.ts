/**
 * Engine contract reviewed for this console release.
 *
 * Keep this pin in sync with docs/laminardb-v0.30-console-contract.md and the
 * contract fixture tests. A semantic version alone is not a sufficient server
 * compatibility boundary while LaminarDB main is evolving.
 */
export const ENGINE_CONTRACT = Object.freeze({
  version: '0.30.0',
  commit: 'f905741c3730bdf4733fd3b0501e45ab31518d89',
  reviewedOn: '2026-08-27',
  branch: 'feature/cluster-subscriptions',
  baseCommit: 'fb88ca9190bbcd6cf8c25242502facfba723c213',
});

export const ENGINE_CONTRACT_SHORT_SHA = ENGINE_CONTRACT.commit.slice(0, 8);

export const PUBLIC_HTTP_ROUTES = Object.freeze([
  'GET /health',
  'GET /ready',
  'GET /metrics',
]);

export const CONSOLE_HTTP_ROUTES = Object.freeze([
  'GET /api/v1/sources',
  'GET /api/v1/sinks',
  'GET /api/v1/streams',
  'GET /api/v1/streams/{name}',
  'GET /api/v1/mvs',
  'GET /api/v1/connectors',
  'POST /api/v1/checkpoint',
  'POST /api/v1/sql',
  'POST /api/v1/reload',
  'GET /api/v1/graph',
  'GET /api/v1/cluster',
  'GET /api/v1/cluster/nodes',
  'GET /api/v1/cluster/vnodes',
  'GET /api/v1/cluster/leader',
  'GET /api/v1/cluster/checkpoints',
  'POST /api/v1/pipeline/stop',
  'POST /api/v1/pipeline/start',
  'GET /api/v1/pipeline/status',
  'GET /ws/{name}',
]);

export const DIAGNOSTIC_HTTP_ROUTES = Object.freeze([
  'GET /api/v1/cluster/local-evidence',
  'GET /api/v1/cluster/local-checkpoint-barrier-timings',
]);
