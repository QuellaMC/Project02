import {
  freezeCharacterProfile,
  type CharacterProfile,
  type VisibleMessage,
} from '../message/message.ts';
import {
  normalizeOneLineMessage,
  normalizeVisibleMessageText,
  OneLineMessageValidationError,
  VisibleMessageTextValidationError,
} from '../message/validation.ts';

export type ConversationSession = {
  readonly id: string;
  readonly character: CharacterProfile;
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

export type CharacterTurnResult = {
  readonly userMessage: VisibleMessage;
  readonly characterMessage: VisibleMessage;
  readonly reply: CharacterAgentReply;
};

export type ConversationSessionOptions = {
  readonly id?: string;
  readonly character: CharacterProfile;
  readonly visibleTranscript?: readonly VisibleMessage[];
};

export type RestoredVisibleTranscriptValidationOptions =
  ConversationSessionOptions & {
    readonly allowIncompleteFinalTurn?: boolean;
  };

export type CharacterTurnOptions = {
  readonly recentMessageLimit?: number;
};

export const defaultRecentVisibleMessageLimit = 8;

// Single owner of the local user's speaker identity: session stamping,
// restore validation, and durable-evidence validation all compare against
// these values. The id is permanent; the display name becomes configurable
// in a later slice.
export const localUserSpeaker = {
  id: 'local-user',
  displayName: 'You',
} as const;

const defaultSessionId = 'local-session';
const sessionTranscripts = new WeakMap<ConversationSession, VisibleMessage[]>();
const sessionTurnQueues = new WeakMap<ConversationSession, Promise<void>>();

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
  const visibleTranscript = [
    ...validateRestoredVisibleTranscript({
      id: sessionId,
      character,
      ...(options.visibleTranscript === undefined
        ? {}
        : {visibleTranscript: options.visibleTranscript}),
    }),
  ];
  const session: ConversationSession = {
    id: sessionId,
    character,
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

  return Object.freeze(
    createInitialVisibleTranscript({
      sessionId,
      character,
      ...(options.visibleTranscript === undefined
        ? {}
        : {visibleTranscript: options.visibleTranscript}),
      allowIncompleteFinalTurn: options.allowIncompleteFinalTurn ?? false,
    }),
  );
}

export async function runCharacterTurn(
  session: ConversationSession,
  message: string | undefined,
  agent: CharacterAgent,
  options: CharacterTurnOptions = {},
): Promise<CharacterTurnResult> {
  return await enqueueSessionTurn(session, async () => {
    return await runSerializedCharacterTurn(session, message, agent, options);
  });
}

export function rollbackLastCharacterTurn(
  session: ConversationSession,
  turn: CharacterTurnResult,
): void {
  const transcript = getMutableTranscript(session);
  const userMessageIndex = transcript.length - 2;

  if (
    userMessageIndex < 0 ||
    transcript[userMessageIndex] !== turn.userMessage ||
    transcript[userMessageIndex + 1] !== turn.characterMessage
  ) {
    throw new Error(
      'Cannot roll back a character turn that is no longer latest.',
    );
  }

  transcript.splice(userMessageIndex, 2);
}

async function runSerializedCharacterTurn(
  session: ConversationSession,
  message: string | undefined,
  agent: CharacterAgent,
  options: CharacterTurnOptions,
): Promise<CharacterTurnResult> {
  const normalizedMessage = normalizeCharacterInput(message);
  const transcript = getMutableTranscript(session);
  const recentVisibleMessages = selectRecentVisibleMessages(
    transcript,
    options.recentMessageLimit ?? defaultRecentVisibleMessageLimit,
  );
  const reply = await agent.reply({
    character: session.character,
    message: normalizedMessage,
    recentVisibleMessages,
  });
  const normalizedReplyText = normalizeCharacterReply(reply);
  const nextMessageNumber = transcript.length + 1;
  const userMessage = Object.freeze({
    id: createMessageId(session, nextMessageNumber),
    role: 'user',
    speakerId: localUserSpeaker.id,
    speakerName: localUserSpeaker.displayName,
    text: normalizedMessage,
  } satisfies VisibleMessage);
  const characterMessage = createCharacterVisibleMessage({
    messageNumber: nextMessageNumber + 1,
    replyText: normalizedReplyText,
    session,
  });

  transcript.push(userMessage, characterMessage);

  return {
    userMessage,
    characterMessage,
    reply: {
      text: normalizedReplyText,
    },
  };
}

async function enqueueSessionTurn<T>(
  session: ConversationSession,
  operation: () => Promise<T>,
): Promise<T> {
  const previousTurn = sessionTurnQueues.get(session) ?? Promise.resolve();
  const currentTurn = previousTurn.then(operation, operation);

  sessionTurnQueues.set(
    session,
    currentTurn.then(
      () => undefined,
      () => undefined,
    ),
  );

  return await currentTurn;
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
  readonly visibleTranscript?: readonly VisibleMessage[];
  readonly allowIncompleteFinalTurn: boolean;
}): VisibleMessage[] {
  const visibleTranscript = options.visibleTranscript ?? [];
  const restoredMessages: VisibleMessage[] = [];

  visibleTranscript.forEach((message, index) => {
    restoredMessages.push(
      freezeValidatedRestoredVisibleMessage({
        sessionId: options.sessionId,
        character: options.character,
        message,
        expectedMessageNumber: index + 1,
      }),
    );
  });

  if (!options.allowIncompleteFinalTurn && restoredMessages.length % 2 !== 0) {
    throw new ConversationRehydrationError(
      'Restored visible messages must end after a complete user/character turn.',
    );
  }

  return restoredMessages;
}

function freezeValidatedRestoredVisibleMessage(options: {
  readonly sessionId: string;
  readonly character: CharacterProfile;
  readonly message: VisibleMessage;
  readonly expectedMessageNumber: number;
}): VisibleMessage {
  const expectedId = createMessageIdForSessionId(
    options.sessionId,
    options.expectedMessageNumber,
  );

  if (options.message.id !== expectedId) {
    throw new ConversationRehydrationError(
      `Restored visible message must have sequential ID "${expectedId}".`,
    );
  }

  validateRestoredRoleOrder({
    expectedMessageNumber: options.expectedMessageNumber,
    message: options.message,
  });
  validateRestoredSpeaker({
    character: options.character,
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

function validateRestoredRoleOrder(options: {
  readonly expectedMessageNumber: number;
  readonly message: VisibleMessage;
}): void {
  const expectedRole =
    options.expectedMessageNumber % 2 === 1 ? 'user' : 'character';

  if (options.message.role !== expectedRole) {
    throw new ConversationRehydrationError(
      'Restored visible messages must preserve user/character commit order.',
    );
  }
}

function validateRestoredSpeaker(options: {
  readonly character: CharacterProfile;
  readonly message: VisibleMessage;
}): void {
  const role = options.message.role as string;

  if (role === 'user') {
    if (
      options.message.speakerId !== localUserSpeaker.id ||
      options.message.speakerName !== localUserSpeaker.displayName
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

function createMessageIdForSessionId(
  sessionId: string,
  messageNumber: number,
): string {
  return `${sessionId}:message-${String(messageNumber)}`;
}
