import {
  applyRuntimeConfigControlOperation,
  applyRuntimePluginConfigControlOperation,
  createRuntimeConfigInspectShape,
  defaultRuntimeConfigPath,
  diagnosticsHaveErrors,
  getRedactedRuntimeConfigValueAtPath,
  inspectRuntimePluginConfig,
  RuntimeConfigMutationError,
  runtimeConfigEnvPathForLocation,
  RuntimeEnvFileError,
  storeRootForLoadedDefaultConfigPath,
  type LoadedProject02RuntimeConfig,
  type RuntimeConfigControlOperation,
  type RuntimeConfigMutationResult,
  type RuntimeConfigValue,
} from '../../runtime/config/index.ts';
import {
  resolveRuntimeCliStartup,
  type RuntimePluginFactoryDefinition,
} from '../../app/index.ts';
import type {RuntimePluginCatalogEntry} from '../../plugins/index.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {
  isLocalRuntimeTerminalError,
  formatCliTerminalErrorMessage,
} from '../shared/terminal-errors.ts';
import {
  parseRuntimeLocationFlag,
  RuntimeLocationCliUsageError,
  type RuntimeLocationCliState,
} from '../shared/runtime-location-flags.ts';
import {
  runRuntimeConfigConsole,
  type RuntimeConfigConsolePromptAdapter,
} from './console.ts';
import {isMainModule} from '../shared/main-module.ts';

type RuntimeConfigCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin?: NodeJS.ReadableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly prompt?: RuntimeConfigConsolePromptAdapter;
};

class RuntimeConfigCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigCliUsageError';
  }
}

export function runRuntimeConfigCliFromArgs(
  args: readonly string[],
  options: RuntimeConfigCliOptions,
): Promise<number> {
  return Promise.resolve()
    .then(() => {
      const parsedArgs = parseRuntimeConfigCliArgs(args);

      if (parsedArgs.commandArgs[0] !== 'ui') {
        return runRuntimeConfigCliFromArgsSync(args, options);
      }

      assertNoExtraArgs(parsedArgs.commandArgs, 0, 'ui');
      const startup = resolveRuntimeCliStartup({
        location: parsedArgs.location,
        ...(options.env === undefined ? {} : {env: options.env}),
        ...(options.factories === undefined
          ? {}
          : {factories: options.factories}),
        continueAfterActivationErrors: true,
      });

      return runRuntimeConfigConsole({
        stdout: options.stdout,
        ...(options.stdin === undefined ? {} : {stdin: options.stdin}),
        env: startup.configEnv,
        runtimeEnv:
          startup.status === 'resolved'
            ? startup.runtimeEnv
            : startup.configEnv,
        ...parsedArgs.location,
        ...(options.factories === undefined
          ? {}
          : {factories: options.factories}),
        ...(options.prompt === undefined ? {} : {prompt: options.prompt}),
      });
    })
    .catch((error: unknown) => handleRuntimeConfigCliError(error, options));
}

function runRuntimeConfigCliFromArgsSync(
  args: readonly string[],
  options: RuntimeConfigCliOptions,
): number {
  try {
    const parsedArgs = parseRuntimeConfigCliArgs(args);

    if (parsedArgs.commandArgs[0] === 'check') {
      return runRuntimeConfigCheckCommand(parsedArgs, options);
    }

    const secretSetCommand =
      parsedArgs.commandArgs[0] === 'secret' &&
      parsedArgs.commandArgs[1] === 'set';
    const cwdDotEnv = runtimeConfigCwdDotEnvModeForCommand(
      parsedArgs,
      options.env ?? process.env,
    );

    if (secretSetCommand) {
      return runRuntimePluginSecretSetCommand(parsedArgs, options, cwdDotEnv);
    }

    return runRuntimeConfigDocumentCommand(parsedArgs, options, cwdDotEnv);
  } catch (error: unknown) {
    return handleRuntimeConfigCliError(error, options);
  }
}

function runRuntimeConfigCheckCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
): number {
  const startup = resolveRuntimeCliStartup({
    location: parsedArgs.location,
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.factories === undefined ? {} : {factories: options.factories}),
  });
  const command = parseRuntimeConfigCommand(
    parsedArgs.commandArgs,
    startup.configEnv,
  );

  if (command.kind !== 'check') {
    throw new TypeError('Runtime config check command parsing drifted.');
  }

  writeJson(options.stdout, {
    runtimeConfig: createRuntimeConfigInspectShape(
      startup.activationPlan.resolvedConfig,
    ),
    activationDiagnostics: startup.activationPlan.activation.diagnostics,
    plugins: startup.activationPlan.activation.plugins,
  });

  return diagnosticsHaveErrors(startup.activationPlan.activation.diagnostics)
    ? 1
    : 0;
}

function runRuntimePluginSecretSetCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
  cwdDotEnv: 'always' | 'auto',
): number {
  const startup = resolveRuntimeConfigCliActivationStartup({
    parsedArgs,
    options,
    cwdDotEnv,
  });
  const command = parseRuntimeConfigCommand(
    parsedArgs.commandArgs,
    startup.configEnv,
  );

  if (command.kind !== 'secret_set') {
    throw new TypeError('Runtime config secret-set command parsing drifted.');
  }

  const result = applyRuntimePluginSecretSetCommand({
    location: parsedArgs.location,
    runtimeEnv:
      startup.status === 'resolved' ? startup.runtimeEnv : startup.configEnv,
    catalogEntries: startup.activationPlan.catalogEntries,
    operation: command.operation,
  });

  writeRuntimeConfigMutationResult(options.stdout, result);
  return 0;
}

function runRuntimeConfigDocumentCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
  cwdDotEnv: 'always' | 'auto',
): number {
  const startup = resolveRuntimeCliStartup({
    stage: 'config',
    location: parsedArgs.location,
    cwdDotEnv,
    ...(options.env === undefined ? {} : {env: options.env}),
  });
  const parsed: RuntimeConfigCliArgs = {
    location: parsedArgs.location,
    command: parseRuntimeConfigCommand(
      parsedArgs.commandArgs,
      startup.configEnv,
    ),
  };

  if (parsed.command.kind === 'path') {
    options.stdout.write(
      `${
        startup.loadedConfig.path ??
        defaultRuntimeConfigPath(parsed.location.storeRoot)
      }\n`,
    );
    return 0;
  }

  if (parsed.command.kind === 'env_path') {
    assertRuntimeConfigLoadedForEnvPath(startup.loadedConfig);
    options.stdout.write(
      `${runtimeConfigEnvPathForLocation({
        loadedConfig: startup.loadedConfig,
        ...(parsed.location.storeRoot === undefined
          ? {}
          : {storeRoot: parsed.location.storeRoot}),
      })}\n`,
    );
    return 0;
  }

  if (parsed.command.kind === 'get') {
    assertRuntimeConfigLoaded(startup.loadedConfig);
    const value = getRedactedRuntimeConfigValueAtPath(
      startup.loadedConfig.config,
      parsed.command.path,
    );

    writeJson(options.stdout, value ?? null);
    return 0;
  }

  if (parsed.command.kind === 'check' || parsed.command.kind === 'secret_set') {
    throw new TypeError('Runtime config command routing drifted.');
  }

  const result = applyRuntimeConfigControlOperation({
    ...parsed.location,
    env: startup.configEnv,
    operation: parsed.command.operation,
  });

  writeRuntimeConfigMutationResult(options.stdout, result);
  return 0;
}

