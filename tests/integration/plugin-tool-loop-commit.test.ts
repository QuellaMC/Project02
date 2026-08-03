import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';
import {createConversationSession} from '../../src/core/index.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {
  testRuntimePluginConfigControlCapability,
  testRuntimePluginFileStoreProvider,
} from '../support/plugin-host-fixtures.ts';
import {
  type RuntimePluginHost,
  type RuntimePluginReloader,
} from '../../src/plugins/host/index.ts';
import {createRuntimePlugin} from '../../src/plugins/api/constructors.ts';
import {runtimePluginConfigUpdateToolName} from '../../src/plugins/api/contract.ts';
import {
  createPluginContextEvidence,
  createRuntimePluginContextItem,
  createRuntimePluginManifest,
  firstPartyModelToolsPluginId,
  runtimePluginId,
} from '../../src/plugins/api/index.ts';
import {
  applyRuntimeConfigControlOperation,
  inspectRuntimePluginConfig,
  resolveRuntimeConfigScopeTarget,
} from '../../src/runtime/config/index.ts';
import {
  writeRuntimeConfig,
  runtimeLocationForTest,
  runtimePluginConfigControlStateForTest,
} from '../support/runtime-config.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {
  characterDataDirPath,
  createProject02HomeLayout,
} from '../../src/runtime/storage/layout-contract.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import type {RuntimeLogStore} from '../../src/runtime/evidence/records.ts';
import {
  type RoleModelAdapter,
  type RoleModelChatMessage,
  type RoleModelToolObservation,
} from '../../src/role-model/index.ts';
import {runLocalUserMessageEvent as runLocalUserMessageEventWithoutHost} from '../../src/runtime/turn/local.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  createAfterTurnCommittedAppendFailingLogStore,
  createAfterTurnCommittedProbeHost,
  createCharacterAppendFailingLogStore,
  createConversationAppendFailingLogStore,
  createOneShotTerminalTraceAppendFailingLogStore,
  createRuntimeTurnCompletedAppendFailingLogStore,
  createRuntimeTurnCompletedAppendThenThrowLogStore,
  createSequencedAdapter,
  createTestEvent,
  createToolCallFinishedAppendFailingLogStore,
  createTurnCompletedAppendFailingLogStore,
  runLocalUserMessageEventWithDefaultTestHost as runLocalUserMessageEvent,
} from '../support/plugin-tool-loop-fixtures.ts';

import {requiredDottedConfigPlugin} from '../support/runtime-config-fixtures.ts';

async function createConfigEffectTestFixture(label: string) {
  const sessionId = `session-config-effect-${label}`;
  const homeRoot = createTestTempRoot(`project02-config-effect-${label}-`);
  const storeRoot = characterDataDirPath(homeRoot, testCharacterProfile.id);

  await createLocalRuntimeSessionStore({
    storeRoot,
    characterId: testCharacterProfile.id,
  }).createSession({
    sessionId,
    createdAt: '2026-07-16T00:00:00.000Z',
  });

  const basePlugin = requiredDottedConfigPlugin(
    `config-effect-${label}.fixture`,
    'tone',
  );
  const targetPlugin = createRuntimePlugin({
    manifest: {
      ...basePlugin.manifest,
      config: {
        scope: 'global_with_character_overrides',
        fields: basePlugin.manifest.config.fields.map(field => ({
          ...field,
          required: false,
          agentMutable: true,
        })),
      },
    },
  });
  const configPath = writeRuntimeConfig(
    createProject02HomeLayout({homeRoot}).configPath,
    {
      plugins: {
        [targetPlugin.manifest.id]: {
          config: {tone: 'cool'},
        },
      },
    },
  );
  const before = inspectRuntimePluginConfig({
    targetScope: 'global',
    runtimeLocation: runtimeLocationForTest({
      configPath: configPath,
      storeRoot: homeRoot,
    }),
    manifest: targetPlugin.manifest,
    pluginManifests: [targetPlugin.manifest],
  });

  return {
    sessionId,
    homeRoot,
    storeRoot,
    targetPlugin,
    configPath,
    before,
  };
}

function createConfigEffectTestHost(options: {
  readonly fixture: Awaited<ReturnType<typeof createConfigEffectTestFixture>>;
  readonly session: ReturnType<typeof createConversationSession>;
}): RuntimePluginHost {
  const {fixture} = options;

  return createRuntimePluginHost({
    fileStore: testRuntimePluginFileStoreProvider,
    storeRoot: fixture.storeRoot,
    sessionId: fixture.sessionId,
    sessionIdentity: options.session,
    pluginConfigControl: runtimePluginConfigControlStateForTest({
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        storeRoot: fixture.homeRoot,
      }),

      control: testRuntimePluginConfigControlCapability,
      pluginManifests: [fixture.targetPlugin.manifest],
    }),
    toolConfirmationHandler: () => ({status: 'approved'}),
  });
}

function createConfigEffectTestAdapter(options: {
  readonly fixture: Awaited<ReturnType<typeof createConfigEffectTestFixture>>;
  readonly reply: string;
  readonly messagesByRound?: RoleModelChatMessage[][];
}): RoleModelAdapter {
  const updateInput = {
    pluginId: options.fixture.targetPlugin.manifest.id,
    fieldName: 'tone',
    operation: 'set',
    value: 'warm',
    expectedFingerprint: options.fixture.before.fingerprint,
  } as const;
  let invocationCount = 0;

  return Object.freeze({
    invoke(_inputEnvelope, invocation) {
      invocationCount += 1;
      options.messagesByRound?.push([...invocation.turnContext.messages]);

      if (invocationCount === 1) {
        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: runtimePluginConfigUpdateToolName,
                input: updateInput,
              },
            ],
          }),
          nativeAssistantMessage: {
            role: 'assistant',
            content: 'Preparing one approved config update.',
            tool_calls: [
              {
                id: 'call_runtime_plugin_config_update',
                type: 'function',
                function: {
                  name: runtimePluginConfigUpdateToolName,
                  arguments: JSON.stringify(updateInput),
                },
              },
            ],
          },
        };
      }

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [
            {
              name: 'visible_reply',
              input: {text: options.reply},
            },
          ],
        }),
      };
    },
  } satisfies RoleModelAdapter);
}

async function createLiveReloadLoopFixture(
  label: string,
  overrides: {
    readonly reloader?: RuntimePluginReloader;
    readonly withSessionScopedNote?: boolean;
  } = {},
) {
  const fixture = await createConfigEffectTestFixture(`reload-${label}`);
  const manifest = createRuntimePluginManifest({
    ...fixture.targetPlugin.manifest,
    declaredPlugins: ['before_role_model_call', 'after_turn_committed'],
    requestedAccess: {model_input: 'write'},
    config: {
      scope: 'global_with_character_overrides',
      fields: [
        ...fixture.targetPlugin.manifest.config.fields.map(field =>
          field.name === 'tone' ? {...field, reloadRequired: false} : field,
        ),
        ...(overrides.withSessionScopedNote === true
          ? [
              {
                name: 'note',
                description: 'Session-scoped note.',
                required: false,
                secret: false,
                valueType: 'string' as const,
                agentMutable: true,
                redactionLabels: [],
              },
            ]
          : []),
      ],
    },
  });
  let before = fixture.before;

  if (overrides.withSessionScopedNote === true) {
    writeRuntimeConfig(fixture.configPath, {
      plugins: {
        [manifest.id]: {
          config: {tone: 'cool', note: 'quiet'},
        },
      },
    });
    before = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        storeRoot: fixture.homeRoot,
      }),
      manifest,
      pluginManifests: [manifest],
    });
  }
  const afterCommitLog: string[] = [];
  const stylePlugin = (tone: string) =>
    createRuntimePlugin({
      manifest,
      lifecycleHooks: {
        afterTurnCommitted() {
          afterCommitLog.push(`after:${tone}`);
          return {status: 'completed' as const, evidence: []};
        },
        beforeRoleModelCall(context) {
          return {
            contextItems: [
              createRuntimePluginContextItem({
                pluginId: manifest.id,
                id: 'style',
                kind: 'runtime_note',
                text: `tone:${tone}`,
                budget: {estimatedTokens: 8, priority: 50},
                sourceReferences: [],
                confidence: 1,
                redactionLabels: context.privacy.redactionLabels,
              }),
            ],
            evidence: [
              createPluginContextEvidence({
                context,
                pluginId: manifest.id,
                status: 'accepted',
                summary: 'Provided style context.',
              }),
            ],
          };
        },
      },
    });
  const authoredTone = () => {
    const config = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as {
      plugins?: Record<string, {config?: {tone?: string}}>;
    };

    return config.plugins?.[manifest.id]?.config?.tone ?? 'cool';
  };
  const session = createConversationSession({
    id: fixture.sessionId,
    character: testCharacterProfile,
  });
  const logStore = createFileRuntimeLogStore({
    boundCharacter: testCharacterProfile,
    characterId: testCharacterProfile.id,
    storeRoot: fixture.storeRoot,
    sessionId: fixture.sessionId,
  });
  let reloaderInvocations = 0;
  const createPluginHost = () =>
    createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      storeRoot: fixture.storeRoot,
      sessionId: fixture.sessionId,
      sessionIdentity: session,
      // Mirrors the configured composition root: the host records which
      // authored config its instances were built from, so recovery can skip
      // rebuilds the running host already reflects.
      constructionConfigFingerprint: inspectRuntimePluginConfig({
        targetScope: 'global',
        runtimeLocation: runtimeLocationForTest({
          configPath: fixture.configPath,
          storeRoot: fixture.homeRoot,
        }),
        manifest,
        pluginManifests: [manifest],
      }).fingerprint,
      plugins: [stylePlugin(authoredTone())],
      enabledPluginIds: [
        runtimePluginId,
        firstPartyModelToolsPluginId,
        manifest.id,
      ],
      pluginConfigControl: runtimePluginConfigControlStateForTest({
        runtimeLocation: runtimeLocationForTest({
          configPath: fixture.configPath,
          storeRoot: fixture.homeRoot,
        }),

        control: testRuntimePluginConfigControlCapability,
        pluginManifests: [manifest],
      }),
      toolConfirmationHandler: () => ({status: 'approved'}),
      pluginReloader:
        overrides.reloader ??
        Object.freeze({
          reload: (pluginId: string) => {
            reloaderInvocations += 1;
            return Promise.resolve(
              pluginId === manifest.id
                ? {
                    status: 'rebuilt' as const,
                    plugin: stylePlugin(authoredTone()),
                  }
                : {status: 'declined' as const, reason: 'unknown plugin'},
            );
          },
        }),
    });
  const pluginHost = createPluginHost();
  const capturedContexts: string[][] = [];
  const contextCaptureAdapter = Object.freeze({
    invoke(inputEnvelope) {
      capturedContexts.push(
        inputEnvelope.decisionContext.pluginContextItems.map(item => item.text),
      );
      return {
        rawOutputText: JSON.stringify({
          toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
        }),
      };
    },
  } satisfies RoleModelAdapter);

  return {
    session,
    logStore,
    pluginHost,
    createPluginHost,
    authoredTone,
    afterCommitLog,
    capturedContexts,
    contextCaptureAdapter,
    reloaderCalls: () => reloaderInvocations,
    updateInput: {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'set',
      value: 'warm',
      expectedFingerprint: before.fingerprint,
    },
  };
}

