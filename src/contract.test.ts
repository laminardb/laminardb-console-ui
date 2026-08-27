import { describe, expect, it } from 'vitest';
import contractDocument from '../docs/laminardb-v0.30-console-contract.md?raw';
import {
  CONSOLE_HTTP_ROUTES,
  DIAGNOSTIC_HTTP_ROUTES,
  ENGINE_CONTRACT,
  PUBLIC_HTTP_ROUTES,
} from './contract';

const ENGINE_SHA = 'f905741c3730bdf4733fd3b0501e45ab31518d89';

describe(`console contract pin ${ENGINE_SHA}`, () => {
  it('pins the reviewed engine identity and registered route matrix', () => {
    expect(ENGINE_CONTRACT).toEqual({
      version: '0.30.0',
      commit: ENGINE_SHA,
      reviewedOn: '2026-08-27',
      branch: 'feature/cluster-subscriptions',
      baseCommit: 'fb88ca9190bbcd6cf8c25242502facfba723c213',
    });
    expect(PUBLIC_HTTP_ROUTES).toEqual([
      'GET /health',
      'GET /ready',
      'GET /metrics',
    ]);
    expect(CONSOLE_HTTP_ROUTES).toEqual([
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
    expect(DIAGNOSTIC_HTTP_ROUTES).toEqual([
      'GET /api/v1/cluster/local-evidence',
      'GET /api/v1/cluster/local-checkpoint-barrier-timings',
    ]);
    expect([...CONSOLE_HTTP_ROUTES, ...DIAGNOSTIC_HTTP_ROUTES]).not.toContain('GET /api/v1/queries');
  });

  it('keeps compatibility documentation pinned to the same immutable review', () => {
    expect(contractDocument).toContain(`Engine commit | \`${ENGINE_SHA}\``);
    expect(contractDocument).toContain('Workspace version | `0.30.0`');
    expect(contractDocument).toContain('Review date | 2026-08-27');
    expect(contractDocument).toContain('Feature base | `fb88ca9190bbcd6cf8c25242502facfba723c213`');
    expect(contractDocument).toContain(`/blob/${ENGINE_SHA}/crates/laminar-server/src/http/router.rs`);
  });
});
