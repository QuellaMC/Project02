import { pathToFileURL } from 'node:url';

import {
  applyRuntimeConfigControlOperation,
  createRuntimeConfigInspectShape,
  defaultRuntimeConfigPath,
  diagnosticsHaveErrors,
  getRedactedRuntimeConfigValueAtPath,
  loadProject02RuntimeConfig,
  resolveConfiguredProject02PluginActivation,
  RuntimeConfigMutationError,
  storeRootForLoadedDefaultConfigPath,
  type LoadedProject02RuntimeConfig,
  type RuntimePluginFactory,
  type RuntimeConfigMutationOperation,
  type RuntimeConfigValue
} from '../runtime/config/index.ts';
import {
  formatLocalRuntimeTerminalError,
  isLocalRuntimeTerminalError
} from '../runtime/terminal-errors.ts';
import {
  hasExplicitRuntimeLocation,
  parseRuntimeLocationFlag,
  RuntimeLocationCliUsageError,
  type RuntimeLocationCliState
} from './runtime-location.ts';
import {
  defaultDotEnvForRuntimeLocation,
  loadRuntimeConfigEnvFile,
  readDefaultDotEnvFile,
  resolveRuntimeConfigActivationBeforeEnvFile,
  runtimeConfigEnvPathForLocation,
  RuntimeEnvFileError,
  shouldReadDefaultDotEnvForRuntimeLocation
} from './runtime-env.ts';

type RuntimeConfigCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactory>>;
};

class RuntimeConfigCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigCliUsageError';
  }
}

export function runRuntimeConfigCliFromArgs(
  args: readonly string[],
  options: RuntimeConfigCliOptions
): Promise<number> {
  return Promise.resolve().then(() => runRuntimeConfigCliFromArgsSync(args, options));
}

function runRuntimeConfigCliFromArgsSync(
  args: readonly string[],
  options: RuntimeConfigCliOptions
): number {
  try {
    const parsedArgs = parseRuntimeConfigCliArgs(args);
    const cliEnv = runtimeConfigCliEnvForLocation({
      location: parsedArgs.location,
      readDefaultDotEnv: shouldReadDefaultDotEnvForCommand(
        parsedArgs,
        options.env ?? process.env
      ),
      ...(options.env === undefined ? {} : { env: options.env })
    });
    const parsed: RuntimeConfigCliArgs = {
      location: parsedArgs.location,
      command: parseRuntimeConfigCommand(parsedArgs.commandArgs, cliEnv.configEnv)
    };

    if (parsed.command.kind === 'path') {
      const loaded = loadProject02RuntimeConfig({
        ...parsed.location,
        env: cliEnv.configEnv
      });

      options.stdout.write(
        `${loaded.path ?? defaultRuntimeConfigPath(parsed.location.storeRoot)}\n`
      );
      return 0;
    }

    if (parsed.command.kind === 'env_path') {
      const loaded = loadProject02RuntimeConfig({
        ...parsed.location,
        env: cliEnv.configEnv
      });
      assertRuntimeConfigLoadedForEnvPath(loaded);
      options.stdout.write(
        `${runtimeConfigEnvPathForLocation({
          loadedConfig: loaded,
          ...(parsed.location.storeRoot === undefined
            ? {}
            : { storeRoot: parsed.location.storeRoot })
        })}\n`
      );
      return 0;
    }

    if (parsed.command.kind === 'check') {
      const loaded = loadProject02RuntimeConfig({
        ...parsed.location,
        env: cliEnv.configEnv
      });
      const configured =
        resolveRuntimeConfigActivationBeforeEnvFile({
          loadedConfig: loaded,
          ...(parsed.location.storeRoot === undefined
            ? {}
            : { storeRoot: parsed.location.storeRoot }),
          env: cliEnv.configEnv,
          diagnoseUncheckedLegacyFactories: true,
          ...(options.factories === undefined ? {} : { factories: options.factories })
        }) ??
        resolveConfiguredProject02PluginActivation({
          loadedConfig: loaded,
          ...(parsed.location.storeRoot === undefined
            ? {}
            : { storeRoot: parsed.location.storeRoot }),
          env: diagnosticsHaveErrors(loaded.diagnostics)
            ? cliEnv.configEnv
            : loadRuntimeConfigEnvFile({
                loadedConfig: loaded,
                ...(parsed.location.storeRoot === undefined
                  ? {}
                  : { storeRoot: parsed.location.storeRoot }),
                env: cliEnv.suppliedEnv,
                envDefaults: checkDefaultEnvForLocation({
                  cliEnv,
                  location: parsed.location
                })
              }),
          diagnoseUncheckedLegacyFactories: true,
          ...(options.factories === undefined ? {} : { factories: options.factories })
        });

      writeJson(options.stdout, {
        runtimeConfig: createRuntimeConfigInspectShape(configured.resolvedConfig),
        activationDiagnostics: configured.activation.diagnostics,
        plugins: configured.activation.plugins
      });
      return configured.activation.diagnostics.some((item) => item.severity === 'error')
        ? 1
        : 0;
    }

    if (parsed.command.kind === 'get') {
      const loaded = loadProject02RuntimeConfig({
        ...parsed.location,
        env: cliEnv.configEnv
      });
      assertRuntimeConfigLoaded(loaded);
      const value = getRedactedRuntimeConfigValueAtPath(
        loaded.config,
        parsed.command.path
      );

      writeJson(options.stdout, value ?? null);
      return 0;
    }

    const result = applyRuntimeConfigControlOperation({
      ...parsed.location,
      env: cliEnv.configEnv,
      operation: parsed.command.operation
    });

    writeJson(options.stdout, {
      configPath: result.configPath,
      envPath: result.envPath,
      version: result.config.version
    });
    return 0;
  } catch (error: unknown) {
    if (
      error instanceof RuntimeConfigCliUsageError ||
      error instanceof RuntimeLocationCliUsageError ||
      error instanceof RuntimeEnvFileError ||
      error instanceof RuntimeConfigMutationError ||
      error instanceof AggregateError ||
      error instanceof TypeError ||
      isLocalRuntimeTerminalError(error)
    ) {
      options.stderr.write(`Error: ${formatTerminalErrorMessage(error)}\n`);
      return 1;
    }

    throw error;
  }
}

