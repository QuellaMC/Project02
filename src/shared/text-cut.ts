/**
 * Where a cut at `index`, in UTF-16 units, may land: one unit earlier when
 * `index` falls between the two halves of a surrogate pair, so neither side
 * of the cut holds half a character.
 */
export function codePointBoundary(text: string, index: number): number {
  return (text.codePointAt(index - 1) ?? 0) > 0xffff ? index - 1 : index;
}

/** The text within `maxLength` units, the ellipsis marking a cut. */
export function truncateText(
  text: string,
  maxLength: number,
  ellipsis: string,
): string {
  return text.length <= maxLength
    ? text
    : `${text.slice(0, codePointBoundary(text, maxLength - ellipsis.length))}${ellipsis}`;
}
