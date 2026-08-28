import {assertCanonicalRuntimeTimestamp} from '../message/event.ts';
import {
  isValidSpeakerDisplayName,
  maxSpeakerDisplayNameLength,
} from '../message/validation.ts';

export const conversationParticipantKindValues = ['user', 'character'] as const;
export type ConversationParticipantKind =
  (typeof conversationParticipantKindValues)[number];

export type ConversationParticipant = {
  readonly kind: ConversationParticipantKind;
  readonly id: string;
  readonly displayName: string;
};

/**
 * One thread between a set of contacts. A direct message is the
 * two-participant case; groups and character-to-character threads are the
 * same shape with another set. Which sets a runtime can drive is the
 * driver's rule, never this model's.
 */
export type Conversation = {
  readonly id: string;
  readonly participants: readonly ConversationParticipant[];
  readonly createdAt: string;
};

export class ConversationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationValidationError';
  }
}

export function createConversation(options: Conversation): Conversation {
  if (
    typeof options.id !== 'string' ||
    options.id.length === 0 ||
    options.id !== options.id.trim()
  ) {
    throw new ConversationValidationError(
      'Conversation ID must be a non-empty string with no surrounding whitespace.',
    );
  }

  if (options.participants.length < 2) {
    throw new ConversationValidationError(
      'A conversation needs at least two participants.',
    );
  }

  const participants = [...options.participants]
    .map(validateConversationParticipant)
    .sort(compareConversationParticipants);

  for (let index = 1; index < participants.length; index += 1) {
    if (
      compareConversationParticipants(
        participants[index - 1] as ConversationParticipant,
        participants[index] as ConversationParticipant,
      ) === 0
    ) {
      throw new ConversationValidationError(
        'Conversation participants must be unique by kind and ID.',
      );
    }
  }

  return Object.freeze({
    id: options.id,
    participants: Object.freeze(participants),
    createdAt: assertCanonicalRuntimeTimestamp(options.createdAt, 'createdAt'),
  } satisfies Conversation);
}

/** Same set of contacts, by kind and ID; display names are per-thread facts. */
export function sameConversationParticipants(
  a: readonly ConversationParticipant[],
  b: readonly ConversationParticipant[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const sortedA = [...a].sort(compareConversationParticipants);
  const sortedB = [...b].sort(compareConversationParticipants);

  return sortedA.every((participant, index) => {
    const other = sortedB[index];

    return (
      other !== undefined &&
      participant.kind === other.kind &&
      participant.id === other.id
    );
  });
}

function validateConversationParticipant(
  participant: ConversationParticipant,
): ConversationParticipant {
  if (!conversationParticipantKindValues.includes(participant.kind)) {
    throw new ConversationValidationError(
      'Conversation participant kind must be "user" or "character".',
    );
  }

  if (
    typeof participant.id !== 'string' ||
    participant.id.length === 0 ||
    participant.id !== participant.id.trim()
  ) {
    throw new ConversationValidationError(
      'Conversation participant ID must be a non-empty string with no surrounding whitespace.',
    );
  }

  if (!isValidSpeakerDisplayName(participant.displayName)) {
    throw new ConversationValidationError(
      'Conversation participant display name must be a non-empty ' +
        'single-line string with no leading or trailing whitespace, at ' +
        `most ${String(maxSpeakerDisplayNameLength)} characters.`,
    );
  }

  return Object.freeze({
    kind: participant.kind,
    id: participant.id,
    displayName: participant.displayName,
  } satisfies ConversationParticipant);
}

function compareConversationParticipants(
  a: ConversationParticipant,
  b: ConversationParticipant,
): number {
  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
