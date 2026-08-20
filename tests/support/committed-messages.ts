import {
  appendCommittedMessage,
  createCharacterMessage,
  createUserMessage,
  type Session,
  type VisibleMessage,
} from '../../src/core/index.ts';

export function appendUserMessage(
  session: Session,
  text: string | undefined,
): VisibleMessage {
  const message = createUserMessage(session, text);

  appendCommittedMessage(session, message);
  return message;
}

export function appendCharacterMessage(
  session: Session,
  reply: unknown,
): VisibleMessage {
  const message = createCharacterMessage(session, reply);

  appendCommittedMessage(session, message);
  return message;
}
