/**
 * Split a SQL script into individual statements for a topology request. The
 * engine requires one statement per array entry (1–64, at most 256 KiB in
 * total) and binds the exact text into the operation's plan hash, so text is
 * preserved verbatim apart from surrounding whitespace and the terminator.
 */
export const MAX_TOPOLOGY_STATEMENTS = 64;
export const MAX_TOPOLOGY_STATEMENT_BYTES = 256 * 1024;

export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  const flush = () => {
    if (!isCommentOnly(current)) statements.push(current.trim());
    current = '';
  };
  while (index < script.length) {
    const char = script[index];
    const next = script[index + 1];
    if (char === "'" || char === '"') {
      const end = closingQuote(script, index, char);
      current += script.slice(index, end);
      index = end;
      continue;
    }
    if (char === '-' && next === '-') {
      const end = script.indexOf('\n', index);
      const stop = end === -1 ? script.length : end;
      current += script.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = script.indexOf('*/', index + 2);
      const stop = end === -1 ? script.length : end + 2;
      current += script.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === ';') {
      flush();
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  flush();
  return statements;
}

/** Index just past the closing quote; doubled quotes are escapes. Unterminated runs to the end. */
function closingQuote(script: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < script.length) {
    if (script[index] === quote) {
      if (script[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return script.length;
}

function isCommentOnly(text: string): boolean {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .trim() === '';
}

function hasComment(statement: string): boolean {
  let index = 0;
  while (index < statement.length) {
    const char = statement[index];
    if (char === "'" || char === '"') {
      index = closingQuote(statement, index, char);
      continue;
    }
    if ((char === '-' && statement[index + 1] === '-') || (char === '/' && statement[index + 1] === '*')) {
      return true;
    }
    index += 1;
  }
  return false;
}

const MIGRATABLE = /^\s*(CREATE\s+(OR\s+REPLACE\s+)?(SOURCE|STREAM|SINK)\b|DROP\s+(SOURCE|STREAM|SINK)\b)/i;

/**
 * Client-side pre-checks mirroring the engine's documented topology limits.
 * The engine remains authoritative; these only catch obvious mistakes early.
 */
export function topologyStatementProblems(statements: string[]): string[] {
  const problems: string[] = [];
  if (statements.length === 0) problems.push('Enter at least one statement.');
  if (statements.length > MAX_TOPOLOGY_STATEMENTS) {
    problems.push(`A topology request accepts at most ${MAX_TOPOLOGY_STATEMENTS} statements.`);
  }
  const bytes = statements.reduce((total, statement) => total + new TextEncoder().encode(statement).length, 0);
  if (bytes > MAX_TOPOLOGY_STATEMENT_BYTES) problems.push('Statements exceed the 256 KiB request limit.');
  statements.forEach((statement, position) => {
    const label = `Statement ${position + 1}`;
    if (!MIGRATABLE.test(statement)) {
      problems.push(`${label}: migrations support only CREATE [OR REPLACE] / DROP of SOURCE, STREAM or SINK.`);
    }
    if (/\bCASCADE\b/i.test(statement) && /^\s*DROP\b/i.test(statement)) {
      problems.push(`${label}: DROP … CASCADE is not supported; drop dependants explicitly first.`);
    }
    if (/^\s*DROP\b/i.test(statement) && hasComment(statement)) {
      problems.push(`${label}: DROP statements must not contain SQL comments.`);
    }
  });
  return problems;
}
