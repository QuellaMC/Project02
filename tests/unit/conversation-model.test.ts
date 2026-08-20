import {describe, expect, it} from 'vitest';

import {
  ConversationValidationError,
  createConversation,
  sameConversationParticipants,
  type ConversationParticipant,
} from '../../src/core/index.ts';

const user: ConversationParticipant = {
  kind: 'user',
  id: 'local-user',
  displayName: 'You',
};
const mira: ConversationParticipant = {
  kind: 'character',
  id: 'mira',
  displayName: 'Mira',
};
const kai: ConversationParticipant = {
  kind: 'character',
  id: 'kai',
  displayName: 'Kai',
};

describe('conversation model', () => {
  it('accepts a two-participant conversation, frozen and canonically ordered', () => {
    const conversation = createConversation({
      id: 'conv_a',
      participants: [user, mira],
      createdAt: '2026-08-20T00:00:00.000Z',
    });

    expect(Object.isFrozen(conversation)).toBe(true);
    expect(Object.isFrozen(conversation.participants)).toBe(true);
    expect(conversation.participants.map(entry => entry.id)).toEqual([
      'mira',
      'local-user',
    ]);

    const reordered = createConversation({
      id: 'conv_a',
      participants: [mira, user],
      createdAt: '2026-08-20T00:00:00.000Z',
    });

    expect(reordered.participants).toEqual(conversation.participants);
  });

  it('accepts sets beyond one user and one character', () => {
    const characters = createConversation({
      id: 'conv_b',
      participants: [kai, mira],
      createdAt: '2026-08-20T00:00:00.000Z',
    });

    expect(characters.participants.map(entry => entry.id)).toEqual([
      'kai',
      'mira',
    ]);

    const group = createConversation({
      id: 'conv_c',
      participants: [user, mira, kai],
      createdAt: '2026-08-20T00:00:00.000Z',
    });

    expect(group.participants).toHaveLength(3);
  });

  it('rejects malformed conversations', () => {
    const base = {id: 'conv_d', createdAt: '2026-08-20T00:00:00.000Z'};

    expect(() => createConversation({...base, participants: [user]})).toThrow(
      ConversationValidationError,
    );
    expect(() =>
      createConversation({...base, participants: [mira, {...mira}]}),
    ).toThrow('unique by kind and ID');
    expect(() =>
      createConversation({
        ...base,
        participants: [user, {...mira, displayName: ' Mira '}],
      }),
    ).toThrow('display name');
    expect(() =>
      createConversation({
        ...base,
        participants: [user, {...mira, id: ' mira'}],
      }),
    ).toThrow('participant ID');
    expect(() =>
      createConversation({
        id: ' conv_d',
        createdAt: base.createdAt,
        participants: [user, mira],
      }),
    ).toThrow('Conversation ID');
    expect(() =>
      createConversation({
        id: 'conv_d',
        createdAt: '2026-08-20T00:00:00+00:00',
        participants: [user, mira],
      }),
    ).toThrow(TypeError);
  });

  it('compares participant sets ignoring order and display names', () => {
    expect(
      sameConversationParticipants(
        [user, mira],
        [{...mira, displayName: 'Renamed'}, user],
      ),
    ).toBe(true);
    expect(sameConversationParticipants([user, mira], [user, kai])).toBe(false);
    expect(sameConversationParticipants([user, mira], [user, mira, kai])).toBe(
      false,
    );
    expect(
      sameConversationParticipants(
        [user, mira],
        [user, {...mira, kind: 'user'}],
      ),
    ).toBe(false);
  });
});
