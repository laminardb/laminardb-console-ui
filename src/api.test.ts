// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError, api, isOperationUuid, newOperationId, normalizeBaseUrl, normalizeTopologyOperation,
  normalizeTopologyStatus, parseEngineJson, saveConnectionConfig, topologyAdoptionBody,
} from './api';

const ENGINE_SHA = 'bd8f85e82ac3c23a5c3f4acc3500e20e79e15a56';

function json(body: string | object, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe(`LaminarDB HTTP contract at ${ENGINE_SHA}`, () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('preserves unquoted Rust u64 values outside the JavaScript safe range', () => {
    expect(parseEngineJson('{"id":18446744073709551615,"safe":42}')).toEqual({
      id: '18446744073709551615',
      safe: 42,
    });
  });

  it('treats stopped health/readiness 503s as a reachable authenticated server', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith('/health')) {
        expect(headers.has('Authorization')).toBe(false);
        return json({ status: 'unhealthy', version: '0.32.0', pipeline_state: 'Stopped' }, 503);
      }
      if (url.endsWith('/ready')) {
        expect(headers.has('Authorization')).toBe(false);
        return json({ error: 'pipeline is Stopped, not Running' }, 503);
      }
      expect(url).toBe('http://localhost:8080/api/v1/pipeline/status');
      expect(headers.get('Authorization')).toBe('Bearer console-secret');
      return json({ pipeline_state: 'Stopped' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.probeConnection({
      baseUrl: 'http://localhost:8080/',
      token: ' console-secret ',
    });

    expect(result.health_http_status).toBe(503);
    expect(result.health.pipeline_state).toBe('Stopped');
    expect(result.readiness).toMatchObject({ ready: false, http_status: 503 });
    expect(result.control_plane_authenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not mistake public health success for control-plane authentication', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({ status: 'healthy', version: '0.32.0', pipeline_state: 'Running' });
      if (url.endsWith('/ready')) return json({ status: 'ready', version: '0.32.0', pipeline_state: 'Running' });
      return json({ error: 'unauthorized' }, 401);
    }));

    await expect(api.probeConnection({ baseUrl: 'http://localhost:8080', token: 'wrong' }))
      .rejects.toMatchObject({ name: ApiError.name, status: 401 });
  });

  it('retains a structured failed checkpoint returned with HTTP 500', async () => {
    saveConnectionConfig('http://localhost:8080', 'secret');
    vi.stubGlobal('fetch', vi.fn(async () => json(`{
      "success":false,
      "checkpoint_id":9007199254740993,
      "epoch":18446744073709551615,
      "duration_ms":17,
      "error":"barrier timed out",
      "failure_disposition":"requires_recovery"
    }`, 500)));

    await expect(api.triggerCheckpoint()).resolves.toEqual({
      success: false,
      checkpoint_id: '9007199254740993',
      epoch: '18446744073709551615',
      duration_ms: '17',
      error: 'barrier timed out',
      failure_disposition: 'requires_recovery',
    });
  });

  it('normalizes assignment and participant node IDs without rounding', async () => {
    saveConnectionConfig('http://localhost:8080', '');
    vi.stubGlobal('fetch', vi.fn(async () => json(`{
      "version":18446744073709551615,
      "partitioning_abi_version":2,
      "vnodes":{"0":9007199254740993,"1":7},
      "participants":[{"node_id":9007199254740993,"boot_incarnation":"boot-a"}],
      "updated_at_ms":1787443200000,
      "draining":false,
      "drain_transition":null
    }`)));

    const assignment = await api.getClusterVnodes();
    expect(assignment.version).toBe('18446744073709551615');
    expect(assignment.vnodes).toEqual({ '0': '9007199254740993', '1': '7' });
    expect(assignment.participants[0].node_id).toBe('9007199254740993');
  });

  it('normalizes process-local cluster subscription output health losslessly', async () => {
    saveConnectionConfig('http://localhost:8080', '');
    vi.stubGlobal('fetch', vi.fn(async () => json(`{
      "mode":"cluster",
      "node_id":"node-a",
      "pipeline_state":"Running",
      "subscription_output":{
        "active_readers":2,
        "pending_bytes":18446744073709551615,
        "retained_bytes":1024,
        "orphan_bytes":0,
        "open_failures":1,
        "segment_write_failures":0,
        "manifest_failures":0,
        "integrity_failures":0,
        "stale_writer_rejections":0,
        "sequence_gaps":0,
        "lag_disconnects":3
      }
    }`)));

    await expect(api.getClusterStatus()).resolves.toEqual({
      mode: 'cluster',
      node_id: 'node-a',
      pipeline_state: 'Running',
      subscription_output: {
        active_readers: '2',
        pending_bytes: '18446744073709551615',
        retained_bytes: '1024',
        orphan_bytes: '0',
        open_failures: '1',
        segment_write_failures: '0',
        manifest_failures: '0',
        integrity_failures: '0',
        stale_writer_rejections: '0',
        sequence_gaps: '0',
        lag_disconnects: '3',
      },
    });
  });

  it('builds only the pinned /ws/{name} endpoint with query token and AS OF epoch', () => {
    saveConnectionConfig('https://db.example.test/control/', 'token value');
    expect(api.getSubscriptionUrl('orders/eu', '42')).toBe(
      'wss://db.example.test/control/ws/orders%2Feu?token=token+value&as_of_epoch=42',
    );
    expect(() => api.getSubscriptionUrl('orders', '18446744073709551616')).toThrow(/u64 range/);
  });

  it('fails closed on a response that drifts from the Rust catalog shape', async () => {
    saveConnectionConfig('http://localhost:8080', '');
    vi.stubGlobal('fetch', vi.fn(async () => json({ name: 'not-an-array' })));

    await expect(api.listSources()).rejects.toMatchObject({
      name: 'ProtocolError',
      message: 'sources response is not a JSON array.',
    });
  });

  it('normalizes connector schema capabilities and tolerates their absence on older servers', async () => {
    saveConnectionConfig('http://localhost:8080', '');
    vi.stubGlobal('fetch', vi.fn(async () => json({
      sources: [{
        schema_capabilities: {
          discovery: 'metadata', metadata_formats: [], built_in_formats: [],
          query_derived: false, bounded_sampling: false, preparation: 'none',
        },
        name: 'postgres-cdc', display_name: 'PostgreSQL CDC', version: '0.32.0',
        is_source: true, is_sink: false,
        config_keys: [{ key: 'host', description: 'PostgreSQL host address', required: true, default: null }],
      }],
      sinks: [{
        name: 'legacy', display_name: 'Legacy', version: '0.32.0', is_source: false, is_sink: true, config_keys: [],
      }],
    })));

    const connectors = await api.listConnectors();
    expect(connectors.sources[0].schema_capabilities).toEqual({
      discovery: 'metadata', metadata_formats: [], built_in_formats: [],
      query_derived: false, bounded_sampling: false, preparation: 'none',
    });
    expect(connectors.sinks[0].schema_capabilities).toBeNull();
  });

  it('lists startup-bound process functions', async () => {
    saveConnectionConfig('http://localhost:8080', '');
    vi.stubGlobal('fetch', vi.fn(async () => json([{
      output: 'activity', source: 'events', function_id: 'account-activity', pipeline_state_id: 'acct-v1',
      descriptor_version: 1, implementation_digest: 'sha256:abc', runtime: 'remote_python',
    }])));
    await expect(api.listProcessFunctions()).resolves.toEqual([{
      output: 'activity', source: 'events', function_id: 'account-activity', pipeline_state_id: 'acct-v1',
      descriptor_version: 1, implementation_digest: 'sha256:abc', runtime: 'remote_python',
    }]);
  });

  it('accepts a 202 SQL topology receipt instead of treating it as applied DDL', async () => {
    saveConnectionConfig('http://localhost:8080', '');
    vi.stubGlobal('fetch', vi.fn(async () => json(`{
      "result_type":"TOPOLOGY MIGRATION",
      "object_name":"hot_devices",
      "topology_operation":{
        "operation_id":"6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d",
        "plan":{"sha256":"aa","encoded_len":512},
        "admitted_by":{"owner":{"node_id":9007199254740993,"boot_id":"0b8f3f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b","process_term":3},"fencing_token":7},
        "admitted_sequence":41,
        "status_sequence":41,
        "state":{"phase":"planned"}
      }
    }`, 202)));

    const result = await api.executeSql('CREATE STREAM hot_devices AS SELECT 1');
    expect(result.result_type).toBe('TOPOLOGY MIGRATION');
    expect(result.topology_operation).toMatchObject({
      operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d',
      status_sequence: '41',
      state: { phase: 'planned' },
      commit: null,
      activation: null,
    });
    // Deep evidence stays lossless for inspection.
    expect((result.topology_operation?.raw.admitted_by as { owner: { node_id: string } }).owner.node_id).toBe('9007199254740993');
  });

  it('normalizes every admission phase, including aborted reasons, commits and Release', () => {
    for (const phase of ['planned', 'preparing', 'quiescing', 'cut_prepared', 'committed', 'activating', 'active']) {
      expect(normalizeTopologyOperation({
        operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d', plan: { sha256: 'aa', encoded_len: 1 },
        admitted_sequence: 1, status_sequence: 2, state: { phase },
      }).state).toEqual({ phase });
    }
    const aborted = normalizeTopologyOperation({
      operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d', plan: { sha256: 'aa', encoded_len: 1 },
      admitted_sequence: 1, status_sequence: 2, state: { phase: 'aborted', reason: 'leader_changed' },
    });
    expect(aborted.state).toEqual({ phase: 'aborted', reason: 'leader_changed' });

    const manifest = { version: 1, sha256: 'bb', encoded_len: 900, entry_count: 4 };
    const active = normalizeTopologyOperation({
      operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d', plan: { sha256: 'aa', encoded_len: 1 },
      admitted_sequence: 1, status_sequence: 9, state: { phase: 'active' },
      preparation: { compatibility: { sha256: 'cc', encoded_len: 3 }, certificates: [{}, {}], complete_sequence: 4 },
      commit: {
        protocol_version: 1, operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d', parent_version: 1,
        parent_manifest: manifest, topology_version: 2, manifest, authority_sequence: 6,
      },
      activation: { processes: [{}, {}], installations: [{}, {}], authority_sequence: 7, release: { authority_sequence: 8 } },
    });
    expect(active.commit?.topology_version).toBe('2');
    expect(active.certificates).toBe(2);
    expect(active.activation).toEqual({ processes: 2, installations: 2, released_sequence: '8' });

    expect(() => normalizeTopologyOperation({
      operation_id: '00000000-0000-0000-0000-000000000000', plan: { sha256: 'aa', encoded_len: 1 },
      admitted_sequence: 1, status_sequence: 1, state: { phase: 'planned' },
    })).toThrow(/non-nil/);
    expect(() => normalizeTopologyOperation({
      operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d', plan: { sha256: 'aa', encoded_len: 1 },
      admitted_sequence: 1, status_sequence: 1, state: { phase: 'rolled_back' },
    })).toThrow(/supported variant/);
  });

  it('normalizes cluster topology status across catalog states', () => {
    const manifest = { version: 1, sha256: 'bb', encoded_len: 900, entry_count: 4 };
    expect(normalizeTopologyStatus({
      catalog: { state: 'legacy_sealed', manifest },
      committed_version: null, locally_active_version: null, live_migration: null,
      journal: { retained: 0, capacity: 64 },
    })).toEqual({
      catalog: { state: 'legacy_sealed', manifest: { version: 1, sha256: 'bb', encoded_len: '900', entry_count: 4 } },
      committed_version: null, locally_active_version: null, live_migration: null,
      journal: { retained: 0, capacity: 64 },
    });
    const versioned = normalizeTopologyStatus({
      catalog: {
        state: 'versioned',
        baseline: {
          protocol_version: 1, topology_version: 1, manifest, deployment_id: '2d3c4b5a-6f7e-4d8c-9b0a-1e2f3a4b5c6d',
          operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d', authority_sequence: 3,
        },
      },
      committed_version: 1, locally_active_version: 1, live_migration: 2,
      journal: { retained: 3, capacity: 64 },
    });
    expect(versioned.catalog).toMatchObject({ state: 'versioned', committed: null });
    expect(versioned.live_migration).toBe('2');
  });

  it('sends topology requests as exact deny-unknown-fields JSON with lossless versions', async () => {
    saveConnectionConfig('http://localhost:8080', 'secret');
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return json({
        operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d', plan: { sha256: 'aa', encoded_len: 1 },
        admitted_sequence: 1, status_sequence: 1, state: { phase: 'planned' },
      }, 202);
    }));
    await api.submitClusterTopology({
      operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d',
      expected_parent_version: '9007199254740993',
      statements: ["CREATE STREAM s AS SELECT 'x'"],
    });
    expect(bodies[0]).toBe('{"operation_id":"6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d","expected_parent_version":9007199254740993,"statements":["CREATE STREAM s AS SELECT \'x\'"]}');
    expect(Object.keys(JSON.parse(bodies[0]))).toEqual(['operation_id', 'expected_parent_version', 'statements']);
    expect(topologyAdoptionBody({
      operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d',
      expected_manifest: { version: 1, sha256: 'bb', encoded_len: '900', entry_count: 4 },
      expected_deployment_id: '2d3c4b5a-6f7e-4d8c-9b0a-1e2f3a4b5c6d',
      coordinated_upgrade_complete: true,
    })).toBe('{"operation_id":"6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d","expected_manifest":{"version":1,"sha256":"bb","encoded_len":900,"entry_count":4},"expected_deployment_id":"2d3c4b5a-6f7e-4d8c-9b0a-1e2f3a4b5c6d","coordinated_upgrade_complete":true}');
  });

  it('surfaces topology error codes and the uncertain operation identity from the message', async () => {
    saveConnectionConfig('http://localhost:8080', '');
    vi.stubGlobal('fetch', vi.fn(async () => json({
      error: '[LDB-6064] topology submission timed out; topology operation 6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d may be admitted; query status and retry the same identity',
      code: 'LDB-6064',
    }, 504)));
    await expect(api.executeSql('DROP STREAM s')).rejects.toMatchObject({
      status: 504,
      code: 'LDB-6064',
      operationId: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d',
    });
  });

  it('generates canonical v4 operation identities without a secure context', () => {
    const id = newOperationId();
    expect(isOperationUuid(id)).toBe(true);
    expect(id[14]).toBe('4');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    expect(isOperationUuid('6F1C2C1E-6C2A-4E55-9D9F-0F1D3A2B4C5D')).toBe(false);
  });

  it('validates connection URLs and strips a trailing slash', () => {
    expect(normalizeBaseUrl(' https://db.example.test/ ')).toBe('https://db.example.test');
    expect(() => normalizeBaseUrl('file:///tmp/server')).toThrow(/http:\/\//);
    expect(() => normalizeBaseUrl('https://user:pass@db.example.test')).toThrow(/credentials/);
  });
});
