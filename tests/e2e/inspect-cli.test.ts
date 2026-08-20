import {characterDataDirPath} from '../../src/runtime/storage/layout-contract.ts';
import {localRuntimeStorageSchemaVersion} from '../../src/runtime/storage/layout-contract.ts';
import {
  ensureCharacterDataMarker,
  ensureInitializedProject02Home,
} from '../../src/runtime/storage/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {
  writeRuntimeConfig,
  runtimeLocationForTest,
} from '../support/runtime-config.ts';
import {withScopedProcessEnv} from '../support/runtime-config-fixtures.ts';
import {collect} from '../support/streams.ts';

import {
  createSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/turn/local.ts';
import {deliverUserMessage, openConversation} from '../../src/runtime/index.ts';
import {readCharacterConversation} from '../support/conversation-fixtures.ts';
import {
  defaultRoleModelProviderCapabilities,
  type RoleModelAdapter,
} from '../../src/role-model/index.ts';
import {runInspectCliFromArgs} from '../../src/cli/inspect/main.ts';
import {
  applyRuntimeConfigControlOperation,
  characterOverlayConfigPath,
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
  resolveRuntimeConfigScopeTarget,
} from '../../src/runtime/config/index.ts';
import {
  createRuntimePlugin,
  runtimePluginContractVersion,
  type RuntimePlugin,
  type RuntimePluginAccessMap,
  type RuntimePluginContext,
} from '../../src/plugins/api/index.ts';
import {
  characterStatePatchModelToolName,
  runtimePluginId,
} from '../../src/plugins/api/contract.ts';
import {createDefaultProject02PluginHost} from '../support/default-plugin-host.ts';
import {createSequencedAdapter} from '../support/role-model-loop-fixtures.ts';

describe('inspect CLI plugin evidence', () => {
  it('shows model rounds and per-tool plugin events', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-');
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-inspect',
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const logStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      sessionId: 'session-inspect.1',
    });
    const session = createSession({
      id: 'session-inspect.1',
      character: testCharacterProfile,
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'hello',
        createRuntimeEventIdentity({
          eventId: 'evt_inspect',
          traceId: 'trace_inspect',
          createdAt: '2026-06-15T00:00:00.000Z',
        }),
      ),
      session,
      logStore,
      pluginHost: createDefaultProject02PluginHost({
        storeRoot: characterDataDirPath(storeRoot, 'mira'),
        sessionId: 'session-inspect.1',
        sessionIdentity: session,
      }),
      roleModelAdapter: createPatchThenReplyAdapter(),
    });
    // A second turn whose first round the parser refused: the refused round
    // is on record and shows up like any other.
    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(
        'again',
        createRuntimeEventIdentity({
          eventId: 'evt_inspect_refused',
          traceId: 'trace_inspect_refused',
          createdAt: '2026-06-15T00:00:01.000Z',
        }),
      ),
      session,
      logStore,
      pluginHost: createDefaultProject02PluginHost({
        storeRoot: characterDataDirPath(storeRoot, 'mira'),
        sessionId: 'session-inspect.1',
        sessionIdentity: session,
      }),
      roleModelAdapter: createSequencedAdapter([
        {toolCalls: []},
        {toolCalls: [{name: 'visible_reply', input: {text: 'recovered'}}]},
      ]),
    });

    let stdout = '';
    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', 'session-inspect.1'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      },
    );
    const output = JSON.parse(stdout) as {
      readonly evidenceScopes: {
        readonly runtimeConfig: string;
        readonly activation: string;
        readonly storedSessionEvidence: string;
        readonly traceEvidence: string;
      };
      readonly counts: {
        readonly traceEntries: number;
      };
      readonly turns: readonly [
        {
          readonly modelRounds: readonly {
            readonly round: number;
            readonly roleModelEvidence: {
              readonly parsedDecision?: {readonly status: string};
              readonly promptSize?: {
                readonly frames: readonly {
                  readonly kind: string;
                  readonly count: number;
                }[];
                readonly total: {readonly estimatedTokens: number};
              };
              readonly output?: {
                readonly rawOutputText: string;
                readonly providerExchange?: {
                  readonly renderedMessages: readonly unknown[];
                  readonly renderedTools: readonly unknown[];
                  readonly requestBody: unknown;
                };
              };
              readonly input?: {
                readonly runtimeNotes: readonly {
                  readonly id: string;
                  readonly text: string;
                  readonly pluginId?: string;
                }[];
                readonly pluginContextItems: readonly {
                  readonly pluginId: string;
                  readonly text: string;
                }[];
              };
            };
          }[];
          readonly toolEvents: readonly [{readonly pluginId: string}];
          readonly pluginEvidence: {
            readonly contextItems: readonly {
              readonly pluginId: string;
              readonly id: string;
              readonly kind: string;
              readonly redactionLabels: readonly string[];
            }[];
            readonly evidence: readonly {
              readonly pluginId: string;
              readonly evidenceKind: string;
              readonly status: string;
            }[];
            readonly plugins: readonly {
              readonly pluginId: string;
              readonly providedTools: readonly {
                readonly name: string;
                readonly concurrency?: string;
              }[];
            }[];
          };
        },
        {
          readonly modelRounds: readonly {
            readonly round: number;
            readonly roleModelEvidence: {
              readonly parsedDecision?: {readonly status: string};
            };
          }[];
          readonly commitValidation?: {
            readonly round: number;
            readonly status: string;
            readonly acceptedVisibleReplyText?: string;
          };
        },
      ];
    };

    expect(exitCode).toBe(0);
    expect(output.evidenceScopes).toEqual({
      runtimeConfig: 'current_at_inspection',
      activation: 'current_at_inspection',
      storedSessionEvidence: 'stored_history',
      traceEvidence: 'derived_from_event_log',
    });
    expect(output.counts.traceEntries).toBeGreaterThan(0);
    expect(output.turns[0].modelRounds).toHaveLength(2);
    expect(output.turns[0].modelRounds.map(round => round.round)).toEqual([
      1, 2,
    ]);
    expect(
      output.turns[0].modelRounds[0]?.roleModelEvidence.output?.rawOutputText,
    ).toContain('character_state.patch');
    // Character State is a trusted runtime note, attributed to its plugin.
    expect(
      output.turns[0].modelRounds[0]?.roleModelEvidence.input?.runtimeNotes,
    ).toEqual([
      expect.objectContaining({id: 'today'}),
      expect.objectContaining({
        pluginId: 'character-state',
        text: expect.stringContaining('mood=') as string,
      }),
    ]);
    // The trusted frame is where the note rendered; the plugin evidence still
    // records the whole item the plugin handed over.
    expect(output.turns[0].pluginEvidence.contextItems).toEqual([
      expect.objectContaining({
        pluginId: 'character-state',
        id: 'current',
        kind: 'runtime_note',
        redactionLabels: expect.any(Array) as string[],
      }),
    ]);
    // The second round replays the first round's call and result, so its
    // prompt size names those frames beside the stable ones.
    expect(
      output.turns[0].modelRounds[1]?.roleModelEvidence.promptSize?.frames.map(
        frame => [frame.kind, frame.count],
      ),
    ).toEqual([
      ['system_protocol', 1],
      ['developer_protocol', 1],
      ['model_only_runtime_context', 1],
      ['current_user_message', 1],
      ['tool_round_assistant_message', 1],
      ['tool_round_result_message', 1],
    ]);
    expect(
      output.turns[0].modelRounds[1]?.roleModelEvidence.promptSize?.total
        .estimatedTokens,
    ).toBeGreaterThan(0);
    expect(
      output.turns[0].modelRounds[1]?.roleModelEvidence.output?.providerExchange
        ?.renderedMessages.length,
    ).toBeGreaterThan(0);
    expect(
      output.turns[0].modelRounds[1]?.roleModelEvidence.output?.providerExchange
        ?.renderedTools.length,
    ).toBeGreaterThan(0);
    expect(
      output.turns[0].modelRounds[1]?.roleModelEvidence.output?.providerExchange
        ?.requestBody,
    ).toMatchObject({
      provider: 'local-fixture',
    });
    expect(
      output.turns[0].modelRounds[1]?.roleModelEvidence.output?.providerExchange?.renderedMessages.some(
        message =>
          typeof message === 'object' &&
          message !== null &&
          (message as {readonly role?: unknown}).role === 'tool',
      ),
    ).toBe(true);
    expect(output.turns[0].toolEvents[0].pluginId).toBe('character-state');
    expect(output.turns[0].pluginEvidence.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'character-state',
          evidenceKind: 'tool_invocation',
          status: 'accepted',
          summary: 'Applied 1 Character State changes.',
        }),
      ]),
    );

    // An audit must tell a tool that runs alone from one that shares a batch,
    // so the tool's own declaration is carried into the projection.
    const patchTool = output.turns[0].pluginEvidence.plugins
      .find(plugin => plugin.pluginId === 'character-state')
      ?.providedTools.find(
        tool => tool.name === characterStatePatchModelToolName,
      );

    expect(patchTool).toMatchObject({
      concurrency: 'exclusive',
    });

    expect(
      output.turns[1].modelRounds.map(round => [
        round.round,
        round.roleModelEvidence.parsedDecision?.status,
      ]),
    ).toEqual([
      [1, 'rejected'],
      [2, 'accepted'],
    ]);
    expect(output.turns[1].commitValidation).toEqual({
      round: 2,
      status: 'accepted',
      acceptedVisibleReplyText: 'recovered',
    });
  });

  it('lists conversations and shows one thread with its segments', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-conversations-');
    const conversation = await openConversation({
      homeRoot: storeRoot,
      character: testCharacterProfile,
    });

    try {
      const delivery = await deliverUserMessage({
        conversation,
        line: 'hello',
        pluginHost: createDefaultProject02PluginHost({
          storeRoot: characterDataDirPath(storeRoot, 'mira'),
          sessionId: conversation.session.id,
          sessionIdentity: conversation.session,
        }),
        roleModelAdapter: createPatchThenReplyAdapter(),
      });

      expect(delivery.status).toBe('completed');
    } finally {
      await conversation.close();
    }

    let listStdout = '';
    const listExitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--conversations'],
      {
        stdout: collect(chunk => {
          listStdout += chunk;
        }),
        stderr: collect(() => {}),
      },
    );
    const listOutput = JSON.parse(listStdout) as {
      readonly conversations: readonly {
        readonly id: string;
        readonly participants: readonly {
          readonly kind: string;
          readonly id: string;
        }[];
      }[];
    };

    expect(listExitCode).toBe(0);
    expect(listOutput.conversations).toHaveLength(1);
    expect(
      listOutput.conversations[0]?.participants.map(
        participant => `${participant.kind}:${participant.id}`,
      ),
    ).toEqual(['character:mira', 'user:local-user']);

    const conversationId = listOutput.conversations[0]?.id ?? '';
    let threadStdout = '';
    const threadExitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--conversation', conversationId],
      {
        stdout: collect(chunk => {
          threadStdout += chunk;
        }),
        stderr: collect(() => {}),
      },
    );
    const threadOutput = JSON.parse(threadStdout) as {
      readonly conversation: {readonly id: string};
      readonly sessions: readonly {readonly sessionId: string}[];
    };

    expect(threadExitCode).toBe(0);
    expect(threadOutput.conversation.id).toBe(conversationId);
    expect(threadOutput.sessions.map(metadata => metadata.sessionId)).toEqual([
      `${conversationId}.1`,
    ]);

    let missingStderr = '';
    const missingExitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--conversation', 'absent'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          missingStderr += chunk;
        }),
      },
    );

    expect(missingExitCode).toBe(1);
    expect(missingStderr).toContain('does not exist');

    let conflictStderr = '';
    const conflictExitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--conversations', '--sessions'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          conflictStderr += chunk;
        }),
      },
    );

    expect(conflictExitCode).toBe(1);
    expect(conflictStderr).toContain('exactly one of');
  });

  it('shows how a continued session opened and the summary its turns saw', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-continued-');
    const conversation = await openConversation({
      homeRoot: storeRoot,
      character: testCharacterProfile,
    });

    try {
      // A 100-token window rotates after the third completed turn; the
      // fourth turn already runs in the continued segment and replays the
      // mechanical summary (no summariser on this adapter).
      for (const line of ['one', 'two', 'three', 'four']) {
        const delivery = await deliverUserMessage({
          conversation,
          line,
          pluginHost: createDefaultProject02PluginHost({
            storeRoot: characterDataDirPath(storeRoot, 'mira'),
            sessionId: conversation.session.id,
            sessionIdentity: conversation.session,
          }),
          roleModelAdapter: createPatchThenReplyAdapter(),
          contextWindowTokens: 100,
        });

        expect(delivery.status).toBe('completed');
      }
    } finally {
      await conversation.close();
    }

    const dm = await readCharacterConversation(storeRoot);
    const conversationId = dm.conversation.id;
    const latestSegment = Number(dm.latestSessionId.split('.').at(-1));

    // Inspect a continued segment that also ran a turn: the one before the
    // latest, since the final rotation may have left the newest one empty.
    const inspectedSegment = latestSegment - 1;

    expect(inspectedSegment).toBeGreaterThan(1);

    let stdout = '';
    const exitCode = await runInspectCliFromArgs(
      [
        '--store',
        storeRoot,
        '--session',
        `${conversationId}.${String(inspectedSegment)}`,
      ],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      },
    );
    const output = JSON.parse(stdout) as {
      readonly continuation?: {
        readonly summary: string;
        readonly continuedFrom: {readonly sessionId: string};
        readonly summarizer: {readonly status: string};
      };
      readonly turns: readonly {
        readonly modelRounds: readonly {
          readonly roleModelEvidence: {
            readonly input?: {readonly contextSummary?: string};
          };
        }[];
      }[];
    };

    expect(exitCode).toBe(0);
    expect(output.continuation).toMatchObject({
      continuedFrom: {
        sessionId: `${conversationId}.${String(inspectedSegment - 1)}`,
      },
      summarizer: {status: 'fallback'},
    });
    expect(output.continuation?.summary).toContain('Earlier conversation');
    expect(
      output.turns.at(-1)?.modelRounds[0]?.roleModelEvidence.input
        ?.contextSummary,
    ).toContain('Earlier conversation');
  });

  it('shows runtime config source and configured plugin activation', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-config-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      storeRoot,
      plugins: {
        'unknown-plugin': {
          enabled: true,
        },
      },
    });
    const dataRoot = characterDataDirPath(storeRoot, 'mira');

    await createLocalRuntimeSessionStore({
      storeRoot: dataRoot,
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-config',
      createdAt: '2026-06-21T00:00:00.000Z',
    });
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      plugins: {
        'character-state': {
          enabled: false,
        },
      },
    });

    let stdout = '';
    const exitCode = await runInspectCliFromArgs(
      ['--config', configPath, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
      },
    );
    const output = JSON.parse(stdout) as {
      readonly runtimeConfig: {
        readonly source: string;
        readonly path: string;
        readonly project02: {readonly storeRoot: string};
      };
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly enabled: boolean;
        readonly requestedAccess: RuntimePluginAccessMap;
        readonly grantedAccess: RuntimePluginAccessMap;
      }[];
    };

    expect(exitCode).toBe(0);
    expect(output.runtimeConfig).toMatchObject({
      source: 'path',
      path: configPath,
      project02: {storeRoot: realpathSync.native(storeRoot)},
    });
    expect(output.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: runtimePluginId,
          enabled: true,
          requestedAccess: {model_input: 'write'},
          grantedAccess: {model_input: 'write'},
        }),
        expect.objectContaining({
          pluginId: 'character-state',
          enabled: false,
        }),
      ]),
    );
    expect(stdout).toContain('"activationDiagnostics"');
    expect(stdout).toContain('"runtime_config_unknown_plugin"');
    expect(stdout).toContain('"disabled_by_config"');
  });

  it('uses cwd dotenv runtime config selectors for unflagged inspect', async () => {
    const cwdRoot = createTestTempRoot('project02-inspect-cwd-env-');
    const storeRoot = createTestTempRoot('project02-inspect-cwd-store-');
    const configPath = writeRuntimeConfig(join(cwdRoot, 'config.json'), {
      storeRoot,
    });
    let stdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${configPath}\n`,
      'utf8',
    );
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-cwd-config',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    await withScopedProcessEnv(
      {cwd: cwdRoot, env: {[runtimeConfigEnvVarName]: undefined}},
      async () => {
        const exitCode = await runInspectCliFromArgs(['--sessions'], {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(() => {}),
        });
        const output = JSON.parse(stdout) as {
          readonly runtimeConfig: {
            readonly source: string;
            readonly path: string;
            readonly project02: {readonly storeRoot: string};
          };
          readonly sessions: readonly {readonly sessionId: string}[];
        };

        expect(exitCode).toBe(0);
        expect(output.runtimeConfig).toMatchObject({
          source: 'env',
          path: configPath,
          project02: {storeRoot: realpathSync.native(storeRoot)},
        });
        expect(output.sessions).toContainEqual(
          expect.objectContaining({
            sessionId: 'session-cwd-config.1',
          }),
        );
      },
    );
  });

  it('ignores process and cwd dotenv runtime config selectors when --store is explicit', async () => {
    const cwdRoot = createTestTempRoot('project02-inspect-cwd-store-');
    const defaultStoreRoot = createTestTempRoot(
      'project02-inspect-default-store-',
    );
    const selectedStoreRoot = createTestTempRoot(
      'project02-inspect-selected-store-',
    );
    const defaultConfigPath = writeRuntimeConfig(join(cwdRoot, 'config.json'), {
      storeRoot: defaultStoreRoot,
    });
    let stdout = '';

    writeFileSync(
      join(cwdRoot, '.env'),
      `${runtimeConfigEnvVarName}=${defaultConfigPath}\n`,
      'utf8',
    );
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(selectedStoreRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-selected-store',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    await withScopedProcessEnv(
      {cwd: cwdRoot, env: {[runtimeConfigEnvVarName]: defaultConfigPath}},
      async () => {
        const exitCode = await runInspectCliFromArgs(
          ['--store', selectedStoreRoot, '--sessions'],
          {
            stdout: collect(chunk => {
              stdout += chunk;
            }),
            stderr: collect(() => {}),
          },
        );
        const output = JSON.parse(stdout) as {
          readonly runtimeConfig: {
            readonly source: string;
            readonly project02: {readonly storeRoot: string};
          };
          readonly sessions: readonly {readonly sessionId: string}[];
        };

        expect(exitCode).toBe(0);
        expect(output.runtimeConfig).toMatchObject({
          source: 'none',
          project02: {storeRoot: realpathSync.native(selectedStoreRoot)},
        });
        expect(output.sessions).toContainEqual(
          expect.objectContaining({
            sessionId: 'session-selected-store.1',
          }),
        );
      },
    );
  });

  it('uses an explicit store before reading an unrelated cwd dotenv', async () => {
    const cwdRoot = createTestTempRoot('project02-inspect-cwd-dotenv-error-');
    const selectedStoreRoot = createTestTempRoot(
      'project02-inspect-selected-dotenv-error-',
    );
    let stdout = '';
    let stderr = '';

    mkdirSync(join(cwdRoot, '.env'));
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(selectedStoreRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-selected-before-cwd-dotenv',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    await withScopedProcessEnv(
      {cwd: cwdRoot, env: {[runtimeConfigEnvVarName]: undefined}},
      async () => {
        const exitCode = await runInspectCliFromArgs(
          ['--store', selectedStoreRoot, '--sessions'],
          {
            stdout: collect(chunk => {
              stdout += chunk;
            }),
            stderr: collect(chunk => {
              stderr += chunk;
            }),
          },
        );
        const output = JSON.parse(stdout) as {
          readonly runtimeConfig: {
            readonly source: string;
            readonly project02: {readonly storeRoot: string};
          };
          readonly sessions: readonly {readonly sessionId: string}[];
        };

        expect(exitCode).toBe(0);
        expect(stderr).toBe('');
        expect(output.runtimeConfig).toMatchObject({
          source: 'none',
          project02: {storeRoot: realpathSync.native(selectedStoreRoot)},
        });
        expect(output.sessions).toContainEqual(
          expect.objectContaining({
            sessionId: 'session-selected-before-cwd-dotenv.1',
          }),
        );
      },
    );
  });

  it('uses a process-env selected runtime config before reading an unrelated cwd dotenv', async () => {
    const cwdRoot = createTestTempRoot(
      'project02-inspect-env-cwd-dotenv-error-',
    );
    const selectedStoreRoot = createTestTempRoot(
      'project02-inspect-env-selected-store-',
    );
    const configRoot = createTestTempRoot(
      'project02-inspect-env-selected-config-',
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
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(selectedStoreRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-env-selected-before-cwd-dotenv',
      createdAt: '2026-06-22T00:00:00.000Z',
    });

    await withScopedProcessEnv(
      {cwd: cwdRoot, env: {[runtimeConfigEnvVarName]: configPath}},
      async () => {
        const exitCode = await runInspectCliFromArgs(['--sessions'], {
          stdout: collect(chunk => {
            stdout += chunk;
          }),
          stderr: collect(chunk => {
            stderr += chunk;
          }),
        });
        const output = JSON.parse(stdout) as {
          readonly runtimeConfig: {
            readonly source: string;
            readonly path: string;
            readonly project02: {readonly storeRoot: string};
          };
          readonly sessions: readonly {readonly sessionId: string}[];
        };

        expect(exitCode).toBe(0);
        expect(stderr).toBe('');
        expect(output.runtimeConfig).toMatchObject({
          source: 'env',
          path: configPath,
          project02: {storeRoot: realpathSync.native(selectedStoreRoot)},
        });
        expect(output.sessions).toContainEqual(
          expect.objectContaining({
            sessionId: 'session-env-selected-before-cwd-dotenv.1',
          }),
        );
      },
    );
  });

  it('uses declared plugin manifests for inspect without constructing plugins', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-factory-');
    const plugin = createInspectFixturePlugin();
    let stdout = '';
    let factoryCalls = 0;

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-custom-factory',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
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
    const output = JSON.parse(stdout) as {
      readonly activationDiagnostics: readonly {readonly code: string}[];
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly enabled: boolean;
        readonly activationStatus: string;
        readonly activationReasons: readonly string[];
      }[];
    };

    expect(exitCode).toBe(0);
    expect(factoryCalls).toBe(0);
    expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
      'runtime_config_unknown_plugin',
    );
    const inspectedPlugin = output.plugins.find(
      item => item.pluginId === plugin.manifest.id,
    );

    expect(inspectedPlugin).toMatchObject({
      pluginId: plugin.manifest.id,
      enabled: true,
      activationStatus: 'active',
    });
    expect(inspectedPlugin?.activationReasons).toEqual(
      expect.arrayContaining(['test_inspect_fixture', 'enabled_by_config']),
    );
  });

  it('reports a corrupt character store instead of an empty session list', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-corrupt-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // A data directory that lost its schema marker while sessions/ still
    // holds content.
    mkdirSync(join(dataRoot, 'sessions', 'lost-session'), {recursive: true});
    writeFileSync(
      join(dataRoot, 'sessions', 'lost-session', 'raw-events.jsonl'),
      '',
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Error:');
  });

  it('warns about a broken installed character while inspecting a healthy one', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-warn-');
    const brokenRoot = join(storeRoot, 'characters', 'broken');
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    mkdirSync(brokenRoot, {recursive: true});
    // The selected character still resolves, so inspect succeeds and the
    // broken package would otherwise go unmentioned.
    writeFileSync(
      join(brokenRoot, 'project02.character.json'),
      '{not json',
      'utf8',
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toContain('Warning:');
    expect(stderr).toContain('invalid_descriptor');
    // The warning goes to stderr only: stdout stays the JSON contract.
    expect(JSON.parse(stdout)).toMatchObject({sessions: []});
  });

  it('reports a foreign home instead of an empty session list', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-foreign-home-');
    let stderr = '';

    writeFileSync(join(storeRoot, 'notes.txt'), 'not a project02 home\n');

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
  });

  it('lists no sessions while a sibling marker replacement is live', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-live-temp-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });
    // A concurrent first initializer caught between temp-write and rename.
    writeFileSync(
      join(
        dataRoot,
        `.schema.json.${String(process.pid)}.0f0e0d0c-0b0a-4908-8706-050403020100.tmp`,
      ),
      '',
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {},
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({sessions: []});
    // The view is built from the overlay a run would produce, without
    // writing it.
    expect(existsSync(characterOverlayConfigPath(dataRoot))).toBe(false);
  });

  it('reports a foreign entry in the data directory instead of an empty session list', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-foreign-entry-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // A marker-less data directory holding a non-allowlisted entry.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(join(dataRoot, 'notes.txt'), 'foreign\n');

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Error:');
  });

  it('rejects a session list when the session catalog is a symlink', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-catalog-link-');
    const outside = createTestTempRoot('project02-inspect-catalog-target-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(
      join(dataRoot, 'schema.json'),
      `${JSON.stringify({
        schemaVersion: localRuntimeStorageSchemaVersion,
        scope: 'character-data',
        characterId: 'mira',
        createdAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );
    writeFileSync(join(outside, 'external-catalog.jsonl'), '');
    symlinkSync(
      join(outside, 'external-catalog.jsonl'),
      join(dataRoot, 'sessions.jsonl'),
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error:');
  });

  it('rejects a session list when the data marker names another character', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-foreign-list-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(
      join(dataRoot, 'schema.json'),
      `${JSON.stringify({
        schemaVersion: localRuntimeStorageSchemaVersion,
        scope: 'character-data',
        characterId: 'nova',
        createdAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('holds history for character "nova"');
  });

  it('rejects a session read when the data marker names another character', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-foreign-marker-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // A copied data directory: mira's path carries nova's marker, and the
    // selected session carries no character evidence at all.
    mkdirSync(dataRoot, {recursive: true});
    writeFileSync(
      join(dataRoot, 'schema.json'),
      `${JSON.stringify({
        schemaVersion: localRuntimeStorageSchemaVersion,
        scope: 'character-data',
        characterId: 'nova',
        createdAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', 'any-session'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('holds history for character "nova"');
  });

  it('composes character state with an explicitly selected global config', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-alias-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');
    const globalConfigPath = join(storeRoot, 'config.json');
    let stdout = '';

    writeRuntimeConfig(globalConfigPath, {
      project02: {userDisplayName: 'Home Name'},
    });
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const exitCode = await runInspectCliFromArgs(
      [
        '--store',
        storeRoot,
        '--character',
        'mira',
        '--config',
        globalConfigPath,
        '--sessions',
      ],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {},
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({sessions: []});
  });

  it('keeps an explicit home when its global config and overlay are absent', async () => {
    const homeRoot = createTestTempRoot('project02-inspect-absent-layers-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    let stdout = '';

    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: dataRoot},
      characterId: 'mira',
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', homeRoot, '--character', 'mira', '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {},
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      runtimeConfig: {
        project02: {
          storeRoot: realpathSync.native(homeRoot),
          character: 'mira',
        },
      },
      sessions: [],
    });
  });

  it('rejects an overlay selected through the environment', async () => {
    const homeRoot = createTestTempRoot('project02-inspect-env-absent-layers-');
    const dataRoot = characterDataDirPath(homeRoot, 'mira');
    const overlayPath = join(dataRoot, 'config.json');
    let stderr = '';

    await ensureInitializedProject02Home({homeRoot});

    const exitCode = await runInspectCliFromArgs(
      ['--character', 'mira', '--sessions'],
      {
        stdout: collect(() => {}),
        stderr: collect(chunk => {
          stderr += chunk;
        }),
        env: {[runtimeConfigEnvVarName]: overlayPath},
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('is inside a character-data directory');
    expect(stderr).toContain('Use --store with --character');
    expect(existsSync(dataRoot)).toBe(false);
  });

  it('lists no sessions for a data directory holding only control state', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-control-only-');
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // A config-only workflow leaves control state but no session artifacts.
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: characterDataDirPath(storeRoot, 'mira')},
      characterId: 'mira',
    });
    const target = resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({
        storeRoot: storeRoot,
        characterId: 'mira',
        env: {},
      }),

      env: {},
      scope: 'character',
    });
    applyRuntimeConfigControlOperation({
      pluginManifests: [],
      target,
      request: {
        kind: 'document',
        operation: {
          kind: 'set',
          path: 'project02.userDisplayName',
          value: 'Config Only',
        },
      },
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        env: {},
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({sessions: []});
  });

  it('reports config load errors before runtime env file errors', async () => {
    const storeRoot = createTestTempRoot(
      'project02-inspect-load-error-before-env-',
    );
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      storeRoot: 42,
    });
    mkdirSync(join(storeRoot, '.env'));

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
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
    expect(stderr).toContain(
      'Runtime config field must be a non-empty string.',
    );
    expect(stderr).not.toContain('Could not load runtime config env file');
  });

  it('reports env-independent activation errors before runtime env file errors', async () => {
    const storeRoot = createTestTempRoot(
      'project02-inspect-activation-before-env-',
    );
    const plugin = createInspectRequiredConfigFixturePlugin(
      'inspect.required-config',
    );
    let stdout = '';
    let stderr = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-activation-before-env',
      createdAt: '2026-06-21T00:00:00.000Z',
    });
    mkdirSync(join(storeRoot, '.env'));

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
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
              throw new Error('inspect should not construct invalid plugins');
            },
          },
        },
      },
    );
    const output = JSON.parse(stdout) as {
      readonly activationDiagnostics: readonly {
        readonly code: string;
        readonly path?: string;
      }[];
    };

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_value_missing',
          path: `plugins.${plugin.manifest.id}.config.endpoint`,
        }),
      ]),
    );
    expect(stdout).not.toContain('Could not load runtime config env file');
  });

  it('loads runtime env before reporting mixed inspect activation diagnostics', async () => {
    const storeRoot = createTestTempRoot(
      'project02-inspect-mixed-activation-env-',
    );
    const plugin = createInspectRequiredSecretAndConfigFixturePlugin(
      'inspect.mixed-config',
    );
    const envVar = 'PROJECT02_INSPECT_MIXED_SECRET_3452532128';
    let stdout = '';
    let stderr = '';

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
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-mixed-activation-env',
      createdAt: '2026-06-21T00:00:00.000Z',
    });
    writeFileSync(
      join(storeRoot, '.env'),
      `${envVar}=inspect-secret\n`,
      'utf8',
    );

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
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
              throw new Error('inspect should not construct invalid plugins');
            },
          },
        },
      },
    );
    const output = JSON.parse(stdout) as {
      readonly activationDiagnostics: readonly {
        readonly code: string;
        readonly path?: string;
      }[];
    };

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(output.activationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime_config_required_value_missing',
          path: `plugins.${plugin.manifest.id}.config.endpoint`,
        }),
      ]),
    );
    expect(output.activationDiagnostics.map(item => item.code)).not.toContain(
      'runtime_config_required_secret_missing',
    );
    expect(stdout).not.toContain(`plugins.${plugin.manifest.id}.config.apiKey`);
  });

  it('does not invoke plugin lifecycle hooks while listing sessions', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-close-');
    const sessionEndContexts: RuntimePluginContext[] = [];
    const plugin = createInspectSessionEndFixturePlugin(context => {
      sessionEndContexts.push(context);
    });
    let stdout = '';

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-close',
      createdAt: '2026-06-22T00:00:00.000Z',
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          stdout += chunk;
        }),
        stderr: collect(() => {}),
        factories: {
          [plugin.manifest.id]: {
            manifest: plugin.manifest,
            create() {
              return plugin;
            },
          },
        },
      },
    );
    const output = JSON.parse(stdout) as {
      readonly plugins: readonly {
        readonly pluginId: string;
        readonly requestedAccess: RuntimePluginAccessMap;
        readonly grantedAccess: RuntimePluginAccessMap;
        readonly activationStatus: string;
      }[];
      readonly sessions: readonly {readonly sessionId: string}[];
    };

    expect(exitCode).toBe(0);
    expect(output.sessions).toContainEqual(
      expect.objectContaining({sessionId: 'session-close.1'}),
    );
    expect(output.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.manifest.id,
        requestedAccess: {turn_context: 'read'},
        grantedAccess: {turn_context: 'read'},
        activationStatus: 'active',
      }),
    );
    expect(sessionEndContexts).toHaveLength(0);
  });

  it('does not invoke plugin lifecycle hooks when a session read fails', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-close-failure-');
    const missingSessionId = 'missing-session';
    const sessionEndContexts: RuntimePluginContext[] = [];
    const plugin = createInspectSessionEndFixturePlugin(context => {
      sessionEndContexts.push(context);
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
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'existing-session',
      createdAt: '2026-06-22T00:00:00.000Z',
    });

    const exitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--session', missingSessionId],
      {
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
              return plugin;
            },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain(`Local runtime session "${missingSessionId}"`);
    expect(sessionEndContexts).toHaveLength(0);
  });

  it('preserves formatted store read errors without constructing plugins', async () => {
    const root = createTestTempRoot('project02-inspect-invalid-store-');
    const storeRoot = join(root, 'store-root-file');
    const configPath = join(root, 'config.json');
    const plugin = createInspectFixturePlugin('inspect.invalid-store.fixture');
    let stdout = '';
    let stderr = '';

    writeFileSync(storeRoot, 'not a directory\n', 'utf8');
    writeRuntimeConfig(configPath, {
      storeRoot,
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
        },
      },
    });

    const exitCode = await runInspectCliFromArgs(
      ['--config', configPath, '--sessions'],
      {
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
              return plugin;
            },
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('Error: Local runtime store could not be read.\n');
  });

  it('loads the runtime env file for inspect without mutating process env', async () => {
    const storeRoot = createTestTempRoot('project02-inspect-env-');
    const configPath = join(storeRoot, 'config.json');
    const envVar = 'PROJECT02_INSPECT_ENV_FILE_SECRET_3448711012';
    const previousEnvValue = process.env[envVar];

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: runtimeConfigVersion,
          project02: {
            storeRoot,
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(storeRoot, '.env'),
      `${envVar}=inspect-secret\n`,
      'utf8',
    );
    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'session-env',
      createdAt: '2026-06-21T00:00:00.000Z',
    });

    try {
      Reflect.deleteProperty(process.env, envVar);

      const exitCode = await runInspectCliFromArgs(
        ['--config', configPath, '--sessions'],
        {
          stdout: collect(() => {}),
          stderr: collect(() => {}),
        },
      );

      expect(exitCode).toBe(0);
      expect(process.env[envVar]).toBeUndefined();
    } finally {
      if (previousEnvValue === undefined) {
        Reflect.deleteProperty(process.env, envVar);
      } else {
        process.env[envVar] = previousEnvValue;
      }
    }
  });
});

