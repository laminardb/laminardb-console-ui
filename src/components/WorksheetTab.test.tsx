// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      listStreams: vi.fn().mockResolvedValue([{
        name: 'positions',
        sql: 'SELECT account_id, SUM(pnl) FROM trades GROUP BY account_id',
      }]),
      listMvs: vi.fn().mockResolvedValue([{
        name: 'position_snapshot', sql: 'SELECT * FROM positions', state: 'ready',
      }]),
      getClusterStatus: vi.fn().mockResolvedValue({
        mode: 'cluster',
        node_id: 'node-a',
        pipeline_state: 'Running',
        subscription_output: {
          active_readers: '0', pending_bytes: '0', retained_bytes: '0', orphan_bytes: '0',
          open_failures: '0', segment_write_failures: '0', manifest_failures: '0',
          integrity_failures: '0', stale_writer_rejections: '0', sequence_gaps: '0',
          lag_disconnects: '0',
        },
      }),
      getSubscriptionUrl: vi.fn().mockReturnValue('ws://db.example.test/ws/positions'),
    },
  };
});

import { api } from '../api';
import WorksheetTab from './WorksheetTab';

const ENGINE_SHA = 'f905741c3730bdf4733fd3b0501e45ab31518d89';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  message(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

afterEach(() => {
  cleanup();
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe(`cluster subscription worksheet at engine ${ENGINE_SHA}`, () => {
  it('opens an admitted cluster stream and renders durable partition metadata', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    render(<WorksheetTab />);

    const target = await screen.findByLabelText('Target');
    await waitFor(() => expect(target).toHaveValue('positions'));
    expect(screen.getByText(/Cluster subscriptions deliver checkpoint-committed output/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /position_snapshot.*unavailable in cluster/ })).toBeDisabled();

    const start = screen.getByRole('button', { name: 'Attach live tail' });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(api.getSubscriptionUrl).toHaveBeenCalledWith('positions', undefined);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    const generation = '07'.repeat(32);
    act(() => socket.message(JSON.stringify({
      type: 'data', subscription_id: 'positions', data: [{ account_id: '7', total_pnl: '125' }],
      sequence: '0', log_sequence: '0', row_offset: '0', row_count: '1',
      stream_generation: generation, partition: '3', partition_sequence: '9', committed_epoch: '12',
    })));
    act(() => socket.message(JSON.stringify({
      type: 'progress', subscription_id: 'positions', sequence: '1', epoch: '12',
      checkpoint_id: '12', log_sequence: '1', through_log_sequence: '1',
      stream_generation: generation,
    })));

    expect(screen.getByRole('columnheader', { name: 'Partition' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Partition sequence' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Committed epoch' })).toBeInTheDocument();
    expect(screen.getByText('committed epoch 12 · checkpoint 12')).toBeInTheDocument();
    expect(screen.getByText(/generation 070707070707/)).toBeInTheDocument();
    expect(socket.send).not.toHaveBeenCalled();
  });
});
