import { describe, expect, it } from 'vitest';
import {
  buildRelationSql, EMIT_OPTIONS, PERIODIC_EMIT_VALUE, sqlStringLiteral, validateRelationName,
} from './catalogMeta';

const ENGINE_SHA = 'f905741c3730bdf4733fd3b0501e45ab31518d89';

describe(`LaminarDB DDL fixtures at ${ENGINE_SHA}`, () => {
  it('builds current source grammar and escapes option literals', () => {
    expect(buildRelationSql({
      kind: 'source',
      name: 'orders',
      connector: 'kafka',
      config: { topic: "customer's-orders", empty: '' },
      format: 'JSON',
      sourceColumns: 'id BIGINT, ts TIMESTAMP,',
      watermarkColumn: 'ts',
      watermarkAmount: '5',
      watermarkUnit: 'SECOND',
    })).toBe(`CREATE SOURCE orders (
  id BIGINT, ts TIMESTAMP,
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
)
FROM KAFKA (
  'topic' = 'customer''s-orders'
)
FORMAT JSON;`);
  });

  it('builds sink and stream grammar without obsolete trailing connector WITH', () => {
    expect(buildRelationSql({
      kind: 'sink', name: 'archive', connector: 'delta-lake', sinkInput: 'orders',
      config: { path: 's3://bucket/table' }, format: 'AVRO',
    })).toBe(`CREATE SINK archive
FROM orders
INTO DELTA_LAKE (
  'path' = 's3://bucket/table'
)
FORMAT AVRO;`);

    expect(buildRelationSql({
      kind: 'stream', name: 'totals', selectSql: 'SELECT COUNT(*) FROM orders',
      emitClause: PERIODIC_EMIT_VALUE, emitEveryAmount: '30', emitEveryUnit: 'SECOND',
      retainHistory: '64mb',
    })).toBe(`CREATE STREAM totals AS
SELECT COUNT(*) FROM orders
EMIT EVERY INTERVAL '30' SECOND
WITH ('retain_history' = '64mb');`);
  });

  it('covers every current EmitClause variant and accepts valid laminar-prefixed plain names', () => {
    expect(EMIT_OPTIONS.map((option) => option.value)).toEqual([
      '', 'EMIT ON UPDATE', 'EMIT CHANGES', 'EMIT FINAL', 'EMIT AFTER WATERMARK',
      'EMIT ON WINDOW CLOSE', 'EMIT EVERY',
    ]);
    expect(validateRelationName('laminar_events')).toBeNull();
    expect(validateRelationName('laminar.models')).toMatch(/plain SQL identifier/);
    expect(sqlStringLiteral("a'b")).toBe("'a''b'");
  });
});
