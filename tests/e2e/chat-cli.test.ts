import {
  testCharacterProfile,
  writeTestCharacterPackage,
} from '../support/character-fixtures.ts';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough, Readable} from 'node:stream';

import {describe, expect, it, vi} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {
  writeRuntimeConfig,
  runtimeLocationForTest,
} from '../support/runtime-config.ts';
import {
  createInitializedTestStoreRoot,
  withScopedProcessEnv,
} from '../support/runtime-config-fixtures.ts';
import {collect} from '../support/streams.ts';

import {createConversationSession} from '../../src/core/index.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {createRuntimePluginManagementPluginManifest} from '../../src/plugins/index.ts';
import {
  createRuntimePlugin,
  createRuntimePluginEvidenceSnapshot,
  runtimePluginId,
  runtimePluginConfigUpdateToolName,
  runtimePluginContractVersion,
  type RuntimePlugin,
  type RuntimePluginContext,
} from '../../src/plugins/api/index.ts';
import {type RuntimeLogStore} from '../../src/runtime/evidence/records.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {
  runtimeConfigEnvVarName,
  inspectRuntimePluginConfig,
} from '../../src/runtime/config/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {
  characterDataDirPath,
  createLocalRuntimeStorageLayout,
  createProject02HomeLayout,
  decodeStorageSchemaMarker,
} from '../../src/runtime/storage/layout-contract.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {nvidiaApiKeyEnvName} from '../../src/role-model/providers/nvidia.ts';
import {runChatCli, runChatCliFromArgs} from '../../src/cli/chat/main.ts';
import {runInspectCliFromArgs} from '../../src/cli/inspect/main.ts';
import {resolveRuntimeCliStartup} from '../../src/app/index.ts';

const roleModelProviderEnvName = 'PROJECT02_ROLE_MODEL_PROVIDER';
const realSetTimeout = globalThis.setTimeout;

describe('chat CLI folded top-level model text', () => {
  it('hides top-level model text by default', async () => {
    let stdout = '';
    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['hello\n/exit\n']),
      stdout: collect(chunk => {
        stdout += chunk;
      }),
      stderr: collect(() => {}),
      roleModelAdapter: createTextOnlyAdapter(),
    });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('folded model note');
  });

  it('rejects a direct invocation without a session or character profile', async () => {
    await expect(
      runChatCli({
        pluginHost: createDefaultProject02PluginHost(),
        stdin: Readable.from(['hello\n/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(() => {}),
      }),
    ).rejects.toThrow(
      'Chat startup requires a session or a character profile.',
    );
  });
});

describe('chat CLI trace summary', () => {
  it('keeps provider and terminal tool evidence when terminal persistence fails', async () => {
    let stderr = '';
    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['hello\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      logStore: createTerminalRawEventAppendFailingLogStore(),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'hello from a failed terminal commit',
                  },
                },
              ],
            }),
            providerMetadata: {
              provider: 'nvidia',
              model: 'trace-fixture',
              request: {
                messageCount: 3,
                stream: false,
              },
              response: {
                status: 200,
              },
            },
          };
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      provider: {
        name: 'nvidia',
        model: 'trace-fixture',
        responseStatus: 200,
      },
      requestedToolCalls: ['visible_reply'],
      executedToolCalls: [],
      terminalToolCalls: ['visible_reply'],
    });
  });

  it('does not classify an interrupted executable round as terminal', async () => {
    let adapterRound = 0;
    let stderr = '';
    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['inspect plugins\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      roleModelAdapter: {
        invoke() {
          adapterRound += 1;

          if (adapterRound > 1) {
            throw new Error('provider failed before terminal output');
          }

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'runtime.plugin.list',
                  input: {},
                },
              ],
            }),
            providerMetadata: {
              provider: 'nvidia',
              model: 'trace-fixture',
              request: {
                messageCount: 3,
                stream: false,
              },
              response: {
                status: 200,
              },
            },
          };
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      provider: {
        name: 'nvidia',
        model: 'trace-fixture',
        responseStatus: 200,
      },
      requestedToolCalls: ['runtime.plugin.list'],
      executedToolCalls: ['runtime.plugin.list'],
      terminalToolCalls: [],
    });
  });

  it('recovers requested calls from interim evidence when tool-start tracing fails', async () => {
    let stderr = '';
    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['inspect plugins\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      logStore: createToolTraceFailingLogStore('tool_call_started'),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'Checking the plugin inventory.',
                  },
                },
                {
                  name: 'runtime.plugin.list',
                  input: {},
                },
              ],
            }),
          };
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['visible_reply', 'runtime.plugin.list'],
      executedToolCalls: [],
      terminalToolCalls: [],
    });
  });

  it('keeps tool-only requested evidence when tool-start tracing fails', async () => {
    let stderr = '';
    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['inspect plugins\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      logStore: createToolTraceFailingLogStore('tool_call_started'),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'runtime.plugin.list',
                  input: {},
                },
              ],
            }),
          };
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['runtime.plugin.list'],
      executedToolCalls: [],
      terminalToolCalls: [],
    });
  });

  it('keeps host-executed evidence when tool-finish tracing fails', async () => {
    let stderr = '';
    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['inspect plugins\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      logStore: createToolTraceFailingLogStore('tool_call_finished'),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'runtime.plugin.list',
                  input: {},
                },
              ],
            }),
          };
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['runtime.plugin.list'],
      executedToolCalls: ['runtime.plugin.list'],
      terminalToolCalls: [],
    });
  });

  it('keeps interim requested evidence when interim tracing fails', async () => {
    let stderr = '';
    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['inspect plugins\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      logStore: createToolTraceFailingLogStore('visible_message_committed'),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'Checking the plugin inventory.',
                  },
                },
                {
                  name: 'runtime.plugin.list',
                  input: {},
                },
              ],
            }),
          };
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['visible_reply', 'runtime.plugin.list'],
      executedToolCalls: [],
      terminalToolCalls: [],
    });
  });

  it('keeps final terminal evidence and a readable conversation when commit tracing fails', async () => {
    const storeRoot = createTestTempRoot(
      'project02-chat-visible-trace-failure-',
    );
    const sessionId = 'visible-trace-failure';
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-07-10T00:00:00.000Z',
    });
    const backingLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId,
    });
    let stderr = '';
    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost({
        storeRoot: characterDataDirPath(storeRoot, 'mira'),
        sessionId,
      }),
      stdin: Readable.from(['hello\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      session: createConversationSession({
        id: sessionId,
        character: testCharacterProfile,
      }),
      logStore: createToolTraceFailingLogStore(
        'visible_message_committed',
        backingLogStore,
      ),
      roleModelAdapter: {
        invoke() {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {
                    text: 'Final reply before trace failure.',
                  },
                },
              ],
            }),
          };
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      requestedToolCalls: ['visible_reply'],
      executedToolCalls: [],
      terminalToolCalls: ['visible_reply'],
    });

    const reopenedLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId,
    });

    expect(
      reopenedLogStore.conversationMessages().map(message => message.text),
    ).toEqual(['hello', 'Final reply before trace failure.']);
    expect(reopenedLogStore.rawEvents().map(event => event.kind)).toEqual(
      expect.arrayContaining([
        'visible_message_committed',
        'runtime_turn_rejected',
      ]),
    );
  });

  it('distinguishes requested, executed, and terminal tool calls for the whole turn', async () => {
    let adapterRound = 0;
    let stderr = '';
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        adapterRound += 1;

        return {
          rawOutputText: JSON.stringify(
            adapterRound === 1
              ? {
                  toolCalls: [
                    {
                      name: 'runtime.plugin.list',
                      input: {},
                    },
                    {
                      name: 'visible_reply',
                      input: {
                        text: 'Checking the plugin inventory.',
                      },
                    },
                    {
                      name: 'character_state.patch',
                      input: {
                        mood: 'curious',
                      },
                    },
                  ],
                }
              : {
                  toolCalls: [
                    {
                      name: 'visible_reply',
                      input: {
                        text: 'The plugin inventory is available.',
                      },
                    },
                  ],
                },
          ),
        };
      },
    };

    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['check plugins\n/exit\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      roleModelAdapter,
    });

    expect(exitCode).toBe(0);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'completed',
      requestedToolCalls: [
        'runtime.plugin.list',
        'visible_reply',
        'character_state.patch',
        'visible_reply',
      ],
      executedToolCalls: ['runtime.plugin.list', 'character_state.patch'],
      terminalToolCalls: ['visible_reply'],
    });
    expect(JSON.parse(stderr.trim())).not.toHaveProperty('toolCalls');
  });

  it('returns undeclared calls to the model and completes after correction', async () => {
    let adapterRound = 0;
    let stderr = '';
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        adapterRound += 1;

        if (adapterRound === 1) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'memory.unknown',
                  input: {
                    query: 'Mira',
                  },
                },
              ],
            }),
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {text: 'that tool is unavailable'},
              },
            ],
          }),
        };
      },
    };

    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['try an unavailable tool\n/exit\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      roleModelAdapter,
    });

    expect(exitCode).toBe(0);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'completed',
      requestedToolCalls: ['memory.unknown', 'visible_reply'],
      executedToolCalls: [],
      terminalToolCalls: ['visible_reply'],
    });
  });

  it('does not count native argument validation failures as executed calls', async () => {
    let adapterRound = 0;
    let stderr = '';
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        adapterRound += 1;

        if (adapterRound === 1) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'runtime.plugin.list',
                  input: {},
                },
              ],
            }),
            nativeAssistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_invalid_runtime_plugin_list_args',
                  type: 'function',
                  function: {
                    name: 'runtime.plugin.list',
                    arguments: '{"score":1e999}',
                  },
                },
              ],
            },
            nativeToolCallArgumentErrors: [
              {
                executableIndex: 0,
                toolName: 'runtime.plugin.list',
                reason: 'invalid_native_tool_arguments',
                message:
                  'runtime.plugin.list arguments must contain finite JSON values.',
              },
            ],
          };
        }

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'The invalid arguments were rejected.',
                },
              },
            ],
          }),
        };
      },
    };

    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['try invalid plugin arguments\n/exit\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      roleModelAdapter,
    });

    expect(exitCode).toBe(0);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      requestedToolCalls: ['runtime.plugin.list', 'visible_reply'],
      executedToolCalls: [],
      terminalToolCalls: ['visible_reply'],
    });
  });

  it('counts a host-dispatched rejection as an executed tool call', async () => {
    let adapterRound = 0;
    let stderr = '';
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        adapterRound += 1;

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              adapterRound === 1
                ? {
                    name: 'character_state.patch',
                    input: {
                      activity: 'reflecting',
                    },
                  }
                : {
                    name: 'visible_reply',
                    input: {
                      text: 'The invalid state patch was rejected.',
                    },
                  },
            ],
          }),
        };
      },
    };

    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['try an invalid state patch\n/exit\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      traceMode: true,
      roleModelAdapter,
    });

    expect(exitCode).toBe(0);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      requestedToolCalls: ['character_state.patch', 'visible_reply'],
      executedToolCalls: ['character_state.patch'],
      terminalToolCalls: ['visible_reply'],
    });
  });
});

