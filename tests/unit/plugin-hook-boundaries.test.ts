import {describe, expect, it} from 'vitest';

import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {
  createRuntimePlugin,
  createRuntimePluginContext,
  runtimePluginContractVersion,
} from '../../src/plugins/api/index.ts';

describe('runtime plugin hook result boundaries', () => {
  it('rejects aggregate hook text over 64 KiB even when each record is in range', async () => {
    const pluginId = 'memory.aggregate-boundary.fixture';
    const summary = 'x'.repeat(14 * 1_024);
    const plugin = createRuntimePlugin({
      manifest: {
        id: pluginId,
        displayName: 'Aggregate Boundary Fixture',
        version: '1.0.0',
        kind: 'memory_provider',
        description: 'Exercises the aggregate hook-result boundary.',
        contractVersion: runtimePluginContractVersion,
        compatibility: {
          hostContractVersions: [runtimePluginContractVersion],
          sourceSystem: 'test',
        },
        declaredPlugins: ['before_role_model_call'],
        config: {fields: []},
        localTrustLevel: 'test_fixture',
        runtimePolicy: {
          requiredForTurn: false,
          sideEffectLevel: 'runtime_read',
          confirmation: 'not_required',
          timeoutMs: 10_000,
          sourceReferencesRequired: false,
          redactionLabels: [],
          failureBehavior: {
            beforeRoleModelCall: 'degrade',
            handleToolCall: 'reject_tool_call',
            afterTurnCommitted: 'log_failure',
            health: 'degrade',
          },
        },
        activation: {
          defaultEnabled: true,
          reasons: ['test'],
        },
        requestedAccess: {model_input: 'write'},
      },
      providedTools: [],
      lifecycleHooks: {
        beforeRoleModelCall(context) {
          return {
            contextItems: [],
            evidence: Array.from({length: 5}, () => ({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot' as const,
              pluginId,
              evidenceKind: 'before_role_model_call' as const,
              status: 'accepted' as const,
              summary,
              redactionLabels: [],
            })),
          };
        },
      },
    });
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [pluginId],
    });
    const result = await host.beforeRoleModelCall(
      createRuntimePluginContext({
        eventId: 'evt_hook_aggregate_boundary',
        traceId: 'trace_hook_aggregate_boundary',
        createdAt: '2026-07-11T00:00:00.000Z',
        sessionId: 'session-hook-aggregate-boundary',
        eventType: 'USER_MESSAGE',
        currentUserMessage: 'hello',
        character: {id: 'mira', displayName: 'Mira'},
      }),
    );

    expect(result.status).toBe('completed');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      pluginId,
      status: 'degraded',
      policyOutcome: 'optional_degraded',
    });
    expect(result.evidence[0]?.summary).toContain('aggregate JSON text limit');
    expect(JSON.stringify(result)).not.toContain(summary);
  });
});
