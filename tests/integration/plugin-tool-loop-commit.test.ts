import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';
import {createSession} from '../../src/core/index.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {
  testRuntimePluginConfigControlCapability,
  testRuntimePluginFileStoreProvider,
} from '../support/plugin-host-fixtures.ts';
import {type RuntimePluginHost} from '../../src/plugins/host/index.ts';
import {createRuntimePlugin} from '../../src/plugins/api/constructors.ts';
import {runtimePluginConfigUpdateToolName} from '../../src/plugins/api/contract.ts';
import {
  createPluginContextEvidence,
  createRuntimePluginContextItem,
  createRuntimePluginManifest,
  runtimePluginId,
} from '../../src/plugins/api/index.ts';
import {inspectRuntimePluginConfig} from '../../src/runtime/config/index.ts';
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
import {
  type RoleModelAdapter,
  type RoleModelChatMessage,
  type ConversationToolRound,
} from '../../src/role-model/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  createRawEventAppendFailingLogStore,
  createAfterTurnCommittedProbeHost,
  runLocalUserMessageEventWithDefaultTestHost as runLocalUserMessageEvent,
} from '../support/plugin-tool-loop-fixtures.ts';
import {
  createSequencedAdapter,
  createTestEvent,
} from '../support/role-model-loop-fixtures.ts';

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
  const inspectTarget = () =>
    inspectRuntimePluginConfig({
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
    before: inspectTarget(),
    inspectTarget,
  };
}

