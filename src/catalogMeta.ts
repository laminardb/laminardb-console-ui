/**
 * SQL grammar choices that are not discoverable through the HTTP catalog.
 *
 * Connector availability and option keys deliberately do not live here: the
 * server build is feature-gated, so the wizard uses GET /api/v1/connectors.
 * Delivery guarantees are also deliberately absent because the discovery
 * response does not expose the runtime admission contract, and several
 * guarantees depend on connector mode and cluster topology. The connector
 * notes below are DDL requirements the engine enforces at the pinned commit
 * (see docs/laminardb-v0.32-console-contract.md), not delivery claims.
 */

import type { ConnectorInfo, SchemaCapabilities } from './api';

// Format::parse in crates/laminar-connectors/src/serde/mod.rs. Debezium is
// deserialize-only; Avro is available only when its server feature is built.
export const SOURCE_FORMATS = ['', 'JSON', 'CSV', 'RAW', 'DEBEZIUM', 'AVRO'] as const;
export const SINK_FORMATS = ['', 'JSON', 'CSV', 'RAW', 'AVRO'] as const;

// EmitClause in crates/laminar-sql/src/parser/statements/mod.rs and
// parse_emit_clause in parser/emit_parser.rs.
export const PERIODIC_EMIT_VALUE = 'EMIT EVERY' as const;
export const EMIT_OPTIONS = [
  { value: '', label: 'Default (no EMIT clause)' },
  { value: 'EMIT ON UPDATE', label: 'ON UPDATE — emit on every input change' },
  { value: 'EMIT CHANGES', label: 'CHANGES — emit the changelog' },
  { value: 'EMIT FINAL', label: 'FINAL — emit only final results' },
  { value: 'EMIT AFTER WATERMARK', label: 'AFTER WATERMARK — emit once the watermark passes' },
  { value: 'EMIT ON WINDOW CLOSE', label: 'ON WINDOW CLOSE — emit when a window closes' },
  { value: PERIODIC_EMIT_VALUE, label: 'EVERY interval — emit periodically' },
] as const;

/**
 * Keys the runtime owns (connector_manager::validate_connector_format_options).
 * Some connectors still advertise them (Iceberg sink lists `delivery.guarantee`,
 * several list `format`), so the wizard never renders or emits them.
 */
const RUNTIME_OWNED_KEYS: Record<'source' | 'sink', readonly string[]> = {
  source: ['laminar.source.name', '_arrow_schema', 'format'],
  sink: ['delivery.guarantee', '_arrow_schema', 'format'],
};

export function isRuntimeOwnedOption(kind: 'source' | 'sink', key: string): boolean {
  return RUNTIME_OWNED_KEYS[kind].some((owned) => owned.toLowerCase() === key.trim().toLowerCase());
}

/** Advertised option keys the wizard may render for this direction. */
export function editableConfigKeys(kind: 'source' | 'sink', connector: ConnectorInfo | undefined) {
  return (connector?.config_keys ?? []).filter((key) => !isRuntimeOwnedOption(kind, key.key));
}

/**
 * A connector whose discovery is `metadata`/`built_in` with an empty matching
 * format list speaks a fixed native protocol and rejects any FORMAT clause
 * (SchemaCapabilities::validate_native_format).
 */
export function isNativeProtocol(caps: SchemaCapabilities | null | undefined): boolean {
  if (!caps) return false;
  if (caps.discovery === 'metadata') return caps.metadata_formats.length === 0;
  if (caps.discovery === 'built_in') return caps.built_in_formats.length === 0;
  return false;
}

export type ColumnPolicy = 'required' | 'optional' | 'sampling' | 'unknown';

/**
 * Connectors whose native metadata authority still requires declared columns
 * (docs/SCHEMA_RESOLUTION.md: PostgreSQL CDC maps a declared typed subset).
 */
const EXPLICIT_COLUMN_CONNECTORS = new Set(['postgres-cdc']);

/**
 * Whether CREATE SOURCE may omit its column list, mirroring
 * ConnectorRegistry::resolve_source_schema: explicit discovery needs columns
 * unless the chosen FORMAT (or the native default) has a built-in decoder;
 * metadata discovery needs a metadata or built-in format.
 */
