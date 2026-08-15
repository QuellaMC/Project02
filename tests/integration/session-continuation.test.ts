import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {createUserMessageRuntimeEvent} from '../../src/core/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/index.ts';
import type {
  RoleModelAdapter,
  RoleModelChatMessage,
  RoleModelTextCompletionRequest,
} from '../../src/role-model/index.ts';
import {runLocalUserMessageEvent} from '../../src/runtime/index.ts';
import {
  createContinuedDurableChatRuntime,
  createDurableChatRuntime,
  createLocalRuntimeSessionStore,
  characterDataDirPath,
} from '../../src/runtime/storage/index.ts';
import {planSessionContinuation} from '../../src/runtime/turn/index.ts';
import {
  continueChatSessionIfNeeded,
  durableSessionContinuation,
} from '../../src/cli/chat/session-continuation.ts';
import {createSessionEndFileStoreProbePlugin} from '../support/plugin-host-fixtures.ts';
import {collect} from '../support/streams.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

const contextWindowTokens = 100;

function replyAdapter(options: {
  readonly capture?: (messages: readonly RoleModelChatMessage[]) => void;
  readonly completeText?: RoleModelAdapter['completeText'];
}): RoleModelAdapter {
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

async function talk(
  runtime: Awaited<ReturnType<typeof createDurableChatRuntime>>,
  adapter: RoleModelAdapter,
  messages: readonly string[],
): Promise<void> {
  for (const message of messages) {
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(message),
      session: runtime.session,
      logStore: runtime.logStore,
      pluginHost: createRuntimePluginHost({plugins: []}),
      roleModelAdapter: adapter,
      contextWindowTokens,
    });

    expect(result.status).toBe('completed');
  }
}