function createPatchThenReplyAdapter(): RoleModelAdapter {
  let calls = 0;

  return {
    invoke(_inputEnvelope, invocation) {
      calls += 1;

      if (calls === 1) {
        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious',
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
              input: {
                text: 'done',
              },
            },
          ],
        }),
        providerExchange: {
          provider: {
            name: 'nvidia',
            model: 'inspect-fixture',
          },
          capabilities: defaultRoleModelProviderCapabilities,
          reasoning: {
            mode: 'enabled',
            params: {},
          },
          renderedMessages: invocation.turnContext.messages,
          renderedTools: invocation.turnContext.tools,
          toolNameMappings: [],
          requestBody: {
            provider: 'local-fixture',
          },
        },
      };
    },
  };
}

function createInspectFixturePlugin(
  pluginId = 'inspect.custom',
): RuntimePlugin {
  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Inspect Custom Factory Fixture',
      version: '1.0.0',
      kind: 'first_party',
      description: 'Test plugin for inspect custom factory activation.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {
        hostContractVersions: [runtimePluginContractVersion],
      },
      declaredPlugins: ['plugin_discovery'],
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
          handleToolCall: 'degrade',
          health: 'degrade',
        },
      },
      activation: {
        defaultEnabled: false,
        reasons: ['test_inspect_fixture'],
      },
      requestedAccess: {},
    },
  });
}