export function sourceColumnPolicy(connector: string, caps: SchemaCapabilities | null | undefined, format = ''): ColumnPolicy {
  if (EXPLICIT_COLUMN_CONNECTORS.has(connector.toLowerCase())) return 'required';
  if (!caps) return 'unknown';
  const chosen = (format.trim() || 'native').toLowerCase();
  const listed = (formats: string[]) => formats.some((item) => item.toLowerCase() === chosen);
  if (isNativeProtocol(caps) || listed(caps.built_in_formats) || listed(caps.metadata_formats)) return 'optional';
  if (caps.discovery === 'query') return 'unknown';
  return caps.bounded_sampling ? 'sampling' : 'required';
}

/** FORMAT choices: the grammar's codecs plus every format the connector names. */
export function sourceFormatOptions(caps: SchemaCapabilities | null | undefined): string[] {
  const named = [...(caps?.metadata_formats ?? []), ...(caps?.built_in_formats ?? [])].map((item) => item.toUpperCase());
  return Array.from(new Set<string>([...SOURCE_FORMATS, ...named]));
}

export function describeSchemaCapabilities(caps: SchemaCapabilities): string {
  const formats = caps.discovery === 'metadata' ? caps.metadata_formats : caps.built_in_formats;
  switch (caps.discovery) {
    case 'explicit':
      return caps.built_in_formats.length
        ? `Explicit schema — declare columns, except with the built-in ${caps.built_in_formats.join('/')} decoder.`
        : 'Explicit schema — declare every column.';
    case 'query':
      return 'Query-derived — writer fields come from the bound input relation.';
    case 'metadata':
      return formats.length === 0
        ? 'Native protocol metadata — columns may be omitted; FORMAT is rejected.'
        : `Metadata-resolved for ${formats.join(', ')} — other formats need explicit columns.`;
    case 'built_in':
      return formats.length === 0
        ? 'Built-in native schema — columns may be omitted; FORMAT is rejected.'
        : `Built-in decoder schema for ${formats.join(', ')}.`;
  }
}

export function describeSchemaPreparation(caps: SchemaCapabilities): string | null {
  switch (caps.preparation) {
    case 'explicit_table_creation':
      return 'Can create the external table only when its auto-create option is explicitly enabled.';
    case 'explicit_registration':
      return 'Can register the writer schema only when explicitly enabled (for example schema.registry.auto.register).';
    default:
      return null;
  }
}

export interface ConnectorNote {
  tone: 'info' | 'warning';
  text: string;
}

