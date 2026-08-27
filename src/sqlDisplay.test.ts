import { describe, expect, it } from 'vitest';
import { isSensitiveOptionKey, redactSqlSecrets } from './sqlDisplay';

describe('stored SQL display boundary', () => {
  it('redacts secrets, tokens, and credential-bearing URLs while retaining ordinary options', () => {
    const ddl = "FROM KAFKA ('bootstrap.servers' = 'kafka:9092', 'sasl.password' = 'hunter2', 'url' = 'https://u:p@example.test')";
    expect(redactSqlSecrets(ddl)).toBe(
      "FROM KAFKA ('bootstrap.servers' = 'kafka:9092', 'sasl.password' = '[hidden]', 'url' = '[hidden]')",
    );
    expect(isSensitiveOptionKey('api_key')).toBe(true);
    expect(isSensitiveOptionKey('topic')).toBe(false);
  });
});
