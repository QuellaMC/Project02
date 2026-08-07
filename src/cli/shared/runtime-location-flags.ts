/**
 * Single owner of the store flags every CLI accepts: `--init` is parsed
 * with them because it consents to the location the others select.
 */
export type {RuntimeLocationCliState} from '../../runtime/config/index.ts';
import {isProject02Identifier} from '../../shared/identifier.ts';
import {readFlagValue} from './flags.ts';
import type {RuntimeLocationCliState} from '../../runtime/config/index.ts';

/** Consent is a CLI concern, kept out of the runtime's location type. */
export type RuntimeStoreCliState = {
  readonly location: RuntimeLocationCliState;
  readonly init: boolean;
};

export type RuntimeStoreFlagParseResult =
  | {
      readonly status: 'matched';
      readonly nextIndex: number;
      readonly state: RuntimeStoreCliState;
    }
  | {
      readonly status: 'unmatched';
    };

export class RuntimeLocationCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeLocationCliUsageError';
  }
}

export const emptyRuntimeStoreCliState: RuntimeStoreCliState = Object.freeze({
  location: Object.freeze({}),
  init: false,
});

export function parseRuntimeStoreFlag(options: {
  readonly args: readonly string[];
  readonly index: number;
  readonly state: RuntimeStoreCliState;
}): RuntimeStoreFlagParseResult {
  const arg = options.args[options.index];
  const {location} = options.state;

  if (arg === '--store') {
    if (location.storeRoot !== undefined) {
      throw new RuntimeLocationCliUsageError(
        '--store can only be provided once.',
      );
    }

    return matchedValueFlag(options, '--store', value => ({
      ...location,
      storeRoot: value,
    }));
  }

  if (arg === '--config') {
    if (location.configPath !== undefined) {
      throw new RuntimeLocationCliUsageError(
        '--config can only be provided once.',
      );
    }

    return matchedValueFlag(options, '--config', value => ({
      ...location,
      configPath: value,
    }));
  }

  if (arg === '--character') {
    if (location.character !== undefined) {
      throw new RuntimeLocationCliUsageError(
        '--character can only be provided once.',
      );
    }

    return matchedValueFlag(options, '--character', value => ({
      ...location,
      character: requireCharacterIdShape(value),
    }));
  }

  if (arg === '--init') {
    if (options.state.init) {
      throw new RuntimeLocationCliUsageError(
        '--init can only be provided once.',
      );
    }

    return {
      status: 'matched',
      // A bare flag consumes no value, so the caller's loop must not skip.
      nextIndex: options.index,
      state: {location, init: true},
    };
  }

  return {
    status: 'unmatched',
  };
}

/** Package discovery would otherwise report a malformed id as "not found". */
function requireCharacterIdShape(value: string): string {
  if (!isProject02Identifier(value.trim())) {
    throw new RuntimeLocationCliUsageError(
      '--character must start with a letter and use only letters, numbers, dots, underscores, or hyphens.',
    );
  }

  return value;
}

function matchedValueFlag(
  options: {
    readonly args: readonly string[];
    readonly index: number;
    readonly state: RuntimeStoreCliState;
  },
  flag: string,
  apply: (value: string) => RuntimeLocationCliState,
): RuntimeStoreFlagParseResult {
  return {
    status: 'matched',
    nextIndex: options.index + 1,
    state: {
      location: apply(
        readFlagValue(
          options.args,
          options.index,
          flag,
          message => new RuntimeLocationCliUsageError(message),
        ),
      ),
      init: options.state.init,
    },
  };
}
