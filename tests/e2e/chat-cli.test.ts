import {
  testCharacterProfile,
  writeTestCharacterPackage,
} from '../support/character-fixtures.ts';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough, Readable} from 'node:stream';

import {describe, expect, it, vi} from 'vitest';

import {configuredPluginConstructionCleanupSessionId} from '../../src/app/index.ts';
import {createLocalRuntimeConversationStore} from '../../src/runtime/storage/conversation-store.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  readCharacterConversation,
  withOpenConversation,
} from '../support/conversation-fixtures.ts';
import {
  writeRuntimeConfig,
  runtimeLocationForTest,
} from '../support/runtime-config.ts';
import {
  createInitializedTestStoreRoot,
  withScopedProcessEnv,
} from '../support/runtime-config-fixtures.ts';
import {collect} from '../support/streams.ts';

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
import {acquireLocalRuntimeSessionWriterLease} from '../../src/runtime/storage/session-store.ts';
import type {RoleModelAdapter} from '../../src/role-model/index.ts';
import {nvidiaApiKeyEnvName} from '../../src/role-model/providers/nvidia.ts';
import {runChatCli, runChatCliFromArgs} from '../../src/cli/chat/main.ts';
import {runInspectCliFromArgs} from '../../src/cli/inspect/main.ts';
import {resolveRuntimeCliStartup} from '../../src/app/index.ts';

const roleModelProviderEnvName = 'PROJECT02_ROLE_MODEL_PROVIDER';
const realSetTimeout = globalThis.setTimeout;