function createConfigEffectTestHost(options: {
  readonly fixture: Awaited<ReturnType<typeof createConfigEffectTestFixture>>;
  readonly session: ReturnType<typeof createSession>;
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

async function createLiveReloadLoopFixture(label: string) {
  const fixture = await createConfigEffectTestFixture(`reload-${label}`);
  const manifest = createRuntimePluginManifest({
    ...fixture.targetPlugin.manifest,
    declaredPlugins: ['before_role_model_call', 'after_turn_committed'],
    requestedAccess: {model_input: 'write'},
    config: {
      scope: 'global_with_character_overrides',
      fields: fixture.targetPlugin.manifest.config.fields.map(field =>
        field.name === 'tone' ? {...field, reloadRequired: false} : field,
      ),
    },
  });
  const before = fixture.before;
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
  const session = createSession({
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
      plugins: [stylePlugin(authoredTone())],
      enabledPluginIds: [runtimePluginId, manifest.id],
      pluginConfigControl: runtimePluginConfigControlStateForTest({
        runtimeLocation: runtimeLocationForTest({
          configPath: fixture.configPath,
          storeRoot: fixture.homeRoot,
        }),

        control: testRuntimePluginConfigControlCapability,
        pluginManifests: [manifest],
      }),
      toolConfirmationHandler: () => ({status: 'approved'}),
      pluginReloader: Object.freeze({
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
  it("keeps the model's text next to its tool calls in the stored decision", async () => {
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [{name: 'visible_reply', input: {text: 'hi'}}],
        text: 'private note',
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('say hi', 'evt_reply_with_note'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');
    // The note is the model's own; it is stored with the decision and never
    // becomes a message.
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['say hi', 'hi']);
    expect(
      logStore.rawEvents().find(event => event.kind === 'role_model_round'),
    ).toMatchObject({
      round: 1,
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'accepted',
          decision: {
            toolCalls: [{name: 'visible_reply', input: {text: 'hi'}}],
            text: 'private note',
          },
        },
      },
    });
    expect(logStore.rawEvents().at(-1)).toMatchObject({
      kind: 'runtime_turn_completed',
      round: 1,
      commitValidation: {
        result: {status: 'accepted', acceptedVisibleReplyText: 'hi'},
      },
    });
  });

  it('commits every visible reply a round asks for, in order', async () => {
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore({
      boundCharacter: testCharacterProfile,
    });
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {name: 'visible_reply', input: {text: 'first thought'}},
          {name: 'visible_reply', input: {text: 'and a second'}},
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('say two things', 'evt_two_replies'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['say two things', 'first thought', 'and a second']);
  });

  it('commits multi-line final visible replies', async () => {
    const session = createSession({
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

  it('runs afterTurnCommitted after visible messages and terminal evidence commit', async () => {
    const session = createSession({
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
    const session = createSession({
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
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRawEventAppendFailingLogStore({
      matches: record => record.kind === 'after_turn_committed',
      message: 'after-turn raw event append failed',
    });
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
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRawEventAppendFailingLogStore({
      matches: record => record.kind === 'runtime_turn_completed',
      message: 'terminal raw event append failed',
    });
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
    const logStore = createRawEventAppendFailingLogStore({
      logStore: fileLogStore,
      matches: record => record.kind === 'runtime_turn_completed',
      message: 'terminal raw event append failed after persisting',
      persist: true,
    });
    const pluginHost = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      storeRoot,
      sessionId,
      plugins: [createCharacterStatePlugin()],
      enabledPluginIds: [runtimePluginId, characterStatePluginId],
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId,
      scope: 'character',
    });

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'hello',
        'evt_character_state_terminal_append_then_throw',
      ),
      session: createSession({
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
      postCommitFailures: ['terminal raw event append failed after persisting'],
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
    const logStore = createRawEventAppendFailingLogStore({
      logStore: fileLogStore,
      matches: record => record.kind === 'runtime_turn_completed',
      message: 'terminal raw event append failed',
    });
    const pluginHost = createRuntimePluginHost({plugins: []});
    const session = createSession({
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

    const restoredSession = createSession({
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

  it('writes an approved config update when the tool executes and tells the model it applied', async () => {
    const fixture = await createConfigEffectTestFixture('applied-at-execution');
    const messagesByRound: RoleModelChatMessage[][] = [];
    const toneSeenByRound: string[] = [];
    const session = createSession({
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
    const adapter = createConfigEffectTestAdapter({
      fixture,
      reply: 'Config updated.',
      messagesByRound,
    });
    const result = await runLocalUserMessageEvent({
      event: createTestEvent('update config', 'evt_config_applied'),
      session,
      logStore,
      pluginHost,
      roleModelAdapter: Object.freeze({
        invoke(inputEnvelope, invocation) {
          // The write is visible to the very next round of the same turn.
          const tone = fixture
            .inspectTarget()
            .fields.find(field => field.name === 'tone')?.authored.value;

          toneSeenByRound.push(typeof tone === 'string' ? tone : 'unset');
          return adapter.invoke(inputEnvelope, invocation);
        },
      } satisfies RoleModelAdapter),
    });
    const after = fixture.inspectTarget();
    const rawEvents = logStore.rawEvents();
    const finished = rawEvents.find(
      event =>
        event.kind === 'tool_call_finished' &&
        event.toolName === runtimePluginConfigUpdateToolName,
    );
    const nativeToolResult = messagesByRound[1]?.find(
      message => message.role === 'tool',
    );

    expect(result.status).toBe('completed');
    expect(toneSeenByRound).toEqual(['cool', 'warm']);
    expect(after.fields.find(field => field.name === 'tone')?.authored).toEqual(
      {configured: true, value: 'warm'},
    );
    expect(finished?.toolResult).toMatchObject({
      status: 'accepted',
      output: {
        status: 'applied',
        appliesTo: 'next_launch',
        reloadRequired: true,
        pluginId: fixture.targetPlugin.manifest.id,
        fieldName: 'tone',
        operation: 'set',
        fingerprint: after.fingerprint,
      },
    });
    expect(finished?.toolResult?.evidence).toContainEqual(
      expect.objectContaining({
        evidenceKind: 'policy',
        policyOutcome: 'user_approved',
        configFingerprint: after.fingerprint,
      }),
    );
    expect(finished?.toolResult?.evidence).toContainEqual(
      expect.objectContaining({
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: expect.stringContaining('Applied approved plugin') as string,
      }),
    );
    expect(rawEvents.some(event => event.kind === 'after_turn_committed')).toBe(
      false,
    );
    expect(nativeToolResult?.content).toContain('"status":"applied"');
    expect(nativeToolResult?.content).not.toContain('preparedConfigEffect');
  });

  it('lets the model correct a rejected config update in the same turn', async () => {
    const fixture = await createConfigEffectTestFixture('rejected-retry');
    const session = createSession({
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
    const toolRoundsByRound: (readonly ConversationToolRound[])[] = [];
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
        toolRoundsByRound.push(inputEnvelope.toolRounds);

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
    const rejection = toolRoundsByRound[1]
      ?.flatMap(round => round.toolCalls)
      .find(call => call.toolName === runtimePluginConfigUpdateToolName);

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

  it('live-applies an approved reloadRequired:false update before the turn ends', async () => {
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
    expect(live.reloaderCalls()).toBe(1);

    const finished = live.logStore
      .rawEvents()
      .find(
        event =>
          event.kind === 'tool_call_finished' &&
          event.toolName === runtimePluginConfigUpdateToolName,
      );

    expect(finished?.toolResult).toMatchObject({
      status: 'accepted',
      output: {status: 'applied', appliesTo: 'now', reloadRequired: false},
    });
    expect(finished?.toolResult?.evidence).toContainEqual(
      expect.objectContaining({
        status: 'accepted',
        summary: expect.stringContaining('Live-applied') as string,
      }),
    );
    // The swap happened inside the tool call, so this turn's own after-commit
    // hook already ran on the rebuilt instance.
    expect(live.afterCommitLog).toEqual(['after:warm']);

    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('and now?', 'evt_live_apply_followup'),
      session: live.session,
      logStore: live.logStore,
      pluginHost: live.pluginHost,
      roleModelAdapter: live.contextCaptureAdapter,
    });

    expect(followupResult.status).toBe('completed');
    expect(live.capturedContexts[0]).toContain('tone:warm');
    expect(live.afterCommitLog).toEqual(['after:warm', 'after:warm']);
  });
});
