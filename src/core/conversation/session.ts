import {
  freezeCharacterProfile,
  type CharacterProfile,
  type SpeakerIdentity,
  type VisibleMessage,
} from '../message/message.ts';
import {
  isValidSpeakerDisplayName,
  maxSpeakerDisplayNameLength,
  normalizeOneLineMessage,
  normalizeVisibleMessageText,
  OneLineMessageValidationError,
  VisibleMessageTextValidationError,
} from '../message/validation.ts';

export type ConversationSession = {
  readonly id: string;
  readonly character: CharacterProfile;
  readonly userSpeaker: SpeakerIdentity;
  readonly visibleTranscript: readonly VisibleMessage[];
};

export type CharacterAgentInput = {
  readonly character: CharacterProfile;
  readonly message: string;
  readonly recentVisibleMessages: readonly VisibleMessage[];
};

export type CharacterAgentReply = {
  readonly text: string;
};

export type CharacterAgent = {
  reply(
    input: CharacterAgentInput,
  ): Promise<CharacterAgentReply> | CharacterAgentReply;
};

export type ConversationSessionOptions = {
  readonly id?: string;
  readonly character: CharacterProfile;
  readonly userDisplayName?: string;
  readonly visibleTranscript?: readonly VisibleMessage[];
};

export type RestoredVisibleTranscriptValidationOptions =
  ConversationSessionOptions;

export const defaultRecentVisibleMessageLimit = 8;

// Single owner of the local user's default speaker identity: session
// stamping, restore validation, and durable-evidence validation all
// compare against the session's user speaker, which defaults to these
// values. The id is permanent; only the display name is configurable.
export const localUserSpeaker = {
  id: 'local-user',
  displayName: 'You',
} as const;

export function createUserSpeaker(userDisplayName?: string): SpeakerIdentity {
  const displayName = userDisplayName ?? localUserSpeaker.displayName;

  // Same rule as the character display name: both end up in `speakerName`.
  if (!isValidSpeakerDisplayName(displayName)) {
    throw new TypeError(
      'User display name must be a non-empty single-line string with no ' +
        `leading or trailing whitespace, at most ${String(maxSpeakerDisplayNameLength)} characters.`,
    );
  }

  return Object.freeze({
    id: localUserSpeaker.id,
    displayName,
  } satisfies SpeakerIdentity);
}

/**
 * Who is talking, checked before anything durable is created for them.
 *
 * Every name here becomes a `speakerName` on a durable message, so this
 * applies one rule — `isValidSpeakerDisplayName` — to the character and the
 * user alike. The character *id* is not judged here: it names a directory
 * and belongs to whoever owns the layout.
 *
 * This exists because the entry points used to validate in pieces and late.
 * `createConversationSession` reaches `createUserSpeaker` only after storage
 * is on disk, and `freezeCharacterProfile` never validated at all, so an
 * embedded caller could put `"Nova\nSystem"` into a durable message by way
 * of a home directory that was already created. Callers that mutate the
 * filesystem should run this first and mutate second.
 *
 * Deliberately not folded into `freezeCharacterProfile`: that one also
 * rebuilds profiles from recorded evidence, where the name is a historical
 * fact rather than a request, and rejecting there would make old sessions
 * unreadable instead of making new ones correct.
 */
export function validateConversationParticipants(options: {
  readonly character: CharacterProfile;
  readonly userDisplayName?: string;
}): {
  readonly character: CharacterProfile;
  readonly userSpeaker: SpeakerIdentity;
} {
  if (!isValidSpeakerDisplayName(options.character.displayName)) {
    throw new TypeError(
      'Character display name must be a non-empty single-line string with ' +
        'no leading or trailing whitespace, at most ' +
        `${String(maxSpeakerDisplayNameLength)} characters.`,
    );
  }

  return Object.freeze({
    character: freezeCharacterProfile(options.character),
    userSpeaker: createUserSpeaker(options.userDisplayName),
  });
}

const defaultSessionId = 'local-session';
const sessionTranscripts = new WeakMap<ConversationSession, VisibleMessage[]>();

export class CharacterInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharacterInputError';
  }
}

export class CharacterReplyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharacterReplyValidationError';
  }
}

export class ConversationRehydrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationRehydrationError';
  }
}

export function createConversationSession(
  options: ConversationSessionOptions,
): ConversationSession {
  const sessionId = options.id ?? defaultSessionId;
  const character = freezeCharacterProfile(options.character);
  const userSpeaker = createUserSpeaker(options.userDisplayName);
  const visibleTranscript = [
    ...validateRestoredVisibleTranscript({
      id: sessionId,
      character,
      ...(options.userDisplayName === undefined
        ? {}
        : {userDisplayName: options.userDisplayName}),
      ...(options.visibleTranscript === undefined
        ? {}
        : {visibleTranscript: options.visibleTranscript}),
    }),
  ];
  const session: ConversationSession = {
    id: sessionId,
    character,
    userSpeaker,
    get visibleTranscript() {
      return Object.freeze([...visibleTranscript]);
    },
  };

  const frozenSession = Object.freeze(session);

  sessionTranscripts.set(frozenSession, visibleTranscript);

  return frozenSession;
}