describe('chat CLI model text', () => {
  it("never shows the model's text note next to its tool calls", async () => {
    let stdout = '';
    const exitCode = await withOpenConversation({}, conversation =>
      runChatCli({
        conversation,
        pluginHost: createDefaultProject02PluginHost(),
        stdin: Readable.from(['hello\n/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        roleModelAdapter: createReplyWithNoteAdapter(),
      }),
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('hello back');
    expect(stdout).not.toContain('private note');
  });
});

describe('chat CLI trace summary', () => {
  it('traces every appended record for rejected user input', async () => {
    let stderr = '';
    const exitCode = await withOpenConversation({}, conversation =>
      runChatCli({
        conversation,
        pluginHost: createDefaultProject02PluginHost(),
        // A whitespace-only line reaches the runtime and fails input validation.
        stdin: Readable.from(['   \n', '/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        traceMode: true,
        roleModelAdapter: {
          invoke() {
            throw new Error('rejected input must never reach the model');
          },
        },
      }),
    );

    expect(exitCode).toBe(0);

    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'rejected',
      steps: [
        'runtime_event_received',
        'raw_event_log_appended',
        'runtime_turn_rejected',
      ],
    });
  });

  it('does not classify an interrupted executable round as terminal', async () => {
    let adapterRound = 0;
    let stderr = '';
    const exitCode = await withOpenConversation({}, conversation =>
      runChatCli({
        conversation,
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
      }),
    );

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

    const exitCode = await withOpenConversation({}, conversation =>
      runChatCli({
        conversation,
        pluginHost: createDefaultProject02PluginHost(),
        stdin: Readable.from(['check plugins\n/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        traceMode: true,
        roleModelAdapter,
      }),
    );

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

    const exitCode = await withOpenConversation({}, conversation =>
      runChatCli({
        conversation,
        pluginHost: createDefaultProject02PluginHost(),
        stdin: Readable.from(['try an unavailable tool\n/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        traceMode: true,
        roleModelAdapter,
      }),
    );

    expect(exitCode).toBe(0);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'completed',
      requestedToolCalls: ['memory.unknown', 'visible_reply'],
      executedToolCalls: [],
      terminalToolCalls: ['visible_reply'],
    });
  });

  it("leaves a refused round's tool calls out of the trace summary", async () => {
    let adapterRound = 0;
    let stderr = '';
    const roleModelAdapter: RoleModelAdapter = {
      invoke() {
        adapterRound += 1;

        if (adapterRound === 1) {
          // Native arguments that were not a JSON object reach the parser as
          // written; the whole round is refused and handed back.
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [{name: 'runtime.plugin.list', input: '{"score":'}],
            }),
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

    const exitCode = await withOpenConversation({}, conversation =>
      runChatCli({
        conversation,
        pluginHost: createDefaultProject02PluginHost(),
        stdin: Readable.from(['try invalid plugin arguments\n/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        traceMode: true,
        roleModelAdapter,
      }),
    );

    expect(exitCode).toBe(0);
    expect(adapterRound).toBe(2);
    expect(JSON.parse(stderr.trim())).toMatchObject({
      status: 'completed',
      requestedToolCalls: ['visible_reply'],
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

    const exitCode = await withOpenConversation({}, conversation =>
      runChatCli({
        conversation,
        pluginHost: createDefaultProject02PluginHost(),
        stdin: Readable.from(['try an invalid state patch\n/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        traceMode: true,
        roleModelAdapter,
      }),
    );

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

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['hello\n/exit\n']),
      stdout: collect(chunk => {
        stdout += chunk;
      }),
      stderr: collect(() => {}),
      pluginHost: createRuntimePluginHost({plugins: []}),
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Zeta is ready.');
    expect(stdout).toContain('Zeta:');
  });

  it('rejects an unknown configured character naming the discovered ids', async () => {
    const storeRoot = createTestTempRoot('project02-chat-character-missing-');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {character: 'ghost'},
    });

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['hello\n/exit\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      pluginHost: createRuntimePluginHost({plugins: []}),
    });

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

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['hello\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      env: {
        [nvidiaApiKeyEnvName]: '',
      },
      pluginHost: createRuntimePluginHost({plugins: []}),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toContain(
      `NVIDIA provider requires ${nvidiaApiKeyEnvName}.`,
    );
  });

  it('sizes the replayed history from project02.contextWindowTokens', async () => {
    const historyLengthsFor = async (contextWindowTokens: number) => {
      const storeRoot = createTestTempRoot('project02-chat-context-window-');
      const historyLengths: number[] = [];
      const adapter: RoleModelAdapter = {
        invoke(_inputEnvelope, invocation) {
          historyLengths.push(invocation.conversationHistory.length);

          return {
            rawOutputText: JSON.stringify({
              toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
            }),
          };
        },
      };

      writeRuntimeConfig(join(storeRoot, 'config.json'), {
        project02: {contextWindowTokens},
      });

      const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
        stdin: Readable.from(['first\n', 'second\n']),
        stdout: collect(() => {}),
        stderr: collect(() => {}),
        roleModelAdapter: adapter,
        pluginHost: createRuntimePluginHost({plugins: []}),
      });

      expect(exitCode).toBe(0);
      return historyLengths;
    };

    // Eight tokens leave no room for a whole prior turn; 4096 replay it.
    expect(await historyLengthsFor(8)).toEqual([0, 0]);
    expect(await historyLengthsFor(4096)).toEqual([0, 1]);
  });

  it('continues into a new session when the history outgrows the window and resumes it next launch', async () => {
    const storeRoot = createTestTempRoot('project02-chat-continuation-');
    const adapter: RoleModelAdapter = {
      invoke() {
        return {
          rawOutputText: JSON.stringify({
            toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
          }),
        };
      },
      completeText() {
        return Promise.resolve({
          status: 'completed',
          text: 'We spoke of small things and I kept up.',
          provider: {name: 'nvidia', model: 'test'},
        });
      },
    };
    let stdout = '';
    const endedSessions: string[] = [];
    const rootLeaseHeldWhen: string[] = [];
    const sessionEndPlugin = createSessionEndPlugin(
      context => {
        endedSessions.push(context.sessionId);
      },
      {
        // From inside a later turn, another window's view: is the closed root
        // segment's writer lease already free while this chat goes on?
        async beforeRoleModelCall(context) {
          try {
            const lease = await acquireLocalRuntimeSessionWriterLease({
              storeRoot: characterDataDirPath(storeRoot, 'mira'),
              sessionId:
                (await readCharacterConversation(storeRoot)).sessions[0]
                  ?.sessionId ?? context.sessionId,
            });

            await lease.release();
          } catch {
            rootLeaseHeldWhen.push(context.sessionId);
          }

          return {contextItems: [], evidence: []};
        },
      },
    );

    // ~21 estimated tokens per turn: a 100-token window replays two turns,
    // so the third completed turn overflows it and the talk continues in a
    // new session with the newest turn carried along.
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {contextWindowTokens: 100},
    });

    // The chat exits right after the continuation, so the closed segment's
    // end evidence is the last write anywhere: the new segment must still be
    // the one a flagless relaunch resumes.
    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['one\n', 'two\n', 'three\n', 'four\n']),
      stdout: collect(chunk => {
        stdout += chunk;
      }),
      stderr: collect(chunk => {
        stdout += `[stderr] ${chunk}`;
      }),
      roleModelAdapter: adapter,
      pluginHost: createRuntimePluginHost({
        plugins: [sessionEndPlugin],
        enabledPluginIds: [sessionEndPlugin.manifest.id],
      }),
    });

    expect(exitCode).toBe(0);
    // Rotation is invisible: the person sees replies and prompts, nothing
    // about sessions.
    expect(stdout).toContain('Mira: noted\nYou: ');
    expect(stdout).not.toContain('[context]');

    const dm = await readCharacterConversation(storeRoot);
    const conversationId = dm.conversation.id;

    // Each segment is closed under its own name: the first at continuation,
    // the second at exit. The root's lease is held only while it is the
    // active segment: the fourth turn, already in the second segment, finds
    // it free.
    expect(endedSessions).toEqual([
      `${conversationId}.1`,
      `${conversationId}.2`,
    ]);
    expect(rootLeaseHeldWhen).toEqual([
      `${conversationId}.1`,
      `${conversationId}.1`,
      `${conversationId}.1`,
    ]);
    expect(dm.sessions.map(metadata => metadata.sessionId)).toEqual([
      `${conversationId}.1`,
      `${conversationId}.2`,
    ]);
    expect(dm.latestSessionId).toBe(`${conversationId}.2`);

    // A flagless relaunch resumes the same conversation in its latest
    // segment; no second conversation appears.
    let resumedStdout = '';
    expect(
      await runChatCliFromArgs(['--store', storeRoot], {
        stdin: Readable.from(['five\n', '/exit\n']),
        stdout: collect(chunk => {
          resumedStdout += chunk;
        }),
        stderr: collect(() => {}),
        roleModelAdapter: adapter,
        pluginHost: createRuntimePluginHost({plugins: []}),
      }),
    ).toBe(0);
    expect(resumedStdout).toContain('Mira: noted');

    const resumed = await readCharacterConversation(storeRoot);

    expect(resumed.conversation.id).toBe(conversationId);
    // The tiny window may rotate again; the thread never changes.
    expect(resumed.latestSessionId.startsWith(`${conversationId}.`)).toBe(true);
    expect(
      await createLocalRuntimeConversationStore({
        homeRoot: storeRoot,
      }).listConversations(),
    ).toHaveLength(1);
  });

  it('warns on stderr when the conversation cannot continue in a new session', async () => {
    const storeRoot = createTestTempRoot('project02-chat-rotation-warning-');
    const adapter: RoleModelAdapter = {
      invoke() {
        return {
          rawOutputText: JSON.stringify({
            toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
          }),
        };
      },
    };

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: {contextWindowTokens: 100},
    });

    // Two turns still fit the window, so the first chat ends with the root
    // segment only.
    expect(
      await runChatCliFromArgs(['--store', storeRoot], {
        stdin: Readable.from(['one\n', 'two\n']),
        stdout: collect(() => {}),
        stderr: collect(() => {}),
        roleModelAdapter: adapter,
        pluginHost: createRuntimePluginHost({plugins: []}),
      }),
    ).toBe(0);

    const dm = await readCharacterConversation(storeRoot);
    const conversationId = dm.conversation.id;

    expect(dm.latestSessionId).toBe(`${conversationId}.1`);

    // Another window holds the next segment's writer lease, so the third
    // completed turn plans a continuation that cannot open.
    const blocker = await acquireLocalRuntimeSessionWriterLease({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId: `${conversationId}.2`,
    });

    try {
      let stdout = '';
      let stderr = '';

      expect(
        await runChatCliFromArgs(['--store', storeRoot], {
          stdin: Readable.from(['three\n']),
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
          roleModelAdapter: adapter,
          pluginHost: createRuntimePluginHost({plugins: []}),
        }),
      ).toBe(0);

      // The reply stands; the person still hears that maintenance broke.
      expect(stdout).toContain('Mira: noted');
      expect(stderr).toContain(
        `Warning: the conversation could not continue in a new session and stays in ${conversationId}.1:`,
      );
      expect(
        (await readCharacterConversation(storeRoot)).sessions.map(
          metadata => metadata.sessionId,
        ),
      ).toEqual([`${conversationId}.1`]);
    } finally {
      await blocker.release();
    }
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

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['/exit\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      env: {
        [nvidiaApiKeyEnvName]: '',
      },
      pluginHost: createRuntimePluginHost({plugins: []}),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
  });

  it('reports an invalid provider environment value as a CLI error', async () => {
    const storeRoot = await createInitializedTestStoreRoot(
      'project02-chat-provider-invalid-env-',
    );
    let stderr = '';
    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['hello\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      env: {[roleModelProviderEnvName]: 'bogus'},
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('must be either "local" or "nvidia"');
    // The env is judged during startup planning, before the run sets up the
    // character; the store itself is arrangement.
    expect(existsSync(characterDataDirPath(storeRoot, 'mira'))).toBe(false);
  });

  it('reports an invalid provider value from the home env file before materializing character state', async () => {
    const storeRoot = createTestTempRoot('project02-chat-provider-env-file-');
    let stderr = '';
    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=bogus\n`);

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['hello\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      env: {},
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('must be either "local" or "nvidia"');
    expect(existsSync(join(storeRoot, 'schema.json'))).toBe(false);
    expect(existsSync(characterDataDirPath(storeRoot, 'mira'))).toBe(false);
  });

  it('releases the durable writer lease when the provider turn fails', async () => {
    const storeRoot = createTestTempRoot(
      'project02-chat-provider-failure-lease-',
    );
    let firstStderr = '';
    let secondStderr = '';
    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=nvidia\n`);

    const failedExitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['hello\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        firstStderr += chunk;
      }),
      env: {[nvidiaApiKeyEnvName]: ''},
    });
    const recoveredExitCode = await runChatCliFromArgs(
      ['--provider', 'local', '--store', storeRoot],
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
        const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
          stdin: Readable.from(['hello\n']),
          stdout: collect(() => {}),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
        });

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
          ['--store', selectedStoreRoot],
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
        expect(
          (
            await readCharacterConversation(selectedStoreRoot)
          ).latestSessionId.endsWith('.1'),
        ).toBe(true);
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
        const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
          stdin: Readable.from(['/exit\n']),
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
        });

        expect(exitCode).toBe(0);
        expect(stdout).toContain('Mira is ready.');
        expect(stderr).toBe('');
        expect(
          (await readCharacterConversation(storeRoot)).latestSessionId.endsWith(
            '.1',
          ),
        ).toBe(true);
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
        const exitCode = await runChatCliFromArgs([], {
          stdin: Readable.from(['/exit\n']),
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
        });

        expect(exitCode).toBe(0);
        expect(stdout).toContain('Mira is ready.');
        expect(stderr).toBe('');
        expect(
          (
            await readCharacterConversation(selectedStoreRoot)
          ).latestSessionId.endsWith('.1'),
        ).toBe(true);
      },
    );
  });

  it('loads the runtime store env before selecting the default chat provider', async () => {
    const storeRoot = createTestTempRoot('project02-chat-provider-env-');
    let stderr = '';

    writeRuntimeEnv(storeRoot, `${roleModelProviderEnvName}=nvidia\n`);

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['hello\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      env: {
        [nvidiaApiKeyEnvName]: '',
      },
    });

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

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['/exit\n']),
      stdout: collect(() => {}),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
      env: {
        [roleModelProviderEnvName]: 'local',
      },
    });

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
      ['--provider', 'local', '--store', storeRoot],
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

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
      stdin: Readable.from(['/exit\n']),
      stdout: collect(chunk => {
        stdout += chunk;
      }),
      stderr: collect(chunk => {
        stderr += chunk;
      }),
    });

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

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
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
    });

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

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
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
    });

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
      ['--provider', 'local', '--store', storeRoot, '--config', configPath],
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
        ['--provider', 'local', '--store', storeRoot, '--config', configPath],
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

  it('returns chat input ownership after a terminal config approval times out', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
    });
    const input = new PassThrough();

    try {
      const storeRoot = createTestTempRoot(
        'project02-chat-plugin-config-timeout-',
      );
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
        ['--provider', 'local', '--store', storeRoot, '--config', configPath],
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
    const sessionEndPlugin = createSessionEndPlugin(context => {
      sessionEndContexts.push(context);
    });
    const pluginHost = createRuntimePluginHost({
      plugins: [sessionEndPlugin],
      enabledPluginIds: [runtimePluginId, sessionEndPlugin.manifest.id],
    });

    let endedSessionId = '';
    let lastRawEvent: unknown;
    const exitCode = await withOpenConversation({}, async conversation => {
      endedSessionId = conversation.session.id;

      const code = await runChatCli({
        conversation,
        stdin: Readable.from(['/exit\n']),
        stdout: collect(() => {}),
        stderr: collect(() => {}),
        pluginHost,
      });

      lastRawEvent = conversation.logStore.rawEvents().at(-1);
      return code;
    });

    expect(exitCode).toBe(0);
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId: endedSessionId,
      currentUserMessage: '/exit',
      character: testCharacterProfile,
    });
    expect(lastRawEvent).toMatchObject({
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
      ['--store', storeRoot, '--config', configPath],
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
      sessionId: (await readCharacterConversation(storeRoot)).latestSessionId,
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

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
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
    });

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(1);

    const {latestSessionId} = await readCharacterConversation(storeRoot);

    expect(beforeRoleModelCallContexts).toHaveLength(1);
    expect(beforeRoleModelCallContexts[0]).toMatchObject({
      sessionId: latestSessionId,
      currentUserMessage: 'hello',
    });
    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId: latestSessionId,
      currentUserMessage: '/exit',
    });
    expect(shutdownContexts).toHaveLength(1);
    expect(shutdownContexts[0]).toMatchObject({
      sessionId: latestSessionId,
      character: testCharacterProfile,
    });
    expect(shutdownContexts[0]?.deadlineAt).toBeGreaterThan(Date.now());
    expect(shutdownContexts[0]?.signal.aborted).toBe(false);
  });

  it('closes configured plugins when the session ends without /exit', async () => {
    const storeRoot = createTestTempRoot('project02-chat-fatal-cleanup-');
    const configuredPlugin = createSessionEndPlugin(() => {}, {
      pluginId: 'chat.session-end.fatal-cleanup.fixture',
      rejectsTurn: true,
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
      ['--provider', 'local', '--store', storeRoot],
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
                  rejectsTurn: true,
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

    const {latestSessionId} = await readCharacterConversation(storeRoot);

    expect(sessionEndContexts).toHaveLength(1);
    expect(sessionEndContexts[0]).toMatchObject({
      sessionId: latestSessionId,
    });

    const storedRawEvents = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId: latestSessionId,
    }).rawEvents();

    expect(
      storedRawEvents.some(event => event.payloadSummary?.rawInput === '/exit'),
    ).toBe(true);
  });

  it('closes configured pre-session plugins read-only when the conversation cannot open', async () => {
    const storeRoot = createTestTempRoot('project02-chat-cleanup-');
    const sessionId = configuredPluginConstructionCleanupSessionId;
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
        requestedAccess: {file_store: 'write', turn_context: 'read'},
      },
    );
    let factoryCalls = 0;
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [configuredPlugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    // Another window holds the conversation open, so this launch cannot.
    const exitCode = await withOpenConversation({homeRoot: storeRoot}, () =>
      runChatCliFromArgs(['--store', storeRoot], {
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
      }),
    );

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('busy: conversation-writer:');
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
    const sessionEndContexts: RuntimePluginContext[] = [];
    const configuredPlugin = createSessionEndPlugin(
      context => {
        sessionEndContexts.push(context);
      },
      {
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
      ['--store', invalidStoreRoot, '--config', configPath],
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

    const exitCode = await runChatCliFromArgs(['--store', storeRoot], {
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
    });

    expect(exitCode).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(cleanupCalls).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain(
      'Configured plugin construction failed before creating a durable session.',
    );
    // The marker owns the directory before plugin factories may touch it, so
    // it is not evidence of a durable session.
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
      ['--store', storeRoot, '--config', configPath],
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
    const pluginHost = createRuntimePluginHost({
      plugins: [createFailingSessionEndPlugin()],
      enabledPluginIds: [runtimePluginId, 'chat.session-end.failure.fixture'],
    });

    const exitCode = await withOpenConversation(
      {homeRoot: storeRoot},
      conversation =>
        runChatCli({
          conversation,
          stdin: Readable.from([]),
          stdout: collect(() => {}),
          stderr: collect(() => {}),
          pluginHost,
        }),
    );

    expect(exitCode).toBe(0);

    const {latestSessionId: sessionId} =
      await readCharacterConversation(storeRoot);
    const storedRawEvents = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId: (await readCharacterConversation(storeRoot)).latestSessionId,
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
    const exitCode = await withOpenConversation({}, conversation =>
      runChatCli({
        conversation,
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

            // A provider failure is nothing the model can correct, so the turn
            // ends; the next turn still runs.
            if (invocations === 1) {
              return {
                rawOutputText: '',
                providerMetadata: {
                  provider: 'nvidia',
                  error: {code: 'http_error', message: 'upstream 503'},
                },
                rejection: {reason: 'provider_error', details: 'upstream 503'},
              };
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
      }),
    );

    expect(exitCode).toBe(0);
    expect(stderr).toContain('Error: ');
    expect(stdout).toContain('second turn reply');
    expect(invocations).toBe(2);
  });

  it('hands a reply the runtime could not use back to the model within the same turn', async () => {
    let stdout = '';
    let stderr = '';
    let invocations = 0;
    const exitCode = await withOpenConversation({}, conversation =>
      runChatCli({
        conversation,
        pluginHost: createDefaultProject02PluginHost(),
        stdin: Readable.from(['first\n/exit\n']),
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        roleModelAdapter: {
          invoke() {
            invocations += 1;

            return invocations === 1
              ? {rawOutputText: 'this is not a decision object'}
              : {
                  rawOutputText: JSON.stringify({
                    toolCalls: [
                      {name: 'visible_reply', input: {text: 'corrected reply'}},
                    ],
                  }),
                };
          },
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('Error: ');
    expect(stdout).toContain('corrected reply');
    expect(invocations).toBe(2);
  });
});

function createReplyWithNoteAdapter(): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          toolCalls: [{name: 'visible_reply', input: {text: 'hello back'}}],
          text: 'private note',
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
      firstParty: false,
      runtimePolicy: {
        timeoutMs: 1000,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
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
    readonly rejectsTurn?: boolean;
    readonly requestedAccess?: RuntimePlugin['manifest']['requestedAccess'];
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
      },
      declaredPlugins,
      config: {
        scope: 'global_with_character_overrides',
        fields: [],
      },
      firstParty: false,
      runtimePolicy: {
        timeoutMs: 1000,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall:
            options.rejectsTurn === true ? 'reject_turn' : 'degrade',
          handleToolCall: 'reject_tool_call',
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
      },
      declaredPlugins: ['on_session_end'],
      config: {
        scope: 'global_with_character_overrides',
        fields: [],
      },
      firstParty: false,
      runtimePolicy: {
        timeoutMs: 1000,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
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
      firstParty: false,
      runtimePolicy: {
        timeoutMs: 1000,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          handleToolCall: 'reject_tool_call',
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
