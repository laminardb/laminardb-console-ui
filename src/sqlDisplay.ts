const SENSITIVE_OPTION = /(?:password|passwd|token|secret|credential|authorization|auth[._-]?(?:header|token)|api[._-]?key|private[._-]?key|client[._-]?key|connection[._-]?(?:string|uri)|dsn|url|uri)$/i;

export function isSensitiveOptionKey(key: string): boolean {
  return SENSITIVE_OPTION.test(key.trim());
}

/**
 * Hide likely credentials before rendering stored connector DDL. This is a
 * display boundary only: the original SQL response is never mutated or sent
 * back to the server.
 */
export function redactSqlSecrets(sql: string): string {
  return sql.replace(
    /((?:['"]?)([A-Za-z_][\w.-]*)(?:['"]?)\s*=\s*)(?:'(?:''|[^'])*'|"(?:""|[^"])*"|[^,\s)]+)/g,
    (assignment, prefix: string, key: string) => isSensitiveOptionKey(key) ? `${prefix}'[hidden]'` : assignment,
  );
}
