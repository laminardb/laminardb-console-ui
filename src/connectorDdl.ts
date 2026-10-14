/**
 * Read the connector type and options back out of stored CREATE SOURCE /
 * CREATE SINK text (SHOW CREATE returns the DDL exactly as submitted). Display
 * only: values of credential-like keys are never returned.
 */
import { isSensitiveOptionKey } from './sqlDisplay';

export interface ConnectorDdl {
  /** Lowercase registry name, e.g. `postgres-cdc`, matching the engine's normalization. */
  connector: string;
  options: Record<string, string>;
  format?: string;
}

interface Token {
  text: string;
  depth: number;
  kind: 'word' | 'quoted' | 'string' | 'symbol';
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
    } else if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
    } else if (char === "'" || char === '"') {
      let end = index + 1;
      let text = '';
      while (end < sql.length) {
        if (sql[end] === char) {
          if (sql[end + 1] === char) {
            text += char;
            end += 2;
            continue;
          }
          break;
        }
        text += sql[end];
        end += 1;
      }
      tokens.push({ text, depth, kind: char === "'" ? 'string' : 'quoted' });
      index = end + 1;
    } else if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_.$-]/.test(sql[end]) && !(sql[end] === '-' && sql[end + 1] === '-')) end += 1;
      tokens.push({ text: sql.slice(index, end), depth, kind: 'word' });
      index = end;
    } else {
      if (char === ')') depth = Math.max(0, depth - 1);
      tokens.push({ text: char, depth, kind: 'symbol' });
      if (char === '(') depth += 1;
      index += 1;
    }
  }
  return tokens;
}

/** Parse `FROM <connector> (...)` for sources or `INTO <connector> (...)` for sinks. */
export function parseConnectorDdl(sql: string, kind: 'source' | 'sink'): ConnectorDdl | null {
  const tokens = tokenize(sql);
  const keyword = kind === 'source' ? 'FROM' : 'INTO';
  const at = tokens.findIndex((token) => token.depth === 0 && token.kind === 'word' && token.text.toUpperCase() === keyword);
  const nameToken = at === -1 ? undefined : tokens[at + 1];
  if (!nameToken || (nameToken.kind !== 'word' && nameToken.kind !== 'quoted')) return null;
  const result: ConnectorDdl = { connector: nameToken.text.toLowerCase(), options: {} };

  let cursor = at + 2;
  if (tokens[cursor]?.text === '(' && tokens[cursor].kind === 'symbol') {
    cursor += 1;
    while (cursor < tokens.length && !(tokens[cursor].kind === 'symbol' && tokens[cursor].text === ')' && tokens[cursor].depth === 0)) {
      const key = tokens[cursor];
      const equals = tokens[cursor + 1];
      const value = tokens[cursor + 2];
      if (key && equals?.text === '=' && value && (key.kind === 'string' || key.kind === 'word' || key.kind === 'quoted')) {
        const optionKey = key.text.trim();
        if (!isSensitiveOptionKey(optionKey)) result.options[optionKey.toLowerCase()] = value.text;
        cursor += 3;
      } else {
        cursor += 1;
      }
    }
  }

  const formatAt = tokens.findIndex((token, position) => position > at && token.depth === 0 && token.kind === 'word' && token.text.toUpperCase() === 'FORMAT');
  const formatToken = formatAt === -1 ? undefined : tokens[formatAt + 1];
  if (formatToken && (formatToken.kind === 'word' || formatToken.kind === 'quoted')) result.format = formatToken.text.toUpperCase();
  return result;
}

/** Keys that describe how a connector reads or writes, shown alongside the relation. */
export const MODE_KEYS = [
  'output.mode', 'snapshot.mode', 'read.mode', 'write.mode', 'envelope', 'starting.version',
  'changelog.mode', 'full.document.mode', 'startup.mode',
] as const;

/** Keys that identify the external object, shown alongside the relation. */
export const TARGET_KEYS = [
  'topic', 'table', 'table.name', 'table.path', 'collection', 'database', 'namespace', 'subject',
] as const;

export const CDC_CONNECTORS = new Set(['postgres-cdc', 'mongodb-cdc']);

/** Delta-Lake sources read the change data feed unless `read.mode=snapshot`. */
export function isChangeFeedSource(ddl: ConnectorDdl): boolean {
  if (CDC_CONNECTORS.has(ddl.connector)) return true;
  return ddl.connector === 'delta-lake' && (ddl.options['read.mode'] ?? 'changes') === 'changes';
}
