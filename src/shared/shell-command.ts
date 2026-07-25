/**
 * Shell quoting for command lines we print for a user to copy and run.
 *
 * A recovery hint that a user cannot paste is worse than no hint: an unquoted
 * home like `/tmp/My Home` makes `--store` consume only `/tmp/My`, and shell
 * metacharacters in the path would be interpreted rather than passed through.
 */

/**
 * Wraps a value in single quotes, escaping any single quotes it contains.
 *
 * Single quotes suppress every other shell metacharacter, so the only case
 * needing care is a quote in the value itself: close the literal, emit an
 * escaped quote, and reopen.
 */
export function shellQuoteCommandArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
