export type RuntimeLocationCliState = {
  readonly storeRoot?: string;
  readonly configPath?: string;
};

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
      throw new RuntimeLocationCliUsageError('--store can only be provided once.');
    }

    return {
      status: 'matched',
      nextIndex: options.index + 1,
      state: {
        ...options.state,
        storeRoot: readFlagValue(options.args, options.index, '--store')
      }
    };
  }

  if (arg === '--config') {
    if (options.state.configPath !== undefined) {
      throw new RuntimeLocationCliUsageError('--config can only be provided once.');
    }

    return {
      status: 'matched',
      nextIndex: options.index + 1,
      state: {
        ...options.state,
        configPath: readFlagValue(options.args, options.index, '--config')
      }
    };
  }

  return {
    status: 'unmatched'
  };
}

export function readRuntimeLocationFlagValue(
  args: readonly string[],
  index: number,
  flag: string
): string {
  return readFlagValue(args, index, flag);
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new RuntimeLocationCliUsageError(`${flag} requires a value.`);
  }

  return value;
}
