import {
  normalizeOneLineMessage,
  OneLineMessageValidationError
} from './message-validation.ts';

export type CharacterProfile = {
  readonly id: string;
  readonly displayName: string;
};

export type VisibleMessageRole = 'user' | 'character';

export type VisibleMessage = {
  readonly id: string;
  readonly role: VisibleMessageRole;
  readonly speakerId: string;
  readonly speakerName: string;
  readonly text: string;
};

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
  reply(input: CharacterAgentInput): Promise<CharacterAgentReply> | CharacterAgentReply;
};

export type CharacterTurnResult = {
  readonly userMessage: VisibleMessage;
  readonly characterMessage: VisibleMessage;
  readonly reply: CharacterAgentReply;
};

export type ConversationSessionOptions = {
  readonly id?: string;
  readonly character?: CharacterProfile;
};

export type CharacterTurnOptions = {
  readonly recentMessageLimit?: number;
};

export const localCharacterProfile: CharacterProfile = freezeCharacterProfile({
  id: 'mira',
  displayName: 'Mira'
});

const localUserSpeaker = {
  id: 'local-user',
  displayName: 'You'
} as const;

const defaultSessionId = 'local-session';
const defaultRecentMessageLimit = 8;
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

export function createConversationSession(
  options: ConversationSessionOptions = {}
): ConversationSession {
  const visibleTranscript: VisibleMessage[] = [];
  const session: ConversationSession = {
    id: options.id ?? defaultSessionId,
    character: freezeCharacterProfile(options.character ?? localCharacterProfile),
    get visibleTranscript() {
      return Object.freeze([...visibleTranscript]);
    }
  };

  const frozenSession = Object.freeze(session);

  sessionTranscripts.set(frozenSession, visibleTranscript);

  return frozenSession;
}

export async function runCharacterTurn(
  session: ConversationSession,
  message: string | undefined,
  agent: CharacterAgent = createDeterministicCharacterAgent(),
  options: CharacterTurnOptions = {}
): Promise<CharacterTurnResult> {
  return await enqueueSessionTurn(session, async () => {
    return await runSerializedCharacterTurn(session, message, agent, options);
  });
}

async function runSerializedCharacterTurn(
  session: ConversationSession,
  message: string | undefined,
  agent: CharacterAgent,
  options: CharacterTurnOptions
): Promise<CharacterTurnResult> {
  const normalizedMessage = normalizeCharacterInput(message);
  const transcript = getMutableTranscript(session);
  const recentVisibleMessages = selectRecentVisibleMessages(
    transcript,
    options.recentMessageLimit ?? defaultRecentMessageLimit
  );
  const reply = await agent.reply({
    character: session.character,
    message: normalizedMessage,
    recentVisibleMessages
  });
  const normalizedReplyText = normalizeCharacterReply(reply);
  const nextMessageNumber = transcript.length + 1;
  const userMessage = Object.freeze({
    id: createMessageId(session, nextMessageNumber),
    role: 'user',
    speakerId: localUserSpeaker.id,
    speakerName: localUserSpeaker.displayName,
    text: normalizedMessage
  } satisfies VisibleMessage);
  const characterMessage = Object.freeze({
    id: createMessageId(session, nextMessageNumber + 1),
    role: 'character',
    speakerId: session.character.id,
    speakerName: session.character.displayName,
    text: normalizedReplyText
  } satisfies VisibleMessage);

  transcript.push(userMessage, characterMessage);

  return {
    userMessage,
    characterMessage,
    reply: {
      text: normalizedReplyText
    }
  };
}

async function enqueueSessionTurn<T>(
  session: ConversationSession,
  operation: () => Promise<T>
): Promise<T> {
  const previousTurn = sessionTurnQueues.get(session) ?? Promise.resolve();
  const currentTurn = previousTurn.then(operation, operation);

  sessionTurnQueues.set(
    session,
    currentTurn.then(
      () => undefined,
      () => undefined
    )
  );

  return await currentTurn;
}

export function createDeterministicCharacterAgent(): CharacterAgent {
  return {
    reply(input) {
      const previousUserMessage = findPreviousUserMessage(input.recentVisibleMessages);

      if (previousUserMessage === undefined) {
        return {
          text: "I'm here. Tell me what you need."
        };
      }

      return {
        text: `I remember you said "${previousUserMessage.text}" Stay with me for a minute.`
      };
    }
  };
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

function normalizeCharacterReply(reply: unknown): string {
  if (!isCharacterAgentReply(reply)) {
    throw new CharacterReplyValidationError('Character agent returned an invalid reply.');
  }

  try {
    return normalizeOneLineMessage(reply.text);
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
      throw new CharacterReplyValidationError(
        error.reason === 'empty'
          ? 'Character agent returned an empty reply.'
          : 'Character agent returned a multi-line reply.'
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

function freezeCharacterProfile(character: CharacterProfile): CharacterProfile {
  return Object.freeze({
    id: character.id,
    displayName: character.displayName
  } satisfies CharacterProfile);
}

function selectRecentVisibleMessages(
  transcript: readonly VisibleMessage[],
  recentMessageLimit: number
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

function createMessageId(session: ConversationSession, messageNumber: number): string {
  return `${session.id}:message-${String(messageNumber)}`;
}

function findPreviousUserMessage(
  visibleMessages: readonly VisibleMessage[]
): VisibleMessage | undefined {
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const visibleMessage = visibleMessages[index];

    if (visibleMessage?.role === 'user') {
      return visibleMessage;
    }
  }

  return undefined;
}
