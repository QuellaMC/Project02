/**
 * The runtime's one token estimate: four characters per token. Coarse on
 * purpose — the history window and the prompt measure share the currency,
 * and a provider's real count, when reported, is held against it rather
 * than replacing it.
 */
export function estimateTextTokens(text: string): number {
  return estimateTokensForChars(text.length);
}

export function estimateTokensForChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}
