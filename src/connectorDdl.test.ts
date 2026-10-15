import { describe, expect, it } from 'vitest';
import { isChangeFeedSource, parseConnectorDdl } from './connectorDdl';

describe('stored connector DDL parsing', () => {
  it('reads quoted connector names, options and FORMAT without credentials', () => {
    const ddl = parseConnectorDdl(`CREATE SOURCE orders (
      id BIGINT NOT NULL, status VARCHAR, PRIMARY KEY (id)
    ) FROM "postgres-cdc" (
      'host' = 'pg', 'password' = '\${PG_PASSWORD}', 'table' = 'public.orders',
      'output.mode' = 'changelog', 'snapshot.mode' = 'initial'
    );`, 'source');
    expect(ddl).toEqual({
      connector: 'postgres-cdc',
      options: { host: 'pg', table: 'public.orders', 'output.mode': 'changelog', 'snapshot.mode': 'initial' },
    });
    expect(ddl && isChangeFeedSource(ddl)).toBe(true);
  });

  it('reads the INTO connector of a sink, not its FROM input', () => {
    expect(parseConnectorDdl(
      "CREATE SINK out FROM totals INTO KAFKA ('topic' = 'totals', 'commit.topic' = 'totals-commits') FORMAT JSON;",
      'sink',
    )).toEqual({ connector: 'kafka', options: { topic: 'totals', 'commit.topic': 'totals-commits' }, format: 'JSON' });
  });

  it('treats Delta sources as change feeds unless they read a snapshot', () => {
    const changes = parseConnectorDdl(`CREATE SOURCE d FROM "delta-lake" ('table.path' = 's3://lake/t')`, 'source');
    const snapshot = parseConnectorDdl(`CREATE SOURCE d FROM "delta-lake" ('table.path' = 's3://lake/t', 'read.mode' = 'snapshot')`, 'source');
    expect(changes && isChangeFeedSource(changes)).toBe(true);
    expect(snapshot && isChangeFeedSource(snapshot)).toBe(false);
    expect(parseConnectorDdl('CREATE SOURCE plain (id BIGINT)', 'source')).toBeNull();
  });
});
