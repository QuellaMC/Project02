/** Single owner of `--flag value` argv reading for all CLIs (S-13). */
export function readFlagValue(
  args: readonly string[],
  index: number,
  flag: string,
  createUsageError: (message: string) => Error,
): string {
  const value = args[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw createUsageError(`${flag} requires a value.`);
  }

  return value;
}
