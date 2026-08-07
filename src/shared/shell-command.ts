/**
 * Shell quoting for command lines we print for a user to copy and run. A
 * single-quoted literal admits no escape, so a contained quote has to close
 * and reopen it.
 */
export function shellQuoteCommandArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
