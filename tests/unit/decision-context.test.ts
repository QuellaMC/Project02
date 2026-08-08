import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {buildUserTurnDecisionContext} from '../../src/role-model/api/decision-context.ts';
import {
  createConversationSession,
  defaultRecentVisibleMessageLimit,
  type VisibleMessage,
} from '../../src/core/index.ts';

type MutableVisibleMessage = {
  id: string;
  role: VisibleMessage['role'];
  speakerId: string;
  speakerName: string;
  text: string;
};

describe('user-turn decision context builder', () => {
  it('builds an immutable fresh-session context with local identity and runtime notes', () => {
    const session = createConversationSession({
      character: testCharacterProfile,
      id: 'session-fresh',
    });
    const runtimeNotes = ['local USER_MESSAGE turn', 'recent visible only'];

    const context = buildUserTurnDecisionContext({
      session,
      runtimeNotes,
    });

    runtimeNotes.push('mutated after build');

    expect(context).toEqual({
      sessionId: 'session-fresh',
      characterSnapshot: testCharacterProfile,
      recentVisibleMessages: [],
      runtimeNotes: ['local USER_MESSAGE turn', 'recent visible only'],
      pluginContextItems: [],
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.characterSnapshot)).toBe(true);
    expect(Object.isFrozen(context.recentVisibleMessages)).toBe(true);
    expect(Object.isFrozen(context.runtimeNotes)).toBe(true);
    expect(Object.isFrozen(context.pluginContextItems)).toBe(true);
    expect(() => {
      Reflect.apply(Array.prototype.push, context.runtimeNotes, ['tampered']);
    }).toThrow(TypeError);
  });

  it('selects the default recent visible window from the session transcript', () => {
    const session = createConversationSession({
      character: testCharacterProfile,
      id: 'session-resumed',
      visibleTranscript: createVisibleTranscriptSeed('session-resumed', 5),
    });
    const context = buildUserTurnDecisionContext({
      session,
    });

    expect(context.recentVisibleMessages).toEqual(
      createVisibleTranscriptSeed('session-resumed', 5).slice(
        -defaultRecentVisibleMessageLimit,
      ),
    );
    expect(context.recentVisibleMessages.map(message => message.id)).toEqual([
      'session-resumed:message-3',
      'session-resumed:message-4',
      'session-resumed:message-5',
      'session-resumed:message-6',
      'session-resumed:message-7',
      'session-resumed:message-8',
      'session-resumed:message-9',
      'session-resumed:message-10',
    ]);
  });

  it('does not accept or duplicate the current user message in the context output', () => {
    const session = createConversationSession({
      character: testCharacterProfile,
      id: 'session-current-message',
    });
    const optionsWithCurrentMessage = {
      session,
      runtimeNotes: ['top-level event envelope owns the current message'],
      currentUserMessage: 'do not put me in DecisionContext',
    };

    const context = buildUserTurnDecisionContext(optionsWithCurrentMessage);

    expect('currentUserMessage' in context).toBe(false);
    expect('currentUserMessage' in context.characterSnapshot).toBe(false);
    expect(context.recentVisibleMessages).toEqual([]);
    expect(JSON.stringify(context)).not.toContain(
      optionsWithCurrentMessage.currentUserMessage,
    );
  });

  it('returns nested snapshots that resist caller mutation', () => {
    const seedMessages = createVisibleTranscriptSeed('session-snapshots', 1);
    const runtimeNotes = ['immutable note'];
    const session = createConversationSession({
      character: testCharacterProfile,
      id: 'session-snapshots',
      visibleTranscript: seedMessages,
    });

    const context = buildUserTurnDecisionContext({
      session,
      runtimeNotes,
    });
    const firstRecentMessage = context.recentVisibleMessages[0];
    const firstSeedMessage = seedMessages[0];

    runtimeNotes[0] = 'mutated note';

    expect(firstRecentMessage).toBeDefined();
    expect(firstSeedMessage).toBeDefined();

    if (firstRecentMessage === undefined) {
      throw new Error('Expected a recent visible message.');
    }

    if (firstSeedMessage === undefined) {
      throw new Error('Expected a seed visible message.');
    }

    firstSeedMessage.text = 'mutated seed';

    expect(context.recentVisibleMessages).toEqual([
      {
        id: 'session-snapshots:message-1',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'user 1',
      },
      {
        id: 'session-snapshots:message-2',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'reply 1',
      },
    ]);
    expect(context.runtimeNotes).toEqual(['immutable note']);
    expect(Object.isFrozen(firstRecentMessage)).toBe(true);
    expect(() => {
      Object.defineProperty(firstRecentMessage, 'text', {
        value: 'tampered',
      });
    }).toThrow(TypeError);
    expect(() => {
      Reflect.apply(Array.prototype.push, context.recentVisibleMessages, [
        {
          id: 'session-snapshots:message-99',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'tampered',
        } satisfies VisibleMessage,
      ]);
    }).toThrow(TypeError);
  });
});

function createVisibleTranscriptSeed(
  sessionId: string,
  turnCount: number,
): MutableVisibleMessage[] {
  const messages: MutableVisibleMessage[] = [];

  for (let turnNumber = 1; turnNumber <= turnCount; turnNumber += 1) {
    const firstMessageNumber = turnNumber * 2 - 1;

    messages.push(
      {
        id: `${sessionId}:message-${String(firstMessageNumber)}`,
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: `user ${String(turnNumber)}`,
      },
      {
        id: `${sessionId}:message-${String(firstMessageNumber + 1)}`,
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: `reply ${String(turnNumber)}`,
      },
    );
  }

  return messages;
}
