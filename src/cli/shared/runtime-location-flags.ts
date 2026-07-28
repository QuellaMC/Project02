/**
 * Single owner of the store flags every CLI accepts: which store to use
 * (`--store`, `--config`, `--character`) and whether the operator has
 * already agreed to create one (`--init`). They are parsed together
 * because they are answered together — `--init` says yes to creating a
 * store at exactly the location these other flags select.
 */
export type {RuntimeLocationCliState} from '../../runtime/config/index.ts';
import {isProject02Identifier} from '../../shared/identifier.ts';
import {readFlagValue} from './flags.ts';
import type {RuntimeLocationCliState} from '../../runtime/config/index.ts';

/**
 * Store selection plus the consent that governs creating it. Kept
 * separate from `RuntimeLocationCliState`, which the runtime owns and
 * which describes only where config lives: consent is a CLI concern and
 * has no meaning to the config resolver.
 */
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
      // A bare flag consumes no value, so the caller's loop must not
      // skip the next argument the way the value flags make it.
      nextIndex: options.index,
      state: {location, init: true},
    };
  }

  return {
    status: 'unmatched',
  };
}

/**
 * Rejects a `--character` value that is not shaped like a character id.
 *
 * The other flags on this surface already refuse a malformed value here
 * — `--store` through the home layout, `--session` through the session
 * id — and `--character` was the one that did not, so a value like
 * `../bad` reached package discovery and came back as "was not found".
 * That answer is wrong twice over: it describes a search that could
 * never have succeeded, and it arrives after a store has been selected
 * on its behalf. A name the runtime cannot spell is a usage error, and
 * usage errors belong to the parser.
 *
 * The shape is the identifier contract itself, not a copy of it, so a
 * `--character` value the CLI accepts is exactly one the character-data
 * directory and the `project02.character` config field would accept.
 */
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