describe('session continuation', () => {
  it('opens a continued session with the summary and carried tail, resumes it by default, and names the segment', async () => {
    const homeRoot = createTestTempRoot('project02-session-continuation-');
    const first = await createDurableChatRuntime({
      homeRoot,
      character: testCharacterProfile,
      userDisplayName: 'Mike',
      newSessionId: 'first',
    });
    let summariserRequest: RoleModelTextCompletionRequest | undefined;
    const adapter = replyAdapter({
      completeText(request) {
        summariserRequest = request;

        return Promise.resolve({
          status: 'completed',
          text: 'Mike asked me four things; I answered each with a nod.',
          provider: {name: 'nvidia', model: 'test'},
        });
      },
    });

    try {
      await talk(first, adapter, ['one', 'two', 'three', 'four']);

      const plan = await planSessionContinuation({
        sessionId: first.session.id,
        logStore: first.logStore,
        roleModelAdapter: adapter,
        contextWindowTokens,
        characterName: testCharacterProfile.displayName,
        userDisplayName: 'Mike',
      });

      expect(plan).toMatchObject({
        continuedFrom: {sessionId: 'first'},
        summary: 'Mike asked me four things; I answered each with a nod.',
        summarizedTurnCount: 3,
        summarizer: {
          status: 'model',
          provider: {name: 'nvidia', model: 'test'},
        },
      });
      expect(plan?.carriedTurns.map(turn => turn.userMessage.text)).toEqual([
        'four',
      ]);
      expect(summariserRequest?.input).toContain('Mike: one');
      expect(summariserRequest?.instructions).toContain('Mira');
      if (plan === undefined) {
        throw new Error('Expected a continuation plan.');
      }

      const second = await createContinuedDurableChatRuntime({
        homeRoot,
        character: testCharacterProfile,
        userDisplayName: 'Mike',
        plan,
      });
      let wire: readonly RoleModelChatMessage[] = [];

      try {
        expect(second.session.id).toBe('first.2');
        expect(second.logStore.rawEvents()[0]).toMatchObject({
          kind: 'session_continued',
          sessionContinuation: {
            sessionId: 'first.2',
            continuedFrom: {sessionId: 'first'},
            summarizedTurnCount: 3,
          },
        });

        await talk(
          second,
          replyAdapter({
            capture(messages) {
              wire = messages;
            },
          }),
          ['five'],
        );
      } finally {
        await second.writerLease.release();
      }

      // The new session's first prompt: the recollection as a fenced user
      // message, the carried turn replayed verbatim, then the new message.
      const conversation = wire.filter(
        message => message.role === 'user' || message.role === 'assistant',
      );
      expect(conversation[0]?.role).toBe('user');
      expect(conversation[0]?.content).toContain('Mike asked me four things');
      expect(conversation.slice(1).map(message => message.content)).toEqual([
        'four',
        'noted',
        'five',
      ]);
      expect(
        wire.some(
          message =>
            message.role === 'system' &&
            message.content.includes('Mike asked me four things'),
        ),
      ).toBe(false);
    } finally {
      await first.writerLease.release();
    }

    // No session named: the newest segment resumes; naming the closed one
    // opens it and says where it went on.
    const resumed = await createDurableChatRuntime({
      homeRoot,
      character: testCharacterProfile,
    });
    try {
      expect(resumed.session.id).toBe('first.2');
      expect(resumed.continuedBy).toBeUndefined();
    } finally {
      await resumed.writerLease.release();
    }
    const reopened = await createDurableChatRuntime({
      homeRoot,
      character: testCharacterProfile,
      sessionId: 'first',
    });
    try {
      expect(reopened.session.id).toBe('first');
      expect(reopened.continuedBy).toBe('first.2');
    } finally {
      await reopened.writerLease.release();
    }
    expect(
      (
        await createLocalRuntimeSessionStore({
          storeRoot: characterDataDirPath(homeRoot, testCharacterProfile.id),
          characterId: testCharacterProfile.id,
        }).listSessions()
      ).map(metadata => [metadata.sessionId, metadata.continuedFrom]),
    ).toEqual([
      ['first', undefined],
      ['first.2', 'first'],
    ]);
  });

  it('plans nothing while the history fits, and falls back to a mechanical summary without a summariser', async () => {
    const homeRoot = createTestTempRoot(
      'project02-session-continuation-fallback-',
    );
    const runtime = await createDurableChatRuntime({
      homeRoot,
      character: testCharacterProfile,
      newSessionId: 'first',
    });
    const adapter = replyAdapter({});

    try {
      await talk(runtime, adapter, ['one']);
      expect(
        await planSessionContinuation({
          sessionId: 'first',
          logStore: runtime.logStore,
          roleModelAdapter: adapter,
          contextWindowTokens,
          characterName: testCharacterProfile.displayName,
        }),
      ).toBeUndefined();

      await talk(runtime, adapter, ['two', 'three', 'four']);
      const plan = await planSessionContinuation({
        sessionId: 'first',
        logStore: runtime.logStore,
        roleModelAdapter: adapter,
        contextWindowTokens,
        characterName: testCharacterProfile.displayName,
      });

      expect(plan?.summarizer).toEqual({
        status: 'fallback',
        reason: 'The selected provider has no summariser model.',
      });
      expect(plan?.summary).toContain('Earlier conversation (3 turns');
      expect(plan?.summary).toContain('“one” · “two” · “three”');
    } finally {
      await runtime.writerLease.release();
    }
  });

  it('keeps the new session newest even though closing the old one writes last', async () => {
    const homeRoot = createTestTempRoot(
      'project02-session-continuation-recency-',
    );
    const runtime = await createDurableChatRuntime({
      homeRoot,
      character: testCharacterProfile,
      newSessionId: 'first',
    });
    const adapter = replyAdapter({});
    const endedSessions: string[] = [];
    const probe = createSessionEndFileStoreProbePlugin({
      pluginId: 'memory.session-end.fixture',
      requestedAccess: {},
      onSessionEnd(context) {
        endedSessions.push(context.sessionId);
      },
    });
    let next;

    try {
      await talk(runtime, adapter, ['one', 'two', 'three', 'four']);
      next = await continueChatSessionIfNeeded({
        current: {
          session: runtime.session,
          logStore: runtime.logStore,
          release: () => runtime.writerLease.release(),
        },
        pluginHost: createRuntimePluginHost({
          plugins: [probe],
          enabledPluginIds: [probe.manifest.id],
        }),
        continueSession: durableSessionContinuation({
          homeRoot,
          character: testCharacterProfile,
          userDisplayName: undefined,
        }),
        roleModelAdapter: adapter,
        contextWindowTokens,
        stdout: collect(() => {}),
      });
    } finally {
      if (next === undefined) {
        await runtime.writerLease.release();
      }
    }

    try {
      expect(next?.session.id).toBe('first.2');
      // The old session's end evidence is the last log write anywhere, yet a
      // flagless launch must resume the new session, not the closed one.
      expect(endedSessions).toEqual(['first']);
      expect(
        (
          await createLocalRuntimeSessionStore({
            storeRoot: characterDataDirPath(homeRoot, testCharacterProfile.id),
            characterId: testCharacterProfile.id,
          }).newestSession()
        )?.sessionId,
      ).toBe('first.2');
    } finally {
      await next?.release();
    }
  });

  it('stays in the current session when the next one cannot be opened, and leaves no empty session behind', async () => {
    const homeRoot = createTestTempRoot(
      'project02-session-continuation-failure-',
    );
    const runtime = await createDurableChatRuntime({
      homeRoot,
      character: testCharacterProfile,
      newSessionId: 'first',
    });
    const adapter = replyAdapter({});
    let stdout = '';

    try {
      await talk(runtime, adapter, ['one', 'two', 'three', 'four']);
      const recordsBefore = runtime.logStore.rawEvents().length;

      // The chat loop's guard: an open that throws is reported, the current
      // session is neither ended nor swapped, and the plan is made again later.
      const next = await continueChatSessionIfNeeded({
        current: {
          session: runtime.session,
          logStore: runtime.logStore,
          release: () => Promise.resolve(),
        },
        pluginHost: createRuntimePluginHost({plugins: []}),
        continueSession: () => Promise.reject(new Error('disk full')),
        roleModelAdapter: adapter,
        contextWindowTokens,
        stdout: collect(chunk => {
          stdout += chunk;
        }),
      });

      expect(next).toBeUndefined();
      expect(stdout).toBe(
        '[context] Could not continue in a new session, staying in first: disk full\n',
      );
      expect(runtime.logStore.rawEvents()).toHaveLength(recordsBefore);

      // The bootstrap's own rollback: a continued session whose opening
      // record cannot be written is discarded rather than left as the newest.
      const plan = await planSessionContinuation({
        sessionId: 'first',
        logStore: runtime.logStore,
        roleModelAdapter: adapter,
        contextWindowTokens,
        characterName: testCharacterProfile.displayName,
      });
      if (plan === undefined) {
        throw new Error('Expected a continuation plan.');
      }

      await expect(
        createContinuedDurableChatRuntime({
          homeRoot,
          character: testCharacterProfile,
          plan: {...plan, summary: ''},
        }),
      ).rejects.toThrow();
      expect(
        (
          await createLocalRuntimeSessionStore({
            storeRoot: characterDataDirPath(homeRoot, testCharacterProfile.id),
            characterId: testCharacterProfile.id,
          }).listSessions()
        ).map(metadata => metadata.sessionId),
      ).toEqual(['first']);
    } finally {
      await runtime.writerLease.release();
    }
  });
});
