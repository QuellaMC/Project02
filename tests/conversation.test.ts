import { describe, expect, it } from 'vitest';

import {
  CharacterInputError,
  CharacterReplyValidationError,
  createConversationSession,
  createDeterministicCharacterAgent,
  localCharacterProfile,
  runCharacterTurn,
  type CharacterAgent,
  type CharacterAgentReply,
  type VisibleMessage
} from '../src/index.ts';

describe('conversation core', () => {
  it('creates a local session for the built-in character with an empty visible transcript', () => {
    const session = createConversationSession();

    expect(session).toEqual({
      id: 'local-session',
      character: localCharacterProfile,
      visibleTranscript: []
    });
  });

  it('commits one normalized user message and one character reply for a successful turn', async () => {
    const session = createConversationSession();
    const agent: CharacterAgent = {
      reply(input) {
        return {
          text: `${input.character.displayName}: ${input.message}`
        };
      }
    };

    const result = await runCharacterTurn(session, '  are you there?  ', agent);

    expect(result).toEqual({
      userMessage: {
        id: 'local-session:message-1',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'are you there?'
      },
      characterMessage: {
        id: 'local-session:message-2',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'Mira: are you there?'
      },
      reply: {
        text: 'Mira: are you there?'
      }
    });
    expect(session.visibleTranscript).toEqual([
      result.userMessage,
      result.characterMessage
    ]);
  });

  it('passes recent visible transcript context to the character agent before committing the new turn', async () => {
    const session = createConversationSession();
    const observedContexts: VisibleMessage[][] = [];
    const agent: CharacterAgent = {
      reply(input) {
        observedContexts.push([...input.recentVisibleMessages]);
        return {
          text: `reply ${String(observedContexts.length)}`
        };
      }
    };

    await runCharacterTurn(session, 'first', agent);
    await runCharacterTurn(session, 'second', agent);

    expect(observedContexts).toEqual([
      [],
      [
        {
          id: 'local-session:message-1',
          role: 'user',
          speakerId: 'local-user',
          speakerName: 'You',
          text: 'first'
        },
        {
          id: 'local-session:message-2',
          role: 'character',
          speakerId: 'mira',
          speakerName: 'Mira',
          text: 'reply 1'
        }
      ]
    ]);
  });

  it('exposes the visible transcript as an immutable snapshot of core-committed messages', async () => {
    const session = createConversationSession();
    const agent = createDeterministicCharacterAgent();

    const firstTurn = await runCharacterTurn(session, 'first', agent);
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
          text: 'injected'
        } satisfies VisibleMessage
      ]);
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(firstVisibleMessage, 'text', {
        value: 'tampered'
      });
    }).toThrow(TypeError);

    await expect(runCharacterTurn(session, 'second', agent)).resolves.toMatchObject({
      reply: {
        text: 'I remember you said "first" Stay with me for a minute.'
      }
    });
    expect(session.visibleTranscript).toEqual([
      firstTurn.userMessage,
      firstTurn.characterMessage,
      {
        id: 'local-session:message-3',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'second'
      },
      {
        id: 'local-session:message-4',
        role: 'character',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'I remember you said "first" Stay with me for a minute.'
      }
    ]);
  });

  it('protects character identity from agent-side mutation before committing a turn', async () => {
    const session = createConversationSession();
    const agent: CharacterAgent = {
      reply(input) {
        expect(Object.isFrozen(input.character)).toBe(true);
        expect(() => {
          Object.defineProperty(input.character, 'displayName', {
            value: 'Mutated'
          });
        }).toThrow(TypeError);
        return {
          text: `${input.character.displayName}: protected`
        };
      }
    };

    const result = await runCharacterTurn(session, 'hello', agent);

    expect(Object.isFrozen(session.character)).toBe(true);
    expect(result.characterMessage).toMatchObject({
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: 'Mira: protected'
    });
    expect(session.visibleTranscript[1]).toMatchObject({
      speakerId: 'mira',
      speakerName: 'Mira'
    });
  });

  it('does not call the agent or change the transcript when user input is invalid', async () => {
    const session = createConversationSession();
    const calls: Array<unknown> = [];
    const agent: CharacterAgent = {
      reply(input) {
        calls.push(input);
        return {
          text: 'unused'
        };
      }
    };

    await expect(runCharacterTurn(session, 'hello\nthere', agent)).rejects.toThrow(
      CharacterInputError
    );
    expect(calls).toEqual([]);
    expect(session.visibleTranscript).toEqual([]);
  });

  it('leaves the transcript unchanged when the character agent returns an invalid reply', async () => {
    const session = createConversationSession();
    const agent: CharacterAgent = {
      reply() {
        return {
          text: 'line one\nline two'
        };
      }
    };

    await expect(runCharacterTurn(session, 'hello', agent)).rejects.toThrow(
      CharacterReplyValidationError
    );
    expect(session.visibleTranscript).toEqual([]);
  });

  it('leaves the transcript unchanged when the character agent returns a malformed reply', async () => {
    const session = createConversationSession();
    // Bypass the static agent contract to exercise runtime boundary validation.
    const malformedReply = {} as CharacterAgentReply;
    const agent: CharacterAgent = {
      reply() {
        return malformedReply;
      }
    };

    await expect(runCharacterTurn(session, 'hello', agent)).rejects.toThrow(
      CharacterReplyValidationError
    );
    await expect(runCharacterTurn(session, 'hello', agent)).rejects.toThrow(
      'Character agent returned an invalid reply.'
    );
    expect(session.visibleTranscript).toEqual([]);
  });

  it('leaves the transcript unchanged when the character agent fails', async () => {
    const session = createConversationSession();
    const agent: CharacterAgent = {
      reply() {
        throw new Error('agent unavailable');
      }
    };

    await expect(runCharacterTurn(session, 'hello', agent)).rejects.toThrow(
      'agent unavailable'
    );
    expect(session.visibleTranscript).toEqual([]);
  });

  it('provides a deterministic local character agent that can use recent context', async () => {
    const session = createConversationSession();
    const agent = createDeterministicCharacterAgent();

    await expect(runCharacterTurn(session, 'are you there?', agent)).resolves.toMatchObject({
      reply: {
        text: "I'm here. Tell me what you need."
      }
    });
    await expect(runCharacterTurn(session, 'I am tired', agent)).resolves.toMatchObject({
      reply: {
        text: 'I remember you said "are you there?" Stay with me for a minute.'
      }
    });
  });
});
