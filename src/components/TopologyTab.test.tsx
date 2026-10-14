// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import axe from 'axe-core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    getConnectionConfig: () => ({ baseUrl: 'http://localhost:8080', token: '' }),
    api: {
      ...original.api,
      getClusterTopology: vi.fn(),
      getClusterNodes: vi.fn().mockResolvedValue([]),
      getClusterVnodes: vi.fn().mockRejectedValue(new Error('not loaded')),
      getMetricsRaw: vi.fn().mockResolvedValue('# TYPE laminardb_placement_owned_vnodes gauge\nlaminardb_placement_owned_vnodes 128\n'),
      validateClusterTopology: vi.fn(),
      submitClusterTopology: vi.fn(),
      getClusterTopologyOperation: vi.fn(),
    },
  };
});

import { ApiError, api } from '../api';
import type { ClusterTopologyStatus, TopologyAdmissionStatus } from '../api';
import TopologyTab from './TopologyTab';

const ENGINE_SHA = 'bd8f85e82ac3c23a5c3f4acc3500e20e79e15a56';
const MANIFEST = { version: 1, sha256: 'a'.repeat(64), encoded_len: '900', entry_count: 4 };
const VERSIONED: ClusterTopologyStatus = {
  catalog: {
    state: 'versioned',
    baseline: {
      protocol_version: 1, topology_version: '1', manifest: MANIFEST,
      deployment_id: '2d3c4b5a-6f7e-4d8c-9b0a-1e2f3a4b5c6d',
      operation_id: '6f1c2c1e-6c2a-4e55-9d9f-0f1d3a2b4c5d', authority_sequence: '3',
    },
    committed: null,
  },
  committed_version: '3',
  locally_active_version: '3',
  live_migration: '3',
  journal: { retained: 5, capacity: 64 },
};

function receipt(operationId: string, phase: TopologyAdmissionStatus['state']): TopologyAdmissionStatus {
  return {
    operation_id: operationId, plan: { sha256: 'b'.repeat(64), encoded_len: '512' },
    admitted_sequence: '7', status_sequence: '7', state: phase, commit: null, activation: null,
    certificates: 0, completed_cut_participants: 0, raw: {},
  };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(api.submitClusterTopology).mockReset();
  vi.mocked(api.getClusterTopologyOperation).mockReset();
  vi.mocked(api.validateClusterTopology).mockReset();
});
afterEach(cleanup);

describe(`topology tab at ${ENGINE_SHA}`, () => {
  it('explains single-node mode when the topology route answers 404', async () => {
    vi.mocked(api.getClusterTopology).mockRejectedValue(new ApiError(404, 'Not Found', 'cluster mode is not enabled'));
    render(<TopologyTab />);
    expect(await screen.findByText(/single-node mode/)).toBeInTheDocument();
  });

  it('shows the owner-map freeze, validates a plan and reuses the identity after an uncertain submit', async () => {
    vi.mocked(api.getClusterTopology).mockResolvedValue(VERSIONED);
    vi.mocked(api.validateClusterTopology).mockResolvedValue({
      validation_format_version: 3, scope: 'local_candidate_plan', deployment_id: VERSIONED.catalog.state === 'versioned' ? VERSIONED.catalog.baseline.deployment_id : '',
      parent_version: '3', target_version: '4', parent_manifest: MANIFEST, target_manifest: { ...MANIFEST, entry_count: 5 },
      environment_sha256: 'c'.repeat(64), compatibility_sha256: 'd'.repeat(64),
      statements: ['CREATE STREAM hot AS SELECT device, COUNT(*) AS n FROM readings GROUP BY device'],
      objects: [{
        name: 'hot', kind: 'stream', catalog_generation: '1', transition: 'add_future_only',
        initialization: 'empty_managed_state_at_cut', definition_sha256: 'e', compatibility_sha256: 'f',
        dependencies: ['readings'], schema_sha256: 'g', managed_state_contract: 'sql_aggregate_v1',
      }],
      requires_processing_pause: true,
      required_before_activation: ['participant_plan_agreement', 'installed_target_release'],
    });
    vi.mocked(api.submitClusterTopology)
      .mockRejectedValueOnce(new ApiError(504, 'Gateway Timeout', '[LDB-6064] topology submission timed out', undefined, { code: 'LDB-6064' }))
      .mockImplementationOnce(async (request) => receipt(request.operation_id, { phase: 'planned' }));
    vi.mocked(api.getClusterTopologyOperation).mockImplementation(async (id) => receipt(id, { phase: 'preparing' }));

    const { container } = render(<TopologyTab />);
    expect(await screen.findByText(/owner map is frozen/)).toBeInTheDocument();
    expect(await screen.findByText('128 vnodes')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Statements \(parent topology v3\)/), {
      target: { value: 'CREATE STREAM hot AS SELECT device, COUNT(*) AS n FROM readings GROUP BY device;' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Validate on this node/ }));
    expect(await screen.findByText('Add (future only)')).toBeInTheDocument();
    expect(screen.getByText('New empty managed state at the cut')).toBeInTheDocument();
    expect(api.validateClusterTopology).toHaveBeenCalledWith('3', ['CREATE STREAM hot AS SELECT device, COUNT(*) AS n FROM readings GROUP BY device']);

    fireEvent.click(screen.getByRole('button', { name: /^Submit migration$/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Submit migration' }));
    expect(await screen.findByText(/outcome is uncertain/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Retry submission/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Submit migration' }));
    await waitFor(() => expect(api.submitClusterTopology).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(api.submitClusterTopology).mock.calls.map(([request]) => request);
    expect(second.operation_id).toBe(first.operation_id);
    expect(second.expected_parent_version).toBe('3');
    expect(await screen.findByText(/Admitted as/)).toBeInTheDocument();
    expect((await screen.findAllByText('Preparing')).length).toBeGreaterThan(0);

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
