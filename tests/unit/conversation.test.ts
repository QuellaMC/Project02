import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {
  appendCommittedMessage,
  type ConversationSession,
  createCharacterMessage,
  createUserMessage,
  CharacterInputError,
  CharacterReplyValidationError,
  createConversationSession,
  createUserSpeaker,
  maxSpeakerDisplayNameLength,
  ConversationRehydrationError,
  type VisibleMessage,
} from '../../src/core/index.ts';

describe('conversation core', () => {
  it('creates a local session for the provided character with an empty visible transcript', () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });

    expect(session).toEqual({
      id: 'local-session',
      character: testCharacterProfile,
      userSpeaker: {id: 'local-user', displayName: 'You'},
      visibleTranscript: [],
    });
    expect(session.character).not.toBe(testCharacterProfile);
  });

  it('appends normalized messages one at a time with sequential role-independent IDs', () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });

    const userMessage = appendUserMessage(session, '  are you there?  ');
    const characterMessage = appendCharacterMessage(session, {
      text: 'Mira: are you there?',
    });

    expect(userMessage).toEqual({
      id: 'local-session:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'are you there?',
    });
    expect(characterMessage).toEqual({
      id: 'local-session:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: 'Mira: are you there?',
    });
    expect(session.visibleTranscript).toEqual([userMessage, characterMessage]);
  });

  it('commits several character messages for one user message in emission order', () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });

    appendUserMessage(session, 'do the thing');
    appendCharacterMessage(session, {text: 'Looking into it.'});
    appendCharacterMessage(session, {text: 'Still working.'});
    appendCharacterMessage(session, {text: 'Done.'});

    expect(session.visibleTranscript.map(message => message.text)).toEqual([
      'do the thing',
      'Looking into it.',
      'Still working.',
      'Done.',
    ]);
    expect(session.visibleTranscript.map(message => message.id)).toEqual([
      'local-session:message-1',
      'local-session:message-2',
      'local-session:message-3',
      'local-session:message-4',
    ]);
  });

  it('allows multi-line character replies while keeping user input single-line', () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });

    appendUserMessage(session, 'list tools');
    appendCharacterMessage(session, {
      text: 'Tools available:\n- runtime.plugin.list\n- character_state.patch',
    });

    expect(session.visibleTranscript.map(message => message.text)).toEqual([
      'list tools',
      'Tools available:\n- runtime.plugin.list\n- character_state.patch',
    ]);
    expect(() => appendUserMessage(session, 'hello\nthere')).toThrow(
      CharacterInputError,
    );
  });

  it('exposes the visible transcript as an immutable snapshot of committed messages', () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });

    appendUserMessage(session, 'first');
    const visibleTranscript = session.visibleTranscript;
    const firstVisibleMessage = visibleTranscript[0];

    expect(Object.isFrozen(visibleTranscript)).toBe(true);
    expect(firstVisibleMessage).toBeDefined();

    if (firstVisibleMessage === undefined) {
      throw new Error('Expected first visible message.');
    }

    expect(Object.isFrozen(firstVisibleMessage)).toBe(true);
    expect(() => {
      Reflect.apply(Array.prototype.push, visibleTranscript, [
        {
          id: 'local-session:message-99',
          role: 'user',
          speakerId: 'external-user',
          speakerName: 'External',
          text: 'injected',
        } satisfies VisibleMessage,
      ]);
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(firstVisibleMessage, 'text', {
        value: 'tampered',
      });
    }).toThrow(TypeError);
  });

  it('rejects invalid user input and invalid character replies without changing the transcript', () => {
    const session = createConversationSession({
      character: testCharacterProfile,
    });

    expect(() => appendUserMessage(session, '')).toThrow(CharacterInputError);
    expect(() => appendCharacterMessage(session, {text: '   '})).toThrow(
      CharacterReplyValidationError,
    );
    expect(() => appendCharacterMessage(session, {})).toThrow(
      'Character agent returned an invalid reply.',
    );
    expect(session.visibleTranscript).toEqual([]);
  });

  it('rehydrates a validated visible transcript and allocates later message IDs after restored records', () => {
    const session = createConversationSession({
      character: testCharacterProfile,
      visibleTranscript: [
        {
          id: 'local-session:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'first',
        },
        {
          id: 'local-session:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: "I'm here. Tell me what you need.",
        },
      ],
    });

    const next = appendUserMessage(session, 'second');

    expect(next.id).toBe('local-session:message-3');
    expect(session.visibleTranscript.map(message => message.id)).toEqual([
      'local-session:message-1',
      'local-session:message-2',
      'local-session:message-3',
    ]);
  });

  it('restores transcripts of any role shape, including consecutive same-role and trailing messages', () => {
    // Commit-as-emitted histories are not pairs: a turn may hold several
    // character messages, a rejected turn leaves a lone user message, and a
    // crash can end the log after either role.
    const session = createConversationSession({
      character: testCharacterProfile,
      visibleTranscript: [
        {
          id: 'local-session:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'do the thing',
        },
        {
          id: 'local-session:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'Looking into it.',
        },
        {
          id: 'local-session:message-3',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'Done.',
        },
        {
          id: 'local-session:message-4',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'thanks',
        },
      ],
    });

    expect(session.visibleTranscript).toHaveLength(4);
  });

  it('rejects restored visible messages from a different session before creating a transcript', () => {
    expect(() =>
      createConversationSession({
        character: testCharacterProfile,
        id: 'selected-session',
        visibleTranscript: [
          {
            id: 'other-session:message-1',
            role: 'user',
            speakerId: 'local-user',
            speakerName: 'You',
            text: 'first',
          },
        ],
      }),
    ).toThrow(ConversationRehydrationError);
  });

  it('rejects restored visible messages that would make the next message ID ambiguous', () => {
    expect(() =>
      createConversationSession({
        character: testCharacterProfile,
        visibleTranscript: [
          {
            id: 'local-session:message-1',
            role: 'user',
            speakerId: 'local-user',
            speakerName: 'You',
            text: 'first',
          },
          {
            id: 'local-session:message-1',
            role: 'character',
            speakerId: 'mira',
            speakerName: 'Mira',
            text: 'duplicate',
          },
        ],
      }),
    ).toThrow(ConversationRehydrationError);
  });

  it('rejects restored messages whose speaker metadata does not match the declared role', () => {
    expect(() =>
      createConversationSession({
        character: testCharacterProfile,
        visibleTranscript: [
          {
            id: 'local-session:message-1',
            role: 'user',
            speakerId: 'mira',
            speakerName: 'Mira',
            text: 'wrong speaker for role',
          },
        ],
      }),
    ).toThrow(ConversationRehydrationError);
  });

  it('bounds the user display name before it becomes session state', () => {
    expect(() =>
      createUserSpeaker('a'.repeat(maxSpeakerDisplayNameLength)),
    ).not.toThrow();

    // The name is stamped onto every user message, so an oversized value would
    // be repeated per turn in durable logs, rehydration, and the prompt.
    expect(() =>
      createUserSpeaker('a'.repeat(maxSpeakerDisplayNameLength + 1)),
    ).toThrow(/at most 128 characters/);

    // Chat interpolates the name before a colon, so a newline would
    // let it forge additional output lines.
    expect(() => createUserSpeaker('Mira\nError: failed')).toThrow(
      /single-line/,
    );
  });
});

function appendUserMessage(
  session: ConversationSession,
  text: string | undefined,
): VisibleMessage {
  const message = createUserMessage(session, text);

  appendCommittedMessage(session, message);
  return message;
}

function appendCharacterMessage(
  session: ConversationSession,
  reply: unknown,
): VisibleMessage {
  const message = createCharacterMessage(session, reply);

  appendCommittedMessage(session, message);
  return message;
}
