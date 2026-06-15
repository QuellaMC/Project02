import { describe, expect, it } from 'vitest';

import {
  createRuntimeEventIdentity
} from '../src/runtime/event.ts';
import {
  createRuntimePlugin,
  createRuntimePluginContext,
  createRuntimePluginEvidenceSnapshot,
  runtimePluginContractVersion
} from '../src/plugins/types.ts';
import {
  createRuntimePluginHost,
  runtimePluginDiscoveryPluginId
} from '../src/plugins/host.ts';
import {
  roleModelPluginListToolName
} from '../src/role-model/contracts.ts';
import type {
  RuntimePlugin
} from '../src/plugins/types.ts';

describe('runtime plugin host', () => {
  it('routes plugin.list through the host-owned discovery plugin', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [runtimePluginDiscoveryPluginId, plugin.manifest.id]
    });
    const context = testPluginContext();

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginDiscoveryPluginId,
        toolName: roleModelPluginListToolName,
        input: {}
      },
      context
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected plugin.list to be accepted.');
    }

    expect(result.output).toMatchObject({
      plugins: [
        {
          id: runtimePluginDiscoveryPluginId
        },
        {
          id: 'memory.search.fixture'
        }
      ]
    });
  });

  it('rejects duplicate model-facing tool names across enabled plugins', () => {
    expect(() =>
      createRuntimePluginHost({
        plugins: [
          createMemorySearchPlugin('memory.one'),
          createMemorySearchPlugin('memory.two')
        ]
      })
    ).toThrow(/declared more than once/iu);
  });

  it('turns handler failures into rejected tool observations', async () => {
    const plugin = createMemorySearchPlugin('memory.failing', true);
    const host = createRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed'
    });
  });

  it('rejects plugin-host-owned invalid input before invoking the handler', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {}
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_input',
      message: 'memory.search input missing required field "query".'
    });
  });
});

function createMemorySearchPlugin(
  id = 'memory.search.fixture',
  fails = false
): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      id,
      displayName: 'Memory Search Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test'
      },
      declaredPlugins: ['tool_provider', 'handle_tool_call'],
      config: {
        fields: []
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: false,
        sideEffectLevel: 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test']
      },
      requestedApis: []
    },
    providedTools: [
      {
        name: 'memory.search',
        description: 'Search memory.',
        requiredForUserTurn: false,
        maxCallsPerUserTurn: 1,
        inputContract: {
          type: 'object',
          fields: [
            {
              name: 'query',
              description: 'Search query.',
              required: true
            }
          ],
          additionalFields: false
        },
        validationOwner: 'plugin_host',
        sideEffectLevel: 'runtime_read',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      }
    ],
    lifecycleHooks: {
      handleToolCall(call, context) {
        if (fails) {
          throw new Error('search backend failed');
        }

        const query = call.input['query'];
        if (typeof query !== 'string') {
          throw new Error('Expected query string.');
        }

        return {
          status: 'accepted',
          output: {
            matched: query
          },
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId: id,
              evidenceKind: 'tool_invocation',
              status: 'accepted',
              summary: 'Search completed.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function testPluginContext() {
  return createRuntimePluginContext({
    ...testIdentity(),
    sessionId: 'session-plugin-host',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'hello',
    character: {
      id: 'mira',
      displayName: 'Mira'
    }
  });
}

function testIdentity() {
  return createRuntimeEventIdentity({
    eventId: 'evt_plugin_host',
    traceId: 'trace_plugin_host',
    createdAt: '2026-06-15T00:00:00.000Z'
  });
}
