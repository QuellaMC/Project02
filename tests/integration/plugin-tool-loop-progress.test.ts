import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';
import {createSession} from '../../src/core/index.ts';
import {createFileRuntimeLogStore} from '../../src/runtime/storage/file-runtime-log-store.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {createRuntimeLogStore} from '../../src/runtime/evidence/index.ts';
import {
  type RoleModelAdapter,
  type RoleModelChatMessage,
  roleModelMalformedOutputRejectionReason,
} from '../../src/role-model/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {
  createDurableCharacterStateHarness,
  createRawEventAppendFailingLogStore,
  runLocalUserMessageEventWithDefaultTestHost as runLocalUserMessageEvent,
} from '../support/plugin-tool-loop-fixtures.ts';
import {
  createSequencedAdapter,
  createTestEvent,
} from '../support/role-model-loop-fixtures.ts';

describe('plugin-driven tool loop progress and evidence', () => {
  it('does not expose plugin inventory through hidden runtime context', async () => {
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const messagesByRound: RoleModelChatMessage[][] = [];
    const adapter: RoleModelAdapter = Object.freeze({
      invoke(_inputEnvelope, invocation) {
        messagesByRound.push([...invocation.turnContext.messages]);

        return {
          rawOutputText: JSON.stringify({
            toolCalls: [
              {
                name: 'visible_reply',
                input: {
                  text: 'I can see callable tools, but I need runtime.plugin.list for the canonical plugin inventory.',
                },
              },
            ],
          }),
        };
      },
    });

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'what plugins are available?',
        'evt_plugin_context_surface',
      ),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    const runtimeContextMessage = messagesByRound[0]?.find(
      message => message.role === 'system' && message.content.includes('mood='),
    );
    const currentUserMessage = messagesByRound[0]?.findLast(
      message => message.role === 'user',
    );

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual([
      'what plugins are available?',
      'I can see callable tools, but I need runtime.plugin.list for the canonical plugin inventory.',
    ]);
    expect(
      logStore.rawEvents().some(event => event.kind === 'tool_call_started'),
    ).toBe(false);
    expect(currentUserMessage?.content).toBe('what plugins are available?');
    // Character State rides the trusted per-turn frame, not the user turn.
    expect(runtimeContextMessage?.content).toContain('mood=');
    expect(runtimeContextMessage?.content).not.toContain('sourceReferences');
    expect(runtimeContextMessage?.content).not.toContain('runtime.plugin.list');
    expect(runtimeContextMessage?.content).not.toContain('visible_reply');
    expect(runtimeContextMessage?.content).not.toContain(
      'character_state.patch',
    );
  });

  it('commits interim visible_reply durably before executable tools run', async () => {
    const conversationId = 'session-interim-visible-reload';
    const sessionId = `${conversationId}.1`;
    const storeRoot = createTestTempRoot('project02-plugin-loop-');
    await createLocalRuntimeSessionStore({
      storeRoot,
      characterId: testCharacterProfile.id,
    }).createSession({
      conversationId,
      createdAt: '2026-06-15T00:00:00.000Z',
    });
    const session = createSession({
      id: sessionId,
      character: testCharacterProfile,
    });
    const logStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot,
      sessionId,
    });
    const progress: unknown[] = [];
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'Authorization: Bearer interim-secret',
            },
          },
          {
            name: 'character_state.patch',
            input: {
              energy: 'high',
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'finished',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('needs tool', 'evt_interim_visible'),
      session,
      logStore,
      roleModelAdapter: adapter,
      onProgress(event) {
        progress.push(event);
      },
    });

    expect(result.status).toBe('completed');
    const reloadedLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot,
      sessionId,
    });
    // Every visible reply is history the moment the user sees it, so interim
    // text commits before the tool round runs.
    expect(
      reloadedLogStore.conversationMessages().map(message => message.text),
    ).toEqual([
      'needs tool',
      'Authorization: Bearer interim-secret',
      'finished',
    ]);
    expect(progress).toEqual([
      {
        kind: 'user_message',
        messageId: `${sessionId}:message-1`,
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'needs tool',
      },
      {
        kind: 'visible_reply',
        messageId: `${sessionId}:message-2`,
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'Authorization: Bearer interim-secret',
        draftId: '1.0',
      },
      {
        kind: 'tool_calls_requested',
        round: 1,
        toolNames: ['character_state.patch'],
      },
      {
        kind: 'tool_call_completed',
        round: 1,
        status: 'accepted',
        toolName: 'character_state.patch',
      },
      {
        kind: 'visible_reply',
        messageId: `${sessionId}:message-3`,
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'finished',
        draftId: '2.0',
      },
    ]);
    const reloadedRawEvents = reloadedLogStore.rawEvents();

    expect(
      reloadedRawEvents
        .filter(event => event.kind === 'visible_message_committed')
        .map(event => event.visibleMessageIds),
    ).toEqual([
      [`${sessionId}:message-1`],
      [`${sessionId}:message-2`],
      [`${sessionId}:message-3`],
    ]);
    expect(
      reloadedLogStore
        .traceEntries()
        .some(entry => entry.step === 'visible_message_committed'),
    ).toBe(true);
  });

  it('continues after interim visible_reply progress callback failures', async () => {
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const progress: unknown[] = [];
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'checking',
            },
          },
          {
            name: 'character_state.patch',
            input: {
              energy: 'high',
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'finished',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('needs tool', 'evt_interim_progress_fails'),
      session,
      logStore,
      roleModelAdapter: adapter,
      onProgress(event) {
        progress.push(event);

        if (event.kind === 'visible_reply' && event.text === 'checking') {
          throw new Error('interim progress observer failed');
        }
      },
    });

    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['needs tool', 'checking', 'finished']);
    expect(progress).toEqual([
      {
        kind: 'user_message',
        messageId: 'local-session:message-1',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'needs tool',
      },
      {
        kind: 'visible_reply',
        messageId: 'local-session:message-2',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'checking',
        draftId: '1.0',
      },
      {
        kind: 'tool_calls_requested',
        round: 1,
        toolNames: ['character_state.patch'],
      },
      {
        kind: 'tool_call_completed',
        round: 1,
        status: 'accepted',
        toolName: 'character_state.patch',
      },
      {
        kind: 'visible_reply',
        messageId: 'local-session:message-3',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'finished',
        draftId: '2.0',
      },
    ]);
    expect(
      logStore
        .rawEvents()
        .some(event => event.kind === 'runtime_turn_rejected'),
    ).toBe(false);
  });

  it('carries the reply as a draft ahead of its commit, and ends every draft before the round moves on', async () => {
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const progress: unknown[] = [];
    const result = await runLocalUserMessageEvent({
      event: createTestEvent('needs tool', 'evt_reply_drafts'),
      session,
      logStore,
      roleModelAdapter: createSequencedAdapter(
        [
          {
            toolCalls: [
              {name: 'visible_reply', input: {text: 'checking'}},
              {name: 'character_state.patch', input: {energy: 'high'}},
            ],
          },
          {toolCalls: [{name: 'visible_reply', input: {text: 'finished'}}]},
        ],
        undefined,
        [
          [
            {reply: 0, text: 'check'},
            {reply: 0, text: 'ing'},
            {reply: 1, text: 'a draft the round never committed'},
          ],
          [{reply: 0, text: 'finished'}],
        ],
      ),
      onProgress(event) {
        progress.push(event);
      },
    });

    expect(result.status).toBe('completed');
    expect(progress).toEqual([
      expect.objectContaining({kind: 'user_message', text: 'needs tool'}),
      {kind: 'reply_delta', draftId: '1.0', text: 'check'},
      {kind: 'reply_delta', draftId: '1.0', text: 'ing'},
      {
        kind: 'reply_delta',
        draftId: '1.1',
        text: 'a draft the round never committed',
      },
      expect.objectContaining({
        kind: 'visible_reply',
        text: 'checking',
        draftId: '1.0',
      }),
      {kind: 'reply_withdrawn', draftId: '1.1'},
      expect.objectContaining({kind: 'tool_calls_requested', round: 1}),
      expect.objectContaining({kind: 'tool_call_completed', round: 1}),
      {kind: 'reply_delta', draftId: '2.0', text: 'finished'},
      expect.objectContaining({
        kind: 'visible_reply',
        text: 'finished',
        draftId: '2.0',
      }),
    ]);
    // Drafts never reach the log: the record of the turn is the committed messages alone.
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['needs tool', 'checking', 'finished']);
  });

  it('lets an observer that awaits hear a draft ahead of its commit, and before the turn ends', async () => {
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const heard: string[] = [];
    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello there', 'evt_slow_observer'),
      session,
      logStore,
      roleModelAdapter: createSequencedAdapter(
        [{toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}]}],
        undefined,
        [
          [
            {reply: 0, text: 'not'},
            {reply: 0, text: 'ed'},
          ],
        ],
      ),
      async onProgress(event) {
        // A slow ear: the draft takes longer to hear than the commit would.
        if (event.kind === 'reply_delta') {
          await new Promise(resolve => setTimeout(resolve, 5));
        }

        heard.push(
          event.kind === 'reply_delta' || event.kind === 'visible_reply'
            ? `${event.kind} ${event.text}`
            : event.kind,
        );
      },
    });

    expect(result.status).toBe('completed');
    expect(heard).toEqual([
      'user_message',
      'reply_delta not',
      'reply_delta ed',
      'visible_reply noted',
    ]);
  });

  it('withdraws a reply that never reached disk, having only ever called it a draft', async () => {
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRawEventAppendFailingLogStore({
      matches: record =>
        record.kind === 'visible_message_committed' &&
        record.visibleMessage?.role === 'character',
      message: 'the disk is full',
    });
    const progress: unknown[] = [];

    await expect(
      runLocalUserMessageEvent({
        event: createTestEvent('hello there', 'evt_reply_persist_fails'),
        session,
        logStore,
        roleModelAdapter: createSequencedAdapter(
          [{toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}]}],
          undefined,
          [[{reply: 0, text: 'noted'}]],
        ),
        onProgress(event) {
          progress.push(event);
        },
      }),
    ).rejects.toThrow('the disk is full');

    // The person's message landed and was announced; the reply that never
    // reached disk was drafted, then withdrawn, and never announced as a
    // message.
    expect(progress).toEqual([
      expect.objectContaining({kind: 'user_message', text: 'hello there'}),
      {kind: 'reply_delta', draftId: '1.0', text: 'noted'},
      {kind: 'reply_withdrawn', draftId: '1.0'},
    ]);
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['hello there']);
  });

  it('feeds prior interim replies back through the next turn model context', async () => {
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const firstTurn = await runLocalUserMessageEvent({
      event: createTestEvent('needs tool', 'evt_interim_context_first'),
      session,
      logStore,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {text: 'checking'},
            },
            {
              name: 'character_state.patch',
              input: {energy: 'high'},
            },
          ],
        },
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {text: 'finished'},
            },
          ],
        },
      ]),
    });

    expect(firstTurn.status).toBe('completed');

    const captureWire = () => {
      const captured: {messages?: readonly RoleModelChatMessage[]} = {};

      return {
        captured,
        adapter: Object.freeze({
          invoke(_inputEnvelope, invocation) {
            captured.messages ??= invocation.turnContext.messages;
            return {
              rawOutputText: JSON.stringify({
                toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
              }),
            };
          },
        } satisfies RoleModelAdapter),
      };
    };
    const live = captureWire();
    const secondTurn = await runLocalUserMessageEvent({
      event: createTestEvent('and now?', 'evt_interim_context_second'),
      session,
      logStore,
      roleModelAdapter: live.adapter,
    });

    expect(secondTurn.status).toBe('completed');
    // The prior turn replays natively: interim reply as assistant content
    // beside the tool call, the tool result, then the final reply.
    const replayed = (live.captured.messages ?? []).filter(
      message =>
        message.role === 'tool' ||
        (message.role === 'assistant' && message.content !== 'noted') ||
        (message.role === 'user' && !message.content.startsWith('and now?')),
    );
    expect(replayed).toEqual([
      {role: 'user', content: 'needs tool'},
      expect.objectContaining({
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          expect.objectContaining({
            type: 'function',
            function: {
              name: 'character_state.patch',
              arguments: '{"energy":"high"}',
            },
          }),
        ],
      }),
      expect.objectContaining({role: 'tool'}),
      {role: 'assistant', content: 'finished'},
    ]);
    const toolCallId = (
      replayed[1] as {tool_calls?: readonly {id: string}[]} | undefined
    )?.tool_calls?.[0]?.id;
    expect(replayed[2]).toMatchObject({tool_call_id: toolCallId});
    expect(
      String((replayed[2] as {content?: unknown} | undefined)?.content),
    ).toContain('"toolName":"character_state.patch"');

    // Reopened from the same log, the replayed prefix is byte-identical.
    const reopened = captureWire();
    const thirdTurn = await runLocalUserMessageEvent({
      event: createTestEvent('still there?', 'evt_interim_context_third'),
      session: createSession({
        id: session.id,
        character: testCharacterProfile,
        visibleTranscript: logStore
          .readSessionEvidence()
          .conversationMessages.map(message => ({
            id: message.id,
            role: message.role,
            speakerId: message.speakerId,
            speakerName: message.speakerName,
            text: message.text,
          })),
      }),
      logStore,
      roleModelAdapter: reopened.adapter,
    });

    expect(thirdTurn.status).toBe('completed');
    const historyOf = (messages: readonly RoleModelChatMessage[]) => {
      const start = messages.findIndex(message => message.role === 'user');

      return JSON.stringify(messages.slice(start, start + replayed.length));
    };
    expect(historyOf(reopened.captured.messages ?? [])).toBe(
      historyOf(live.captured.messages ?? []),
    );
  });

  it('keeps durable final visible_reply committed when progress callback fails', async () => {
    const conversationId = 'session-final-progress-fails';
    const sessionId = `${conversationId}.1`;
    const {session, logStore, storeRoot} =
      await createDurableCharacterStateHarness(conversationId);
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: 'final reply',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent('hello', 'evt_final_progress_fails'),
      session,
      logStore,
      roleModelAdapter: adapter,
      onProgress(event) {
        if (event.kind === 'visible_reply') {
          throw new Error('final progress observer failed');
        }
      },
    });

    expect(result.status).toBe('completed');
    expect(result.rawEvent).toMatchObject({
      kind: 'runtime_turn_completed',
      status: 'completed',
    });
    expect(
      logStore
        .rawEvents()
        .some(event => event.kind === 'runtime_turn_rejected'),
    ).toBe(false);

    const reopenedLogStore = createFileRuntimeLogStore({
      boundCharacter: testCharacterProfile,
      characterId: testCharacterProfile.id,
      storeRoot,
      sessionId,
    });

    expect(
      reopenedLogStore.conversationMessages().map(message => message.text),
    ).toEqual(['hello', 'final reply']);
    expect(
      reopenedLogStore
        .rawEvents()
        .filter(
          event =>
            event.kind === 'runtime_turn_completed' ||
            event.kind === 'runtime_turn_rejected',
        )
        .map(event => event.kind),
    ).toEqual(['runtime_turn_completed']);

    const restoredSession = createSession({
      character: testCharacterProfile,
      id: sessionId,
      visibleTranscript: reopenedLogStore.conversationMessages(),
    });
    const followupResult = await runLocalUserMessageEvent({
      event: createTestEvent('again', 'evt_final_progress_followup'),
      session: restoredSession,
      logStore: reopenedLogStore,
      roleModelAdapter: createSequencedAdapter([
        {
          toolCalls: [
            {
              name: 'visible_reply',
              input: {
                text: 'followup reply',
              },
            },
          ],
        },
      ]),
    });

    expect(followupResult.status).toBe('completed');
    expect(
      reopenedLogStore.conversationMessages().map(message => message.text),
    ).toEqual(['hello', 'final reply', 'again', 'followup reply']);
    expect(
      reopenedLogStore
        .rawEvents()
        .filter(
          event =>
            event.kind === 'runtime_turn_completed' ||
            event.kind === 'runtime_turn_rejected',
        )
        .map(event => event.kind),
    ).toEqual(['runtime_turn_completed', 'runtime_turn_completed']);
  });

  it('records the refused round it handed back to the model, before the round that recovered', async () => {
    const session = createSession({
      character: testCharacterProfile,
    });
    const logStore = createRuntimeLogStore();
    const adapter = createSequencedAdapter([
      {
        toolCalls: [
          {
            name: 'visible_reply',
            input: {
              text: '   ',
            },
          },
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
              text: 'finished',
            },
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'needs invalid interim',
        'evt_invalid_interim_visible',
      ),
      session,
      logStore,
      roleModelAdapter: adapter,
    });

    // An empty visible_reply is the model's own doing, so the error goes back
    // to it as another round instead of ending the turn — and the refused
    // round is on record like any other.
    expect(result.status).toBe('completed');
    expect(
      logStore.conversationMessages().map(message => message.text),
    ).toEqual(['needs invalid interim', 'finished']);
    expect(
      logStore
        .rawEvents()
        .filter(event => event.kind === 'role_model_round')
        .map(event => [
          event.round,
          event.parsedRoleModelDecisionSnapshot?.result.status,
        ]),
    ).toEqual([
      [1, 'rejected'],
      [2, 'accepted'],
    ]);
    expect(
      logStore.rawEvents().some(event => event.kind === 'tool_call_started'),
    ).toBe(false);
    expect(
      logStore
        .rawEvents()
        .some(event => event.kind === 'runtime_turn_rejected'),
    ).toBe(false);
  });

  it('preserves prior tool evidence when a later interim visible_reply is invalid', async () => {
    const session = createSession({
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
              text: '   ',
            },
          },
          {
            name: 'runtime.plugin.list',
            input: {},
          },
        ],
      },
    ]);

    const result = await runLocalUserMessageEvent({
      event: createTestEvent(
        'needs invalid later interim',
        'evt_invalid_later_interim_visible',
      ),
      session,
      logStore,
      roleModelAdapter: adapter,
    });
    const rejectionEvents = logStore
      .rawEvents()
      .filter(event => event.kind === 'runtime_turn_rejected');

    expect(result).toMatchObject({
      status: 'rejected',
      reason: roleModelMalformedOutputRejectionReason,
    });
    expect(rejectionEvents).toHaveLength(1);

    for (const event of rejectionEvents) {
      expect(event).toMatchObject({
        reason: roleModelMalformedOutputRejectionReason,
        toolCallIds: [
          'evt_invalid_later_interim_visible.trace_evt_invalid_later_interim_visible.round-1.1.character_state.patch',
        ],
      });
      expect(event.runtimePluginEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'character-state',
            evidenceKind: 'tool_invocation',
            status: 'accepted',
          }),
        ]),
      );
      const characterStateInvocation =
        event.runtimePluginTurnEvidence?.toolInvocations.find(
          invocation =>
            invocation.pluginId === 'character-state' &&
            invocation.toolName === 'character_state.patch',
        );

      expect(characterStateInvocation).toMatchObject({
        result: {
          status: 'accepted',
        },
      });
      expect(characterStateInvocation?.result.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'character-state',
            evidenceKind: 'tool_invocation',
            status: 'accepted',
          }),
        ]),
      );
    }
  });
});