const CONNECTOR_NOTES: Record<string, Partial<Record<'source' | 'sink', ConnectorNote[]>>> = {
  'postgres-cdc': {
    source: [
      { tone: 'warning', text: 'Declare explicit columns (a subset of the table is allowed) and a PRIMARY KEY identical to the table’s non-deferrable primary key. Non-key columns must be nullable so deletes can arrive as key-only tombstones.' },
      { tone: 'info', text: 'The publication must contain exactly the configured schema.table. slot.name is a prefix (≤46 bytes of [a-z0-9_]); the engine creates <prefix>_<16 hex>. Requires PostgreSQL 17+ and REPLICA IDENTITY FULL.' },
      { tone: 'info', text: 'output.mode=upsert (default) emits keyed puts and tombstones for keyed-mutation consumers. output.mode=changelog requires snapshot.mode=initial and a trailing __weight BIGINT NOT NULL column (+1/−1).' },
      { tone: 'warning', text: 'Embedded and single-node deployments only; cluster admission rejects this singleton source. At-least-once delivery only.' },
    ],
  },
  'mongodb-cdc': {
    source: [
      { tone: 'info', text: 'output.mode=history (default) emits a fixed change-event schema (event_id, operation, document_key, full_document, resume_token, cluster_time_*, …); columns may be omitted.' },
      { tone: 'warning', text: 'output.mode=document is a typed keyed projection: PRIMARY KEY must be _id (plus shard keys), non-key columns must be nullable, full.document.mode must be required, and pipeline stages are rejected.' },
      { tone: 'info', text: 'snapshot.mode=initial copies existing documents before streaming; never starts from the change stream. objectid.columns and document.json.column shape ObjectId and raw-document output.' },
      { tone: 'warning', text: 'Embedded and single-node deployments only; cluster admission rejects this singleton source.' },
    ],
  },
  'delta-lake': {
    source: [
      { tone: 'info', text: 'read.mode=changes (default) reads the Change Data Feed — the table needs delta.enableChangeDataFeed=true — and emits table columns plus a trailing __weight BIGINT NOT NULL. Columns may be omitted; if declared they must keep __weight.' },
      { tone: 'info', text: 'starting.version: unset emits the current snapshot then every later commit; <n> starts at commit n without a snapshot; latest only follows new commits. read.mode=snapshot reads once.' },
      { tone: 'warning', text: 'Embedded and single-node deployments only; cluster admission rejects this singleton source.' },
    ],
    sink: [
      { tone: 'info', text: 'write.mode=upsert needs merge.key.columns. Under exactly-once delivery only write.mode=append is admitted. auto.create must be explicit.' },
    ],
  },
  kafka: {
    source: [
      { tone: 'info', text: 'include.metadata and include.headers were removed; list metadata.columns (key, topic, partition, offset, timestamp, timestamp_type, headers) instead.' },
    ],
    sink: [
      { tone: 'warning', text: 'With server delivery = "exactly_once" (embedded/single-node), every Kafka sink needs commit.topic — a compacted topic distinct from topic — and dlq.topic is rejected. Each committed checkpoint becomes visible once to isolation.level=read_committed readers. Cluster Kafka output stays at-least-once.' },
      { tone: 'info', text: 'envelope=upsert requires partition.count and routes each key to murmur2(key) % partitions. key.format chooses native, kafka, text or json key bytes.' },
    ],
  },
  iceberg: {
    source: [
      { tone: 'info', text: 'read.mode=append follows new snapshots (replayable); read.mode=snapshot reads once; changelog is rejected.' },
    ],
    sink: [
      { tone: 'info', text: 'Only write.mode=append is supported; schema.evolution.mode=strict. auto.create must be explicit.' },
    ],
  },
  'mongodb-sink': {
    sink: [
      { tone: 'info', text: 'write.mode=cdc_replay replays a history-mode mongodb-cdc source; set replay.source.namespace (database.collection). upsert consumes a keyed changelog.' },
    ],
  },
  'postgres-sink': {
    sink: [
      { tone: 'info', text: 'write.mode=upsert with changelog.mode=true can consume a keyed CDC source directly in single-node mode when the primary key matches the source PRIMARY KEY.' },
    ],
  },
};

export function connectorNotes(name: string, kind: 'source' | 'sink'): ConnectorNote[] {
  return CONNECTOR_NOTES[name.toLowerCase()]?.[kind] ?? [];
}

/** The wizard intentionally emits unquoted, single-part SQL identifiers. */
export function validateRelationName(name: string): string | null {
  if (!name.trim()) return 'Name is required.';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim())) {
    return 'Use a plain SQL identifier (letters, digits, underscores; no spaces).';
  }
  // The engine reserves the qualified `laminar.` namespace. A plain identifier
  // such as `laminar_events` is valid and must not be rejected here.
  return null;
}

/** Comma-separated plain identifiers for PRIMARY KEY (...). */
export function validateKeyColumns(value: string): string | null {
  if (!value.trim()) return null;
  const parts = value.split(',').map((part) => part.trim());
  if (parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    return 'Primary key must be a comma-separated list of plain column identifiers.';
  }
  return null;
}

