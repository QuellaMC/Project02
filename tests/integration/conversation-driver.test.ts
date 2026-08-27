import {describe, expect, it} from 'vitest';

import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {
  RoleModelAdapter,
  RoleModelChatMessage,
} from '../../src/role-model/index.ts';
import {deliverUserMessage, openConversation} from '../../src/runtime/index.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  characterDataDirPath,
  createLocalRuntimeSessionStore,
} from '../../src/runtime/storage/index.ts';
import {testCharacterProfile} from '../support/character-fixtures.ts';
import {createSessionEndFileStoreProbePlugin} from '../support/plugin-host-fixtures.ts';
import {withOpenConversation} from '../support/conversation-fixtures.ts';

const contextWindowTokens = 100;

function replyAdapter(
  options: {
    readonly capture?: (messages: readonly RoleModelChatMessage[]) => void;
    readonly completeText?: RoleModelAdapter['completeText'];
  } = {},
): RoleModelAdapter {
  return {
    invoke(_inputEnvelope, invocation) {
      options.capture?.(invocation.turnContext.messages);

      return {
        rawOutputText: JSON.stringify({
          toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
        }),
      };
    },
    ...(options.completeText === undefined
      ? {}
      : {completeText: options.completeText}),
  };
}

describe('conversation driver', () => {
  it('delivers a message through the character turn into its segment', async () => {
    await withOpenConversation({}, async conversation => {
      const delivery = await deliverUserMessage({
        conversation,
        line: 'hello there',
        pluginHost: createRuntimePluginHost({plugins: []}),
        roleModelAdapter: replyAdapter(),
      });

      expect(delivery.status).toBe('completed');
      expect(delivery.status === 'completed' && delivery.rotation).toBe(
        undefined,
      );
      expect(
        conversation.session.visibleTranscript.map(message => message.text),
      ).toEqual(['hello there', 'noted']);
      expect(conversation.session.id).toBe(`${conversation.conversation.id}.1`);
    });
  });

  it('reports a rejected turn and records nothing more than the rejection', async () => {
    await withOpenConversation({}, async conversation => {
      const delivery = await deliverUserMessage({
        conversation,
        line: 'hello there',
        pluginHost: createRuntimePluginHost({plugins: []}),
        roleModelAdapter: {
          invoke() {
            return {rawOutputText: 'not json at all'};
          },
        },
      });

      expect(delivery).toMatchObject({
        status: 'rejected',
        turn: {reason: 'malformed_output'},
      });
      expect(conversation.session.visibleTranscript).toHaveLength(1);
    });
  });

  it('records an input rejection without running a turn', async () => {
    await withOpenConversation({}, async conversation => {
      const delivery = await deliverUserMessage({
        conversation,
        line: '   ',
        pluginHost: createRuntimePluginHost({plugins: []}),
        roleModelAdapter: replyAdapter(),
      });

      expect(delivery).toMatchObject({
        status: 'input_rejected',
        turn: {reason: 'input_validation_rejected'},
      });
      expect(
        conversation.logStore.rawEvents().map(rawEvent => rawEvent.kind),
      ).toEqual(['runtime_event_received', 'runtime_turn_rejected']);
    });
  });

  it('rotates the segment when history outgrows the window and stays invisible', async () => {
    const endedSessions: string[] = [];
    const probe = createSessionEndFileStoreProbePlugin({
      pluginId: 'session.end.probe',
      requestedAccess: {},
      onSessionEnd(context) {
        endedSessions.push(context.sessionId);
      },
    });
    const pluginHost = createRuntimePluginHost({
      plugins: [probe],
      enabledPluginIds: ['session.end.probe'],
    });

    await withOpenConversation({}, async (conversation, homeRoot) => {
      const conversationId = conversation.conversation.id;
      const deliveries = [];

      for (const line of ['one', 'two', 'three', 'four']) {
        deliveries.push(
          await deliverUserMessage({
            conversation,
            line,
            pluginHost,
            roleModelAdapter: replyAdapter(),
            contextWindowTokens,
          }),
        );
      }

      const rotated = deliveries.find(
        delivery =>
          delivery.status === 'completed' && delivery.rotation !== undefined,
      );

      expect(rotated).toMatchObject({
        status: 'completed',
        rotation: {
          status: 'rotated',
          from: `${conversationId}.1`,
          to: `${conversationId}.2`,
        },
      });
      expect(conversation.session.id).toBe(`${conversationId}.2`);
      expect(endedSessions).toEqual([`${conversationId}.1`]);

      const storeRoot = characterDataDirPath(homeRoot, testCharacterProfile.id);
      const sessionStore = createLocalRuntimeSessionStore({
        storeRoot,
        characterId: testCharacterProfile.id,
      });

      expect(
        (await sessionStore.listSessions()).map(metadata => metadata.sessionId),
      ).toEqual([`${conversationId}.1`, `${conversationId}.2`]);
      expect(
        conversation.logStore.rawEvents()[0]?.sessionContinuation,
      ).toMatchObject({sessionId: `${conversationId}.2`});

      // The closed segment's writer lease is free again.
      const lease = await acquireLocalRuntimeSessionWriterLease({
        storeRoot,
        sessionId: `${conversationId}.1`,
      });

      await lease.release();
    });
  });

  it('stays in the current segment when the next one cannot open', async () => {
    await withOpenConversation({}, async (conversation, homeRoot) => {
      const conversationId = conversation.conversation.id;
      const storeRoot = characterDataDirPath(homeRoot, testCharacterProfile.id);
      // Hold the next segment's writer lease from outside, so rotation fails
      // after planning.
      const blocker = await acquireLocalRuntimeSessionWriterLease({
        storeRoot,
        sessionId: `${conversationId}.2`,
      });
      const pluginHost = createRuntimePluginHost({plugins: []});

      try {
        let rotationFailure;

        for (const line of ['one', 'two', 'three', 'four']) {
          const delivery = await deliverUserMessage({
            conversation,
            line,
            pluginHost,
            roleModelAdapter: replyAdapter(),
            contextWindowTokens,
          });

          expect(delivery.status).toBe('completed');

          if (
            delivery.status === 'completed' &&
            delivery.rotation !== undefined
          ) {
            rotationFailure = delivery.rotation;
          }
        }

        expect(rotationFailure).toMatchObject({
          status: 'failed',
          from: `${conversationId}.1`,
        });
        expect(conversation.session.id).toBe(`${conversationId}.1`);

        const sessionStore = createLocalRuntimeSessionStore({
          storeRoot,
          characterId: testCharacterProfile.id,
        });

        // The unopened segment was discarded again; the chat keeps working.
        expect(
          (await sessionStore.listSessions()).map(
            metadata => metadata.sessionId,
          ),
        ).toEqual([`${conversationId}.1`]);

        const next = await deliverUserMessage({
          conversation,
          line: 'five',
          pluginHost,
          roleModelAdapter: replyAdapter(),
        });

        expect(next.status).toBe('completed');
      } finally {
        await blocker.release();
      }
    });
  });

  it('discards a continuation a crash left empty and resumes its predecessor', async () => {
    await withOpenConversation({}, async (conversation, homeRoot) => {
      const conversationId = conversation.conversation.id;
      const delivery = await deliverUserMessage({
        conversation,
        line: 'one',
        pluginHost: createRuntimePluginHost({plugins: []}),
        roleModelAdapter: replyAdapter(),
      });

      expect(delivery.status).toBe('completed');
      await conversation.close();

      const sessionStore = createLocalRuntimeSessionStore({
        storeRoot: characterDataDirPath(homeRoot, testCharacterProfile.id),
        characterId: testCharacterProfile.id,
      });

      // A crash between publishing the next segment and writing its opening
      // record leaves an empty `.2` in the catalog.
      await sessionStore.createContinuedSession({
        continuedFrom: `${conversationId}.1`,
      });

      const reopened = await openConversation({
        homeRoot,
        character: testCharacterProfile,
      });

      try {
        expect(reopened.session.id).toBe(`${conversationId}.1`);
        expect(
          reopened.session.visibleTranscript.map(message => message.text),
        ).toContain('noted');
        expect(
          (await sessionStore.listSessions()).map(
            metadata => metadata.sessionId,
          ),
        ).toEqual([`${conversationId}.1`]);
      } finally {
        await reopened.close();
      }
    });
  });

  it('lets every concurrent close observe the same finished cleanup', async () => {
    await withOpenConversation({}, async (conversation, homeRoot) => {
      let releaseReply = () => {};
      const gate = new Promise<void>(resolve => {
        releaseReply = resolve;
      });
      const delivery = deliverUserMessage({
        conversation,
        line: 'one',
        pluginHost: createRuntimePluginHost({plugins: []}),
        roleModelAdapter: {
          async invoke() {
            await gate;

            return {
              rawOutputText: JSON.stringify({
                toolCalls: [{name: 'visible_reply', input: {text: 'noted'}}],
              }),
            };
          },
        },
      });
      const firstClose = conversation.close();
      const secondClose = conversation.close();

      releaseReply();
      await secondClose;

      // The second closer returned, so both leases must already be free.
      const reopened = await openConversation({
        homeRoot,
        character: testCharacterProfile,
      });

      await reopened.close();
      await firstClose;
      expect((await delivery).status).toBe('completed');
    });
  });

  it('resumes the latest segment after closing, and refuses a second opener', async () => {
    await withOpenConversation({}, async (conversation, homeRoot) => {
      const conversationId = conversation.conversation.id;
      const pluginHost = createRuntimePluginHost({plugins: []});

      for (const line of ['one', 'two', 'three', 'four']) {
        await deliverUserMessage({
          conversation,
          line,
          pluginHost,
          roleModelAdapter: replyAdapter(),
          contextWindowTokens,
        });
      }

      expect(conversation.session.id).toBe(`${conversationId}.2`);
      await expect(
        openConversation({homeRoot, character: testCharacterProfile}),
      ).rejects.toMatchObject({code: 'conversation_busy'});
      await conversation.close();

      const reopened = await openConversation({
        homeRoot,
        character: testCharacterProfile,
      });

      try {
        expect(reopened.conversation.id).toBe(conversationId);
        expect(reopened.session.id).toBe(`${conversationId}.2`);
        expect(reopened.session.visibleTranscript.length).toBeGreaterThan(0);
      } finally {
        await reopened.close();
      }
    });
  });

  it('carries the summary into the new segment the model replays', async () => {
    const transcripts: RoleModelChatMessage[][] = [];

    await withOpenConversation({}, async conversation => {
      const pluginHost = createRuntimePluginHost({plugins: []});
      const adapter = replyAdapter({
        capture(messages) {
          transcripts.push([...messages]);
        },
        completeText() {
          return Promise.resolve({
            status: 'completed' as const,
            text: 'We talked through four things.',
            provider: {name: 'nvidia', model: 'test'},
          });
        },
      });

      for (const line of ['one', 'two', 'three', 'four', 'five']) {
        await deliverUserMessage({
          conversation,
          line,
          pluginHost,
          roleModelAdapter: adapter,
          contextWindowTokens,
        });
      }
    });

    const lastTranscript = transcripts.at(-1) ?? [];

    expect(
      lastTranscript.some(
        message =>
          message.role === 'user' &&
          message.content.includes('We talked through four things.'),
      ),
    ).toBe(true);
  });
});
