import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createConversationSession
} from '../src/core/conversation.ts';
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
import {
  createRuntimeLogStore
} from '../src/runtime/log.ts';
import {
  runtimeConfigVersion
} from '../src/runtime/config/index.ts';
import {
  createFileRuntimeLogStore
} from '../src/runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeStorageLayout
} from '../src/runtime/storage/layout.ts';
import {
  createLocalRuntimeSessionStore
} from '../src/runtime/storage/session-store.ts';
import type {
  RoleModelAdapter
} from '../src/role-model/loop.ts';
import {
  nvidiaApiKeyEnvName
} from '../src/role-model/providers/nvidia.ts';
import { runChatCli, runChatCliFromArgs } from '../src/cli/chat.ts';
import { runInspectCliFromArgs } from '../src/cli/inspect.ts';

const roleModelProviderEnvName = 'PROJECT02_ROLE_MODEL_PROVIDER';

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

describe('chat CLI provider selection', () => {
  it('loads the runtime store env before selecting the default chat provider', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-provider-env-'));
    const sessionId = 'runtime-env-provider';
    let stderr = '';

    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=nvidia\n`);

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['hello\n']),
        stdout: collect(() => {}),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        env: {
          [nvidiaApiKeyEnvName]: ''
        }
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`NVIDIA provider requires ${nvidiaApiKeyEnvName}.`);
  });

  it('lets --provider take precedence over the runtime store env', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-provider-cli-'));
    let stderr = '';

    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=not-a-provider\n`);

    const exitCode = await runChatCliFromArgs(
      ['--provider', 'local', '--store', storeRoot, '--new-session', 'cli-provider'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        env: {}
      }
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
  });
});

describe('chat CLI plugin lifecycle', () => {
  it('runs session-end hooks when /exit closes the chat', async () => {
    const sessionEndContexts: RuntimePluginContext[] = [];
    const logStore = createRuntimeLogStore();
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
      logStore,
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
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
      runtimePluginEvidence: [
        {
          pluginId: 'chat.session-end.fixture',
          evidenceKind: 'session_end',
          status: 'accepted',
          summary: 'Session end observed.'
        }
      ],
      runtimePluginTurnEvidence: {
        evidence: [
          {
            pluginId: 'chat.session-end.fixture',
            evidenceKind: 'session_end',
            status: 'accepted',
            summary: 'Session end observed.'
          }
        ]
      }
    });
  });

  it('preserves an injected plugin host when configured plugin activation would fail', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-injected-host-'));
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'character-state': {
          config: {
            typoo: true
          }
        }
      }
    });
    const sessionId = 'injected-host-session';
    const sessionEndContexts: RuntimePluginContext[] = [];
    const pluginHost = createRuntimePluginHost({
      plugins: [
        createSessionEndPlugin((context) => {
          sessionEndContexts.push(context);
        })
      ]
    });
    let stderr = '';

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--config', configPath, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        pluginHost
      }
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(sessionEndContexts).toHaveLength(1);

    const storedRawEvents = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    }).rawEvents();

    expect(storedRawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
      runtimePluginEvidence: [
        {
          pluginId: 'chat.session-end.fixture',
          evidenceKind: 'session_end',
          status: 'accepted',
          summary: 'Session end observed.'
        }
      ]
    });
  });

  it('constructs configured manifest-backed plugins once during chat startup', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-configured-host-'));
    const sessionId = 'configured-host-session';
    const configuredPlugin = createSessionEndPlugin(() => {});
    const sessionEndContexts: RuntimePluginContext[] = [];
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true
        }
      }
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(() => {}),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              factoryCalls += 1;

              return createSessionEndPlugin((context) => {
                sessionEndContexts.push(context);
              });
            }
          }
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(1);
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId,
      currentUserMessage: '/exit'
    });
  });

  it('aborts startup when configured plugin activation reports errors', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-activation-error-'));
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'character-state': {
          config: {
            typoo: true
          }
        }
      }
    });
    let stdout = '';
    let stderr = '';

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--config', configPath, '--new-session', 'activation-error'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        })
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config activation failed');
    expect(stderr).toContain('runtime_config_unknown_plugin_config_field');
    expect(stderr).toContain('plugins.character-state.config.typoo');
    expect(stderr).toContain('Unknown config field "typoo" for plugin "character-state".');
  });

  it('persists session-end hook failures when stdin closes normally', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'project02-chat-session-end-'));
    const sessionId = 'session-end-failure';
    await createLocalRuntimeSessionStore({ storeRoot }).createSession({
      sessionId,
      createdAt: '2026-06-16T00:00:00.000Z'
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    });
    const pluginHost = createRuntimePluginHost({
      plugins: [createFailingSessionEndPlugin()]
    });

    const exitCode = await runChatCli({
      stdin: Readable.from([]),
      stdout: collect(() => {}),
      stderr: collect(() => {}),
      session: createConversationSession({ id: sessionId }),
      logStore,
      pluginHost
    });

    expect(exitCode).toBe(0);

    const storedRawEvents = createFileRuntimeLogStore({
      storeRoot,
      sessionId
    }).rawEvents();

    expect(storedRawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed_with_failures',
      payloadSummary: {
        rawInput: '/exit',
        normalizedCurrentUserMessage: '/exit'
      },
      runtimePluginEvidence: [
        {
          pluginId: 'chat.session-end.failure.fixture',
          evidenceKind: 'session_end',
          status: 'failed',
          summary: 'Session end fixture failed.'
        }
      ]
    });

    let stdout = '';
    const inspectExitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', sessionId],
      {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect(() => {})
      }
    );
    const output = JSON.parse(stdout) as {
      readonly turns: readonly [
        {
          readonly status: string;
          readonly pluginEvidence: {
            readonly evidence: readonly [
              {
                readonly pluginId: string;
                readonly evidenceKind: string;
                readonly status: string;
                readonly summary: string;
              }
            ];
          };
        }
      ];
    };

    expect(inspectExitCode).toBe(0);
    expect(output.turns[0]).toMatchObject({
      status: 'completed_with_failures',
      pluginEvidence: {
        evidence: [
          {
            pluginId: 'chat.session-end.failure.fixture',
            evidenceKind: 'session_end',
            status: 'failed',
            summary: 'Session end fixture failed.'
          }
        ]
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

function createFailingSessionEndPlugin(): RuntimePlugin {
  const pluginId = 'chat.session-end.failure.fixture';

  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Chat Session End Failure Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin for failed chat session end lifecycle.',
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
        return {
          status: 'failed',
          evidence: [
            createRuntimePluginEvidenceSnapshot({
              eventId: context.eventId,
              traceId: context.traceId,
              createdAt: context.timestamp,
              kind: 'runtime_plugin_evidence_snapshot',
              pluginId,
              evidenceKind: 'session_end',
              status: 'failed',
              summary: 'Session end fixture failed.',
              redactionLabels: []
            })
          ]
        };
      }
    }
  });
}

function writeRuntimeConfig(
  path: string,
  config: Readonly<Record<string, unknown>>
): string {
  writeFileSync(
    path,
    `${JSON.stringify({ version: runtimeConfigVersion, ...config }, null, 2)}\n`,
    'utf8'
  );
  return path;
}

function writeRuntimeEnv(storeRoot: string, content: string): void {
  writeFileSync(
    createLocalRuntimeStorageLayout({ storeRoot }).envPath,
    content,
    'utf8'
  );
}

function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk));
      callback();
    }
  });
}
