export type ScrubReasoningBlocksResult =
  | {
      readonly status: 'accepted';
      readonly text: string;
    }
  | {
      readonly status: 'rejected';
    };

const reasoningBlockPattern =
  /<\s*(think|reasoning)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu;
const reasoningTagPattern = /<\s*\/?\s*(think|reasoning)\b[^>]*>/iu;

export function scrubReasoningBlocks(
  text: string
): ScrubReasoningBlocksResult {
  const scrubbed = text.replaceAll(reasoningBlockPattern, '');

  if (reasoningTagPattern.test(scrubbed)) {
    return Object.freeze({ status: 'rejected' });
  }

  return Object.freeze({
    status: 'accepted',
    text: scrubbed
  });
}