/** Escape a value used between single quotes in generated SQL. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface RelationSqlInput {
  kind: 'source' | 'sink' | 'stream' | 'mv';
  name: string;
  connector?: string;
  config?: Record<string, string>;
  format?: string;
  sourceColumns?: string;
  primaryKey?: string;
  watermarkColumn?: string;
  watermarkAmount?: string;
  watermarkUnit?: string;
  sinkInput?: string;
  selectSql?: string;
  emitClause?: string;
  emitEveryAmount?: string;
  emitEveryUnit?: string;
  retainHistory?: string;
}

/**
 * Connector types are matched by `to_ascii_lowercase()` only; punctuation is
 * provider-owned. `postgres-cdc` therefore must be written as a quoted
 * identifier — `POSTGRES_CDC` would resolve to the unregistered `postgres_cdc`.
 */
export function connectorIdentifier(name: string): string {
  const trimmed = name.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return trimmed.toUpperCase();
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function optionBlock(kind: 'source' | 'sink', config: Record<string, string> = {}): string {
  return Object.entries(config)
    .filter(([key, value]) => key.trim() !== '' && value.trim() !== '' && !isRuntimeOwnedOption(kind, key))
    .map(([key, value]) => `  ${sqlStringLiteral(key.trim())} = ${sqlStringLiteral(value.trim())}`)
    .join(',\n');
}

function renderEmit(input: RelationSqlInput): string {
  if (!input.emitClause) return '';
  if (input.emitClause !== PERIODIC_EMIT_VALUE) return `\n${input.emitClause}`;
  return `\n${PERIODIC_EMIT_VALUE} INTERVAL ${sqlStringLiteral(input.emitEveryAmount || '10')} ${input.emitEveryUnit || 'SECOND'}`;
}

/** Build only grammar forms verified at the pinned LaminarDB engine commit. */
export function buildRelationSql(input: RelationSqlInput): string {
  if (input.kind === 'source') {
    const schemaParts: string[] = [];
    const columns = (input.sourceColumns || '').trim().replace(/,\s*$/, '');
    if (columns) schemaParts.push(columns);
    // Order mirrors the parser's documented form; the engine accepts either order.
    const primaryKey = (input.primaryKey || '').split(',').map((part) => part.trim()).filter(Boolean);
    if (primaryKey.length > 0) schemaParts.push(`PRIMARY KEY (${primaryKey.join(', ')})`);
    if (input.watermarkColumn?.trim()) {
      const column = input.watermarkColumn.trim();
      schemaParts.push(`WATERMARK FOR ${column} AS ${column} - INTERVAL ${sqlStringLiteral(input.watermarkAmount || '0')} ${input.watermarkUnit || 'SECOND'}`);
    }
    const schema = schemaParts.length ? ` (\n  ${schemaParts.join(',\n  ')}\n)` : '';
    const options = optionBlock('source', input.config);
    const from = options
      ? `FROM ${connectorIdentifier(input.connector || '')} (\n${options}\n)`
      : `FROM ${connectorIdentifier(input.connector || '')}`;
    return `CREATE SOURCE ${input.name}${schema}\n${from}${input.format ? `\nFORMAT ${input.format}` : ''};`;
  }

  if (input.kind === 'sink') {
    const options = optionBlock('sink', input.config);
    const into = options
      ? `INTO ${connectorIdentifier(input.connector || '')} (\n${options}\n)`
      : `INTO ${connectorIdentifier(input.connector || '')}`;
    return `CREATE SINK ${input.name}\nFROM ${input.sinkInput || ''}\n${into}${input.format ? `\nFORMAT ${input.format}` : ''};`;
  }

  const emit = renderEmit(input);
  if (input.kind === 'stream') {
    const history = input.retainHistory?.trim()
      ? `\nWITH ('retain_history' = ${sqlStringLiteral(input.retainHistory.trim())})`
      : '';
    return `CREATE STREAM ${input.name} AS\n${(input.selectSql || '').trim()}${emit}${history};`;
  }
  return `CREATE MATERIALIZED VIEW ${input.name} AS\n${(input.selectSql || '').trim()}${emit};`;
}

/** Option-key aliases normalized by connector_manager.rs. */
export const OPTION_KEY_ALIASES: Record<string, string> = {
  brokers: 'bootstrap.servers',
  group_id: 'group.id',
  offset_reset: 'auto.offset.reset',
};