describe('chat CLI character selection', () => {
  // Storage staying clean is startup-seam behavior, asserted once in
  // tests/unit/runtime-config-overlay.test.ts. This covers only the chat
  // CLI's own job: routing character_invalid to an exit code and message.
  it('maps an invalid explicit character to a usage error', async () => {
    const storeRoot = createTestTempRoot('project02-chat-invalid-character-');
    let stderr = '';

    const exitCode = await runChatCliFromArgs(
      [
        '--store',
        storeRoot,
        '--character',
        '../bad',
        '--new-session',
        'invalid-character',
      ],
      {
        stdin: Readable.from([]),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        pluginHost: createRuntimePluginHost({plugins: []}),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('--character must start with a letter');
  });

  it('speaks as an operator-installed character selected by config', async () => {
    const storeRoot = createTestTempRoot('project02-chat-character-swap-');
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {character: 'zeta'},
    });
    writeTestCharacterPackage(storeRoot, {
      id: 'zeta',
      displayName: 'Zeta',
      personaSections: ['You are Zeta, a fixture character.'],
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'zeta-session'],
      {
        stdin: Readable.from(['hello\n/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        pluginHost: createRuntimePluginHost({plugins: []}),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Zeta is ready.');
    expect(stdout).toContain('Zeta:');
  });

  it('rejects an invalid session id before materializing any character state', async () => {
    const storeRoot = createTestTempRoot('project02-chat-bad-session-');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'bad/session'],
      {
        stdin: Readable.from([]),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        pluginHost: createRuntimePluginHost({plugins: []}),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      'Local runtime session ID must use only letters, numbers, dots, ' +
        'underscores, or hyphens.',
    );
    // Session args were validated before startup: no home marker and
    // no character data directory were created.
    expect(existsSync(join(storeRoot, 'schema.json'))).toBe(false);
    expect(existsSync(characterDataDirPath(storeRoot, 'mira'))).toBe(false);
  });

  it('rejects an unknown configured character naming the discovered ids', async () => {
    const storeRoot = createTestTempRoot('project02-chat-character-missing-');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {character: 'ghost'},
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'ghost-session'],
      {
        stdin: Readable.from(['hello\n/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        pluginHost: createRuntimePluginHost({plugins: []}),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Character "ghost" was not found');
    expect(stderr).toContain('mira');
  });
});

describe('chat CLI provider selection', () => {
  it('selects the chat provider from project02.roleModelProvider', async () => {
    const storeRoot = createTestTempRoot('project02-chat-provider-config-');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {
        roleModelProvider: 'nvidia',
      },
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'configured-provider'],
      {
        stdin: Readable.from(['hello\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {
          [nvidiaApiKeyEnvName]: '',
        },
        pluginHost: createRuntimePluginHost({plugins: []}),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toContain(
      `NVIDIA provider requires ${nvidiaApiKeyEnvName}.`,
    );
  });

  it('lets the runtime env provider override project02.roleModelProvider', async () => {
    const storeRoot = createTestTempRoot('project02-chat-provider-env-config-');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {
        roleModelProvider: 'nvidia',
      },
    });
    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=local\n`);

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'env-over-config-provider'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {
          [nvidiaApiKeyEnvName]: '',
        },
        pluginHost: createRuntimePluginHost({plugins: []}),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
  });

  it('reports an invalid provider environment value as a CLI error', async () => {
    const storeRoot = await createInitializedTestStoreRoot(
      'project02-chat-provider-invalid-env-',
    );
    let stderr = '';
    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'invalid-provider-env'],
      {
        stdin: Readable.from(['hello\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {[roleModelProviderEnvName]: 'bogus'},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('must be either "local" or "nvidia"');
    // The env is judged in the startup planning phase, so the value that
    // makes this command unusable is reported before the run sets up the
    // character. The store itself is arrangement — the operator already
    // has one — so what a rejected run must not leave behind is the
    // character data directory this command would have created.
    expect(existsSync(characterDataDirPath(storeRoot, 'mira'))).toBe(false);
  });

  it('reports an invalid provider value from the home env file before materializing character state', async () => {
    const storeRoot = createTestTempRoot('project02-chat-provider-env-file-');
    let stderr = '';
    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=bogus\n`);

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'invalid-provider-env-file'],
      {
        stdin: Readable.from(['hello\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('must be either "local" or "nvidia"');
    expect(existsSync(join(storeRoot, 'schema.json'))).toBe(false);
    expect(existsSync(characterDataDirPath(storeRoot, 'mira'))).toBe(false);
  });

  it('releases the durable writer lease when the provider turn fails', async () => {
    const storeRoot = createTestTempRoot(
      'project02-chat-provider-failure-lease-',
    );
    const sessionId = 'provider-failure-lease';
    let firstStderr = '';
    let secondStderr = '';
    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=nvidia\n`);

    const failedExitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['hello\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          firstStderr += chunk;
        }),
        env: {[nvidiaApiKeyEnvName]: ''},
      },
    );
    const recoveredExitCode = await runChatCliFromArgs(
      ['--provider', 'local', '--store', storeRoot, '--session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          secondStderr += chunk;
        }),
        env: {},
      },
    );

    expect(failedExitCode).toBe(0);
    expect(firstStderr).toContain(
      `NVIDIA provider requires ${nvidiaApiKeyEnvName}.`,
    );
    expect(recoveredExitCode).toBe(0);
    expect(secondStderr).toBe('');
  });

  it('lets the selected store env override the cwd dotenv defaults', async () => {
    const cwdRoot = createTestTempRoot('project02-chat-cwd-env-');
    const storeRoot = createTestTempRoot('project02-chat-store-env-');
    let stderr = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${roleModelProviderEnvName}=local\n${nvidiaApiKeyEnvName}=cwd-secret\n`,
      'utf8',
    );
    writeRuntimeEnv(
      storeRoot,
      `${roleModelProviderEnvName}=nvidia\n${nvidiaApiKeyEnvName}=\n`,
    );

    await withScopedProcessEnv(
      {
        cwd: cwdRoot,
        env: {
          [roleModelProviderEnvName]: undefined,
          [nvidiaApiKeyEnvName]: undefined,
          [runtimeConfigEnvVarName]: undefined,
        },
      },
      async () => {
        const exitCode = await runChatCliFromArgs(
          ['--store', storeRoot, '--new-session', 'selected-store-env'],
          {
            stdin: Readable.from(['hello\n']),
            stdout: collect(() => {}),
            stderr: collect(chunk => {
              stderr += chunk;
            }),
          },
        );

        expect(exitCode).toBe(0);
        expect(stderr).toContain(
          `NVIDIA provider requires ${nvidiaApiKeyEnvName}.`,
        );
      },
    );
  });

  it('ignores process and cwd dotenv runtime config selectors when --store is explicit', async () => {
    const cwdRoot = createTestTempRoot('project02-chat-cwd-config-');
    const defaultStoreRoot = createTestTempRoot(
      'project02-chat-default-config-store-',
    );
    const selectedStoreRoot = await createInitializedTestStoreRoot(
      'project02-chat-selected-config-store-',
    );
    const sessionId = 'selected-store-config';
    const defaultConfigPath = writeRuntimeConfig(
      join(defaultStoreRoot, 'config.json'),
      {
        storeRoot: defaultStoreRoot,
      },
    );
    let stderr = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${defaultConfigPath}\n${roleModelProviderEnvName}=local\n`,
      'utf8',
    );

    await withScopedProcessEnv(
      {
        cwd: cwdRoot,
        env: {
          [roleModelProviderEnvName]: undefined,
          [nvidiaApiKeyEnvName]: undefined,
          [runtimeConfigEnvVarName]: defaultConfigPath,
        },
      },
      async () => {
        const exitCode = await runChatCliFromArgs(
          ['--store', selectedStoreRoot, '--new-session', sessionId],
          {
            stdin: Readable.from(['/exit\n']),
            stdout: collect(() => {}),
            stderr: collect(chunk => {
              stderr += chunk;
            }),
          },
        );

        expect(exitCode).toBe(0);
        expect(stderr).toBe('');
        await expect(
          createLocalRuntimeSessionStore({
            storeRoot: characterDataDirPath(selectedStoreRoot, 'mira'),
            characterId: 'mira',
          }).readSession(sessionId),
        ).resolves.toMatchObject({
          sessionId,
        });
        expect(
          existsSync(
            createLocalRuntimeStorageLayout({
              storeRoot: characterDataDirPath(defaultStoreRoot, 'mira'),
            }).sessionCatalogPath,
          ),
        ).toBe(false);
      },
    );
  });

  it('uses an explicit store before reading an unrelated cwd dotenv', async () => {
    const cwdRoot = createTestTempRoot('project02-chat-cwd-dotenv-error-');
    const storeRoot = await createInitializedTestStoreRoot(
      'project02-chat-selected-dotenv-error-',
    );
    const sessionId = 'selected-store-before-cwd-dotenv';
    let stdout = '';
    let stderr = '';

    mkdirSync(join(cwdRoot, '.env'));

    await withScopedProcessEnv(
      {
        cwd: cwdRoot,
        env: {
          [roleModelProviderEnvName]: undefined,
          [nvidiaApiKeyEnvName]: undefined,
          [runtimeConfigEnvVarName]: undefined,
        },
      },
      async () => {
        const exitCode = await runChatCliFromArgs(
          ['--store', storeRoot, '--new-session', sessionId],
          {
            stdin: Readable.from(['/exit\n']),
            stdout: collect(chunk => {
              stdout += chunk;
            }),
            stderr: collect(chunk => {
              stderr += chunk;
            }),
          },
        );

        expect(exitCode).toBe(0);
        expect(stdout).toContain('Mira is ready.');
        expect(stderr).toBe('');
        await expect(
          createLocalRuntimeSessionStore({
            storeRoot: characterDataDirPath(storeRoot, 'mira'),
            characterId: 'mira',
          }).readSession(sessionId),
        ).resolves.toMatchObject({
          sessionId,
        });
      },
    );
  });

  it('uses a process-env selected runtime config before reading an unrelated cwd dotenv', async () => {
    const cwdRoot = createTestTempRoot('project02-chat-env-cwd-dotenv-error-');
    const selectedStoreRoot = await createInitializedTestStoreRoot(
      'project02-chat-env-selected-store-',
    );
    const configRoot = createTestTempRoot(
      'project02-chat-env-selected-config-',
    );
    const configPath = writeRuntimeConfig(
      join(configRoot, 'runtime-config.json'),
      {
        storeRoot: selectedStoreRoot,
      },
    );
    const sessionId = 'env-selected-store-before-cwd-dotenv';
    let stdout = '';
    let stderr = '';

    mkdirSync(join(cwdRoot, '.env'));

    await withScopedProcessEnv(
      {
        cwd: cwdRoot,
        env: {
          [roleModelProviderEnvName]: undefined,
          [nvidiaApiKeyEnvName]: undefined,
          [runtimeConfigEnvVarName]: configPath,
        },
      },
      async () => {
        const exitCode = await runChatCliFromArgs(
          ['--new-session', sessionId],
          {
            stdin: Readable.from(['/exit\n']),
            stdout: collect(chunk => {
              stdout += chunk;
            }),
            stderr: collect(chunk => {
              stderr += chunk;
            }),
          },
        );

        expect(exitCode).toBe(0);
        expect(stdout).toContain('Mira is ready.');
        expect(stderr).toBe('');
        await expect(
          createLocalRuntimeSessionStore({
            storeRoot: characterDataDirPath(selectedStoreRoot, 'mira'),
            characterId: 'mira',
          }).readSession(sessionId),
        ).resolves.toMatchObject({
          sessionId,
        });
      },
    );
  });

  it('loads the runtime store env before selecting the default chat provider', async () => {
    const storeRoot = createTestTempRoot('project02-chat-provider-env-');
    const sessionId = 'runtime-env-provider';
    let stderr = '';

    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=nvidia\n`);

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['hello\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {
          [nvidiaApiKeyEnvName]: '',
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toContain(
      `NVIDIA provider requires ${nvidiaApiKeyEnvName}.`,
    );
  });

  it('keeps injected env values ahead of the runtime store env', async () => {
    const storeRoot = createTestTempRoot('project02-chat-injected-env-');
    let stderr = '';

    writeRuntimeEnv(
      storeRoot,
      `${roleModelProviderEnvName}=nvidia\n${nvidiaApiKeyEnvName}=\n`,
    );

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'injected-env-provider'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {
          [roleModelProviderEnvName]: 'local',
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
  });

  it('lets --provider take precedence over the runtime store env and project02.roleModelProvider', async () => {
    const storeRoot = createTestTempRoot('project02-chat-provider-cli-');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {
        roleModelProvider: 'nvidia',
      },
    });
    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=not-a-provider\n`);

    const exitCode = await runChatCliFromArgs(
      [
        '--provider',
        'local',
        '--store',
        storeRoot,
        '--new-session',
        'cli-provider',
      ],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
        pluginHost: createRuntimePluginHost({plugins: []}),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
  });

  it('reports config load errors before runtime env file errors', async () => {
    const storeRoot = createTestTempRoot(
      'project02-chat-load-error-before-env-',
    );
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      storeRoot: 42,
    });
    mkdirSync(join(storeRoot, '.env'));

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'load-error-before-env'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config is invalid');
    expect(stderr).toContain('runtime_config_string_invalid');
    expect(stderr).toContain('storeRoot');
    expect(stderr).toContain(
      'Runtime config field must be a non-empty string.',
    );
    expect(stderr).not.toContain('Could not load runtime config env file');
  });

  it('reports activation config errors before runtime env file errors', async () => {
    const storeRoot = createTestTempRoot(
      'project02-chat-activation-before-env-',
    );
    const plugin = createRequiredConfigPlugin('chat.required-config');
    const homeLayout = createProject02HomeLayout({homeRoot: storeRoot});
    const layout = createLocalRuntimeStorageLayout({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    });
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    mkdirSync(homeLayout.envPath);

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'activation-before-env'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              throw new Error(
                'chat startup should not construct invalid plugins',
              );
            },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config activation failed');
    expect(stderr).toContain('runtime_config_required_value_missing');
    expect(stderr).toContain(`plugins.${plugin.manifest.id}.config.endpoint`);
    expect(stderr).not.toContain('Could not load runtime config env file');
    expect(existsSync(layout.sessionCatalogPath)).toBe(false);
    expect(existsSync(layout.sessionsRoot)).toBe(false);
  });

  it('loads runtime env before reporting mixed activation diagnostics', async () => {
    const storeRoot = createTestTempRoot(
      'project02-chat-mixed-activation-env-',
    );
    const plugin = createRequiredSecretAndConfigPlugin('chat.mixed-config');
    const homeLayout = createProject02HomeLayout({homeRoot: storeRoot});
    const envVar = 'PROJECT02_CHAT_MIXED_SECRET_3452532128';
    let stdout = '';
    let stderr = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: {
            apiKey: {$env: envVar},
          },
        },
      },
    });
    writeFileSync(homeLayout.envPath, `${envVar}=chat-secret\n`, 'utf8');

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', 'mixed-activation-env'],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              factoryCalls += 1;

              return plugin;
            },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config activation failed');
    expect(stderr).toContain('runtime_config_required_value_missing');
    expect(stderr).toContain(`plugins.${plugin.manifest.id}.config.endpoint`);
    expect(stderr).not.toContain('runtime_config_required_secret_missing');
    expect(stderr).not.toContain(`plugins.${plugin.manifest.id}.config.apiKey`);
  });
});

describe('chat CLI plugin lifecycle', () => {
  it('uses the active chat input stream for one y/N plugin config approval', async () => {
    const storeRoot = createTestTempRoot(
      'project02-chat-plugin-config-approval-',
    );
    const sessionId = 'plugin-config-approval-session';
    const configurablePlugin = createChatConfigurablePlugin();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    await materializeChatCharacterConfig({
      storeRoot,
      configPath,
      plugin: configurablePlugin,
    });
    const fingerprint = inspectRuntimePluginConfig({
      targetScope: 'character',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: storeRoot,
      }),
      manifest: configurablePlugin.manifest,
      pluginManifests: [configurablePlugin.manifest],
    }).fingerprint;
    let adapterRound = 0;
    let stdout = '';
    let stderr = '';

    const exitCode = await runChatCliFromArgs(
      [
        '--provider',
        'local',
        '--store',
        storeRoot,
        '--config',
        configPath,
        '--new-session',
        sessionId,
      ],
      {
        stdin: Readable.from(['change the plugin tone\n', 'y\n', '/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [configurablePlugin.manifest.id]: {
            manifest: configurablePlugin.manifest,
            create: () => configurablePlugin,
          },
        },
        roleModelAdapter: {
          invoke() {
            adapterRound += 1;

            return {
              rawOutputText: JSON.stringify({
                toolCalls:
                  adapterRound === 1
                    ? [
                        {
                          name: runtimePluginConfigUpdateToolName,
                          input: {
                            pluginId: configurablePlugin.manifest.id,
                            fieldName: 'tone',
                            operation: 'set',
                            value: 'warm',
                            expectedFingerprint: fingerprint,
                          },
                        },
                      ]
                    : [
                        {
                          name: 'visible_reply',
                          input: {text: 'Plugin tone updated.'},
                        },
                      ],
              }),
            };
          },
        },
      },
    );
    const committed = inspectRuntimePluginConfig({
      targetScope: 'character',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: storeRoot,
      }),
      manifest: configurablePlugin.manifest,
      pluginManifests: [configurablePlugin.manifest],
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(adapterRound).toBe(2);
    expect(stdout).toContain('Plugin config update requires your approval.');
    expect(stdout).toContain('Approve this one exact change? [y/N] ');
    expect(stdout).toContain('Mira: Plugin tone updated.');
    expect(
      committed.fields.find(field => field.name === 'tone')?.authored.value,
    ).toBe('warm');
  });

  it('allows terminal config approval after ten seconds', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
    });
    const input = new PassThrough();

    try {
      const storeRoot = createTestTempRoot(
        'project02-chat-plugin-config-slow-approval-',
      );
      const sessionId = 'plugin-config-slow-approval-session';
      const configurablePlugin = createChatConfigurablePlugin();
      const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
      await materializeChatCharacterConfig({
        storeRoot,
        configPath,
        plugin: configurablePlugin,
      });
      const before = inspectRuntimePluginConfig({
        targetScope: 'character',
        runtimeLocation: runtimeLocationForTest({
          configPath: configPath,
          storeRoot: storeRoot,
        }),
        manifest: configurablePlugin.manifest,
        pluginManifests: [configurablePlugin.manifest],
      });
      let adapterRound = 0;
      let stdout = '';
      let stderr = '';
      const run = runChatCliFromArgs(
        [
          '--provider',
          'local',
          '--store',
          storeRoot,
          '--config',
          configPath,
          '--new-session',
          sessionId,
        ],
        {
          stdin: input,
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          factories: {
            [configurablePlugin.manifest.id]: {
              manifest: configurablePlugin.manifest,
              create: () => configurablePlugin,
            },
          },
          roleModelAdapter: {
            invoke() {
              adapterRound += 1;

              return {
                rawOutputText: JSON.stringify({
                  toolCalls:
                    adapterRound === 1
                      ? [
                          {
                            name: runtimePluginConfigUpdateToolName,
                            input: {
                              pluginId: configurablePlugin.manifest.id,
                              fieldName: 'tone',
                              operation: 'set',
                              value: 'warm',
                              expectedFingerprint: before.fingerprint,
                            },
                          },
                        ]
                      : [
                          {
                            name: 'visible_reply',
                            input: {text: 'Plugin config request finished.'},
                          },
                        ],
                }),
              };
            },
          },
        },
      );

      input.write('change the plugin tone\n');
      await waitForMicrotasks(() =>
        stdout.includes('Approve this one exact change? [y/N] '),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      input.write('y\n/exit\n');
      await vi.advanceTimersByTimeAsync(0);

      expect(await run).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('Mira: Plugin config request finished.');
      const after = inspectRuntimePluginConfig({
        targetScope: 'character',
        runtimeLocation: runtimeLocationForTest({
          configPath: configPath,
          storeRoot: storeRoot,
        }),
        manifest: configurablePlugin.manifest,
        pluginManifests: [configurablePlugin.manifest],
      });

      expect({
        adapterRound,
        authoredTone: after.fields.find(field => field.name === 'tone')
          ?.authored.value,
      }).toEqual({
        adapterRound: 2,
        authoredTone: 'warm',
      });
    } finally {
      input.destroy();
      vi.useRealTimers();
    }
  });

  it('uses an injected plugin config confirmation handler without consuming chat input', async () => {
    const storeRoot = createTestTempRoot(
      'project02-chat-plugin-config-injected-',
    );
    const sessionId = 'plugin-config-injected-session';
    const configurablePlugin = createChatConfigurablePlugin();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    await materializeChatCharacterConfig({
      storeRoot,
      configPath,
      plugin: configurablePlugin,
    });
    const before = inspectRuntimePluginConfig({
      targetScope: 'character',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: storeRoot,
      }),
      manifest: configurablePlugin.manifest,
      pluginManifests: [configurablePlugin.manifest],
    });
    let adapterRound = 0;
    let confirmationCalls = 0;
    let stdout = '';

    const exitCode = await runChatCliFromArgs(
      [
        '--provider',
        'local',
        '--store',
        storeRoot,
        '--config',
        configPath,
        '--new-session',
        sessionId,
      ],
      {
        stdin: Readable.from(['change the plugin tone\n', '/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        toolConfirmationHandler(request) {
          confirmationCalls += 1;
          expect(request.preview).toMatchObject({
            targetPluginId: configurablePlugin.manifest.id,
            fieldName: 'tone',
            operation: 'set',
          });
          return {status: 'denied'};
        },
        factories: {
          [configurablePlugin.manifest.id]: {
            manifest: configurablePlugin.manifest,
            create: () => configurablePlugin,
          },
        },
        roleModelAdapter: {
          invoke() {
            adapterRound += 1;

            return {
              rawOutputText: JSON.stringify({
                toolCalls:
                  adapterRound === 1
                    ? [
                        {
                          name: runtimePluginConfigUpdateToolName,
                          input: {
                            pluginId: configurablePlugin.manifest.id,
                            fieldName: 'tone',
                            operation: 'set',
                            value: 'warm',
                            expectedFingerprint: before.fingerprint,
                          },
                        },
                      ]
                    : [
                        {
                          name: 'visible_reply',
                          input: {text: 'Plugin tone was not changed.'},
                        },
                      ],
              }),
            };
          },
        },
      },
    );
    const after = inspectRuntimePluginConfig({
      targetScope: 'character',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: storeRoot,
      }),
      manifest: configurablePlugin.manifest,
      pluginManifests: [configurablePlugin.manifest],
    });

    expect(exitCode).toBe(0);
    expect(adapterRound).toBe(2);
    expect(confirmationCalls).toBe(1);
    expect(stdout).not.toContain('Approve this one exact change?');
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('returns chat input ownership after a terminal config approval times out', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
    });
    const input = new PassThrough();

    try {
      const storeRoot = createTestTempRoot(
        'project02-chat-plugin-config-timeout-',
      );
      const sessionId = 'plugin-config-timeout-session';
      const configurablePlugin = createChatConfigurablePlugin();
      const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
      await materializeChatCharacterConfig({
        storeRoot,
        configPath,
        plugin: configurablePlugin,
      });
      const before = inspectRuntimePluginConfig({
        targetScope: 'character',
        runtimeLocation: runtimeLocationForTest({
          configPath: configPath,
          storeRoot: storeRoot,
        }),
        manifest: configurablePlugin.manifest,
        pluginManifests: [configurablePlugin.manifest],
      });
      const approvalTimeoutMs = 5 * 60_000;

      expect(
        createRuntimePluginManagementPluginManifest().runtimePolicy.timeoutMs,
      ).toBe(5_000);
      let adapterRound = 0;
      let stdout = '';
      let stderr = '';
      const run = runChatCliFromArgs(
        [
          '--provider',
          'local',
          '--store',
          storeRoot,
          '--config',
          configPath,
          '--new-session',
          sessionId,
        ],
        {
          stdin: input,
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          factories: {
            [configurablePlugin.manifest.id]: {
              manifest: configurablePlugin.manifest,
              create: () => configurablePlugin,
            },
          },
          roleModelAdapter: {
            invoke() {
              adapterRound += 1;

              return {
                rawOutputText: JSON.stringify({
                  toolCalls:
                    adapterRound === 1
                      ? [
                          {
                            name: runtimePluginConfigUpdateToolName,
                            input: {
                              pluginId: configurablePlugin.manifest.id,
                              fieldName: 'tone',
                              operation: 'set',
                              value: 'warm',
                              expectedFingerprint: before.fingerprint,
                            },
                          },
                        ]
                      : [
                          {
                            name: 'visible_reply',
                            input: {text: 'Plugin tone was not changed.'},
                          },
                        ],
                }),
              };
            },
          },
        },
      );

      input.write('change the plugin tone\n');
      await waitForMicrotasks(() =>
        stdout.includes('Approve this one exact change? [y/N] '),
      );
      await vi.advanceTimersByTimeAsync(approvalTimeoutMs);
      input.write('/exit\n');
      await vi.advanceTimersByTimeAsync(0);

      expect(await run).toBe(0);
      expect(stderr).toBe('');
      expect(adapterRound).toBe(2);
      expect(stdout).toContain('Plugin tone was not changed.');
      expect(
        inspectRuntimePluginConfig({
          targetScope: 'character',
          runtimeLocation: runtimeLocationForTest({
            configPath: configPath,
            storeRoot: storeRoot,
          }),
          manifest: configurablePlugin.manifest,
          pluginManifests: [configurablePlugin.manifest],
        }).fingerprint,
      ).toBe(before.fingerprint);
    } finally {
      input.destroy();
      vi.useRealTimers();
    }
  });

  it('runs session-end hooks when /exit closes the chat', async () => {
    const sessionEndContexts: RuntimePluginContext[] = [];
    const logStore = createRuntimeLogStore();
    const sessionEndPlugin = createSessionEndPlugin(context => {
      sessionEndContexts.push(context);
    });
    const pluginHost = createRuntimePluginHost({
      plugins: [sessionEndPlugin],
      enabledPluginIds: [runtimePluginId, sessionEndPlugin.manifest.id],
    });

    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      stdin: Readable.from(['/exit\n']),
      stdout: collect(() => {}),
      stderr: collect(() => {}),
      logStore,
      pluginHost,
    });

    expect(exitCode).toBe(0);
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId: 'local-session',
      currentUserMessage: '/exit',
      character: testCharacterProfile,
    });
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
      runtimePluginEvidence: [
        {
          pluginId: 'chat.session-end.fixture',
          evidenceKind: 'session_end',
          status: 'accepted',
          summary: 'Session end observed.',
        },
      ],
      runtimePluginTurnEvidence: {
        evidence: [
          {
            pluginId: 'chat.session-end.fixture',
            evidenceKind: 'session_end',
            status: 'accepted',
            summary: 'Session end observed.',
          },
        ],
      },
    });
  });

  it('preserves an injected plugin host when configured plugin activation would fail', async () => {
    const storeRoot = createTestTempRoot('project02-chat-injected-host-');
    const configuredPlugin = createRequiredConfigPlugin(
      'chat.injected-required-config',
    );
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    const sessionId = 'injected-host-session';
    const sessionEndContexts: RuntimePluginContext[] = [];
    const sessionEndPlugin = createSessionEndPlugin(context => {
      sessionEndContexts.push(context);
    });
    const pluginHost = createRuntimePluginHost({
      plugins: [sessionEndPlugin],
      enabledPluginIds: [runtimePluginId, sessionEndPlugin.manifest.id],
    });
    let stderr = '';
    let configuredFactoryCalls = 0;

    const exitCode = await runChatCliFromArgs(
      [
        '--store',
        storeRoot,
        '--config',
        configPath,
        '--new-session',
        sessionId,
      ],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        pluginHost,
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              configuredFactoryCalls += 1;
              throw new Error(
                'injected plugin host must bypass configured factories',
              );
            },
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(configuredFactoryCalls).toBe(0);
    expect(sessionEndContexts).toHaveLength(1);

    const storedRawEvents = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId,
    }).rawEvents();

    expect(storedRawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
      runtimePluginEvidence: [
        {
          pluginId: 'chat.session-end.fixture',
          evidenceKind: 'session_end',
          status: 'accepted',
          summary: 'Session end observed.',
        },
      ],
    });
  });

  it('constructs configured manifest-backed plugins once during chat startup', async () => {
    const storeRoot = createTestTempRoot('project02-chat-configured-host-');
    const sessionId = 'configured-host-session';
    const configuredPlugin = createSessionEndPlugin(() => {}, {
      beforeRoleModelCall() {
        return {contextItems: [], evidence: []};
      },
      onShutdown() {
        return {status: 'completed', evidence: []};
      },
    });
    const beforeRoleModelCallContexts: RuntimePluginContext[] = [];
    const sessionEndContexts: RuntimePluginContext[] = [];
    const shutdownContexts: RuntimePluginContext[] = [];
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['hello\n/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(() => {}),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              factoryCalls += 1;

              return createSessionEndPlugin(
                context => {
                  sessionEndContexts.push(context);
                },
                {
                  onShutdown(context) {
                    shutdownContexts.push(context);
                    return {status: 'completed', evidence: []};
                  },
                  beforeRoleModelCall(context) {
                    beforeRoleModelCallContexts.push(context);
                    return {contextItems: [], evidence: []};
                  },
                },
              );
            },
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(1);
    expect(beforeRoleModelCallContexts).toHaveLength(1);
    expect(beforeRoleModelCallContexts[0]).toMatchObject({
      sessionId,
      currentUserMessage: 'hello',
    });
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId,
      currentUserMessage: '/exit',
    });
    expect(shutdownContexts).toHaveLength(1);
    expect(shutdownContexts[0]).toMatchObject({
      sessionId,
      character: testCharacterProfile,
    });
    expect(shutdownContexts[0]?.deadlineAt).toBeGreaterThan(Date.now());
    expect(shutdownContexts[0]?.signal.aborted).toBe(false);
  });

  it('closes configured plugins when the session ends without /exit', async () => {
    const storeRoot = createTestTempRoot('project02-chat-fatal-cleanup-');
    const sessionId = 'fatal-cleanup-session';
    const configuredPlugin = createSessionEndPlugin(() => {}, {
      pluginId: 'chat.session-end.fatal-cleanup.fixture',
      requiredForTurn: true,
      beforeRoleModelCall() {
        throw new Error('configured before-role-model hook failed');
      },
    });
    const sessionEndContexts: RuntimePluginContext[] = [];
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    const exitCode = await runChatCliFromArgs(
      ['--provider', 'local', '--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['hello\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              return createSessionEndPlugin(
                context => {
                  sessionEndContexts.push(context);
                },
                {
                  pluginId: configuredPlugin.manifest.id,
                  requiredForTurn: true,
                  beforeRoleModelCall() {
                    throw new Error('configured before-role-model hook failed');
                  },
                },
              );
            },
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toContain('configured before-role-model hook failed');
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId,
    });

    const storedRawEvents = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId,
    }).rawEvents();

    expect(
      storedRawEvents.some(event => event.payloadSummary?.rawInput === '/exit'),
    ).toBe(true);
  });

  it('closes configured pre-session plugins read-only when later session creation fails', async () => {
    const storeRoot = createTestTempRoot('project02-chat-cleanup-');
    const sessionId = 'pre-session-cleanup';
    const sessionEndContexts: RuntimePluginContext[] = [];
    const cleanupWriteBlocked: boolean[] = [];
    const configuredPlugin = createSessionEndPlugin(
      context => {
        sessionEndContexts.push(context);

        if (context.fileStore === undefined) {
          throw new Error(
            'Expected startup cleanup context to include fileStore.',
          );
        }

        try {
          context.fileStore.writeJsonAtomic('cleanup.json', {
            value: 'should-not-write',
          });
          cleanupWriteBlocked.push(false);
        } catch {
          cleanupWriteBlocked.push(true);
        }
      },
      {
        sideEffectLevel: 'local_memory_write',
        requestedAccess: {file_store: 'write', turn_context: 'read'},
      },
    );
    let factoryCalls = 0;
    let stdout = '';
    let stderr = '';

    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-22T00:00:00.000Z',
    });
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              factoryCalls += 1;

              return configuredPlugin;
            },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain(
      `Local runtime session "${sessionId}" already exists.`,
    );
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId,
    });
    expect(sessionEndContexts[0]?.currentUserMessage).toContain(
      'chat startup failed',
    );
    expect(cleanupWriteBlocked).toEqual([true]);
    expect(
      createRuntimePluginFileStore({
        storeRoot,
        sessionId,
        pluginId: configuredPlugin.manifest.id,
      }).readJson('cleanup.json'),
    ).toBeUndefined();
  });

  it('preserves formatted startup storage errors when cleanup file-store setup fails', async () => {
    const configRoot = createTestTempRoot(
      'project02-chat-invalid-store-cleanup-',
    );
    const invalidStoreRoot = join(configRoot, 'store-root-file');
    const sessionId = 'invalid-store-cleanup';
    const sessionEndContexts: RuntimePluginContext[] = [];
    const configuredPlugin = createSessionEndPlugin(
      context => {
        sessionEndContexts.push(context);
      },
      {
        sideEffectLevel: 'local_memory_write',
        requestedAccess: {file_store: 'write', turn_context: 'read'},
      },
    );
    let stdout = '';
    let stderr = '';

    writeFileSync(invalidStoreRoot, 'not a runtime store directory\n', 'utf8');
    const configPath = writeRuntimeConfig(join(configRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    const exitCode = await runChatCliFromArgs(
      [
        '--store',
        invalidStoreRoot,
        '--config',
        configPath,
        '--new-session',
        sessionId,
      ],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              return configuredPlugin;
            },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('Error: Local runtime store could not be read.\n');
    expect(sessionEndContexts).toHaveLength(0);
  });

  it('aborts manifest-backed factory construction failures before creating a durable session', async () => {
    const storeRoot = createTestTempRoot('project02-chat-factory-failure-');
    const sessionId = 'manifest-factory-failure';
    const layout = createLocalRuntimeStorageLayout({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
    });
    const configuredPlugin = createSessionEndPlugin(() => {});
    let factoryCalls = 0;
    let cleanupCalls = 0;
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    const exitCode = await runChatCliFromArgs(
      ['--store', storeRoot, '--new-session', sessionId],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        factories: {
          [configuredPlugin.manifest.id]: {
            manifest: configuredPlugin.manifest,
            create() {
              factoryCalls += 1;
              createSessionEndPlugin(() => {
                cleanupCalls += 1;
              });
              throw new Error(
                'manifest-backed factory failed during construction',
              );
            },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(cleanupCalls).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain(
      'Configured plugin construction failed before creating a durable session.',
    );
    // The unified schema marker owns the character-data directory before
    // plugin factories may touch it; it is not evidence that a durable
    // session was created.
    expect(
      decodeStorageSchemaMarker(readFileSync(layout.schemaPath, 'utf8')),
    ).toMatchObject({
      scope: 'character-data',
      characterId: 'mira',
    });
    expect(existsSync(layout.sessionCatalogPath)).toBe(false);
    expect(existsSync(layout.sessionsRoot)).toBe(false);
  });

  it('rejects invalid configured plugin fields before materializing startup', async () => {
    const storeRoot = createTestTempRoot('project02-chat-activation-error-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        'character-state': {
          config: {
            typoo: true,
          },
        },
      },
    });
    let stdout = '';
    let stderr = '';

    const exitCode = await runChatCliFromArgs(
      [
        '--store',
        storeRoot,
        '--config',
        configPath,
        '--new-session',
        'activation-error',
      ],
      {
        stdin: Readable.from(['/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Runtime config is invalid');
    expect(stderr).toContain('runtime_config_unknown_plugin_config_field');
    expect(stderr).toContain('plugins.character-state.config.typoo');
    expect(stderr).toContain(
      'Unknown config field "typoo" for plugin "character-state".',
    );
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(join(storeRoot, 'schema.json'))).toBe(false);
  });

  it('persists session-end hook failures when stdin closes normally', async () => {
    const storeRoot = createTestTempRoot('project02-chat-session-end-');
    const sessionId = 'session-end-failure';
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      sessionId,
      createdAt: '2026-06-16T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId,
    });
    const pluginHost = createRuntimePluginHost({
      plugins: [createFailingSessionEndPlugin()],
      enabledPluginIds: [runtimePluginId, 'chat.session-end.failure.fixture'],
    });

    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      stdin: Readable.from([]),
      stdout: collect(() => {}),
      stderr: collect(() => {}),
      session: createConversationSession({
        id: sessionId,
        character: testCharacterProfile,
      }),
      logStore,
      pluginHost,
    });

    expect(exitCode).toBe(0);

    const storedRawEvents = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId,
    }).rawEvents();

    expect(storedRawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed_with_failures',
      payloadSummary: {
        rawInput: '/exit',
        normalizedCurrentUserMessage: '/exit',
      },
      runtimePluginEvidence: [
        {
          pluginId: 'chat.session-end.failure.fixture',
          evidenceKind: 'session_end',
          status: 'failed',
          summary: 'Session end fixture failed.',
        },
      ],
    });

    let stdout = '';
    const inspectExitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', sessionId],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      },
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
              },
            ];
          };
        },
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
            summary: 'Session end fixture failed.',
          },
        ],
      },
    });
  });
});

describe('chat CLI rejected-turn recovery', () => {
  it('keeps the session alive after a rejected turn and completes the next one', async () => {
    let stdout = '';
    let stderr = '';
    let invocations = 0;
    const exitCode = await runChatCli({
      characterProfile: testCharacterProfile,
      pluginHost: createDefaultProject02PluginHost(),
      stdin: Readable.from(['first\nsecond\n/exit\n']),
      stdout: collect(chunk => {
        stdout += chunk;
      }),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      roleModelAdapter: {
        invoke() {
          invocations += 1;

          if (invocations === 1) {
            return {rawOutputText: 'this is not a decision object'};
          }

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {text: 'second turn reply'},
                },
              ],
            }),
          };
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toContain('Error: ');
    expect(stdout).toContain('second turn reply');
    expect(invocations).toBe(2);
  });
});

function createTextOnlyAdapter(): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          text: 'folded model note',
          toolCalls: [],
        }),
      };
    },
  };
}

async function materializeChatCharacterConfig(options: {
  readonly storeRoot: string;
  readonly configPath: string;
  readonly plugin: RuntimePlugin;
}): Promise<void> {
  const startup = await resolveRuntimeCliStartup({
    location: {
      storeRoot: options.storeRoot,
      configPath: options.configPath,
    },
    env: {},
    factories: {
      [options.plugin.manifest.id]: {
        manifest: options.plugin.manifest,
        create: () => options.plugin,
      },
    },
    continueAfterActivationErrors: true,
  });

  if (startup.status === 'character_invalid') {
    throw new Error('Expected character config materialization to succeed.');
  }
}

function createChatConfigurablePlugin(): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      id: 'chat.configurable.fixture',
      displayName: 'Chat configurable fixture',
      version: '1.0.0',
      kind: 'tool_provider',
      description:
        'Configurable plugin used by the chat approval contract test.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test',
      },
      declaredPlugins: ['tool_provider'],
      config: {
        scope: 'global_with_character_overrides',
        fields: [
          {
            name: 'tone',
            description: 'Configured reply tone.',
            required: false,
            secret: false,
            valueType: 'string',
            agentMutable: true,
            reloadRequired: true,
            redactionLabels: [],
          },
        ],
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
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: false,
        reasons: ['test'],
      },
      requestedAccess: {},
    },
    providedTools: [],
    lifecycleHooks: {},
  });
}

function createSessionEndPlugin(
  onSessionEnd: (context: RuntimePluginContext) => void,
  options: {
    readonly pluginId?: string;
    readonly beforeRoleModelCall?: NonNullable<
      RuntimePlugin['lifecycleHooks']['beforeRoleModelCall']
    >;
    readonly onShutdown?: NonNullable<
      RuntimePlugin['lifecycleHooks']['onShutdown']
    >;
    readonly requiredForTurn?: boolean;
    readonly requestedAccess?: RuntimePlugin['manifest']['requestedAccess'];
    readonly sideEffectLevel?: RuntimePlugin['manifest']['runtimePolicy']['sideEffectLevel'];
    readonly defaultEnabled?: boolean;
  } = {},
): RuntimePlugin {
  const pluginId = options.pluginId ?? 'chat.session-end.fixture';
  const declaredPlugins: RuntimePlugin['manifest']['declaredPlugins'] = [
    ...(options.beforeRoleModelCall === undefined
      ? []
      : (['before_role_model_call'] as const)),
    'on_session_end',
    ...(options.onShutdown === undefined ? [] : (['on_shutdown'] as const)),
  ];

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
        sourceSystem: 'test',
      },
      declaredPlugins,
      config: {
        scope: 'global_with_character_overrides',
        fields: [],
      },
      localTrustLevel: 'test_fixture',
      runtimePolicy: {
        requiredForTurn: options.requiredForTurn === true,
        sideEffectLevel: options.sideEffectLevel ?? 'runtime_read',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall:
            options.requiredForTurn === true ? 'reject_turn' : 'degrade',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: options.defaultEnabled ?? true,
        reasons: ['test'],
      },
      requestedAccess: options.requestedAccess ?? {turn_context: 'read'},
    },
    providedTools: [],
    lifecycleHooks: {
      ...(options.beforeRoleModelCall === undefined
        ? {}
        : {beforeRoleModelCall: options.beforeRoleModelCall}),
      ...(options.onShutdown === undefined
        ? {}
        : {onShutdown: options.onShutdown}),
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
              redactionLabels: [],
            }),
          ],
        };
      },
    },
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
        sourceSystem: 'test',
      },
      declaredPlugins: ['on_session_end'],
      config: {
        scope: 'global_with_character_overrides',
        fields: [],
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
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: true,
        reasons: ['test'],
      },
      requestedAccess: {},
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
              redactionLabels: [],
            }),
          ],
        };
      },
    },
  });
}

function createRequiredConfigPlugin(pluginId: string): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Required Config Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin with required non-secret config.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
        sourceSystem: 'test',
      },
      declaredPlugins: ['on_session_end'],
      config: {
        scope: 'global_with_character_overrides',
        fields: [
          {
            name: 'endpoint',
            description: 'Required endpoint.',
            required: true,
            secret: false,
            valueType: 'string',
            redactionLabels: [],
          },
        ],
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
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: false,
        reasons: ['test'],
      },
      requestedAccess: {},
    },
    providedTools: [],
    lifecycleHooks: {
      onSessionEnd() {
        return {
          status: 'completed',
          evidence: [],
        };
      },
    },
  });
}

function createRequiredSecretAndConfigPlugin(pluginId: string): RuntimePlugin {
  const plugin = createRequiredConfigPlugin(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      config: {
        scope: 'global_with_character_overrides',
        fields: [
          ...plugin.manifest.config.fields,
          {
            name: 'apiKey',
            description: 'Required API key.',
            required: true,
            secret: true,
            valueType: 'secret',
            redactionLabels: ['secret'],
          },
        ],
      },
    },
    providedTools: plugin.providedTools,
    lifecycleHooks: plugin.lifecycleHooks,
  });
}

function writeRuntimeEnv(storeRoot: string, content: string): void {
  writeFileSync(
    createProject02HomeLayout({homeRoot: storeRoot}).envPath,
    content,
    'utf8',
  );
}

async function waitForMicrotasks(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }

    vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>(resolve => {
      realSetTimeout(resolve, 0);
    });
  }

  throw new Error('Expected asynchronous chat state was not reached.');
}

function createTerminalRawEventAppendFailingLogStore(): RuntimeLogStore {
  const logStore = createRuntimeLogStore();

  return Object.freeze({
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      if (record.kind === 'runtime_turn_completed') {
        throw new Error('terminal raw event append failed');
      }

      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record, expectedCharacter) {
      return logStore.appendConversationMessage(record, expectedCharacter);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}

function createToolTraceFailingLogStore(
  failingStep:
    'visible_message_committed' | 'tool_call_started' | 'tool_call_finished',
  logStore: RuntimeLogStore = createRuntimeLogStore(),
): RuntimeLogStore {
  // The user-message commit also traces visible_message_committed; these
  // scenarios target a model-reply commit, so the first occurrence passes.
  let visibleCommitTraces = 0;

  return Object.freeze({
    ...(logStore.localRuntimeSessionPaths === undefined
      ? {}
      : {localRuntimeSessionPaths: logStore.localRuntimeSessionPaths}),
    ...(logStore.localRuntimeWriterLockOwnerToken === undefined
      ? {}
      : {
          localRuntimeWriterLockOwnerToken:
            logStore.localRuntimeWriterLockOwnerToken,
        }),
    appendTrace(entry) {
      if (entry.step === failingStep) {
        if (
          failingStep !== 'visible_message_committed' ||
          visibleCommitTraces > 0
        ) {
          throw new Error(`${failingStep} trace append failed`);
        }

        visibleCommitTraces += 1;
      }

      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record, expectedCharacter) {
      return logStore.appendConversationMessage(record, expectedCharacter);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    },
  } satisfies RuntimeLogStore);
}
