import { describe, expect, it } from 'vitest';

import {
  createRuntimePluginToolInvocationSnapshot,
  redactRuntimePluginText
} from '../src/plugins/types.ts';
import type {
  RuntimePluginJsonObject,
  RuntimePluginJsonValue
} from '../src/plugins/types.ts';

describe('runtime plugin text redaction', () => {
  it('redacts JSON-shaped quoted secret keys', () => {
    const cases = [
      ['{"api_key":"super-secret"}', '{"api_key":"[redacted]"}'],
      ['"password": "open-sesame"', '"password": "[redacted]"'],
      ['{ "token" : "secret-token" }', '{ "token" : "[redacted]" }'],
      ["'secret': 'hidden-value'", "'secret': '[redacted]'"]
    ] as const;

    for (const [input, expected] of cases) {
      expect(redactRuntimePluginText(input)).toBe(expected);
    }
  });

  it('redacts URI query values with credential-shaped keys', () => {
    const input =
      'https://example.test/search?api.key=dotted-secret&api_key=underscore-secret&api-key=hyphen-secret&safe=kept#section';

    const redacted = redactRuntimePluginText(input);

    expect(redacted).toBe(
      'https://example.test/search?api.key=[redacted]&api_key=[redacted]&api-key=[redacted]&safe=kept#section'
    );
    expect(redacted).not.toContain('dotted-secret');
    expect(redacted).not.toContain('underscore-secret');
    expect(redacted).not.toContain('hyphen-secret');
  });

  it('redacts structured values under credential-shaped plugin result keys', () => {
    const snapshot = createRuntimePluginToolInvocationSnapshot({
      eventId: 'evt_plugin_structured_redaction',
      traceId: 'trace_plugin_structured_redaction',
      createdAt: '2026-06-16T00:00:00.000Z',
      kind: 'runtime_plugin_tool_invocation_snapshot',
      pluginId: 'memory.structured-secret.fixture',
      toolName: 'memory.search',
      input: {
        query: 'Mira'
      },
      result: {
        status: 'accepted',
        output: {
          api_key: 'super-secret',
          nested: {
            password: 'open-sesame',
            safe: 'kept'
          },
          list: [
            {
              access_token: 'secret-token',
              label: 'kept'
            }
          ]
        },
        evidence: []
      }
    });

    expect(snapshot.result).toMatchObject({
      status: 'accepted',
      output: {
        api_key: '[redacted]',
        nested: {
          password: '[redacted]',
          safe: 'kept'
        },
        list: [
          {
            access_token: '[redacted]',
            label: 'kept'
          }
        ]
      }
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('open-sesame');
    expect(serialized).not.toContain('secret-token');
  });

  it('preserves own __proto__ keys in accepted tool output snapshots', () => {
    const snapshot = createRuntimePluginToolInvocationSnapshot({
      eventId: 'evt_plugin_proto_snapshot',
      traceId: 'trace_plugin_proto_snapshot',
      createdAt: '2026-06-16T00:00:00.000Z',
      kind: 'runtime_plugin_tool_invocation_snapshot',
      pluginId: 'memory.proto.fixture',
      toolName: 'memory.search',
      input: {
        query: 'Mira'
      },
      result: {
        status: 'accepted',
        output: createProtoKeyOutput(),
        evidence: []
      }
    });

    expect(snapshot.result.status).toBe('accepted');
    if (snapshot.result.status !== 'accepted') {
      throw new Error('Expected accepted tool output.');
    }

    const output = expectJsonObject(snapshot.result.output);
    const nested = expectJsonObject(output['nested']);

    expect(Object.hasOwn(output, '__proto__')).toBe(true);
    expect(output['__proto__']).toEqual({
      polluted: true
    });
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(nested['__proto__']).toBe('nested-value');
    expect(JSON.stringify(output)).toContain(
      '"__proto__":{"polluted":true}'
    );
    expect(JSON.stringify(output)).toContain(
      '"nested":{"__proto__":"nested-value"}'
    );
  });
});

function createProtoKeyOutput(): RuntimePluginJsonObject {
  const nested: Record<string, RuntimePluginJsonValue> = {};
  Object.defineProperty(nested, '__proto__', {
    value: 'nested-value',
    enumerable: true
  });

  const output: Record<string, RuntimePluginJsonValue> = {
    nested
  };
  Object.defineProperty(output, '__proto__', {
    value: {
      polluted: true
    },
    enumerable: true
  });

  return output;
}

function expectJsonObject(
  value: RuntimePluginJsonValue | undefined
): RuntimePluginJsonObject {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    isJsonArray(value)
  ) {
    throw new Error('Expected JSON object.');
  }

  return value;
}

function isJsonArray(
  value: RuntimePluginJsonValue
): value is readonly RuntimePluginJsonValue[] {
  return Array.isArray(value);
}
