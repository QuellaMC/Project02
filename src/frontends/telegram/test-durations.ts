/**
 * How a test harness shortens a program's waits, so expiry and pings run
 * in seconds: `key=milliseconds` pairs separated by commas, read once at
 * start. A hidden switch, never a setting, so a key the program does not
 * read is refused rather than left to do nothing.
 */
const testDurationsVariable = 'PROJECT02_TEST_DURATIONS';

/**
 * The durations the variable sets among the keys this program reads, none
 * when it is absent; or the refusal to start, naming the key: one this
 * program does not read, one given twice, or one whose value is not a
 * whole number of milliseconds above 0.
 */
export function readTestDurations<const K extends string>(
  env: NodeJS.ProcessEnv,
  keys: readonly K[],
): {readonly durations: ReadonlyMap<K, number>} | {readonly refusal: string} {
  const durations = new Map<K, number>();

  for (const pair of env[testDurationsVariable]?.split(',') ?? []) {
    const separator = pair.indexOf('=');
    const key = separator === -1 ? pair : pair.slice(0, separator);
    const value = separator === -1 ? '' : pair.slice(separator + 1);

    if (!isOneOf(key, keys)) {
      return refused(
        `unknown key "${key}"; the keys here are ${keys.join(', ')}.`,
      );
    }

    if (durations.has(key)) {
      return refused(`key "${key}" is given twice.`);
    }

    const milliseconds = Number(value);

    if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(milliseconds)) {
      return refused(
        `key "${key}" needs a whole number of milliseconds above 0, not "${value}".`,
      );
    }

    durations.set(key, milliseconds);
  }

  return {durations};
}

function isOneOf<const T extends string>(
  value: unknown,
  allowedValues: readonly T[],
): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

function refused(why: string): {readonly refusal: string} {
  return {refusal: `${testDurationsVariable}: ${why}`};
}
