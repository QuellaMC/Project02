/**
 * Single owner of the store flags every CLI accepts. `--init` is read on
 * its own: it consents to creating a store, which inspect never does.
 */
export type {RuntimeLocationCliState} from '../../runtime/config/index.ts';
import {isProject02Identifier} from '../../shared/identifier.ts';
import {readFlagValue} from './flags.ts';
import {CliUsageError} from './usage-error.ts';
import type {RuntimeLocationCliState} from '../../runtime/config/index.ts';

type RuntimeStoreFlagParseResult =
  | {
      readonly status: 'matched';
      readonly nextIndex: number;
      readonly location: RuntimeLocationCliState;
    }
  | {
      readonly status: 'unmatched';
    };

export function parseRuntimeStoreFlag(options: {
  readonly args: readonly string[];
  readonly index: number;
  readonly location: RuntimeLocationCliState;
}): RuntimeStoreFlagParseResult {
  const arg = options.args[options.index];
  const {location} = options;

  if (arg === '--store') {
    if (location.storeRoot !== undefined) {
      throw new CliUsageError('--store can only be provided once.');
    }

    return matchedValueFlag(options, '--store', value => ({
      ...location,
      storeRoot: value,
    }));
  }

  if (arg === '--config') {
    if (location.configPath !== undefined) {
      throw new CliUsageError('--config can only be provided once.');
    }

    return matchedValueFlag(options, '--config', value => ({
      ...location,
      configPath: value,
    }));
  }

  if (arg === '--character') {
    if (location.character !== undefined) {
      throw new CliUsageError('--character can only be provided once.');
    }

    return matchedValueFlag(options, '--character', value => ({
      ...location,
      character: requireCharacterIdShape(value),
    }));
  }

  return {
    status: 'unmatched',
  };
}

/**
 * Matches `--init`, the consent to create the store the flags above
 * select, and rejects a repeat as the typo it is.
 */
export function matchesRuntimeStoreInitFlag(
  arg: string,
  init: boolean,
): boolean {
  if (arg !== '--init') {
    return false;
  }

  if (init) {
    throw new CliUsageError('--init can only be provided once.');
  }

  return true;
}

/** Package discovery would otherwise report a malformed id as "not found". */
function requireCharacterIdShape(value: string): string {
  if (!isProject02Identifier(value.trim())) {
    throw new CliUsageError(
      '--character must start with a letter and use only letters, numbers, dots, underscores, or hyphens.',
    );
  }

  return value;
}

function matchedValueFlag(
  options: {
    readonly args: readonly string[];
    readonly index: number;
  },
  flag: string,
  apply: (value: string) => RuntimeLocationCliState,
): RuntimeStoreFlagParseResult {
  return {
    status: 'matched',
    nextIndex: options.index + 1,
    location: apply(readFlagValue(options.args, options.index, flag)),
  };
}
