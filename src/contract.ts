/**
 * Engine contract reviewed for this console release.
 *
 * Keep this pin in sync with docs/laminardb-v0.32-console-contract.md and the
 * contract fixture tests. A semantic version alone is not a sufficient server
 * compatibility boundary while LaminarDB main is evolving.
 */
export const ENGINE_CONTRACT = Object.freeze({
  version: '0.32.0',
  commit: 'bd8f85e82ac3c23a5c3f4acc3500e20e79e15a56',
  reviewedOn: '2026-10-14',
  branch: 'main',
  /** Merge of the previously pinned feature-branch review (cluster subscriptions, #471). */
  previousReviewMerge: 'e3ad6123',
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
  'GET /api/v1/process-functions',
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
  'GET /api/v1/cluster/topology',
  'POST /api/v1/cluster/topology/operations',
  'POST /api/v1/cluster/topology/adopt',
  'POST /api/v1/cluster/topology/validate',
  'GET /api/v1/cluster/topology/operations/{operation_id}',
  'POST /api/v1/cluster/topology/operations/{operation_id}/prepare',
  'POST /api/v1/pipeline/stop',
  'POST /api/v1/pipeline/start',
  'GET /api/v1/pipeline/status',
  'GET /ws/{name}',
]);

/**
 * Registered console routes this SPA deliberately does not call. Per-node
 * preparation is driven automatically by every node's recovery monitor; the
 * route is a manual re-certification fallback that the engine README omits.
 */
export const UNUSED_CONSOLE_HTTP_ROUTES = Object.freeze([
  'POST /api/v1/cluster/topology/operations/{operation_id}/prepare',
]);

export const DIAGNOSTIC_HTTP_ROUTES = Object.freeze([
  'GET /api/v1/cluster/local-evidence',
  'GET /api/v1/cluster/local-checkpoint-barrier-timings',
]);
