import {
  appendCommittedMessage,
  createCharacterMessage,
  createUserMessage,
  type ConversationSession,
  type VisibleMessage,
} from '../../src/core/index.ts';

// Building a message and committing it are separate in the runtime, because
// only a durable message joins the session. A test that wants a transcript
// wants both, so the pair lives here rather than in each suite that needs it.

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