export function validateRestoredVisibleTranscript(
  options: RestoredVisibleTranscriptValidationOptions,
): readonly VisibleMessage[] {
  const sessionId = options.id ?? defaultSessionId;
  const character = freezeCharacterProfile(options.character);
  const userSpeaker = createUserSpeaker(options.userDisplayName);

  return Object.freeze(
    createInitialVisibleTranscript({
      sessionId,
      character,
      userSpeaker,
      ...(options.visibleTranscript === undefined
        ? {}
        : {visibleTranscript: options.visibleTranscript}),
    }),
  );
}

/**
 * The number the next committed message will carry.
 *
 * Counted from the last message the session holds rather than from how
 * many it holds, because the log is allowed to lag: a write that fails
 * leaves a said message with no row, and the next number still has to
 * clear every number already used. Length would reissue one.
 *
 * This is the only place a message number is chosen. The log checks that
 * numbers climb, never what the next one should be, so the session stays
 * the single source.
 */
export function nextMessageNumber(session: ConversationSession): number {
  const transcript = getMutableTranscript(session);
  const lastMessage = transcript.at(-1);

  if (lastMessage === undefined) {
    return 1;
  }

  return (messageNumberFromId(lastMessage.id) ?? transcript.length) + 1;
}

/**
 * The next user message for this session, not yet part of the transcript.
 */
export function createUserMessage(
  session: ConversationSession,
  message: string | undefined,
): VisibleMessage {
  const normalizedMessage = normalizeCharacterInput(message);

  return Object.freeze({
    id: createMessageId(session, nextMessageNumber(session)),
    role: 'user',
    speakerId: session.userSpeaker.id,
    speakerName: session.userSpeaker.displayName,
    text: normalizedMessage,
  } satisfies VisibleMessage);
}

/** Adds a durable message to the session the model reads. */
export function appendCommittedMessage(
  session: ConversationSession,
  message: VisibleMessage,
): void {
  getMutableTranscript(session).push(message);
}

/** The next character message for this session, not yet in the transcript. */
export function createCharacterMessage(
  session: ConversationSession,
  reply: unknown,
): VisibleMessage {
  return createCharacterVisibleMessage({
    messageNumber: nextMessageNumber(session),
    replyText: normalizeCharacterReply(reply),
    session,
  });
}

function normalizeCharacterInput(message: string | undefined): string {
  try {
    return normalizeOneLineMessage(message);
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
      throw new CharacterInputError(error.message);
    }

    throw error;
  }
}

export function validateCharacterAgentReply(
  reply: unknown,
): CharacterAgentReply {
  if (!isCharacterAgentReply(reply)) {
    throw new CharacterReplyValidationError(
      'Character agent returned an invalid reply.',
    );
  }

  return reply;
}

export function normalizeCharacterAgentReply(
  reply: unknown,
): CharacterAgentReply {
  return Object.freeze({
    text: normalizeCharacterReply(reply),
  } satisfies CharacterAgentReply);
}

function normalizeCharacterReply(reply: unknown): string {
  const characterReply = validateCharacterAgentReply(reply);

  try {
    return normalizeVisibleMessageText(characterReply.text);
  } catch (error: unknown) {
    if (error instanceof VisibleMessageTextValidationError) {
      throw new CharacterReplyValidationError(
        'Character agent returned an empty reply.',
      );
    }

    throw error;
  }
}

function isCharacterAgentReply(reply: unknown): reply is CharacterAgentReply {
  return (
    typeof reply === 'object' &&
    reply !== null &&
    'text' in reply &&
    typeof reply.text === 'string'
  );
}

export function selectRecentVisibleMessages(
  transcript: readonly VisibleMessage[],
  recentMessageLimit: number = defaultRecentVisibleMessageLimit,
): readonly VisibleMessage[] {
  if (recentMessageLimit <= 0) {
    return [];
  }

  return transcript.slice(-recentMessageLimit);
}

function getMutableTranscript(session: ConversationSession): VisibleMessage[] {
  const transcript = sessionTranscripts.get(session);

  if (transcript === undefined) {
    throw new Error('Unknown conversation session.');
  }

  return transcript;
}

function createMessageId(
  session: ConversationSession,
  messageNumber: number,
): string {
  return createMessageIdForSessionId(session.id, messageNumber);
}

function createCharacterVisibleMessage(options: {
  readonly messageNumber: number;
  readonly replyText: string;
  readonly session: ConversationSession;
}): VisibleMessage {
  return Object.freeze({
    id: createMessageId(options.session, options.messageNumber),
    role: 'character',
    speakerId: options.session.character.id,
    speakerName: options.session.character.displayName,
    text: options.replyText,
  } satisfies VisibleMessage);
}