type RuntimeConfigCliArgs = {
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

type RuntimeConfigCliParsedArgs = {
  readonly location: RuntimeLocationCliState;
  readonly commandArgs: readonly string[];
};

function parseRuntimeConfigCliArgs(
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

function runtimeConfigCwdDotEnvModeForCommand(
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

function resolveRuntimeConfigCliActivationStartup(options: {
  readonly parsedArgs: RuntimeConfigCliParsedArgs;
  readonly options: RuntimeConfigCliOptions;
  readonly cwdDotEnv: 'always' | 'auto';
}): ReturnType<typeof resolveRuntimeCliStartup> {
  try {
    return resolveRuntimeCliStartup({
      location: options.parsedArgs.location,
      cwdDotEnv: options.cwdDotEnv,
      ...(options.options.factories === undefined
        ? {}
        : {factories: options.options.factories}),
      ...(options.options.env === undefined ? {} : {env: options.options.env}),
      continueAfterActivationErrors: true,
    });
  } catch (error: unknown) {
    if (!(error instanceof RuntimeEnvFileError) || error.path === undefined) {
      throw error;
    }

    throw new RuntimeConfigMutationError(
      `Could not read runtime config env file at ${error.path}.`,
    );
  }
}

function applyRuntimePluginSecretSetCommand(options: {
  readonly location: RuntimeLocationCliState;
  readonly runtimeEnv: NodeJS.ProcessEnv;
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly operation: Extract<
    RuntimeConfigCliArgs['command'],
    {readonly kind: 'secret_set'}
  >['operation'];
}) {
  const definition = ownJsonRecordValue(
    options.catalogEntries,
    options.operation.pluginId,
  );

  if (
    definition === undefined ||
    definition.manifest.id !== options.operation.pluginId
  ) {
    throw new RuntimeConfigCliUsageError(
      `Plugin "${options.operation.pluginId}" is not installed.`,
    );
  }

  const runtimeEnv = {
    ...options.runtimeEnv,
    [options.operation.envVar]: options.operation.secretValue,
  };
  const inspected = inspectRuntimePluginConfig({
    ...options.location,
    env: runtimeEnv,
    manifest: definition.manifest,
  });

  return applyRuntimePluginConfigControlOperation({
    ...options.location,
    env: runtimeEnv,
    manifest: definition.manifest,
    actor: 'operator',
    expectedFingerprint: inspected.fingerprint,
    operation: {
      kind: 'secret_set',
      fieldName: options.operation.fieldName,
      envVar: options.operation.envVar,
      secretValue: options.operation.secretValue,
    },
  });
}

function writeRuntimeConfigMutationResult(
  stdout: NodeJS.WritableStream,
  result: RuntimeConfigMutationResult,
): void {
  writeJson(stdout, {
    configPath: result.configPath,
    envPath: result.envPath,
    version: result.config.version,
  });
}

function parseRuntimeConfigCommand(
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

function assertNoExtraArgs(
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

function assertRuntimeConfigLoaded(loaded: LoadedProject02RuntimeConfig): void {
  if (!diagnosticsHaveErrors(loaded.diagnostics)) {
    return;
  }

  throw new RuntimeConfigCliUsageError(
    loaded.diagnostics.find(diagnostic => diagnostic.severity === 'error')
      ?.message ?? 'Runtime config is invalid.',
  );
}

function assertRuntimeConfigLoadedForEnvPath(
  loaded: LoadedProject02RuntimeConfig,
): void {
  if (!diagnosticsHaveErrors(loaded.diagnostics)) {
    return;
  }

  const errorDiagnostic = loaded.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (
    errorDiagnostic?.code === 'runtime_config_missing' &&
    storeRootForLoadedDefaultConfigPath(loaded) !== undefined
  ) {
    return;
  }

  throw new RuntimeConfigCliUsageError(
    errorDiagnostic?.message ?? 'Runtime config is invalid.',
  );
}

function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function handleRuntimeConfigCliError(
  error: unknown,
  options: RuntimeConfigCliOptions,
): number {
  if (
    error instanceof RuntimeConfigCliUsageError ||
    error instanceof RuntimeLocationCliUsageError ||
    error instanceof RuntimeEnvFileError ||
    error instanceof RuntimeConfigMutationError ||
    error instanceof AggregateError ||
    error instanceof TypeError ||
    isLocalRuntimeTerminalError(error)
  ) {
    options.stderr.write(`Error: ${formatCliTerminalErrorMessage(error)}\n`);
    return 1;
  }

  throw error;
}

if (isMainModule(import.meta.url)) {
  const exitCode = await runRuntimeConfigCliFromArgs(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });

  process.exitCode = exitCode;
}
