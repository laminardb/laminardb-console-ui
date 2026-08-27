/**
 * SQL grammar choices that are not discoverable through the HTTP catalog.
 *
 * Connector availability and option keys deliberately do not live here: the
 * server build is feature-gated, so the wizard uses GET /api/v1/connectors.
 * Delivery guarantees are also deliberately absent because the discovery
 * response does not expose the runtime admission contract, and several
 * guarantees depend on connector mode and cluster topology.
 */

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

function connectorIdentifier(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

function optionBlock(config: Record<string, string> = {}): string {
  return Object.entries(config)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `  ${sqlStringLiteral(key)} = ${sqlStringLiteral(value.trim())}`)
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
    if (input.watermarkColumn?.trim()) {
      const column = input.watermarkColumn.trim();
      schemaParts.push(`WATERMARK FOR ${column} AS ${column} - INTERVAL ${sqlStringLiteral(input.watermarkAmount || '0')} ${input.watermarkUnit || 'SECOND'}`);
    }
    const schema = schemaParts.length ? ` (\n  ${schemaParts.join(',\n  ')}\n)` : '';
    const options = optionBlock(input.config);
    const from = options
      ? `FROM ${connectorIdentifier(input.connector || '')} (\n${options}\n)`
      : `FROM ${connectorIdentifier(input.connector || '')}`;
    return `CREATE SOURCE ${input.name}${schema}\n${from}${input.format ? `\nFORMAT ${input.format}` : ''};`;
  }

  if (input.kind === 'sink') {
    const options = optionBlock(input.config);
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