type RuntimeConfigCliArgs = {
  readonly location: RuntimeLocationCliState;
  readonly command:
    | { readonly kind: 'path' }
    | { readonly kind: 'env_path' }
    | { readonly kind: 'check' }
    | { readonly kind: 'get'; readonly path: string }
    | { readonly kind: 'mutate'; readonly operation: RuntimeConfigMutationOperation };
};

type RuntimeConfigCliParsedArgs = {
  readonly location: RuntimeLocationCliState;
  readonly commandArgs: readonly string[];
};

function parseRuntimeConfigCliArgs(args: readonly string[]): RuntimeConfigCliParsedArgs {
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

    const locationResult = parseRuntimeLocationFlag({ args, index, state: location });

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
    commandArgs
  };
}

function runtimeConfigCommandArgsFrom(
  args: readonly string[],
  startIndex: number
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

function runtimeConfigCliEnvForLocation(options: {
  readonly location: RuntimeLocationCliState;
  readonly readDefaultDotEnv: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): {
  readonly suppliedEnv: NodeJS.ProcessEnv;
  readonly defaultEnv: NodeJS.ProcessEnv;
  readonly configEnv: NodeJS.ProcessEnv;
} {
  const suppliedEnv = options.env ?? process.env;
  const defaultEnv =
    options.readDefaultDotEnv &&
    (options.env === undefined || options.env === process.env)
      ? defaultDotEnvForRuntimeLocation(readDefaultDotEnvFile(), options.location)
      : {};

  return {
    suppliedEnv,
    defaultEnv,
    configEnv: { ...defaultEnv, ...suppliedEnv }
  };
}

function shouldReadDefaultDotEnvForCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  suppliedEnv: NodeJS.ProcessEnv
): boolean {
  const command = parsedArgs.commandArgs[0];

  if (command === 'secret' && parsedArgs.commandArgs[1] === 'set') {
    return shouldReadDefaultDotEnvForSecretSetCommand(parsedArgs, suppliedEnv);
  }

  if (!hasExplicitRuntimeLocation(parsedArgs.location)) {
    return shouldReadDefaultDotEnvForRuntimeLocation({
      location: parsedArgs.location,
      env: suppliedEnv
    });
  }

  return command === 'secret';
}

function shouldReadDefaultDotEnvForSecretSetCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  suppliedEnv: NodeJS.ProcessEnv
): boolean {
  const envVar = secretSetEnvVarNameFromArgs(parsedArgs.commandArgs);

  if (envVar === undefined || !envHasNonEmptyValue(suppliedEnv, envVar)) {
    return true;
  }

  return shouldReadDefaultDotEnvForRuntimeLocation({
    location: parsedArgs.location,
    env: suppliedEnv
  });
}

function secretSetEnvVarNameFromArgs(args: readonly string[]): string | undefined {
  const value = args[4];

  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value;
}

function envHasNonEmptyValue(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name]?.length ?? 0) > 0;
}

function checkDefaultEnvForLocation(options: {
  readonly cliEnv: ReturnType<typeof runtimeConfigCliEnvForLocation>;
  readonly location: RuntimeLocationCliState;
}): NodeJS.ProcessEnv {
  if (!hasExplicitRuntimeLocation(options.location)) {
    return options.cliEnv.defaultEnv;
  }

  return {};
}

function parseRuntimeConfigCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv
): RuntimeConfigCliArgs['command'] {
  const command = args[0];

  if (command === 'path') {
    assertNoExtraArgs(args, 0, 'path');
    return { kind: 'path' };
  }

  if (command === 'env-path') {
    assertNoExtraArgs(args, 0, 'env-path');
    return { kind: 'env_path' };
  }

  if (command === 'check') {
    assertNoExtraArgs(args, 0, 'check');
    return { kind: 'check' };
  }

  if (command === 'get') {
    const path = requiredArg(args, 1, 'get requires a path.');
    assertNoExtraArgs(args, 1, 'get');
    return { kind: 'get', path };
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
        value: parseConfigValue(value)
      }
    };
  }

  if (command === 'unset') {
    const path = requiredArg(args, 1, 'unset requires a path.');
    assertNoExtraArgs(args, 1, 'unset');

    return {
      kind: 'mutate',
      operation: {
        kind: 'unset',
        path
      }
    };
  }

  if (command === 'plugin') {
    const action = requiredArg(args, 1, 'plugin requires enable or disable.');
    const pluginId = requiredArg(args, 2, 'plugin command requires a plugin id.');

    if (action === 'enable') {
      assertNoExtraArgs(args, 2, 'plugin enable');
      return {
        kind: 'mutate',
        operation: { kind: 'plugin_enable', pluginId }
      };
    }

    if (action === 'disable') {
      assertNoExtraArgs(args, 2, 'plugin disable');
      return {
        kind: 'mutate',
        operation: { kind: 'plugin_disable', pluginId }
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
          : { pluginId: args[1] })
      }
    };
  }

  if (command === 'secret' && args[1] === 'set') {
    const envVar = requiredArg(args, 4, 'secret set requires an env var.');
    const secretValue = env[envVar];

    assertNoExtraArgs(
      args,
      4,
      'secret set',
      'secret set reads the secret from the named env var; do not pass the secret value as an argument.'
    );

    if (secretValue === undefined || secretValue.length === 0) {
      throw new RuntimeConfigCliUsageError(
        `Secret env var ${envVar} must be set before running secret set.`
      );
    }

    return {
      kind: 'mutate',
      operation: {
        kind: 'secret_set',
        pluginId: requiredArg(args, 2, 'secret set requires a plugin id.'),
        fieldName: requiredArg(args, 3, 'secret set requires a field name.'),
        envVar,
        secretValue
      }
    };
  }

  throw new RuntimeConfigCliUsageError(
    'Use path, env-path, check, get, set, unset, plugin enable, plugin disable, default-memory-provider, or secret set.'
  );
}

function assertNoExtraArgs(
  args: readonly string[],
  lastAcceptedIndex: number,
  commandName: string,
  message = `${commandName} does not accept extra arguments.`
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

function requiredArg(args: readonly string[], index: number, message: string): string {
  const value = args[index];

  if (value === undefined || value.trim().length === 0) {
    throw new RuntimeConfigCliUsageError(message);
  }

  return value;
}

function assertRuntimeConfigLoaded(loaded: LoadedProject02RuntimeConfig): void {
  if (!diagnosticsHaveErrors(loaded.diagnostics)) {
    return;
  }

  throw new RuntimeConfigCliUsageError(
    loaded.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
      ?.message ?? 'Runtime config is invalid.'
  );
}

function assertRuntimeConfigLoadedForEnvPath(
  loaded: LoadedProject02RuntimeConfig
): void {
  if (!diagnosticsHaveErrors(loaded.diagnostics)) {
    return;
  }

  const errorDiagnostic = loaded.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error'
  );

  if (
    errorDiagnostic?.code === 'runtime_config_missing' &&
    storeRootForLoadedDefaultConfigPath(loaded) !== undefined
  ) {
    return;
  }

  throw new RuntimeConfigCliUsageError(
    errorDiagnostic?.message ?? 'Runtime config is invalid.'
  );
}

function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatTerminalErrorMessage(
  error:
    | RuntimeConfigCliUsageError
    | RuntimeLocationCliUsageError
    | RuntimeEnvFileError
    | RuntimeConfigMutationError
    | AggregateError
    | TypeError
    | Parameters<typeof formatLocalRuntimeTerminalError>[0]
): string {
  if (
    error instanceof RuntimeConfigCliUsageError ||
    error instanceof RuntimeLocationCliUsageError ||
    error instanceof RuntimeEnvFileError ||
    error instanceof RuntimeConfigMutationError ||
    error instanceof AggregateError ||
    error instanceof TypeError
  ) {
    return error.message;
  }

  return formatLocalRuntimeTerminalError(error);
}

function isMainModule(): boolean {
  const scriptPath = process.argv[1];

  if (scriptPath === undefined) {
    return false;
  }

  return import.meta.url === pathToFileURL(scriptPath).href;
}

if (isMainModule()) {
  const exitCode = await runRuntimeConfigCliFromArgs(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr
  });

  process.exitCode = exitCode;
}