function createInspectRequiredConfigFixturePlugin(
  pluginId: string,
): RuntimePlugin {
  const plugin = createInspectFixturePlugin(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
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
    },
  });
}

function createInspectRequiredSecretAndConfigFixturePlugin(
  pluginId: string,
): RuntimePlugin {
  const plugin = createInspectRequiredConfigFixturePlugin(pluginId);

  return createRuntimePlugin({
    manifest: {
      ...plugin.manifest,
      config: {
        scope: 'global_with_character_overrides',
        fields: [
          ...plugin.manifest.config.fields,
          {
            name: 'apiKey',
            description: 'API key.',
            required: true,
            secret: true,
            valueType: 'secret',
            redactionLabels: ['secret'],
          },
        ],
      },
    },
  });
}

function createInspectSessionEndFixturePlugin(
  onSessionEnd: (context: RuntimePluginContext) => void,
): RuntimePlugin {
  const pluginId = 'inspect.session-end.fixture';

  return createRuntimePlugin({
    manifest: {
      id: pluginId,
      displayName: 'Inspect Session End Fixture',
      version: '1.0.0',
      kind: 'memory_provider',
      description: 'Test plugin for inspect session end lifecycle cleanup.',
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
        defaultEnabled: false,
        reasons: ['test_inspect_cleanup'],
      },
      requestedAccess: {turn_context: 'read'},
    },
    lifecycleHooks: {
      onSessionEnd(context) {
        onSessionEnd(context);

        return {
          status: 'completed',
          evidence: [],
        };
      },
    },
  });
}
