import { describe, expect, it } from 'vitest';
import {
  dataFrameRowKeys, normalizeU64Input, parseSubscriptionFrame, SubscriptionProtocolError,
} from './subscription';

const ENGINE_SHA = 'f905741c3730bdf4733fd3b0501e45ab31518d89';
const GENERATION = 'ab'.repeat(32);

describe(`LaminarDB WebSocket fixtures at ${ENGINE_SHA}`, () => {
  it('parses the exact data frame and produces replay-stable row keys', () => {
    const frame = parseSubscriptionFrame(JSON.stringify({
      type: 'data',
      subscription_id: 'orders',
      data: [{ id: '9007199254740993' }, { id: '2' }],
      sequence: '0',
      log_sequence: '18446744073709551614',
      row_offset: '7',
      row_count: '2',
    }));
    expect(frame.type).toBe('data');
    if (frame.type !== 'data') throw new Error('fixture did not produce data');
    expect(dataFrameRowKeys(frame)).toEqual([
      '18446744073709551614:7',
      '18446744073709551614:8',
    ]);
  });

  it('uses durable cluster frame identity for replay deduplication', () => {
    const frame = parseSubscriptionFrame(JSON.stringify({
      type: 'data',
      subscription_id: 'positions',
      data: [{ account_id: '7' }, { account_id: '9' }],
      sequence: '4',
      log_sequence: '15',
      row_offset: '2',
      row_count: '2',
      stream_generation: GENERATION,
      partition: '3',
      partition_sequence: '9',
      committed_epoch: '12',
    }));
    expect(frame).toMatchObject({
      stream_generation: GENERATION,
      partition: '3',
      partition_sequence: '9',
      committed_epoch: '12',
    });
    expect(frame.type).toBe('data');
    if (frame.type !== 'data') throw new Error('fixture did not produce data');
    expect(dataFrameRowKeys(frame)).toEqual([
      `${GENERATION}:3:9:2`,
      `${GENERATION}:3:9:3`,
    ]);
  });

  it.each([
    {
      type: 'progress', subscription_id: 'orders', epoch: '8', checkpoint_id: '3',
      log_sequence: '20', through_log_sequence: '19', sequence: '1', stream_generation: GENERATION,
    },
    {
      type: 'gap', subscription_id: 'orders', code: 'subscription_lagged',
      message: 'receiver lagged', skipped_messages: '4', sequence: '2',
    },
    {
      type: 'error', subscription_id: 'orders', code: 'subscription_failed',
      message: 'portal closed', sequence: '3',
    },
  ])('parses the $type server frame', (fixture) => {
    expect(parseSubscriptionFrame(JSON.stringify(fixture))).toMatchObject(fixture);
  });

  it('rejects invented legacy frames and inconsistent row counts', () => {
    expect(() => parseSubscriptionFrame('{"type":"ping"}')).toThrow(SubscriptionProtocolError);
    expect(() => parseSubscriptionFrame(JSON.stringify({
      type: 'data', subscription_id: 'orders', data: [{}], sequence: '0',
      log_sequence: '1', row_offset: '0', row_count: '2',
    }))).toThrow(/row_count/);
  });

  it('rejects partial or malformed cluster metadata', () => {
    const base = {
      type: 'data', subscription_id: 'positions', data: [{}], sequence: '0',
      log_sequence: '1', row_offset: '0', row_count: '1',
    };
    expect(() => parseSubscriptionFrame(JSON.stringify({
      ...base, stream_generation: GENERATION, partition: '3',
    }))).toThrow(/all four identity fields/);
    expect(() => parseSubscriptionFrame(JSON.stringify({
      ...base,
      stream_generation: GENERATION.toUpperCase(),
      partition: '3', partition_sequence: '9', committed_epoch: '12',
    }))).toThrow(/lowercase SHA-256/);
    expect(() => parseSubscriptionFrame(JSON.stringify({
      ...base,
      stream_generation: GENERATION,
      partition: '65536', partition_sequence: '9', committed_epoch: '12',
    }))).toThrow(/decimal u16/);
  });

  it('normalizes AS OF epoch input within the Rust u64 range', () => {
    expect(normalizeU64Input(' 00042 ')).toBe('42');
    expect(normalizeU64Input('')).toBeUndefined();
    expect(() => normalizeU64Input('18446744073709551616')).toThrow(/u64 range/);
    expect(() => normalizeU64Input('-1')).toThrow(/unsigned integer/);
  });
});
