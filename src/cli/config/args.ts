/**
 * Argument and command parsing for the runtime config CLI: separates
 * location flags from command words and parses the command vocabulary
 * into the typed RuntimeConfigCliArgs command union. Pure parsing; no
 * IO and no runtime access beyond reading the supplied env.
 */
import {
  parseRuntimeLocationFlag,
  type RuntimeLocationCliState,
} from '../shared/runtime-location-flags.ts';
import type {
  RuntimeConfigControlOperation,
  RuntimeConfigValue,
} from '../../runtime/config/index.ts';

export class RuntimeConfigCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigCliUsageError';
  }
}

export type RuntimeConfigCliArgs = {
  readonly location: RuntimeLocationCliState;
  readonly command:
    | {readonly kind: 'path'}
    | {readonly kind: 'env_path'}
    | {readonly kind: 'check'}
    | {readonly kind: 'get'; readonly path: string}
    | {
        readonly kind: 'mutate';
        readonly operation: RuntimeConfigControlOperation;
      }
    | {
        readonly kind: 'secret_set';
        readonly operation: {
          readonly kind: 'secret_set';
          readonly pluginId: string;
          readonly fieldName: string;
          readonly envVar: string;
          readonly secretValue: string;
        };
      };
};

export type RuntimeConfigCliParsedArgs = {
  readonly location: RuntimeLocationCliState;
  readonly commandArgs: readonly string[];
};

export function parseRuntimeConfigCliArgs(
  args: readonly string[],
): RuntimeConfigCliParsedArgs {
  let location: RuntimeLocationCliState = {};
  const commandArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === '--') {
      commandArgs.push(...runtimeConfigCommandArgsFrom(args, index + 1));
      break;
    }

    const locationResult = parseRuntimeLocationFlag({
      args,
      index,
      state: location,
    });

    if (locationResult.status === 'matched') {
      location = locationResult.state;
      index = locationResult.nextIndex;
      continue;
    }

    commandArgs.push(...runtimeConfigCommandArgsFrom(args, index));
    break;
  }

  return {
    location,
    commandArgs,
  };
}

function runtimeConfigCommandArgsFrom(
  args: readonly string[],
  startIndex: number,
): string[] {
  const commandArgs: string[] = [];
  let delimiterConsumed = false;

  for (let index = startIndex; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (!delimiterConsumed && arg === '--') {
      delimiterConsumed = true;
      continue;
    }

    commandArgs.push(arg);
  }

  return commandArgs;
}

export function runtimeConfigCwdDotEnvModeForCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  suppliedEnv: NodeJS.ProcessEnv,
): 'always' | 'auto' {
  const envVar = secretSetEnvVarNameFromArgs(parsedArgs.commandArgs);

  if (
    parsedArgs.commandArgs[0] === 'secret' &&
    parsedArgs.commandArgs[1] === 'set' &&
    (envVar === undefined || !envHasNonEmptyValue(suppliedEnv, envVar))
  ) {
    return 'always';
  }

  return 'auto';
}

function secretSetEnvVarNameFromArgs(
  args: readonly string[],
): string | undefined {
  const value = args[4];

  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value;
}

function envHasNonEmptyValue(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name]?.length ?? 0) > 0;
}

export function parseRuntimeConfigCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): RuntimeConfigCliArgs['command'] {
  const command = args[0];

  if (command === 'path') {
    assertNoExtraArgs(args, 0, 'path');
    return {kind: 'path'};
  }

  if (command === 'env-path') {
    assertNoExtraArgs(args, 0, 'env-path');
    return {kind: 'env_path'};
  }

  if (command === 'check') {
    assertNoExtraArgs(args, 0, 'check');
    return {kind: 'check'};
  }

  if (command === 'get') {
    const path = requiredArg(args, 1, 'get requires a path.');
    assertNoExtraArgs(args, 1, 'get');
    return {kind: 'get', path};
  }

  if (command === 'set') {
    const path = requiredArg(args, 1, 'set requires a path.');
    const value = requiredArg(args, 2, 'set requires a value.');
    assertNoExtraArgs(args, 2, 'set');

    return {
      kind: 'mutate',
      operation: {
        kind: 'set',
        path,
        value: parseConfigValue(value),
      },
    };
  }

  if (command === 'unset') {
    const path = requiredArg(args, 1, 'unset requires a path.');
    assertNoExtraArgs(args, 1, 'unset');

    return {
      kind: 'mutate',
      operation: {
        kind: 'unset',
        path,
      },
    };
  }

  if (command === 'plugin') {
    const action = requiredArg(args, 1, 'plugin requires enable or disable.');
    const pluginId = requiredArg(
      args,
      2,
      'plugin command requires a plugin id.',
    );

    if (action === 'enable') {
      assertNoExtraArgs(args, 2, 'plugin enable');
      return {
        kind: 'mutate',
        operation: {kind: 'plugin_enable', pluginId},
      };
    }

    if (action === 'disable') {
      assertNoExtraArgs(args, 2, 'plugin disable');
      return {
        kind: 'mutate',
        operation: {kind: 'plugin_disable', pluginId},
      };
    }
  }

  if (command === 'default-memory-provider') {
    assertNoExtraArgs(args, 1, 'default-memory-provider');
    return {
      kind: 'mutate',
      operation: {
        kind: 'default_memory_provider',
        ...(args[1] === undefined || args[1] === '--unset'
          ? {}
          : {pluginId: args[1]}),
      },
    };
  }

  if (command === 'secret' && args[1] === 'set') {
    const envVar = requiredArg(args, 4, 'secret set requires an env var.');
    const secretValue = env[envVar];

    assertNoExtraArgs(
      args,
      4,
      'secret set',
      'secret set reads the secret from the named env var; do not pass the secret value as an argument.',
    );

    if (secretValue === undefined || secretValue.length === 0) {
      throw new RuntimeConfigCliUsageError(
        `Secret env var ${envVar} must be set before running secret set.`,
      );
    }

    return {
      kind: 'secret_set',
      operation: {
        kind: 'secret_set',
        pluginId: requiredArg(args, 2, 'secret set requires a plugin id.'),
        fieldName: requiredArg(args, 3, 'secret set requires a field name.'),
        envVar,
        secretValue,
      },
    };
  }

  throw new RuntimeConfigCliUsageError(
    'Use ui, path, env-path, check, get, set, unset, plugin enable, plugin disable, default-memory-provider, or secret set.',
  );
}

export function assertNoExtraArgs(
  args: readonly string[],
  lastAcceptedIndex: number,
  commandName: string,
  message = `${commandName} does not accept extra arguments.`,
): void {
  if (args[lastAcceptedIndex + 1] !== undefined) {
    throw new RuntimeConfigCliUsageError(message);
  }
}

function parseConfigValue(value: string): RuntimeConfigValue {
  try {
    return JSON.parse(value) as RuntimeConfigValue;
  } catch {
    return value;
  }
}

function requiredArg(
  args: readonly string[],
  index: number,
  message: string,
): string {
  const value = args[index];

  if (value === undefined || value.trim().length === 0) {
    throw new RuntimeConfigCliUsageError(message);
  }

  return value;
}
