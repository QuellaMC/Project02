import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';
import {
  createConversationSession,
  createRuntimeEventIdentity,
} from '../../src/core/index.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin,
} from '../../src/plugins/packages/character-state/plugin.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';
import {testRuntimePluginFileStoreProvider} from '../support/plugin-host-fixtures.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {
  createRuntimePluginContext,
  firstPartyModelToolsPluginId,
  runtimePluginId,
} from '../../src/plugins/api/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {
  type RoleModelAdapter,
  type RoleModelChatMessage,
} from '../../src/role-model/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  createDurableCharacterStateHarness,
  createHealthRejectingPlugin,
  createSequencedAdapter,
  createTestEvent,
  runLocalUserMessageEventWithDefaultTestHost as runLocalUserMessageEvent,
  transactionIdentityFromContext,
} from '../support/plugin-tool-loop-fixtures.ts';

describe('plugin-driven Character State tool loop', () => {
  it('executes character_state.patch through the built-in plugin and continues', async () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const adapter = createSequencedAdapter([
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
              text: 'state updated',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_plugin_patch'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['hello', 'state updated']);

    const rawEvents = logStore.rawEvents();
    const toolEvents = rawEvents.filter(event =>
      event.kind.startsWith('tool_call'),
    );

    expect(toolEvents.map(event => event.kind)).toEqual([
      'tool_call_started',
      'tool_call_finished',
    ]);
    expect(toolEvents[0]).toMatchObject({
      toolCallId:
        'evt_plugin_patch.trace_evt_plugin_patch.round-1.1.character_state.patch',
      toolName: 'character_state.patch',
      toolPluginId: 'character-state',
      toolInput: {
        mood: 'curious',
      },
    });
    expect(toolEvents[1]).toMatchObject({
      toolCallId:
        'evt_plugin_patch.trace_evt_plugin_patch.round-1.1.character_state.patch',
      dispatchedToHost: true,
      toolName: 'character_state.patch',
      toolPluginId: 'character-state',
      toolResult: {
        status: 'accepted',
      },
    });
    expect(toolEvents[1]).not.toHaveProperty('pluginStoreRevision');
    const terminalEvent = rawEvents.find(
      event => event.kind === 'runtime_turn_completed',
    );

    expect(terminalEvent).toMatchObject({
      kind: 'runtime_turn_completed',
      toolCallIds: [
        'evt_plugin_patch.trace_evt_plugin_patch.round-1.1.character_state.patch',
      ],
    });
    const observations =
      terminalEvent?.roleModelIOSnapshot?.inputEnvelope.toolObservations ?? [];

    expect(observations).toHaveLength(1);
    expect(observations[0]?.round).toBe(1);
    expect(observations[0]?.pluginId).toBe('character-state');
    expect(observations[0]?.toolName).toBe('character_state.patch');
    expect(observations[0]?.result.status).toBe('accepted');
  });

  it('persists role-model evidence on tool-authorizing rounds without interim replies', async () => {
    const sessionId = 'session-tool-round-evidence';
    const {session, logStore, storeRoot} =
      await createDurableCharacterStateHarness(sessionId);
    const adapter = createSequencedAdapter([
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
              text: 'state updated',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_tool_round_evidence'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');

    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
    });
    const reopenedRawEvents = reopenedLogStore.rawEvents();
    const toolStartEvents = reopenedRawEvents.filter(
      event => event.kind === 'tool_call_started',
    );
    const toolStartEvent = toolStartEvents[0];

    expect(toolStartEvents).toHaveLength(1);

    if (toolStartEvent === undefined) {
      throw new Error('Expected tool_call_started evidence.');
    }

    expect(toolStartEvent).toMatchObject({
      toolCallId:
        'evt_tool_round_evidence.trace_evt_tool_round_evidence.round-1.1.character_state.patch',
      toolRound: 1,
      roleModelIOSnapshot: {
        inputEnvelope: {
          toolObservations: [],
        },
      },
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'accepted',
          decision: {
            toolCalls: [
              {
                name: 'character_state.patch',
                input: {
                  mood: 'curious',
                },
              },
            ],
          },
        },
      },
    });
    expect(toolStartEvent.roleModelIOSnapshot?.rawOutputText).toContain(
      'character_state.patch',
    );
    expect(toolStartEvent.commitValidation).toBeUndefined();

    const terminalEvent = reopenedRawEvents.find(
      event => event.kind === 'runtime_turn_completed',
    );

    expect(terminalEvent?.roleModelIOSnapshot?.rawOutputText).toContain(
      'visible_reply',
    );
    expect(terminalEvent?.roleModelIOSnapshot?.rawOutputText).not.toContain(
      'character_state.patch',
    );
  });

  it('persists repeated same tool calls across separate durable turns', async () => {
    const sessionId = 'session-repeated-tool-turns';
    const {session, logStore, storeRoot} =
      await createDurableCharacterStateHarness(sessionId);

    for (const eventId of [
      'evt_repeated_tool_first',
      'evt_repeated_tool_second',
    ]) {
      const result = await runLocalUserMessageEvent({
        event: createTestEvent('update state', eventId),
        session,
        logStore,
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
                  text: `state updated for ${eventId}`,
                },
              },
            ],
          },
        ]),
      });

      expect(result.status).toBe('completed');
    }

    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
    });
    const toolStartIds = reopenedLogStore
      .rawEvents()
      .filter(event => event.kind === 'tool_call_started')
      .map(event => event.toolCallId);

    expect(toolStartIds).toEqual([
      'evt_repeated_tool_first.trace_evt_repeated_tool_first.round-1.1.character_state.patch',
      'evt_repeated_tool_second.trace_evt_repeated_tool_second.round-1.1.character_state.patch',
    ]);
  });

  it('counts invalid character_state.patch attempts against its turn limit', async () => {
    const {session, logStore, pluginStore} =
      await createDurableCharacterStateHarness(
        'session-plugin-patch-invalid-retry',
      );
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'character_state.patch',
            input: {
              activity: 'reflecting',
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'character_state.patch',
            input: {
              currentActivity: 'reflecting',
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'state corrected',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('correct state', 'evt_plugin_patch_invalid_retry'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });
    const toolFinishedEvents = logStore
      .rawEvents()
      .filter(event => event.kind === 'tool_call_finished');

    expect(result.status).toBe('completed');
    expect(toolFinishedEvents).toHaveLength(2);
    expect(toolFinishedEvents[0]).toMatchObject({
      dispatchedToHost: true,
      toolName: 'character_state.patch',
      toolResult: {
        status: 'rejected',
        reason: 'invalid_input',
      },
    });
    expect(toolFinishedEvents[1]).toMatchObject({
      dispatchedToHost: false,
      toolName: 'character_state.patch',
      toolResult: {
        status: 'rejected',
        reason: 'tool_call_limit_reached',
      },
    });
    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(0);
    const checkpoint = pluginStore.readJson('checkpoint.json');
    expect(checkpoint).toMatchObject({eventCount: 0});
    expect(JSON.stringify(checkpoint)).not.toContain('reflecting');
  });

  it('replays a durably stored turn that recovered through decision-error feedback', async () => {
    const sessionId = 'session-feedback-replay';
    const {session, logStore, storeRoot} =
      await createDurableCharacterStateHarness(sessionId);
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'memory.unknown',
            input: {query: 'Mira'},
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {text: 'recovered after feedback'},
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('try unknown', 'evt_feedback_replay'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');

    const reopenedLogStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId,
    });
    const replayedEvents = reopenedLogStore.rawEvents();
    const terminal = replayedEvents.at(-1);

    expect(terminal).toMatchObject({
      kind: 'runtime_turn_completed',
    });
    expect(
      replayedEvents.filter(event => event.kind === 'tool_call_finished'),
    ).toMatchObject([
      {
        dispatchedToHost: false,
        toolName: 'memory.unknown',
        toolResult: {status: 'rejected', reason: 'tool_not_declared'},
      },
    ]);
    expect(
      reopenedLogStore
        .conversationMessages()
        .some(message => message.text === 'recovered after feedback'),
    ).toBe(true);
  });

  it('persists character_state.patch during handleToolCall', async () => {
    const {session, logStore, pluginStore} =
      await createDurableCharacterStateHarness('session-plugin-patch-accepted');
    const adapter = createSequencedAdapter([
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
              text: 'state updated',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_plugin_patch_accepted'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result.status).toBe('completed');
    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(1);
    expect(pluginStore.readJson('checkpoint.json')).toMatchObject({
      current: {
        current: {
          mood: 'curious',
        },
      },
    });
  });

  it('discards staged character_state.patch when a later commit validation rejects the turn', async () => {
    const {session, logStore, pluginStore} =
      await createDurableCharacterStateHarness('session-plugin-patch-rejected');
    const adapter = createSequencedAdapter([
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
              text: '',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_plugin_patch_rejected'),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'invalid_visible_reply',
    });
    expect(logStore.conversationMessages()).toEqual([]);
    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(0);
    expect(pluginStore.readJson('checkpoint.json')).toBeUndefined();
  });

  it('discards staged character_state.patch when precommit plugin health rejects', async () => {
    const sessionId = 'session-plugin-patch-health-rejected';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({storeRoot}).createSession({
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
    });
    const pluginHost = createRuntimePluginHost({
      fileStore: testRuntimePluginFileStoreProvider,
      storeRoot,
      sessionId,
      plugins: [createCharacterStatePlugin(), createHealthRejectingPlugin()],
      enabledPluginIds: [
        runtimePluginId,
        firstPartyModelToolsPluginId,
        characterStatePluginId,
        'health-reject.fixture',
      ],
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId,
    });
    const adapter = createSequencedAdapter([
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
              text: 'health should reject before commit',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_plugin_patch_health_rejected'),
      session,
      logStore,
      roleModelAdapter: adapter,
      pluginHost,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_health_rejected',
    });
    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(0);
    expect(pluginStore.readJson('checkpoint.json')).toBeUndefined();
  });

  it('commits accepted character_state.patch once for repeated tool call identity', async () => {
    const sessionId = 'session-plugin-patch-idempotent';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({storeRoot}).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });

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
    const context = createRuntimePluginContext({
      ...createRuntimeEventIdentity({
        eventId: 'evt_plugin_patch_idempotent',
        traceId: 'trace_plugin_patch_idempotent',
        createdAt: '2026-06-15T00:00:00.000Z',
      }),
      sessionId,
      eventType: 'USER_MESSAGE',
      currentUserMessage: 'hello',
      character: testCharacterProfile,
    });
    const call = Object.freeze({
      eventId: context.eventId,
      traceId: context.traceId,
      createdAt: context.timestamp,
      toolCallId:
        'evt_plugin_patch_idempotent.trace_plugin_patch_idempotent.round-1.1.character_state.patch',
      pluginId: characterStatePluginId,
      toolName: 'character_state.patch',
      input: {
        mood: 'curious',
      },
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      pluginHost.beginFileStoreTransaction?.();
      const result = await pluginHost.handleToolCall(call, context);

      expect(result.status).toBe('accepted');
      const prepared = await pluginHost.prepareFileStoreTransaction?.(
        transactionIdentityFromContext(context),
      );
      await prepared?.finalize();
    }

    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(1);
    expect(pluginStore.readJson('checkpoint.json')).toMatchObject({
      current: {
        current: {
          mood: 'curious',
        },
      },
    });
  });

  it('replays the stored Character State result after intervening state changes', async () => {
    const sessionId = 'session-plugin-patch-idempotent-replay';
    const storeRoot = createTestTempRoot('project02-plugin-loop-');

    await createLocalRuntimeSessionStore({storeRoot}).createSession({
      sessionId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });

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
    const context = createRuntimePluginContext({
      ...createRuntimeEventIdentity({
        eventId: 'evt_plugin_patch_idempotent_replay',
        traceId: 'trace_plugin_patch_idempotent_replay',
        createdAt: '2026-06-15T00:00:00.000Z',
      }),
      sessionId,
      eventType: 'USER_MESSAGE',
      currentUserMessage: 'hello',
      character: testCharacterProfile,
    });
    const originalCall = Object.freeze({
      eventId: context.eventId,
      traceId: context.traceId,
      createdAt: context.timestamp,
      toolCallId: 'character-state-call-original',
      pluginId: characterStatePluginId,
      toolName: 'character_state.patch',
      input: {
        mood: 'curious',
      },
    });
    const interveningContext = createRuntimePluginContext({
      ...createRuntimeEventIdentity({
        eventId: 'evt_plugin_patch_intervening',
        traceId: 'trace_plugin_patch_intervening',
        createdAt: context.timestamp,
      }),
      sessionId,
      eventType: 'USER_MESSAGE',
      currentUserMessage: 'hello',
      character: testCharacterProfile,
    });
    const interveningCall = Object.freeze({
      eventId: interveningContext.eventId,
      traceId: interveningContext.traceId,
      createdAt: interveningContext.timestamp,
      toolCallId: 'character-state-call-intervening',
      pluginId: characterStatePluginId,
      toolName: 'character_state.patch',
      input: {
        mood: 'playful',
      },
    });
    const pluginStore = createRuntimePluginFileStore({
      storeRoot,
      sessionId,
      pluginId: characterStatePluginId,
    });

    pluginHost.beginFileStoreTransaction?.();
    const originalResult = await pluginHost.handleToolCall(
      originalCall,
      context,
    );
    const originalPrepared = await pluginHost.prepareFileStoreTransaction?.(
      transactionIdentityFromContext(context),
    );
    await originalPrepared?.finalize();
    pluginHost.beginFileStoreTransaction?.();
    await pluginHost.handleToolCall(interveningCall, interveningContext);
    const interveningPrepared = await pluginHost.prepareFileStoreTransaction?.(
      transactionIdentityFromContext(interveningContext),
    );
    await interveningPrepared?.finalize();
    pluginHost.beginFileStoreTransaction?.();
    const replayedResult = await pluginHost.handleToolCall(
      originalCall,
      context,
    );
    const replayPrepared = await pluginHost.prepareFileStoreTransaction?.(
      transactionIdentityFromContext(context),
    );
    await replayPrepared?.finalize();
    pluginHost.beginFileStoreTransaction?.();
    const conflictingResult = await pluginHost.handleToolCall(
      {
        ...originalCall,
        input: {
          mood: 'tired',
        },
      },
      context,
    );
    const conflictingPrepared = await pluginHost.prepareFileStoreTransaction?.(
      transactionIdentityFromContext(context),
    );
    await conflictingPrepared?.finalize();

    expect(originalResult).toMatchObject({
      status: 'accepted',
      output: {
        current: {
          mood: 'curious',
        },
        appliedChanges: [
          {
            field: 'mood',
            before: 'steady',
            after: 'curious',
          },
        ],
      },
    });
    expect(replayedResult).toMatchObject({
      status: 'accepted',
      output: {
        current: {
          mood: 'curious',
        },
        appliedChanges: [
          {
            field: 'mood',
            before: 'steady',
            after: 'curious',
          },
        ],
        idempotent: true,
      },
    });
    expect(conflictingResult).toMatchObject({
      status: 'rejected',
      reason: 'character_state_idempotency_conflict',
    });
    expect(pluginStore.readJsonl('events.jsonl')).toHaveLength(2);
    expect(pluginStore.readJson('checkpoint.json')).toMatchObject({
      current: {
        current: {
          mood: 'playful',
        },
      },
    });
  });

  it('records no-op character_state.patch identities without writing the current cache', async () => {
    const {session, logStore, pluginStore} =
      await createDurableCharacterStateHarness('session-plugin-patch-noop');
    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_plugin_patch_noop'),
      session,
      logStore,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'character_state.patch',
              input: {
                mood: 'steady',
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'no change needed',
              },
            },
          ],
        },
      ]),
    });

    expect(result.status).toBe('completed');
    expect(pluginStore.readJsonl('events.jsonl')).toMatchObject([
      {
        result: {
          status: 'accepted',
          appliedChanges: [],
        },
      },
    ]);
    expect(pluginStore.readJson('checkpoint.json')).toMatchObject({
      eventCount: 1,
      current: {
        current: {
          mood: 'steady',
        },
      },
    });
  });

  it('isolates default in-memory Character State by session object', async () => {
    const firstSession = createConversationSession({
      character: testCharacterProfile,
    });
    const firstLogStore = createRuntimeLogStore();
    const firstAdapter = createSequencedAdapter([
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
              text: 'first updated',
            },
          },
        ],
      },
    ]);

    await runLocalUserMessageEvent({
      event: createTestEvent('first session', 'evt_session_isolation_first'),
      session: firstSession,
      logStore: firstLogStore,
      roleModelAdapter: firstAdapter,
    });

    const secondSession = createConversationSession({
      character: testCharacterProfile,
    });
    const secondLogStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const secondAdapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        messagesByRound.push([...invocation.turnContext.messages]);

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'second fresh',
                },
              },
            ],
          }),
        };
      },
    });

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('second session', 'evt_session_isolation_second'),
      session: secondSession,
      logStore: secondLogStore,
      roleModelAdapter: secondAdapter,
    });
    const runtimeContextMessage = messagesByRound[0]?.find(
      message =>
        message.role === 'user' &&
        message.content.includes('Untrusted plugin context'),
    );
    const currentUserMessage = messagesByRound[0]?.findLast(
      message => message.role === 'user',
    );

    expect(result.status).toBe('completed');
    expect(currentUserMessage?.content).toBe('second session');
    expect(runtimeContextMessage?.content).toContain('mood=steady');
    expect(runtimeContextMessage?.content).not.toContain('mood=curious');
  });
});
