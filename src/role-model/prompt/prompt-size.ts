import {
  estimateTextTokens,
  estimateTokensForChars,
} from '../../shared/token-estimate.ts';
import {
  freezeRoleModelPromptSize,
  type RoleModelPromptFrameSize,
  type RoleModelPromptSize,
  type RoleModelPromptSizeMeasure,
} from '../api/prompt-size.ts';
import type {RoleModelTurnContext} from './render.ts';

/**
 * Measures the rendered prompt in the currency the history window is
 * budgeted in: every frame costs what it adds to the serialized wire
 * messages, so the frames sum to the wire and a suffix frame is charged the
 * bytes it puts into the user message, separator and escaping included.
 */
export function measureRoleModelPromptSize(
  turnContext: RoleModelTurnContext,
): RoleModelPromptSize {
  const byKind = new Map<
    string,
    {count: number; chars: number; tokens: number}
  >();
  let userMessage: {content: string; serializedLength: number} | undefined;

  for (const frame of turnContext.frames) {
    let chars: number;
    let tokens: number;

    if (frame.placement === 'own_message') {
      const serialized = JSON.stringify(frame.message);

      chars = serialized.length;
      tokens = estimateTextTokens(serialized);
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
      tokens = estimateTokensForChars(chars);
      userMessage = {content, serializedLength};
    }

    const entry = byKind.get(frame.kind) ?? {count: 0, chars: 0, tokens: 0};

    entry.count += 1;
    entry.chars += chars;
    entry.tokens += tokens;
    byKind.set(frame.kind, entry);
  }

  const frames: RoleModelPromptFrameSize[] = [...byKind.entries()].map(
    ([kind, entry]) => ({
      kind,
      count: entry.count,
      chars: entry.chars,
      estimatedTokens: entry.tokens,
    }),
  );

  return freezeRoleModelPromptSize({
    frames,
    tools: measureText(
      turnContext.tools.length === 0 ? '' : JSON.stringify(turnContext.tools),
    ),
  });
}

function measureText(text: string): RoleModelPromptSizeMeasure {
  return {
    chars: text.length,
    estimatedTokens: text.length === 0 ? 0 : estimateTextTokens(text),
  };
}
