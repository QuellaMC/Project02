/**
 * The runtime's one token estimate: four characters per token. Coarse on
 * purpose — every consumer budgets with the same currency, and a provider's
 * real count, when reported, is measured against it rather than replacing it.
 */
export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
