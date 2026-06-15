import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createRuntimePluginHost
} from '../src/plugins/host.ts';
import {
  createRuntimePlugin,
  createRuntimePluginEvidenceSnapshot,
  runtimePluginContractVersion,
  type RuntimePlugin,
  type RuntimePluginContext
} from '../src/plugins/types.ts';
import type {
  RoleModelAdapter
} from '../src/role-model/loop.ts';
import { runChatCli } from '../src/cli/chat.ts';

describe('chat CLI folded top-level model text', () => {
  it('hides top-level model text by default', async () => {
    let stdout = '';
    const exitCode = await runChatCli({
      stdin: Readable.from(['hello\n/exit\n']),
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect(() => {}),
      roleModelAdapter: createTextOnlyAdapter()
    });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('folded model note');
  });
});

describe('chat CLI plugin lifecycle', () => {
  it('runs session-end hooks when /exit closes the chat', async () => {
    const sessionEndContexts: RuntimePluginContext[] = [];
    const pluginHost = createRuntimePluginHost({
      plugins: [
        createSessionEndPlugin((context) => {
          sessionEndContexts.push(context);
        })
      ]
    });

    const exitCode = await runChatCli({
      stdin: Readable.from(['/exit\n']),
      stdout: collect(() => {}),
      stderr: collect(() => {}),
      pluginHost
    });

    expect(exitCode).toBe(0);
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId: 'local-session',
      currentUserMessage: '/exit',
      character: {
        id: 'mira',
        displayName: 'Mira'
      }
    });
  });
});

function createTextOnlyAdapter(): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          text: 'folded model note',
          toolCalls: []
        })
      };
    }
  };
}

function createSessionEndPlugin(
  onSessionEnd: (context: RuntimePluginContext) => void
): RuntimePlugin {
  const pluginId = 'chat.session-end.fixture';

  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Chat Session End Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin for chat session end lifecycle.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test'
      },
      declaredPlugins: ['on_session_end'],
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
    providedTools: [],
    lifecycleHooks: {
      onSessionEnd(context) {
        onSessionEnd(context);

        return {
          status: 'completed',
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'session_end',
              status: 'accepted',
              summary: 'Session end observed.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk));
      callback();
    }
  });
}
