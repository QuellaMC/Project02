export type {RuntimeLocationCliState} from '../../runtime/config/index.ts';
import {readFlagValue} from './flags.ts';
import type {RuntimeLocationCliState} from '../../runtime/config/index.ts';

export type RuntimeLocationFlagParseResult =
  | {
      readonly status: 'matched';
      readonly nextIndex: number;
      readonly state: RuntimeLocationCliState;
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

export function parseRuntimeLocationFlag(options: {
  readonly args: readonly string[];
  readonly index: number;
  readonly state: RuntimeLocationCliState;
}): RuntimeLocationFlagParseResult {
  const arg = options.args[options.index];

  if (arg === '--store') {
    if (options.state.storeRoot !== undefined) {
      throw new RuntimeLocationCliUsageError(
        '--store can only be provided once.',
      );
    }

    return {
      status: 'matched',
      nextIndex: options.index + 1,
      state: {
        ...options.state,
        storeRoot: readFlagValue(
          options.args,
          options.index,
          '--store',
          message => new RuntimeLocationCliUsageError(message),
        ),
      },
    };
  }

  if (arg === '--config') {
    if (options.state.configPath !== undefined) {
      throw new RuntimeLocationCliUsageError(
        '--config can only be provided once.',
      );
    }

    return {
      status: 'matched',
      nextIndex: options.index + 1,
      state: {
        ...options.state,
        configPath: readFlagValue(
          options.args,
          options.index,
          '--config',
          message => new RuntimeLocationCliUsageError(message),
        ),
      },
    };
  }

  if (arg === '--character') {
    if (options.state.character !== undefined) {
      throw new RuntimeLocationCliUsageError(
        '--character can only be provided once.',
      );
    }

    return {
      status: 'matched',
      nextIndex: options.index + 1,
      state: {
        ...options.state,
        character: readFlagValue(
          options.args,
          options.index,
          '--character',
          message => new RuntimeLocationCliUsageError(message),
        ),
      },
    };
  }

  return {
    status: 'unmatched',
  };
}
