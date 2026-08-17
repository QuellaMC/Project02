import {
  freezeRoleModelPromptSize,
  type RoleModelPromptFrameSize,
  type RoleModelPromptSize,
} from '../api/prompt-size.ts';
import type {RoleModelTurnContext} from './render.ts';

/**
 * Measures the rendered prompt as the characters each frame puts on the
 * wire: a frame that travels as its own message costs its serialized
 * message, and a suffix frame is charged the bytes it adds to the user
 * message, separator and escaping included, so the frames sum to the wire.
 */
export function measureRoleModelPromptSize(
  turnContext: RoleModelTurnContext,
): RoleModelPromptSize {
  const byKind = new Map<string, {count: number; chars: number}>();
  let userMessage: {content: string; serializedLength: number} | undefined;

  for (const frame of turnContext.frames) {
    let chars: number;

    if (frame.placement === 'own_message') {
      chars = JSON.stringify(frame.message).length;
      userMessage =
        frame.message.role === 'user' &&
        typeof frame.message.content === 'string'
          ? {content: frame.message.content, serializedLength: chars}
          : undefined;
    } else {
      if (userMessage === undefined) {
        throw new TypeError(
          `Prompt frame ${frame.kind} must follow the current user message.`,
        );
      }

      const content = `${userMessage.content}\n\n${frame.content}`;
      const serializedLength = JSON.stringify({role: 'user', content}).length;

      chars = serializedLength - userMessage.serializedLength;
      userMessage = {content, serializedLength};
    }

    const entry = byKind.get(frame.kind) ?? {count: 0, chars: 0};

    entry.count += 1;
    entry.chars += chars;
    byKind.set(frame.kind, entry);
  }

  const frames: RoleModelPromptFrameSize[] = [...byKind.entries()].map(
    ([kind, entry]) => ({kind, count: entry.count, chars: entry.chars}),
  );

  return freezeRoleModelPromptSize({
    frames,
    toolChars:
      turnContext.tools.length === 0
        ? 0
        : JSON.stringify(turnContext.tools).length,
  });
}