describe('plugin-driven tool loop commit and rollback', () => {
  it('requires a startup-injected host before recording turn evidence', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });

    await expect(
      Reflect.apply(runLocalUserMessageEventWithoutHost, undefined, [
        {
          event: createTestEvent('hello', 'evt_missing_plugin_host'),
          session,
          logStore,
          roleModelAdapter: createSequencedAdapter([
            {
              toolCalls: [
                {
                  name: 'visible_reply',
                  input: {text: 'This turn must not run.'},
                },
              ],
            },
          ]),
        },
      ]),
    ).rejects.toThrow(
      'Local runtime turns require an explicitly configured plugin host.',
    );
    expect(logStore.traceEntries()).toEqual([]);
    expect(logStore.rawEvents()).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
  });

  it('terminates on top-level text only without committing visible messages', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    const adapter = createSequencedAdapter([
      {
        text: 'folded model note',
        toolCalls: [],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('quiet turn', 'evt_text_only'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    if (result.status !== 'completed') {
      throw new Error('Expected text-only turn to complete.');
    }

    // The user's message is history the moment it is accepted, even when
    // the model folds its answer into non-committed text: nothing the
    // user said disappears because the turn produced no visible reply.
    expect(
      logStore.conversationMessages().map(message => message.role),
    ).toEqual(['user']);
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'accepted',
          nonCommittedText: 'folded model note',
        },
      },
      commitValidation: {
        result: {
          status: 'accepted',
        },
      },
    });
    expect(logStore.rawEvents().at(-1)?.visibleMessageIds).toEqual([
      'local-session:message-1',
    ]);
  });

  it('keeps a message whose commit anchor persisted before the append threw', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-loop-');
    const sessionId = 'session-anchor-persisted-then-failed';

    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });

    const fileLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot,
      sessionId,
    });
    const session = createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const logStore = Object.freeze({
      ...(fileLogStore.localRuntimeSessionPaths === undefined
        ? {}
        : {localRuntimeSessionPaths: fileLogStore.localRuntimeSessionPaths}),
      ...(fileLogStore.localRuntimeWriterLockOwnerToken === undefined
        ? {}
        : {
            localRuntimeWriterLockOwnerToken:
              fileLogStore.localRuntimeWriterLockOwnerToken,
          }),
      appendTrace: entry => fileLogStore.appendTrace(entry),
      appendRawEvent(record) {
        const stored = fileLogStore.appendRawEvent(record);

        if (
          record.kind === 'visible_message_committed' &&
          stored.visibleMessageIds?.includes(`${sessionId}:message-2`) === true
        ) {
          throw new Error('anchor persisted then failed');
        }

        return stored;
      },
      appendConversationMessage: (record, expectedCharacter) =>
        fileLogStore.appendConversationMessage(record, expectedCharacter),
      removeConversationMessages(messageIds) {
        fileLogStore.removeConversationMessages(messageIds);
      },
      recoverAbandonedWriterEvidence: () =>
        fileLogStore.recoverAbandonedWriterEvidence?.() ?? false,
      checkpointWriterEvidence: () => fileLogStore.checkpointWriterEvidence?.(),
      readSessionEvidence: () => fileLogStore.readSessionEvidence(),
      traceEntries: () => fileLogStore.traceEntries(),
      rawEvents: () => fileLogStore.rawEvents(),
      conversationMessages: () => fileLogStore.conversationMessages(),
    } satisfies RuntimeLogStore);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('hi', 'evt_anchor_persisted_then_failed'),
        session,
        logStore,
        roleModelAdapter: createSequencedAdapter([
          {
            toolCalls: [{name: 'visible_reply', input: {text: 'hello back'}}],
          },
        ]),
      }),
    ).rejects.toThrow('anchor persisted then failed');

    // The durable anchor references this message, so deleting the row
    // would leave evidence pointing at a message that no longer exists —
    // a shape writer recovery cannot repair. The message stays.
    const paths = fileLogStore.localRuntimeSessionPaths;

    if (paths === undefined) {
      throw new Error('Expected file runtime log store session paths.');
    }

    const durableMessageTexts = readFileSync(paths.conversationPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => (JSON.parse(line) as {text: string}).text);
    const durableAnchoredIds = readFileSync(paths.rawEventsPath, 'utf8')
      .split('\n')
      .filter(line => line.includes('"visible_message_committed"'))
      .flatMap(
        line =>
          (JSON.parse(line) as {visibleMessageIds?: string[]})
            .visibleMessageIds ?? [],
      );

    expect(durableMessageTexts).toEqual(['hi', 'hello back']);
    expect(durableAnchoredIds).toEqual([
      `${sessionId}:message-1`,
      `${sessionId}:message-2`,
    ]);
  });

  it('completes a text-only terminal round after a committed interim reply', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {text: 'let me check'},
          },
          {
            name: 'character_state.patch',
            input: {mood: 'curious'},
          },
        ],
      },
      {
        text: 'internal wrap-up note',
        toolCalls: [],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('quiet finish', 'evt_interim_then_text_only'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    // The terminal decision has no visible_reply, so commit validation
    // carries no accepted reply text even though an earlier round
    // committed an interim message; the turn stays a valid completion.
    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['quiet finish', 'let me check']);
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'accepted',
          nonCommittedText: 'internal wrap-up note',
        },
      },
    });
    expect(
      logStore.rawEvents().at(-1)?.commitValidation?.result,
    ).not.toHaveProperty('acceptedVisibleReplyText');
  });

  it('commits multi-line final visible replies', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'I can use:\n- runtime.plugin.list\n- character_state.patch',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('list tools', 'evt_multiline_visible'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual([
      'list tools',
      'I can use:\n- runtime.plugin.list\n- character_state.patch',
    ]);
  });

  it('commits authoritative visible reply text while durable evidence stays redacted', async () => {
    const sessionId = 'session-authoritative-visible';
    const storeRoot = createTestTempRoot('project02-authoritative-visible-');

    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });

    const session = createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
    });
    const replyText = 'Authorization: Bearer committed-reply-secret';
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {text: replyText},
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'show the exact value',
        'evt_authoritative_visible',
      ),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['show the exact value', replyText]);

    const serializedEvidence = JSON.stringify({
      rawEvents: logStore.rawEvents(),
      traces: logStore.traceEntries(),
    });

    expect(serializedEvidence).toContain('Authorization: [redacted]');
    expect(serializedEvidence).not.toContain('committed-reply-secret');
  });

  it('rolls back visible session messages when conversation log append fails', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createConversationAppendFailingLogStore();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'this should not remain in memory',
            },
          },
        ],
      },
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('hello', 'evt_conversation_append_fails'),
        session,
        logStore,
        roleModelAdapter: adapter,
      }),
    ).rejects.toThrow('conversation append failed');
    expect(session.visibleTranscript).toEqual([]);
    expect(logStore.conversationMessages()).toEqual([]);
  });

  it('discards a prepared Character State patch when conversation append fails', async () => {
    const sessionId = 'session-character-state-conversation-append-fails';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });

    const session = createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const logStore = createConversationAppendFailingLogStore(
      createFileRuntimeLogStore({
        boundCharacter: testCharacterProfile,
        characterId: testCharacterProfile.id,
        storeRoot,
        sessionId,
      }),
    );
    const pluginHost = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      storeRoot,
      sessionId,
      plugins: [createCharacterStatePlugin()],
      enabledPluginIds: [
        runtimePluginId,
        firstPartyModelToolsPluginId,
        characterStatePluginId,
      ],
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId,
    });

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent(
          'hello',
          'evt_character_state_conversation_append_fails',
        ),
        session,
        logStore,
        pluginHost,
        roleModelAdapter: createSequencedAdapter([
          {
            toolCalls: [
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'the conversation append should fail',
                },
              },
            ],
          },
        ]),
      }),
    ).rejects.toThrow('conversation append failed');

    expect(pluginStore.readJsonl('events.jsonl')).toEqual([]);
    expect(pluginStore.readJson('checkpoint.json')).toBeUndefined();
  });

  it('keeps the accepted user row and rejects the turn when a character append fails', async () => {
    const storeRoot = createTestTempRoot('project02-log-store-');
    const sessionId = 'session-character-append-fails';
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const fileLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot,
      sessionId,
    });
    const logStore = createCharacterAppendFailingLogStore(fileLogStore);
    const session = createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'this should not leave an unmatched user row',
            },
          },
        ],
      },
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('hello', 'evt_character_append_fails'),
        session,
        logStore,
        roleModelAdapter: adapter,
      }),
    ).rejects.toThrow('character append failed');

    const reopenedLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot,
      sessionId,
    });

    // Commit-as-emitted: the user's accepted message is already history,
    // so only the failed character append rolls back. The rejected turn
    // closes around the kept user row.
    expect(session.visibleTranscript.map(message => message.role)).toEqual([
      'user',
    ]);
    expect(
      reopenedLogStore.conversationMessages().map(message => message.role),
    ).toEqual(['user']);
    expect(reopenedLogStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
    });
  });

  it('runs afterTurnCommitted after visible messages and terminal evidence commit', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    let visibleMessagesVisibleToHook = false;
    let terminalEventVisibleToHook = false;
    const pluginHost = createAfterTurnCommittedProbeHost(() => {
      visibleMessagesVisibleToHook =
        logStore.conversationMessages().length === 2;
      terminalEventVisibleToHook = logStore
        .rawEvents()
        .some(event => event.kind === 'runtime_turn_completed');
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'terminal evidence comes first',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_after_commit_order'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost,
    });

    expect(result.status).toBe('completed');
    expect(visibleMessagesVisibleToHook).toBe(true);
    expect(terminalEventVisibleToHook).toBe(true);
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
    });
  });

  it('persists afterTurnCommitted failures as follow-up turn evidence', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    const pluginHost = createAfterTurnCommittedProbeHost(() => {}, {
      status: 'failed',
      summary: 'After commit fixture failed.',
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'after commit evidence is durable',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_after_commit_failure'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost,
    });
    const terminalEvent = logStore
      .rawEvents()
      .find(event => event.kind === 'runtime_turn_completed');
    const afterCommitEvent = logStore.rawEvents().at(-1);

    expect(result.status).toBe('completed');
    expect(result.rawEvent).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
    });
    expect(terminalEvent).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
    });
    expect(afterCommitEvent).toMatchObject({
      kind: 'after_turn_committed',
      status: 'completed_with_failures',
      runtimePluginEvidence: [
        {
          pluginId: 'after-commit.fixture',
          evidenceKind: 'after_turn_committed',
          status: 'failed',
          summary: 'After commit fixture failed.',
        },
      ],
    });
  });

  it('keeps the completed turn when afterTurnCommitted evidence append fails', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createAfterTurnCommittedAppendFailingLogStore();
    const pluginHost = createAfterTurnCommittedProbeHost(() => {}, {
      status: 'failed',
      summary: 'After commit fixture failed after terminal commit.',
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'terminal commit survives after hook log failure',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_after_commit_append_failure'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost,
    });

    expect(result.status).toBe('completed');
    expect(result.rawEvent).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
    });
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['hello', 'terminal commit survives after hook log failure']);
    expect(
      logStore
        .rawEvents()
        .filter(
          event =>
            event.kind === 'runtime_turn_completed' ||
            event.kind === 'runtime_turn_rejected',
        )
        .map(event => event.kind),
    ).toEqual(['runtime_turn_completed']);
    expect(
      logStore.rawEvents().some(event => event.kind === 'after_turn_committed'),
    ).toBe(false);
  });

  it('does not run afterTurnCommitted when terminal raw event append fails', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeTurnCompletedAppendFailingLogStore();
    let afterTurnCommittedCalls = 0;
    const pluginHost = createAfterTurnCommittedProbeHost(() => {
      afterTurnCommittedCalls += 1;
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'terminal append should fail first',
            },
          },
        ],
      },
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('hello', 'evt_terminal_append_fails'),
        session,
        logStore,
        roleModelAdapter: adapter,
        pluginHost,
      }),
    ).rejects.toThrow('terminal raw event append failed');
    expect(afterTurnCommittedCalls).toBe(0);
    expect(session.visibleTranscript.map(message => message.text)).toEqual([
      'hello',
      'terminal append should fail first',
    ]);
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['hello', 'terminal append should fail first']);
    expect(
      logStore
        .rawEvents()
        .some(event => event.kind === 'runtime_turn_completed'),
    ).toBe(false);
    const visibleMessageIds = logStore
      .conversationMessages()
      .map(message => message.id);

    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      visibleMessageIds,
    });
  });

  it('reconciles a one-shot terminal trace failure without rejecting the completed turn', async () => {
    const sessionId = 'session-terminal-trace-reconciliation';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });

    const fileLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
    });
    const logStore =
      createOneShotTerminalTraceAppendFailingLogStore(fileLogStore);
    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_terminal_trace_reconciliation'),
      session: createConversationSession({
        id: sessionId,
        character: testCharacterProfile,
      }),
      logStore,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'the completed reply survives trace reconciliation',
              },
            },
          ],
        },
      ]),
    });
    const reopened = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected a completed runtime turn.');
    }
    expect(result.conversationMessages.at(-1)).toMatchObject({
      role: 'character',
      text: 'the completed reply survives trace reconciliation',
    });
    expect(result).not.toHaveProperty('postCommitFailures');
    expect(
      reopened
        .rawEvents()
        .filter(record => record.kind === 'runtime_turn_completed'),
    ).toHaveLength(1);
    expect(
      reopened
        .traceEntries()
        .filter(
          entry =>
            entry.eventId === 'evt_terminal_trace_reconciliation' &&
            (entry.step === 'raw_event_log_appended' ||
              entry.step === 'runtime_turn_completed'),
        )
        .map(entry => entry.step),
    ).toEqual(['raw_event_log_appended', 'runtime_turn_completed']);
  });

  it('commits a prepared Character State patch when terminal append throws after persisting', async () => {
    const sessionId = 'session-character-state-terminal-append-then-throw';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });

    const fileLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
    });
    const logStore =
      createRuntimeTurnCompletedAppendThenThrowLogStore(fileLogStore);
    const pluginHost = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      storeRoot,
      sessionId,
      plugins: [createCharacterStatePlugin()],
      enabledPluginIds: [
        runtimePluginId,
        firstPartyModelToolsPluginId,
        characterStatePluginId,
      ],
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId,
    });

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'hello',
        'evt_character_state_terminal_append_then_throw',
      ),
      session: createConversationSession({
        id: sessionId,
        character: testCharacterProfile,
      }),
      logStore,
      pluginHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'character_state.patch',
              input: {mood: 'curious'},
            },
          ],
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {text: 'the committed terminal is reconciled'},
            },
          ],
        },
      ]),
    });

    expect(result).toMatchObject({
      status: 'completed',
      rawEvent: {
        kind: 'runtime_turn_completed',
      },
      postCommitFailures: [
        'terminal raw event append reported failure after write',
      ],
    });
    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(1);
    expect(pluginStore.readJson('checkpoint.json')).toMatchObject({
      current: {
        current: {
          mood: 'curious',
        },
      },
    });
    expect(
      fileLogStore
        .rawEvents()
        .filter(
          event =>
            event.kind === 'runtime_turn_completed' ||
            event.kind === 'runtime_turn_rejected',
        )
        .map(event => event.kind),
    ).toEqual(['runtime_turn_completed']);
  });

  it('keeps durable visible-reply evidence valid when terminal raw event append fails', async () => {
    const sessionId = 'session-terminal-append-visible-reply-evidence';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });

    const fileLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot,
      sessionId,
    });
    const logStore =
      createRuntimeTurnCompletedAppendFailingLogStore(fileLogStore);
    const pluginHost = createRuntimePluginHost({plugins: []});
    const session = createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'terminal append fails after visible evidence',
            },
          },
        ],
      },
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('hello', 'evt_terminal_append_visible_evidence'),
        session,
        logStore,
        roleModelAdapter: adapter,
        pluginHost,
      }),
    ).rejects.toThrow('terminal raw event append failed');

    const reopenedLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot,
      sessionId,
    });
    const conversationMessages = reopenedLogStore.conversationMessages();
    const visibleMessageIds = conversationMessages.map(message => message.id);
    const rawEvents = reopenedLogStore.rawEvents();

    expect(conversationMessages.map(message => message.text)).toEqual([
      'hello',
      'terminal append fails after visible evidence',
    ]);
    expect(
      rawEvents
        .filter(
          event =>
            event.kind === 'runtime_turn_completed' ||
            event.kind === 'runtime_turn_rejected',
        )
        .map(event => event.kind),
    ).toEqual(['runtime_turn_rejected']);
    expect(
      rawEvents
        .filter(event => event.kind === 'visible_message_committed')
        .flatMap(event => event.visibleMessageIds ?? []),
    ).toEqual(visibleMessageIds);
    expect(rawEvents.at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
      visibleMessageIds,
    });

    const restoredSession = createConversationSession({
      character: testCharacterProfile,
      id: sessionId,
      visibleTranscript: conversationMessages,
    });
    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('again', 'evt_terminal_append_followup'),
      session: restoredSession,
      logStore: reopenedLogStore,
      pluginHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'followup after rejection evidence',
              },
            },
          ],
        },
      ]),
    });

    expect(followupResult.status).toBe('completed');
    expect(
      reopenedLogStore.conversationMessages().map(message => message.text),
    ).toEqual([
      'hello',
      'terminal append fails after visible evidence',
      'again',
      'followup after rejection evidence',
    ]);
  });

  it('applies an approved config effect only after durable terminal intent', async () => {
    const fixture = await createConfigEffectTestFixture('durable-success');
    const messagesByRound: RoleModelChatMessage[][] = [];
    const session = createConversationSession({
      id: fixture.sessionId,
      character: testCharacterProfile,
    });
    const logStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: fixture.storeRoot,
      sessionId: fixture.sessionId,
    });
    const pluginHost = createConfigEffectTestHost({fixture, session});
    const result = await runLocalUserMessageEvent({
      event: createTestEvent('update config', 'evt_config_effect_success'),
      session,
      logStore,
      pluginHost,
      roleModelAdapter: createConfigEffectTestAdapter({
        fixture,
        reply: 'Config committed.',
        messagesByRound,
      }),
    });
    const after = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        storeRoot: fixture.homeRoot,
      }),
      manifest: fixture.targetPlugin.manifest,
      pluginManifests: [fixture.targetPlugin.manifest],
    });
    const terminal = logStore
      .rawEvents()
      .find(event => event.kind === 'runtime_turn_completed');
    const effect = terminal?.runtimeConfigEffects?.[0];
    const marker = logStore
      .rawEvents()
      .find(
        event =>
          event.kind === 'after_turn_committed' &&
          event.runtimePluginEvidence?.some(evidence =>
            evidence.sourceReferences?.some(
              reference => reference.id === effect?.effectId,
            ),
          ),
      );
    const nativeToolResult = messagesByRound[1]?.find(
      message => message.role === 'tool',
    );

    expect(result.status).toBe('completed');
    expect(terminal).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
      runtimeConfigEffects: [
        {
          targetPluginId: fixture.targetPlugin.manifest.id,
          operation: {kind: 'set', value: 'warm'},
        },
      ],
    });
    expect(after.fields.find(field => field.name === 'tone')?.authored).toEqual(
      {configured: true, value: 'warm'},
    );
    expect(marker).toMatchObject({
      kind: 'after_turn_committed',
      status: 'completed',
    });
    expect(nativeToolResult?.content).toContain(
      '"status":"approved_pending_commit"',
    );
    expect(nativeToolResult?.content).not.toContain('preparedConfigEffect');
    expect(nativeToolResult?.content).not.toContain('runtimeConfigEffects');
  });

  it('lets the model correct a rejected config update in the same turn', async () => {
    const fixture = await createConfigEffectTestFixture('rejected-retry');
    const session = createConversationSession({
      id: fixture.sessionId,
      character: testCharacterProfile,
    });
    const logStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: fixture.storeRoot,
      sessionId: fixture.sessionId,
    });
    const pluginHost = createConfigEffectTestHost({fixture, session});
    const observationsByRound: (readonly RoleModelToolObservation[])[] = [];
    const updateInput = {
      pluginId: fixture.targetPlugin.manifest.id,
      fieldName: 'tone',
      operation: 'set',
      expectedFingerprint: fixture.before.fingerprint,
    } as const;
    let invocationCount = 0;
    const adapter = Object.freeze({
      invoke(inputEnvelope) {
        invocationCount += 1;
        observationsByRound.push(inputEnvelope.toolObservations);

        if (invocationCount === 1) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: runtimePluginConfigUpdateToolName,
                  input: {...updateInput, value: 7},
                },
              ],
            }),
          };
        }

        if (invocationCount === 2) {
          return {
            rawOutputText: JSON.stringify({
              toolCalls: [
                {
                  name: runtimePluginConfigUpdateToolName,
                  input: {...updateInput, value: 'warm'},
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
                input: {text: 'Tone corrected to warm.'},
              },
            ],
          }),
        };
      },
    } satisfies RoleModelAdapter);
    const result = await runLocalUserMessageEvent({
      event: createTestEvent('update config', 'evt_config_effect_retry'),
      session,
      logStore,
      pluginHost,
      roleModelAdapter: adapter,
    });
    const after = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        storeRoot: fixture.homeRoot,
      }),
      manifest: fixture.targetPlugin.manifest,
      pluginManifests: [fixture.targetPlugin.manifest],
    });
    const rejection = observationsByRound[1]?.find(
      observation => observation.toolName === runtimePluginConfigUpdateToolName,
    );

    expect(result.status).toBe('completed');
    expect(rejection?.result).toMatchObject({
      status: 'rejected',
      message:
        'Plugin config field "tone" must be a string; received a number.',
    });
    expect(after.fields.find(field => field.name === 'tone')?.authored).toEqual(
      {configured: true, value: 'warm'},
    );
  });

  it('live-applies an approved reloadRequired:false config update by the next turn', async () => {
    const live = await createLiveReloadLoopFixture('live-apply');
    const updateAdapter = createSequencedAdapter([
      {
        toolCalls: [
          {name: runtimePluginConfigUpdateToolName, input: live.updateInput},
        ],
      },
      {toolCalls: [{name: 'visible_reply', input: {text: 'tone updated'}}]},
    ]);

    const updateResult = await runLocalUserMessageEvent({
      event: createTestEvent('update tone', 'evt_live_apply_update'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: live.pluginHost,
      roleModelAdapter: updateAdapter,
    });

    expect(updateResult.status).toBe('completed');
    if (updateResult.status !== 'completed') {
      throw new Error('Expected the update turn to complete.');
    }
    expect(updateResult.postCommitFailures).toBeUndefined();
    expect(live.authoredTone()).toBe('warm');

    const liveApplyEvidence = live.logStore
      .rawEvents()
      .filter(event => event.kind === 'after_turn_committed')
      .flatMap(event => event.runtimePluginEvidence ?? [])
      .find(evidence => evidence.summary.startsWith('Live-applied'));

    expect(liveApplyEvidence).toMatchObject({status: 'accepted'});
    expect(live.afterCommitLog).toEqual(['after:cool']);

    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('and now?', 'evt_live_apply_followup'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: live.pluginHost,
      roleModelAdapter: live.contextCaptureAdapter,
    });

    expect(followupResult.status).toBe('completed');
    expect(live.capturedContexts[0]).toContain('tone:warm');
    expect(live.afterCommitLog).toEqual(['after:cool', 'after:warm']);
  });

  it('keeps the old instance and records a post-commit failure when the reload factory throws', async () => {
    const live = await createLiveReloadLoopFixture('live-fail', {
      reloader: {
        reload: () => Promise.reject(new Error('factory exploded')),
      },
    });
    const updateAdapter = createSequencedAdapter([
      {
        toolCalls: [
          {name: runtimePluginConfigUpdateToolName, input: live.updateInput},
        ],
      },
      {toolCalls: [{name: 'visible_reply', input: {text: 'tone updated'}}]},
    ]);

    const updateResult = await runLocalUserMessageEvent({
      event: createTestEvent('update tone', 'evt_live_fail_update'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: live.pluginHost,
      roleModelAdapter: updateAdapter,
    });

    expect(updateResult.status).toBe('completed');
    if (updateResult.status !== 'completed') {
      throw new Error('Expected the update turn to complete.');
    }
    expect(updateResult.postCommitFailures?.join(' ')).toContain(
      'factory exploded',
    );
    expect(live.authoredTone()).toBe('warm');

    const failedEvidence = live.logStore
      .rawEvents()
      .filter(event => event.kind === 'after_turn_committed')
      .flatMap(event => event.runtimePluginEvidence ?? [])
      .find(evidence => evidence.summary.startsWith('Live config reload'));

    expect(failedEvidence).toMatchObject({status: 'failed'});

    const failedAfterCommitEvent = live.logStore
      .rawEvents()
      .filter(event => event.kind === 'after_turn_committed')
      .find(event =>
        event.runtimePluginEvidence?.some(evidence =>
          evidence.summary.startsWith('Live config reload'),
        ),
      );

    expect(failedAfterCommitEvent?.status).toBe('completed_with_failures');

    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('and now?', 'evt_live_fail_followup'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: live.pluginHost,
      roleModelAdapter: live.contextCaptureAdapter,
    });

    expect(followupResult.status).toBe('completed');
    expect(live.capturedContexts[0]).toContain('tone:cool');
  });

  it('recovers an applied config effect when its commit marker append failed', async () => {
    const fixture = await createConfigEffectTestFixture('marker-recovery');
    const session = createConversationSession({
      id: fixture.sessionId,
      character: testCharacterProfile,
    });
    const fileLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: fixture.storeRoot,
      sessionId: fixture.sessionId,
    });
    const logStore =
      createAfterTurnCommittedAppendFailingLogStore(fileLogStore);
    const pluginHost = createConfigEffectTestHost({fixture, session});
    const firstResult = await runLocalUserMessageEvent({
      event: createTestEvent('update config', 'evt_config_marker_recovery'),
      session,
      logStore,
      pluginHost,
      roleModelAdapter: createConfigEffectTestAdapter({
        fixture,
        reply: 'Config committed before marker failure.',
      }),
    });
    const terminal = fileLogStore
      .rawEvents()
      .find(event => event.kind === 'runtime_turn_completed');
    const effect = terminal?.runtimeConfigEffects?.[0];
    const afterApply = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        storeRoot: fixture.homeRoot,
      }),
      manifest: fixture.targetPlugin.manifest,
      pluginManifests: [fixture.targetPlugin.manifest],
    });

    expect(firstResult).toMatchObject({
      status: 'completed',
      postCommitFailures: ['after-turn raw event append failed'],
    });
    expect(afterApply.fingerprint).toBe(effect?.resultFingerprint);
    expect(
      fileLogStore
        .rawEvents()
        .some(event => event.kind === 'after_turn_committed'),
    ).toBe(false);

    const reopenedLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: fixture.storeRoot,
      sessionId: fixture.sessionId,
    });
    const restoredSession = createConversationSession({
      character: testCharacterProfile,
      id: fixture.sessionId,
      visibleTranscript: reopenedLogStore.conversationMessages(),
    });
    const recoveryHost = createConfigEffectTestHost({
      fixture,
      session: restoredSession,
    });

    expect(
      await runLocalUserMessageEvent({
        event: createTestEvent('continue', 'evt_config_marker_followup'),
        session: restoredSession,
        logStore: reopenedLogStore,
        pluginHost: recoveryHost,
        roleModelAdapter: createSequencedAdapter([
          {
            toolCalls: [
              {
                name: 'visible_reply',
                input: {text: 'Recovered marker.'},
              },
            ],
          },
        ]),
      }),
    ).toMatchObject({status: 'completed'});
    expect(
      reopenedLogStore
        .rawEvents()
        .filter(
          event =>
            event.kind === 'after_turn_committed' &&
            event.runtimePluginEvidence?.some(evidence =>
              evidence.sourceReferences?.some(
                reference => reference.id === effect?.effectId,
              ),
            ),
        ),
    ).toHaveLength(1);
  });

  it('skips the recovery rebuild when the running host already carries the config', async () => {
    const live = await createLiveReloadLoopFixture('already-applied');
    const failingStore = createAfterTurnCommittedAppendFailingLogStore(
      live.logStore,
    );
    const crashResult = await runLocalUserMessageEvent({
      event: createTestEvent('update tone', 'evt_already_applied_update'),
      session: live.session,
      logStore: failingStore,
      pluginHost: live.pluginHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {name: runtimePluginConfigUpdateToolName, input: live.updateInput},
          ],
        },
        {toolCalls: [{name: 'visible_reply', input: {text: 'tone updated'}}]},
      ]),
    });

    expect(crashResult.status).toBe('completed');
    if (crashResult.status !== 'completed') {
      throw new Error('Expected the marker-losing turn to complete.');
    }
    // The commit applied AND live-applied the change; only the marker died.
    expect(crashResult.postCommitFailures?.join(' ')).toContain(
      'append failed',
    );
    expect(live.authoredTone()).toBe('warm');
    expect(live.reloaderCalls()).toBe(1);

    // A restarted host is built from the already-updated config; replaying
    // the pending effect must not rebuild and retire its fresh instance.
    const restartedHost = live.createPluginHost();
    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('and now?', 'evt_already_applied_followup'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: restartedHost,
      roleModelAdapter: live.contextCaptureAdapter,
    });

    expect(followupResult.status).toBe('completed');
    expect(live.capturedContexts[0]).toContain('tone:warm');
    expect(live.reloaderCalls()).toBe(1);

    const recoveryEvents = live.logStore
      .rawEvents()
      .filter(
        event =>
          event.kind === 'after_turn_committed' &&
          event.eventId === 'evt_already_applied_update',
      );

    expect(recoveryEvents).toHaveLength(1);
    expect(
      (recoveryEvents[0]?.runtimePluginEvidence ?? []).some(evidence =>
        evidence.summary.startsWith('Live-applied'),
      ),
    ).toBe(false);
  });

  it('skips the recovery rebuild when the tail effect conflicted at commit', async () => {
    const live = await createLiveReloadLoopFixture('accepted-final');
    const failingStore = createAfterTurnCommittedAppendFailingLogStore(
      live.logStore,
    );
    // Two same-plugin live updates prepared against the SAME fingerprint:
    // the first applies at commit, the second conflict-closes, so the file
    // (and the live-applied instance) end at the first effect's result.
    const staleSecondInput = {...live.updateInput, value: 'sharp'};
    const crashResult = await runLocalUserMessageEvent({
      event: createTestEvent('update tone twice', 'evt_accepted_final'),
      session: live.session,
      logStore: failingStore,
      pluginHost: live.pluginHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {name: runtimePluginConfigUpdateToolName, input: live.updateInput},
          ],
        },
        {
          toolCalls: [
            {name: runtimePluginConfigUpdateToolName, input: staleSecondInput},
          ],
        },
        {toolCalls: [{name: 'visible_reply', input: {text: 'updated'}}]},
      ]),
    });

    expect(crashResult.status).toBe('completed');
    if (crashResult.status !== 'completed') {
      throw new Error('Expected the marker-losing turn to complete.');
    }
    expect(live.authoredTone()).toBe('warm');
    expect(live.reloaderCalls()).toBe(1);

    // A restarted host is built from the file at the last ACCEPTED effect's
    // fingerprint; recovery must recognize that currency even though the
    // terminal event's raw tail is the conflicted effect.
    const restartedHost = live.createPluginHost();
    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('and now?', 'evt_accepted_final_followup'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: restartedHost,
      roleModelAdapter: live.contextCaptureAdapter,
    });

    expect(followupResult.status).toBe('completed');
    expect(live.capturedContexts[0]).toContain('tone:warm');
    expect(live.reloaderCalls()).toBe(1);
  });

  it('retries at recovery a reload whose outcome was never made durable', async () => {
    const live = await createLiveReloadLoopFixture('undurable-reload', {
      reloader: {
        reload: () => Promise.reject(new Error('factory exploded')),
      },
    });
    const failingStore = createAfterTurnCommittedAppendFailingLogStore(
      live.logStore,
    );
    const crashResult = await runLocalUserMessageEvent({
      event: createTestEvent('update tone', 'evt_undurable_reload'),
      session: live.session,
      logStore: failingStore,
      pluginHost: live.pluginHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {name: runtimePluginConfigUpdateToolName, input: live.updateInput},
          ],
        },
        {toolCalls: [{name: 'visible_reply', input: {text: 'tone updated'}}]},
      ]),
    });

    expect(crashResult.status).toBe('completed');
    if (crashResult.status !== 'completed') {
      throw new Error('Expected the marker-losing turn to complete.');
    }
    // The reload failed AND the marker append died, so no reload decision
    // is durable and the same process keeps serving the stale instance.
    expect(crashResult.postCommitFailures?.join(' ')).toContain(
      'factory exploded',
    );
    expect(live.authoredTone()).toBe('warm');

    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('and now?', 'evt_undurable_reload_followup'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: live.pluginHost,
      roleModelAdapter: live.contextCaptureAdapter,
    });

    expect(followupResult.status).toBe('completed');
    expect(live.capturedContexts[0]).toContain('tone:cool');

    // Recovery must NOT skip: the running host is not current for the
    // committed config, so the reload is re-attempted and its outcome is
    // finally recorded durably.
    const recoveryEvent = live.logStore
      .rawEvents()
      .find(
        event =>
          event.kind === 'after_turn_committed' &&
          event.eventId === 'evt_undurable_reload',
      );

    expect(recoveryEvent?.status).toBe('completed_with_failures');
    expect(
      (recoveryEvent?.runtimePluginEvidence ?? []).some(
        evidence =>
          evidence.status === 'failed' &&
          evidence.summary.startsWith('Live config reload'),
      ),
    ).toBe(true);
  });

  it('includes prior-reconciled effects when recovery groups a reload', async () => {
    const live = await createLiveReloadLoopFixture('prior-accepted', {
      withSessionScopedNote: true,
    });
    // Turn 1: the session-scoped no-op reconciles fine, the live field hits
    // a transient (non-conflict) error, so the marker records ONE effect as
    // reconciled and leaves the live one pending.
    const baseHost = live.pluginHost;
    const flakyHost = Object.freeze({
      ...baseHost,
      reconcileConfigEffect(effect) {
        if (effect.fieldName === 'tone') {
          throw new Error('io hiccup during reconcile');
        }

        if (baseHost.reconcileConfigEffect === undefined) {
          throw new Error('Expected config effect reconciliation support.');
        }

        return baseHost.reconcileConfigEffect(effect);
      },
    } satisfies RuntimePluginHost);
    const noteInput = {
      pluginId: live.updateInput.pluginId,
      fieldName: 'note',
      operation: 'set',
      value: 'quiet',
      expectedFingerprint: live.updateInput.expectedFingerprint,
    };
    const crashResult = await runLocalUserMessageEvent({
      event: createTestEvent('update note and tone', 'evt_prior_accepted'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: flakyHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {name: runtimePluginConfigUpdateToolName, input: noteInput},
          ],
        },
        {
          toolCalls: [
            {name: runtimePluginConfigUpdateToolName, input: live.updateInput},
          ],
        },
        {toolCalls: [{name: 'visible_reply', input: {text: 'both approved'}}]},
      ]),
    });

    expect(crashResult.status).toBe('completed');
    if (crashResult.status !== 'completed') {
      throw new Error('Expected the flaky update turn to complete.');
    }
    expect(crashResult.postCommitFailures?.join(' ')).toContain('io hiccup');
    expect(live.authoredTone()).toBe('cool');

    // Turn 2: recovery replays the live field, but its reload group must
    // still contain the previously reconciled session-scoped effect — the
    // commit path would have deferred this mixed group.
    const recoveryHost = live.createPluginHost();
    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('and now?', 'evt_prior_accepted_followup'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: recoveryHost,
      roleModelAdapter: live.contextCaptureAdapter,
    });

    expect(followupResult.status).toBe('completed');
    expect(live.authoredTone()).toBe('warm');
    expect(live.capturedContexts[0]).toContain('tone:cool');
    expect(live.reloaderCalls()).toBe(0);

    const deferredEvidence = live.logStore
      .rawEvents()
      .filter(event => event.kind === 'after_turn_committed')
      .flatMap(event => event.runtimePluginEvidence ?? [])
      .find(evidence => evidence.status === 'degraded');

    expect(deferredEvidence?.summary).toContain(
      'mix live and reload-required fields',
    );
  });

  it('keeps recovery progress durable when one effect fails to reconcile', async () => {
    const live = await createLiveReloadLoopFixture('partial-recovery', {
      withSessionScopedNote: true,
    });
    // Turn 1 crashes reconciliation entirely, leaving both effects pending
    // with the config file untouched.
    const crashingHost = Object.freeze({
      ...live.pluginHost,
      reconcileConfigEffect() {
        throw new Error('reconcile crashed before applying the group');
      },
    } satisfies RuntimePluginHost);
    const noteInput = {
      pluginId: live.updateInput.pluginId,
      fieldName: 'note',
      operation: 'set',
      value: 'quiet',
      expectedFingerprint: live.updateInput.expectedFingerprint,
    };
    const crashResult = await runLocalUserMessageEvent({
      event: createTestEvent('update note and tone', 'evt_partial_recovery'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: crashingHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {name: runtimePluginConfigUpdateToolName, input: noteInput},
          ],
        },
        {
          toolCalls: [
            {name: runtimePluginConfigUpdateToolName, input: live.updateInput},
          ],
        },
        {toolCalls: [{name: 'visible_reply', input: {text: 'both approved'}}]},
      ]),
    });

    expect(crashResult.status).toBe('completed');

    // Turn 2's recovery replays the note effect fine but hits a transient
    // error on the tone effect: the pass must complete the turn, keep the
    // note's evidence durable, and leave only the tone effect pending.
    const baseRecoveryHost = live.createPluginHost();
    const flakyRecoveryHost = Object.freeze({
      ...baseRecoveryHost,
      reconcileConfigEffect(effect) {
        if (effect.fieldName === 'tone') {
          throw new Error('disk hiccup during recovery');
        }

        if (baseRecoveryHost.reconcileConfigEffect === undefined) {
          throw new Error('Expected config effect reconciliation support.');
        }

        return baseRecoveryHost.reconcileConfigEffect(effect);
      },
    } satisfies RuntimePluginHost);
    const secondResult = await runLocalUserMessageEvent({
      event: createTestEvent('and now?', 'evt_partial_recovery_second'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: flakyRecoveryHost,
      roleModelAdapter: live.contextCaptureAdapter,
    });

    expect(secondResult.status).toBe('completed');
    expect(live.authoredTone()).toBe('cool');

    const partialEvent = live.logStore
      .rawEvents()
      .find(
        event =>
          event.kind === 'after_turn_committed' &&
          (event.runtimePluginEvidence ?? []).some(
            evidence => evidence.status === 'failed',
          ),
      );

    expect(partialEvent?.status).toBe('completed_with_failures');
    expect(
      (partialEvent?.runtimePluginEvidence ?? []).some(
        evidence =>
          evidence.status === 'failed' &&
          evidence.summary.includes('stays pending'),
      ),
    ).toBe(true);
    expect(
      (partialEvent?.runtimePluginEvidence ?? []).filter(
        evidence => evidence.status === 'accepted',
      ),
    ).toHaveLength(1);

    // Turn 3 retries the pending tone effect on a healthy host; the group
    // still includes the previously reconciled note, so it defers as mixed.
    const thirdResult = await runLocalUserMessageEvent({
      event: createTestEvent('once more', 'evt_partial_recovery_third'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: live.createPluginHost(),
      roleModelAdapter: live.contextCaptureAdapter,
    });

    expect(thirdResult.status).toBe('completed');
    expect(live.authoredTone()).toBe('warm');
    expect(live.capturedContexts.at(-1)).toContain('tone:cool');
    expect(
      live.logStore
        .rawEvents()
        .flatMap(event => event.runtimePluginEvidence ?? [])
        .some(
          evidence =>
            evidence.status === 'degraded' &&
            evidence.summary.includes('mix live and reload-required fields'),
        ),
    ).toBe(true);
  });

  it('defers a mixed pending config group at recovery exactly like the commit path', async () => {
    const live = await createLiveReloadLoopFixture('mixed-recovery', {
      withSessionScopedNote: true,
    });
    // Crash the turn between the terminal event append and reconciliation so
    // both effects stay pending; recovery must then replay them as ONE group.
    const crashingHost = Object.freeze({
      ...live.pluginHost,
      reconcileConfigEffect() {
        throw new Error('reconcile crashed before applying the group');
      },
    } satisfies RuntimePluginHost);
    const noteInput = {
      pluginId: live.updateInput.pluginId,
      fieldName: 'note',
      operation: 'set',
      value: 'quiet',
      expectedFingerprint: live.updateInput.expectedFingerprint,
    };
    const crashResult = await runLocalUserMessageEvent({
      event: createTestEvent('update note and tone', 'evt_mixed_recovery'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: crashingHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {name: runtimePluginConfigUpdateToolName, input: noteInput},
          ],
        },
        {
          toolCalls: [
            {name: runtimePluginConfigUpdateToolName, input: live.updateInput},
          ],
        },
        {toolCalls: [{name: 'visible_reply', input: {text: 'both approved'}}]},
      ]),
    });

    expect(crashResult.status).toBe('completed');
    if (crashResult.status !== 'completed') {
      throw new Error('Expected the crashing update turn to complete.');
    }
    expect(crashResult.postCommitFailures?.join(' ')).toContain(
      'reconcile crashed',
    );
    expect(live.authoredTone()).toBe('cool');

    const terminal = live.logStore
      .rawEvents()
      .find(
        event =>
          event.kind === 'runtime_turn_completed' &&
          event.eventId === 'evt_mixed_recovery',
      );

    expect(terminal?.runtimeConfigEffects).toHaveLength(2);

    const recoveryHost = live.createPluginHost();
    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('and now?', 'evt_mixed_recovery_followup'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: recoveryHost,
      roleModelAdapter: live.contextCaptureAdapter,
    });

    expect(followupResult.status).toBe('completed');
    // Recovery replayed the authored changes but must NOT live-apply them:
    // the commit path would have deferred this mixed group, so the follow-up
    // turn still serves the instance built from the pre-update config.
    expect(live.authoredTone()).toBe('warm');
    expect(live.capturedContexts[0]).toContain('tone:cool');

    const recoveryEvents = live.logStore
      .rawEvents()
      .filter(
        event =>
          event.kind === 'after_turn_committed' &&
          (event.runtimePluginEvidence ?? []).some(evidence =>
            evidence.sourceReferences?.some(
              reference => reference.kind === 'runtime',
            ),
          ),
      );

    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents[0]?.status).toBe('completed');

    const recoveryEvidence = recoveryEvents[0]?.runtimePluginEvidence ?? [];

    expect(
      recoveryEvidence.filter(evidence => evidence.status === 'accepted'),
    ).toHaveLength(2);
    expect(
      recoveryEvidence.find(evidence => evidence.status === 'degraded'),
    ).toMatchObject({
      summary: expect.stringContaining(
        'mix live and reload-required fields',
      ) as unknown,
      configFingerprint:
        terminal?.runtimeConfigEffects?.at(-1)?.resultFingerprint,
    });
  });

  it('closes a conflicted config effect with a rejected record and continues the session', async () => {
    const fixture = await createConfigEffectTestFixture('fingerprint-drift');
    const session = createConversationSession({
      id: fixture.sessionId,
      character: testCharacterProfile,
    });
    const logStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot: fixture.storeRoot,
      sessionId: fixture.sessionId,
    });
    const baseHost = createConfigEffectTestHost({fixture, session});
    let driftApplied = false;
    const driftHost = Object.freeze({
      ...baseHost,
      reconcileConfigEffect(effect) {
        if (!driftApplied) {
          applyRuntimeConfigControlOperation({
            target: resolveRuntimeConfigScopeTarget({
              runtimeLocation: runtimeLocationForTest({
                configPath: fixture.configPath,
                storeRoot: fixture.homeRoot,
              }),
              scope: 'global',
            }),
            expectedFingerprint: fixture.before.fingerprint,
            request: {
              kind: 'plugin_config',
              manifest: fixture.targetPlugin.manifest,
              actor: 'operator',
              fieldOperation: {
                kind: 'set',
                fieldName: 'tone',
                value: 'competing-value',
              },
            },
          });
          driftApplied = true;
        }

        if (baseHost.reconcileConfigEffect === undefined) {
          throw new Error('Expected config effect reconciliation support.');
        }

        return baseHost.reconcileConfigEffect(effect);
      },
    } satisfies RuntimePluginHost);
    const firstResult = await runLocalUserMessageEvent({
      event: createTestEvent('update config', 'evt_config_effect_drift'),
      session,
      logStore,
      pluginHost: driftHost,
      roleModelAdapter: createConfigEffectTestAdapter({
        fixture,
        reply: 'Config intent committed.',
      }),
    });
    const afterDrift = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        storeRoot: fixture.homeRoot,
      }),
      manifest: fixture.targetPlugin.manifest,
      pluginManifests: [fixture.targetPlugin.manifest],
    });
    const effectId = logStore
      .rawEvents()
      .find(candidate => candidate.kind === 'runtime_turn_completed')
      ?.runtimeConfigEffects?.[0]?.effectId;
    const rejectedClosureRecords = () =>
      logStore
        .rawEvents()
        .filter(
          event =>
            event.kind === 'after_turn_committed' &&
            event.runtimePluginEvidence?.some(
              evidence =>
                evidence.status === 'rejected' &&
                evidence.sourceReferences?.some(
                  reference =>
                    reference.kind === 'runtime' && reference.id === effectId,
                ),
            ),
        );

    expect(firstResult.status).toBe('completed');
    expect(
      firstResult.status === 'completed' ? firstResult.postCommitFailures : [],
    ).toEqual([
      expect.stringContaining(
        'cannot be reconciled because authored config changed',
      ),
    ]);
    expect(
      afterDrift.fields.find(field => field.name === 'tone')?.authored.value,
    ).toBe('competing-value');
    expect(effectId).toBeDefined();
    expect(rejectedClosureRecords()).toHaveLength(1);

    const restoredSession = createConversationSession({
      character: testCharacterProfile,
      id: fixture.sessionId,
      visibleTranscript: logStore.conversationMessages(),
    });
    const recoveryHost = createConfigEffectTestHost({
      fixture,
      session: restoredSession,
    });
    const followUpResult = await runLocalUserMessageEvent({
      event: createTestEvent('continue', 'evt_config_drift_followup'),
      session: restoredSession,
      logStore,
      pluginHost: recoveryHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {text: 'Session continues after conflict.'},
            },
          ],
        },
      ]),
    });
    const thirdResult = await runLocalUserMessageEvent({
      event: createTestEvent('and again', 'evt_config_drift_third'),
      session: restoredSession,
      logStore,
      pluginHost: recoveryHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {text: 'Still healthy.'},
            },
          ],
        },
      ]),
    });

    expect(followUpResult.status).toBe('completed');
    expect(thirdResult.status).toBe('completed');
    expect(
      afterDrift.fields.find(field => field.name === 'tone')?.authored.value,
    ).toBe('competing-value');
    expect(rejectedClosureRecords()).toHaveLength(1);
  });

  it('rejects a prepared config effect when durable session evidence is unavailable', async () => {
    const fixture = await createConfigEffectTestFixture('no-durable-store');
    const session = createConversationSession({
      id: fixture.sessionId,
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    const pluginHost = createConfigEffectTestHost({fixture, session});

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('update config', 'evt_config_no_durable_store'),
        session,
        logStore,
        pluginHost,
        roleModelAdapter: createConfigEffectTestAdapter({
          fixture,
          reply: 'Must not commit.',
        }),
      }),
    ).rejects.toThrow(
      'Approved runtime config effects require durable local session evidence.',
    );
    const after = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: fixture.configPath,
        storeRoot: fixture.homeRoot,
      }),
      manifest: fixture.targetPlugin.manifest,
      pluginManifests: [fixture.targetPlugin.manifest],
    });

    expect(after.fingerprint).toBe(fixture.before.fingerprint);
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
    });
    expect(
      logStore
        .rawEvents()
        .some(event => event.kind === 'runtime_turn_completed'),
    ).toBe(false);
  });

  it('recovers a durable pending config effect once and records its effect marker', async () => {
    const sessionId = 'session-config-update-recovery';
    const homeRoot = createTestTempRoot('project02-config-update-recovery-');
    const storeRoot = characterDataDirPath(homeRoot, testCharacterProfile.id);

    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      sessionId,
      createdAt: '2026-07-16T00:00:00.000Z',
    });

    const basePlugin = requiredDottedConfigPlugin(
      'config-update-recovery-target.fixture',
      'tone',
    );
    const targetPlugin = createRuntimePlugin({
      manifest: {
        ...basePlugin.manifest,
        config: {
          scope: 'global_with_character_overrides',
          fields: basePlugin.manifest.config.fields.map(field => ({
            ...field,
            required: false,
            agentMutable: true,
          })),
        },
      },
    });
    const configPath = writeRuntimeConfig(
      createProject02HomeLayout({homeRoot}).configPath,
      {
        plugins: {
          [targetPlugin.manifest.id]: {
            config: {tone: 'cool'},
          },
        },
      },
    );
    const before = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: homeRoot,
      }),
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
    });
    const session = createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
    });
    const baseHost = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      storeRoot,
      sessionId,
      sessionIdentity: session,
      pluginConfigControl: runtimePluginConfigControlStateForTest({
        runtimeLocation: runtimeLocationForTest({
          configPath: configPath,
          storeRoot: homeRoot,
        }),

        control: testRuntimePluginConfigControlCapability,
        pluginManifests: [targetPlugin.manifest],
      }),
      toolConfirmationHandler: () => ({status: 'approved'}),
    });
    const recoveryPendingHost = Object.freeze({
      ...baseHost,
      reconcileConfigEffect() {
        throw new Error('simulated config reconciliation interruption');
      },
    } satisfies RuntimePluginHost);
    const firstResult = await runLocalUserMessageEvent({
      event: createTestEvent('update config', 'evt_config_update_recovery'),
      session,
      logStore,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: runtimePluginConfigUpdateToolName,
              input: {
                pluginId: targetPlugin.manifest.id,
                fieldName: 'tone',
                operation: 'set',
                value: 'warm',
                expectedFingerprint: before.fingerprint,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {text: 'Config update is committed.'},
            },
          ],
        },
      ]),
      pluginHost: recoveryPendingHost,
    });
    const terminal = logStore
      .rawEvents()
      .find(event => event.kind === 'runtime_turn_completed');
    const effect = terminal?.runtimeConfigEffects?.[0];
    const toolFinished = logStore
      .rawEvents()
      .find(event => event.kind === 'tool_call_finished');
    const afterInterruptedCommit = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: homeRoot,
      }),
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
    });

    expect(firstResult).toMatchObject({
      status: 'completed',
      postCommitFailures: ['simulated config reconciliation interruption'],
    });
    expect(effect).toMatchObject({
      targetPluginId: targetPlugin.manifest.id,
      fieldName: 'tone',
      expectedFingerprint: before.fingerprint,
      operation: {kind: 'set', value: 'warm'},
    });
    expect(terminal?.toolCallIds).toContain(effect?.effectId);
    expect(toolFinished?.toolResult).toMatchObject({
      status: 'accepted',
      output: {status: 'approved_pending_commit'},
    });
    expect(toolFinished).not.toHaveProperty('runtimeConfigEffects');
    expect(toolFinished?.toolResult).not.toHaveProperty('preparedConfigEffect');
    expect(
      JSON.stringify(
        terminal?.roleModelIOSnapshot?.inputEnvelope.toolObservations,
      ),
    ).not.toContain('preparedConfigEffect');
    expect(afterInterruptedCommit.fingerprint).toBe(before.fingerprint);

    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
    });
    const restoredSession = createConversationSession({
      character: testCharacterProfile,
      id: sessionId,
      visibleTranscript: reopenedLogStore.conversationMessages(),
    });
    const recoveryHost = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      storeRoot,
      sessionId,
      sessionIdentity: restoredSession,
      pluginConfigControl: runtimePluginConfigControlStateForTest({
        runtimeLocation: runtimeLocationForTest({
          configPath: configPath,
          storeRoot: homeRoot,
        }),

        control: testRuntimePluginConfigControlCapability,
        pluginManifests: [targetPlugin.manifest],
      }),
      toolConfirmationHandler: () => ({status: 'approved'}),
    });
    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('continue', 'evt_config_update_recovery_followup'),
      session: restoredSession,
      logStore: reopenedLogStore,
      pluginHost: recoveryHost,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {text: 'Recovered.'},
            },
          ],
        },
      ]),
    });
    const afterRecovery = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: homeRoot,
      }),
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
    });
    const effectMarkers = reopenedLogStore
      .rawEvents()
      .flatMap(event =>
        event.kind !== 'after_turn_committed'
          ? []
          : (event.runtimePluginEvidence ?? []).filter(evidence =>
              evidence.sourceReferences?.some(
                reference =>
                  reference.kind === 'runtime' &&
                  reference.id === effect?.effectId,
              ),
            ),
      );

    expect(followupResult.status).toBe('completed');
    expect(
      afterRecovery.fields.find(field => field.name === 'tone')?.authored,
    ).toEqual({configured: true, value: 'warm'});
    expect(effectMarkers).toHaveLength(1);
    expect(effectMarkers[0]).toMatchObject({
      pluginId: runtimePluginId,
      evidenceKind: 'after_turn_committed',
      status: 'accepted',
      configFingerprint: effect?.resultFingerprint,
    });
  });

  it('leaves authored config unchanged when config-update finish logging fails', async () => {
    const sessionId = 'session-config-update-finish-log-failure';
    const homeRoot = createTestTempRoot('project02-config-update-loop-');
    const storeRoot = characterDataDirPath(homeRoot, testCharacterProfile.id);

    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      sessionId,
      createdAt: '2026-07-16T00:00:00.000Z',
    });

    const basePlugin = requiredDottedConfigPlugin(
      'config-update-target.fixture',
      'tone',
    );
    const targetPlugin = createRuntimePlugin({
      manifest: {
        ...basePlugin.manifest,
        config: {
          scope: 'global_with_character_overrides',
          fields: basePlugin.manifest.config.fields.map(field => ({
            ...field,
            required: false,
            agentMutable: true,
          })),
        },
      },
    });
    const configPath = writeRuntimeConfig(join(homeRoot, 'config.json'), {
      plugins: {
        [targetPlugin.manifest.id]: {
          config: {tone: 'cool'},
        },
      },
    });
    const before = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: homeRoot,
      }),
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
    });
    const session = createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const logStore = createToolCallFinishedAppendFailingLogStore(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        boundCharacter: testCharacterProfile,
        characterId: testCharacterProfile.id,
      }),
    );
    const pluginHost = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      storeRoot,
      sessionId,
      sessionIdentity: session,
      pluginConfigControl: runtimePluginConfigControlStateForTest({
        runtimeLocation: runtimeLocationForTest({
          configPath: configPath,
          storeRoot: homeRoot,
        }),

        control: testRuntimePluginConfigControlCapability,
        pluginManifests: [targetPlugin.manifest],
      }),
      toolConfirmationHandler: () => ({status: 'approved'}),
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: runtimePluginConfigUpdateToolName,
            input: {
              pluginId: targetPlugin.manifest.id,
              fieldName: 'tone',
              operation: 'set',
              value: 'warm',
              expectedFingerprint: before.fingerprint,
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {text: 'Config updated.'},
          },
        ],
      },
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent(
          'update config',
          'evt_config_update_finish_fails',
        ),
        session,
        logStore,
        roleModelAdapter: adapter,
        pluginHost,
      }),
    ).rejects.toThrow('tool_call_finished raw event append failed');

    const after = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: homeRoot,
      }),
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
    });

    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.fields.find(field => field.name === 'tone')?.authored).toEqual(
      {
        configured: true,
        value: 'cool',
      },
    );
    expect(
      logStore.rawEvents().some(event => event.kind === 'tool_call_finished'),
    ).toBe(false);
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_rejected',
      status: 'rejected',
    });
  });

  it('leaves authored config unchanged when the terminal append fails with a prepared effect', async () => {
    const sessionId = 'session-config-update-terminal-append-failure';
    const homeRoot = createTestTempRoot('project02-config-update-loop-');
    const storeRoot = characterDataDirPath(homeRoot, testCharacterProfile.id);

    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      sessionId,
      createdAt: '2026-07-16T00:00:00.000Z',
    });

    const basePlugin = requiredDottedConfigPlugin(
      'config-update-terminal.fixture',
      'tone',
    );
    const targetPlugin = createRuntimePlugin({
      manifest: {
        ...basePlugin.manifest,
        config: {
          scope: 'global_with_character_overrides',
          fields: basePlugin.manifest.config.fields.map(field => ({
            ...field,
            required: false,
            agentMutable: true,
          })),
        },
      },
    });
    const configPath = writeRuntimeConfig(join(homeRoot, 'config.json'), {
      plugins: {
        [targetPlugin.manifest.id]: {
          config: {tone: 'cool'},
        },
      },
    });
    const before = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: homeRoot,
      }),
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
    });
    const session = createConversationSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const logStore = createTurnCompletedAppendFailingLogStore(
      createFileRuntimeLogStore({
        storeRoot,
        sessionId,
        boundCharacter: testCharacterProfile,
        characterId: testCharacterProfile.id,
      }),
    );
    const pluginHost = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      storeRoot,
      sessionId,
      sessionIdentity: session,
      pluginConfigControl: runtimePluginConfigControlStateForTest({
        runtimeLocation: runtimeLocationForTest({
          configPath: configPath,
          storeRoot: homeRoot,
        }),

        control: testRuntimePluginConfigControlCapability,
        pluginManifests: [targetPlugin.manifest],
      }),
      toolConfirmationHandler: () => ({status: 'approved'}),
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: runtimePluginConfigUpdateToolName,
            input: {
              pluginId: targetPlugin.manifest.id,
              fieldName: 'tone',
              operation: 'set',
              value: 'warm',
              expectedFingerprint: before.fingerprint,
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {text: 'Config updated.'},
          },
        ],
      },
    ]);

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent(
          'update config',
          'evt_config_update_terminal_fails',
        ),
        session,
        logStore,
        roleModelAdapter: adapter,
        pluginHost,
      }),
    ).rejects.toThrow('runtime_turn_completed raw event append failed');

    const after = inspectRuntimePluginConfig({
      targetScope: 'global',
      runtimeLocation: runtimeLocationForTest({
        configPath: configPath,
        storeRoot: homeRoot,
      }),
      manifest: targetPlugin.manifest,
      pluginManifests: [targetPlugin.manifest],
    });

    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.fields.find(field => field.name === 'tone')?.authored).toEqual(
      {
        configured: true,
        value: 'cool',
      },
    );
    expect(
      logStore
        .rawEvents()
        .some(event => event.kind === 'runtime_turn_completed'),
    ).toBe(false);
    expect(
      logStore.rawEvents().some(event => event.kind === 'after_turn_committed'),
    ).toBe(false);
  });
});
