import { describe, expect, it } from 'vitest';

import {
  createJsonBoundarySnapshot,
  defaultJsonBoundaryLimits
} from '../src/shared/json-boundary.ts';
import { redactJsonBoundaryText } from '../src/shared/redaction.ts';
import {
  canonicalJsonStringify,
  canonicalJsonValuesEqual,
  createCanonicalJsonFingerprint
} from '../src/shared/canonical-json.ts';

describe('shared JSON boundary', () => {
  it('compares nested arrays structurally', () => {
    expect(
      canonicalJsonValuesEqual(
        ['same', { nested: [1, true, null] }],
        ['same', { nested: [1, true, null] }]
      )
    ).toBe(true);
    expect(
      canonicalJsonValuesEqual(
        ['same', { nested: [1, true, null] }],
        ['same', { nested: [1, false, null] }]
      )
    ).toBe(false);
  });

  it('compares object values independently of key order', () => {
    expect(
      canonicalJsonValuesEqual(
        { first: 1, second: { alpha: 'a', beta: 'b' } },
        { second: { beta: 'b', alpha: 'a' }, first: 1 }
      )
    ).toBe(true);
    expect(canonicalJsonValuesEqual({ first: 1 }, { second: 1 })).toBe(false);
  });

  it('canonicalizes fingerprints independently of object key order', () => {
    const left = { first: 1, nested: { alpha: true, beta: false } };
    const right = { nested: { beta: false, alpha: true }, first: 1 };

    expect(canonicalJsonStringify(left)).toBe(canonicalJsonStringify(right));
    expect(createCanonicalJsonFingerprint(left)).toBe(
      createCanonicalJsonFingerprint(right)
    );
  });

  it('redacts structured credentials and credential-bearing text recursively', () => {
    const snapshot = createJsonBoundarySnapshot(
      {
        authorization: 'Basic dXNlcjpwYXNz',
        cookie: 'session=very-secret',
        auth_token: 'auth-secret',
        csrfToken: 'csrf-secret',
        'id-token': 'identity-secret',
        aws_secret_access_key: 'aws-secret',
        ssh_private_key_pem: 'ssh-secret',
        oauth_client_secret_value: 'oauth-secret',
        safe: 'keep',
        nested: {
          endpoint: 'postgresql://user:pass@example.test/db',
          mssqlEndpoint: 'mssql://user:pass@example.test/db',
          graphEndpoint: 'neo4j+s://user:pass@example.test/db',
          message: 'Authorization: ApiKey auth-sentinel',
          proxyMessage: 'Proxy-Authorization: Digest proxy-sentinel'
        }
      },
      { field: 'result', redact: true }
    );

    expect(snapshot).toEqual({
      authorization: '[redacted]',
      cookie: '[redacted]',
      auth_token: '[redacted]',
      csrfToken: '[redacted]',
      'id-token': '[redacted]',
      aws_secret_access_key: '[redacted]',
      ssh_private_key_pem: '[redacted]',
      oauth_client_secret_value: '[redacted]',
      safe: 'keep',
      nested: {
        endpoint: 'postgresql://[redacted]@example.test/db',
        mssqlEndpoint: 'mssql://[redacted]@example.test/db',
        graphEndpoint: 'neo4j+s://[redacted]@example.test/db',
        message: 'Authorization: [redacted]',
        proxyMessage: 'Proxy-Authorization: [redacted]'
      }
    });
    expect(JSON.stringify(snapshot)).not.toContain('very-secret');
    expect(JSON.stringify(snapshot)).not.toContain('auth-sentinel');
    expect(JSON.stringify(snapshot)).not.toContain('proxy-sentinel');
    expect(redactJsonBoundaryText('Basic dXNlcjpwYXNz')).toBe(
      'Basic [redacted]'
    );
  });

  it('rejects cycles, non-finite numbers, and values beyond exact limits', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(() =>
      createJsonBoundarySnapshot(cyclic, { field: 'result' })
    ).toThrow('result.self must not contain cycles');
    expect(() =>
      createJsonBoundarySnapshot({ value: Number.NaN }, { field: 'result' })
    ).toThrow('result.value must be finite JSON');
    expect(() =>
      createJsonBoundarySnapshot(
        'x'.repeat(defaultJsonBoundaryLimits.maxStringBytes + 1),
        { field: 'result' }
      )
    ).toThrow('result exceeds the JSON string byte limit');
  });

  it('applies string limits to raw UTF-8 bytes, including redacted credentials', () => {
    const exactMultibyte = '界'.repeat(
      Math.floor(defaultJsonBoundaryLimits.maxStringBytes / 3)
    );

    expect(
      createJsonBoundarySnapshot(exactMultibyte, { field: 'result' })
    ).toBe(exactMultibyte);
    expect(() =>
      createJsonBoundarySnapshot(`${exactMultibyte}界`, { field: 'result' })
    ).toThrow('result exceeds the JSON string byte limit');
    expect(() =>
      createJsonBoundarySnapshot(
        {
          authorization: 'x'.repeat(
            defaultJsonBoundaryLimits.maxStringBytes + 1
          )
        },
        { field: 'result', redact: true }
      )
    ).toThrow('result.authorization exceeds the JSON string byte limit');
  });

  it('accepts the aggregate UTF-8 byte limit exactly and rejects one byte over', () => {
    const segment = 'x'.repeat(defaultJsonBoundaryLimits.maxStringBytes);
    const exact = Array.from({ length: 4 }, () => segment);

    expect(
      createJsonBoundarySnapshot(exact, { field: 'result' })
    ).toHaveLength(4);
    expect(() =>
      createJsonBoundarySnapshot([...exact, 'x'], { field: 'result' })
    ).toThrow('result exceeds the aggregate JSON text limit');
  });

  it('applies the same byte budget to JSON object keys', () => {
    const oversizedKey = 'k'.repeat(
      defaultJsonBoundaryLimits.maxStringBytes + 1
    );

    expect(() =>
      createJsonBoundarySnapshot({ [oversizedKey]: true }, { field: 'result' })
    ).toThrow('result object key exceeds the JSON string byte limit');
  });

  it('accepts exact depth, container, and node limits and rejects plus one', () => {
    const nested = (depth: number): unknown => {
      let value: unknown = null;

      for (let index = 0; index < depth; index += 1) {
        value = [value];
      }

      return value;
    };
    const exactNodes = [
      ...Array.from({ length: 15 }, () => Array.from({ length: 255 }, () => null)),
      Array.from({ length: 254 }, () => null)
    ];
    const overNodes = [
      ...exactNodes.slice(0, -1),
      Array.from({ length: 255 }, () => null)
    ];

    expect(
      createJsonBoundarySnapshot(nested(defaultJsonBoundaryLimits.maxDepth), {
        field: 'result'
      })
    ).toBeDefined();
    expect(() =>
      createJsonBoundarySnapshot(
        nested(defaultJsonBoundaryLimits.maxDepth + 1),
        { field: 'result' }
      )
    ).toThrow('exceeds the JSON depth limit');
    expect(
      createJsonBoundarySnapshot(
        Array.from(
          { length: defaultJsonBoundaryLimits.maxEntriesPerContainer },
          () => null
        ),
        { field: 'result' }
      )
    ).toHaveLength(defaultJsonBoundaryLimits.maxEntriesPerContainer);
    expect(() =>
      createJsonBoundarySnapshot(
        Array.from(
          { length: defaultJsonBoundaryLimits.maxEntriesPerContainer + 1 },
          () => null
        ),
        { field: 'result' }
      )
    ).toThrow('exceeds the JSON container entry limit');
    expect(createJsonBoundarySnapshot(exactNodes, { field: 'result' })).toBeDefined();
    expect(() =>
      createJsonBoundarySnapshot(overNodes, { field: 'result' })
    ).toThrow('exceeds the JSON node limit');
  });
});
