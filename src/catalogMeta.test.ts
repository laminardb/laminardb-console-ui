import { describe, expect, it } from 'vitest';
import {
  buildRelationSql, connectorIdentifier, editableConfigKeys, EMIT_OPTIONS, isNativeProtocol,
  PERIODIC_EMIT_VALUE, sourceColumnPolicy, sourceFormatOptions, sqlStringLiteral, validateKeyColumns, validateRelationName,
} from './catalogMeta';
import type { ConnectorInfo, SchemaCapabilities } from './api';

const NATIVE: SchemaCapabilities = {
  discovery: 'metadata', metadata_formats: [], built_in_formats: [],
  query_derived: false, bounded_sampling: false, preparation: 'none',
};

const ENGINE_SHA = 'bd8f85e82ac3c23a5c3f4acc3500e20e79e15a56';

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
INTO "delta-lake" (
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

  it('quotes hyphenated connector types because the engine only lowercases them', () => {
    expect(connectorIdentifier('kafka')).toBe('KAFKA');
    expect(connectorIdentifier('postgres-cdc')).toBe('"postgres-cdc"');
    expect(connectorIdentifier('mongodb-cdc')).toBe('"mongodb-cdc"');
    expect(buildRelationSql({
      kind: 'source',
      name: 'orders',
      connector: 'postgres-cdc',
      config: {
        host: 'pg', database: 'shop', publication: 'orders_pub', 'slot.name': 'laminar_orders',
        table: 'public.orders', 'laminar.source.name': 'spoofed', format: 'json',
      },
      sourceColumns: 'id BIGINT NOT NULL, status VARCHAR',
      primaryKey: 'id',
    })).toBe(`CREATE SOURCE orders (
  id BIGINT NOT NULL, status VARCHAR,
  PRIMARY KEY (id)
)
FROM "postgres-cdc" (
  'host' = 'pg',
  'database' = 'shop',
  'publication' = 'orders_pub',
  'slot.name' = 'laminar_orders',
  'table' = 'public.orders'
);`);
  });

  it('derives FORMAT and column rules from schema capabilities', () => {
    expect(isNativeProtocol(NATIVE)).toBe(true);
    expect(isNativeProtocol({ ...NATIVE, metadata_formats: ['AVRO'] })).toBe(false);
    expect(isNativeProtocol({ ...NATIVE, discovery: 'built_in' })).toBe(true);
    expect(isNativeProtocol(null)).toBe(false);
    // Shapes reported by a live 0.32 server's /api/v1/connectors.
    const kafka = { ...NATIVE, metadata_formats: ['avro'], built_in_formats: ['raw', 'bytes'] };
    const nats = { ...NATIVE, discovery: 'explicit' as const, built_in_formats: ['raw', 'bytes'] };
    const files = { ...NATIVE, metadata_formats: ['parquet', 'arrow_ipc', 'arrow'], built_in_formats: ['text', 'txt'], bounded_sampling: true };
    expect(sourceColumnPolicy('generator', { ...NATIVE, discovery: 'built_in' })).toBe('optional');
    expect(sourceColumnPolicy('mongodb-cdc', NATIVE)).toBe('optional');
    expect(sourceColumnPolicy('postgres-cdc', NATIVE)).toBe('required');
    expect(sourceColumnPolicy('kafka', kafka, 'JSON')).toBe('required');
    expect(sourceColumnPolicy('kafka', kafka, 'AVRO')).toBe('optional');
    expect(sourceColumnPolicy('kafka', kafka, 'RAW')).toBe('optional');
    expect(sourceColumnPolicy('nats', nats, 'JSON')).toBe('required');
    expect(sourceColumnPolicy('nats', nats, 'RAW')).toBe('optional');
    expect(sourceColumnPolicy('files', files, 'PARQUET')).toBe('optional');
    expect(sourceColumnPolicy('files', files, 'CSV')).toBe('sampling');
    expect(sourceColumnPolicy('custom', null)).toBe('unknown');
    expect(sourceFormatOptions(files)).toEqual(['', 'JSON', 'CSV', 'RAW', 'DEBEZIUM', 'AVRO', 'PARQUET', 'ARROW_IPC', 'ARROW', 'TEXT', 'TXT']);
    expect(validateKeyColumns('_id, shard')).toBeNull();
    expect(validateKeyColumns('a b')).toMatch(/comma-separated/);
  });

  it('never offers runtime-owned options even when a connector advertises them', () => {
    const iceberg: ConnectorInfo = {
      name: 'iceberg', display_name: 'Iceberg', version: '0.32.0', is_source: false, is_sink: true,
      schema_capabilities: null,
      config_keys: [
        { key: 'catalog.uri', description: '', required: true, default: null },
        { key: 'delivery.guarantee', description: '', required: false, default: 'at_least_once' },
        { key: 'format', description: '', required: false, default: 'parquet' },
      ],
    };
    expect(editableConfigKeys('sink', iceberg).map((key) => key.key)).toEqual(['catalog.uri']);
  });
});
