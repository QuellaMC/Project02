import {
  appendCommittedMessage,
  createCharacterMessage,
  createUserMessage,
  type ConversationSession,
  type VisibleMessage,
} from '../../src/core/index.ts';

export function appendUserMessage(
  session: ConversationSession,
  text: string | undefined,
): VisibleMessage {
  const message = createUserMessage(session, text);

  appendCommittedMessage(session, message);
  return message;
}

export function appendCharacterMessage(
  session: ConversationSession,
  reply: unknown,
): VisibleMessage {
  const message = createCharacterMessage(session, reply);

  appendCommittedMessage(session, message);
  return message;
}
