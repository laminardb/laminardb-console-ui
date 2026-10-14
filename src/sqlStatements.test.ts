import { describe, expect, it } from 'vitest';
import { splitSqlStatements, topologyStatementProblems } from './sqlStatements';

describe('topology statement splitting', () => {
  it('splits on semicolons outside quotes and comments and keeps text verbatim', () => {
    expect(splitSqlStatements(`
      -- add a filtered stream; then its sink
      CREATE STREAM s AS SELECT 'a;b' AS v, "x;y" FROM t;
      /* block ; comment */
      CREATE SINK k FROM s INTO KAFKA ('topic' = 'it''s;fine');
    `)).toEqual([
      `-- add a filtered stream; then its sink
      CREATE STREAM s AS SELECT 'a;b' AS v, "x;y" FROM t`,
      `/* block ; comment */
      CREATE SINK k FROM s INTO KAFKA ('topic' = 'it''s;fine')`,
    ]);
    expect(splitSqlStatements(' ; -- only a comment\n;')).toEqual([]);
  });

  it('pre-checks the documented migration limits', () => {
    expect(topologyStatementProblems(['CREATE OR REPLACE STREAM s AS SELECT 1', 'DROP SINK k'])).toEqual([]);
    expect(topologyStatementProblems(['CREATE MATERIALIZED VIEW v AS SELECT 1'])[0]).toMatch(/SOURCE, STREAM or SINK/);
    expect(topologyStatementProblems(['DROP STREAM s CASCADE'])).toContainEqual(expect.stringMatching(/CASCADE/));
    expect(topologyStatementProblems(['DROP STREAM s -- old'])).toContainEqual(expect.stringMatching(/comments/));
    expect(topologyStatementProblems(["DROP STREAM \"a--b\""])).toEqual([]);
    expect(topologyStatementProblems(Array.from({ length: 65 }, () => 'DROP SINK k'))[0]).toMatch(/at most 64/);
  });
});
