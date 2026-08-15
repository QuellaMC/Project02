import {estimateTextTokens} from '../../shared/token-estimate.ts';
import {
  freezeRoleModelPromptSize,
  type RoleModelPromptFrameSize,
  type RoleModelPromptSize,
  type RoleModelPromptSizeMeasure,
} from '../api/prompt-size.ts';
import type {RoleModelTurnContext} from './render.ts';

/**
 * Measures the rendered prompt in the currency the history window is
 * budgeted in: a frame that travels as its own message costs its serialized
 * message; a suffix frame costs the text it adds to the user message.
 */
export function measureRoleModelPromptSize(
  turnContext: RoleModelTurnContext,
): RoleModelPromptSize {
  const byKind = new Map<
    string,
    {count: number; chars: number; tokens: number}
  >();

  for (const frame of turnContext.frames) {
    const text =
      frame.placement === 'own_message'
        ? JSON.stringify(frame.message)
        : frame.content;
    const entry = byKind.get(frame.kind) ?? {count: 0, chars: 0, tokens: 0};

    entry.count += 1;
    entry.chars += text.length;
    entry.tokens += estimateTextTokens(text);
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
  const tools = measureText(
    turnContext.tools.length === 0 ? '' : JSON.stringify(turnContext.tools),
  );

  return freezeRoleModelPromptSize({
    frames,
    tools,
    total: {
      chars: frames.reduce((sum, frame) => sum + frame.chars, tools.chars),
      estimatedTokens: frames.reduce(
        (sum, frame) => sum + frame.estimatedTokens,
        tools.estimatedTokens,
      ),
    },
  });
}

function measureText(text: string): RoleModelPromptSizeMeasure {
  return {
    chars: text.length,
    estimatedTokens: text.length === 0 ? 0 : estimateTextTokens(text),
  };
}