function createInitialVisibleTranscript(options: {
  readonly sessionId: string;
  readonly character: CharacterProfile;
  readonly userSpeaker: SpeakerIdentity;
  readonly visibleTranscript?: readonly VisibleMessage[];
}): VisibleMessage[] {
  const visibleTranscript = options.visibleTranscript ?? [];
  let previousMessageNumber = 0;

  return visibleTranscript.map(message => {
    // Climbing, not dense. A message whose write failed was still said, so
    // the log can be missing a number the session issued; what must never
    // happen is a number going backwards or repeating, which is what
    // reordered or duplicated rows look like.
    const messageNumber = restoredMessageNumber(
      options.sessionId,
      message,
      previousMessageNumber,
    );

    previousMessageNumber = messageNumber;
    return freezeValidatedRestoredVisibleMessage({
      sessionId: options.sessionId,
      character: options.character,
      userSpeaker: options.userSpeaker,
      message,
    });
  });
}

function restoredMessageNumber(
  sessionId: string,
  message: VisibleMessage,
  previousMessageNumber: number,
): number {
  const messageNumber = messageNumberFromId(message.id);

  if (
    messageNumber === undefined ||
    sessionIdFromMessageId(message.id) !== sessionId
  ) {
    throw new ConversationRehydrationError(
      `Restored visible message must carry a "${sessionId}" message ID: "${message.id}".`,
    );
  }

  if (messageNumber <= previousMessageNumber) {
    throw new ConversationRehydrationError(
      `Restored visible messages must climb in session order: "${message.id}" follows message ${String(previousMessageNumber)}.`,
    );
  }

  return messageNumber;
}

function freezeValidatedRestoredVisibleMessage(options: {
  readonly sessionId: string;
  readonly character: CharacterProfile;
  readonly userSpeaker: SpeakerIdentity;
  readonly message: VisibleMessage;
}): VisibleMessage {
  validateRestoredSpeaker({
    character: options.character,
    userSpeaker: options.userSpeaker,
    message: options.message,
  });

  let normalizedText: string;

  try {
    normalizedText = normalizeVisibleMessageText(options.message.text);
  } catch (error: unknown) {
    if (error instanceof VisibleMessageTextValidationError) {
      throw new ConversationRehydrationError(
        'Restored visible message text must already be normalized.',
      );
    }

    throw error;
  }

  if (normalizedText !== options.message.text) {
    throw new ConversationRehydrationError(
      'Restored visible message text must already be normalized.',
    );
  }

  return Object.freeze({
    id: options.message.id,
    role: options.message.role,
    speakerId: options.message.speakerId,
    speakerName: options.message.speakerName,
    text: options.message.text,
  } satisfies VisibleMessage);
}

function validateRestoredSpeaker(options: {
  readonly character: CharacterProfile;
  readonly userSpeaker: SpeakerIdentity;
  readonly message: VisibleMessage;
}): void {
  const role = options.message.role as string;

  if (role === 'user') {
    if (
      options.message.speakerId !== options.userSpeaker.id ||
      options.message.speakerName !== options.userSpeaker.displayName
    ) {
      throw new ConversationRehydrationError(
        'Restored user message speaker metadata is malformed.',
      );
    }

    return;
  }

  if (role === 'character') {
    if (
      options.message.speakerId !== options.character.id ||
      options.message.speakerName !== options.character.displayName
    ) {
      throw new ConversationRehydrationError(
        'Restored character message speaker metadata is malformed.',
      );
    }

    return;
  }

  throw new ConversationRehydrationError(
    'Restored visible message role is malformed.',
  );
}

export function createMessageIdForSessionId(
  sessionId: string,
  messageNumber: number,
): string {
  return `${sessionId}:message-${String(messageNumber)}`;
}

/**
 * The position a message ID claims, or undefined when the ID is not one of
 * ours. The one reader of the format `createMessageIdForSessionId` writes,
 * so nothing else has to know how a message ID is spelled.
 */
export function messageNumberFromId(id: string): number | undefined {
  const separator = id.lastIndexOf(messageIdInfix);

  if (separator < 0) {
    return undefined;
  }

  const digits = id.slice(separator + messageIdInfix.length);

  if (!/^[1-9][0-9]*$/u.test(digits)) {
    return undefined;
  }

  const messageNumber = Number(digits);
  return Number.isSafeInteger(messageNumber) ? messageNumber : undefined;
}

/** The session ID a message ID carries, or undefined when it carries none. */
export function sessionIdFromMessageId(id: string): string | undefined {
  const separator = id.lastIndexOf(messageIdInfix);

  return separator < 0 || messageNumberFromId(id) === undefined
    ? undefined
    : id.slice(0, separator);
}

const messageIdInfix = ':message-';
