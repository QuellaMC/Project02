import {CliUsageError} from './usage-error.ts';

/** Single owner of `--flag value` argv reading for all CLIs. */
export function readFlagValue(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new CliUsageError(`${flag} requires a value.`);
  }

  return value;
}
