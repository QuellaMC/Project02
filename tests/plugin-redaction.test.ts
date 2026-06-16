import { describe, expect, it } from 'vitest';

import {
  createRuntimePluginToolInvocationSnapshot,
  redactRuntimePluginText
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
});
