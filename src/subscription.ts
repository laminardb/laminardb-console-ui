import { parseEngineJson } from './api';
import type { WireU64 } from './api';

interface SubscriptionFrameBase {
  subscription_id: string;
  sequence: WireU64;
}

export interface SubscriptionDataFrame extends SubscriptionFrameBase {
  type: 'data';
  data: Record<string, unknown>[];
  log_sequence: WireU64;
  row_offset: WireU64;
  row_count: WireU64;
  /** Present together only for checkpoint-committed cluster output. */
  stream_generation?: string;
  partition?: WireU64;
  partition_sequence?: WireU64;
  committed_epoch?: WireU64;
}

export interface SubscriptionProgressFrame extends SubscriptionFrameBase {
  type: 'progress';
  epoch: WireU64;
  checkpoint_id: WireU64;
  log_sequence: WireU64;
  through_log_sequence: WireU64;
  /** Present on whole-cluster committed progress frames. */
  stream_generation?: string;
}

export interface SubscriptionGapFrame extends SubscriptionFrameBase {
  type: 'gap';
  code: 'subscription_lagged';
  message: string;
  skipped_messages: WireU64;
}

export interface SubscriptionErrorFrame extends SubscriptionFrameBase {
  type: 'error';
  code: string;
  message: string;
}

export type SubscriptionFrame =
  | SubscriptionDataFrame
  | SubscriptionProgressFrame
  | SubscriptionGapFrame
  | SubscriptionErrorFrame;

export class SubscriptionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionProtocolError';
  }
}

const U64_MAX = 18_446_744_073_709_551_615n;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SubscriptionProtocolError('WebSocket frame is not a JSON object.');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new SubscriptionProtocolError(`WebSocket ${field} must be a string.`);
  return value;
}

function u64(value: unknown, field: string): WireU64 {
  const result = text(value, field);
  if (!/^\d+$/.test(result) || BigInt(result) > U64_MAX) {
    throw new SubscriptionProtocolError(`WebSocket ${field} must be a decimal u64 string.`);
  }
  return result;
}

function u16(value: unknown, field: string): WireU64 {
  const result = u64(value, field);
  if (BigInt(result) > 65_535n) {
    throw new SubscriptionProtocolError(`WebSocket ${field} must be a decimal u16 string.`);
  }
  return result;
}

function streamGeneration(value: unknown): string {
  const result = text(value, 'stream_generation');
  if (!/^[0-9a-f]{64}$/.test(result) || /^0+$/.test(result)) {
    throw new SubscriptionProtocolError('WebSocket stream_generation must be a non-zero lowercase SHA-256 string.');
  }
  return result;
}

function hasOwn(frame: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(frame, field);
}

export function normalizeU64Input(value: string): WireU64 | undefined {
  const input = value.trim();
  if (!input) return undefined;
  if (!/^\d+$/.test(input)) throw new Error('Epoch must be an unsigned integer.');
  const parsed = BigInt(input);
  if (parsed > U64_MAX) throw new Error('Epoch exceeds the LaminarDB u64 range.');
  return parsed.toString();
}

/** Parse and validate one server-to-client frame from the pinned WebSocket protocol. */
export function parseSubscriptionFrame(raw: string): SubscriptionFrame {
  let value: unknown;
  try {
    value = parseEngineJson(raw);
  } catch (cause) {
    throw new SubscriptionProtocolError(
      `WebSocket frame is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const frame = record(value);
  const type = text(frame.type, 'type');
  const base = {
    subscription_id: text(frame.subscription_id, 'subscription_id'),
    sequence: u64(frame.sequence, 'sequence'),
  };

  if (type === 'data') {
    if (!Array.isArray(frame.data) || frame.data.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))) {
      throw new SubscriptionProtocolError('WebSocket data must be an array of row objects.');
    }
    const rowCount = u64(frame.row_count, 'row_count');
    if (BigInt(rowCount) !== BigInt(frame.data.length)) {
      throw new SubscriptionProtocolError('WebSocket row_count does not match the data array length.');
    }
    const clusterFields = ['stream_generation', 'partition', 'partition_sequence', 'committed_epoch'];
    const presentClusterFields = clusterFields.filter((field) => hasOwn(frame, field));
    if (presentClusterFields.length !== 0 && presentClusterFields.length !== clusterFields.length) {
      throw new SubscriptionProtocolError('WebSocket cluster data metadata must contain all four identity fields.');
    }
    const cluster = presentClusterFields.length === clusterFields.length
      ? {
          stream_generation: streamGeneration(frame.stream_generation),
          partition: u16(frame.partition, 'partition'),
          partition_sequence: u64(frame.partition_sequence, 'partition_sequence'),
          committed_epoch: u64(frame.committed_epoch, 'committed_epoch'),
        }
      : {};
    return {
      ...base,
      type,
      data: frame.data as Record<string, unknown>[],
      log_sequence: u64(frame.log_sequence, 'log_sequence'),
      row_offset: u64(frame.row_offset, 'row_offset'),
      row_count: rowCount,
      ...cluster,
    };
  }

  if (type === 'progress') {
    const cluster = hasOwn(frame, 'stream_generation')
      ? { stream_generation: streamGeneration(frame.stream_generation) }
      : {};
    return {
      ...base,
      type,
      epoch: u64(frame.epoch, 'epoch'),
      checkpoint_id: u64(frame.checkpoint_id, 'checkpoint_id'),
      log_sequence: u64(frame.log_sequence, 'log_sequence'),
      through_log_sequence: u64(frame.through_log_sequence, 'through_log_sequence'),
      ...cluster,
    };
  }

  if (type === 'gap') {
    const code = text(frame.code, 'code');
    if (code !== 'subscription_lagged') {
      throw new SubscriptionProtocolError(`Unknown WebSocket gap code '${code}'.`);
    }
    return {
      ...base,
      type,
      code,
      message: text(frame.message, 'message'),
      skipped_messages: u64(frame.skipped_messages, 'skipped_messages'),
    };
  }

  if (type === 'error') {
    return {
      ...base,
      type,
      code: text(frame.code, 'code'),
      message: text(frame.message, 'message'),
    };
  }

  throw new SubscriptionProtocolError(`Unsupported WebSocket frame type '${type}'.`);
}

export type ClusterSubscriptionDataFrame = SubscriptionDataFrame & Required<Pick<
  SubscriptionDataFrame,
  'stream_generation' | 'partition' | 'partition_sequence' | 'committed_epoch'
>>;

export function isClusterSubscriptionDataFrame(
  frame: SubscriptionDataFrame,
): frame is ClusterSubscriptionDataFrame {
  return frame.stream_generation !== undefined;
}

/** Stable row identities used to suppress duplicates after checkpoint-granular replay. */
export function dataFrameRowKeys(frame: SubscriptionDataFrame): string[] {
  const offset = BigInt(frame.row_offset);
  if (isClusterSubscriptionDataFrame(frame)) {
    return frame.data.map((_, index) => [
      frame.stream_generation,
      frame.partition,
      frame.partition_sequence,
      offset + BigInt(index),
    ].join(':'));
  }
  return frame.data.map((_, index) => `${frame.log_sequence}:${offset + BigInt(index)}`);
}
