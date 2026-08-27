// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError, api, normalizeBaseUrl, parseEngineJson, saveConnectionConfig,
} from './api';

const ENGINE_SHA = 'f905741c3730bdf4733fd3b0501e45ab31518d89';

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
        return json({ status: 'unhealthy', version: '0.30.0', pipeline_state: 'Stopped' }, 503);
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
      if (url.endsWith('/health')) return json({ status: 'healthy', version: '0.30.0', pipeline_state: 'Running' });
      if (url.endsWith('/ready')) return json({ status: 'ready', version: '0.30.0', pipeline_state: 'Running' });
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

  it('validates connection URLs and strips a trailing slash', () => {
    expect(normalizeBaseUrl(' https://db.example.test/ ')).toBe('https://db.example.test');
    expect(() => normalizeBaseUrl('file:///tmp/server')).toThrow(/http:\/\//);
    expect(() => normalizeBaseUrl('https://user:pass@db.example.test')).toThrow(/credentials/);
  });
});
