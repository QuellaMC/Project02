import {
  applyRuntimeConfigControlOperation,
  assertGlobalConfigLoadableForCharacterScope,
  createRuntimeConfigInspectShape,
  defaultRuntimeConfigPath,
  diagnosticsHaveErrors,
  getRedactedRuntimeConfigValueAtPath,
  loadCharacterOverlayForScope,
  resolveRuntimeConfigScopeTarget,
  runtimeConfigDiagnosticAttribution,
  RuntimeConfigMutationError,
  runtimeConfigEnvPathForLocation,
  runtimeConfigEnvVarName,
  RuntimeEnvFileError,
  storeRootForLoadedDefaultConfigPath,
  type LoadedProject02RuntimeConfig,
  type ResolvedRuntimeConfigScopeTarget,
  type RuntimeConfigMutationResult,
} from '../../runtime/config/index.ts';
import {
  assertProject02HomeAdoptable,
  assertRealHomeEnvFile,
} from '../../runtime/storage/index.ts';
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
  RuntimeLocationCliUsageError,
  type RuntimeLocationCliState,
} from '../shared/runtime-location-flags.ts';
import {
  runRuntimeConfigConsole,
  type RuntimeConfigConsolePromptAdapter,
} from './console.ts';
import {
  assertNoExtraArgs,
  parseRuntimeConfigCliArgs,
  parseRuntimeConfigCommand,
  RuntimeConfigCliUsageError,
  runtimeConfigCwdDotEnvModeForCommand,
  type RuntimeConfigCliArgs,
  type RuntimeConfigCliParsedArgs,
} from './args.ts';
import {isMainModule} from '../shared/main-module.ts';

type RuntimeConfigCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin?: NodeJS.ReadableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly prompt?: RuntimeConfigConsolePromptAdapter;
};

type RuntimeConfigCliMutationOperation = Extract<
  RuntimeConfigCliArgs['command'],
  {readonly kind: 'mutate'}
>['operation'];

type CharacterScopedRuntimeCliStartup = Exclude<
  Awaited<ReturnType<typeof resolveRuntimeCliStartup>>,
  {readonly status: 'character_invalid'}
>;

export function runRuntimeConfigCliFromArgs(
  args: readonly string[],
  options: RuntimeConfigCliOptions,
): Promise<number> {
  return Promise.resolve()
    .then(async () => {
      const parsedArgs = parseRuntimeConfigCliArgs(args);

      if (
        parsedArgs.location.character !== undefined &&
        parsedArgs.commandArgs[0] !== 'ui'
      ) {
        return runCharacterScopedRuntimeConfigCommand(parsedArgs, options);
      }

      if (parsedArgs.commandArgs[0] !== 'ui') {
        return runRuntimeConfigCliFromArgsSync(args, options);
      }

      assertNoExtraArgs(parsedArgs.commandArgs, 0, 'ui');
      const startup = await resolveRuntimeCliStartup({
        location: parsedArgs.location,
        ...(options.env === undefined ? {} : {env: options.env}),
        ...(options.factories === undefined
          ? {}
          : {factories: options.factories}),
        continueAfterActivationErrors: true,
      });

      return await runRuntimeConfigConsole({
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

async function runRuntimeConfigCliFromArgsSync(
  args: readonly string[],
  options: RuntimeConfigCliOptions,
): Promise<number> {
  try {
    const parsedArgs = parseRuntimeConfigCliArgs(args);

    if (parsedArgs.commandArgs[0] === 'check') {
      return await runRuntimeConfigCheckCommand(parsedArgs, options);
    }

    const secretSetCommand =
      parsedArgs.commandArgs[0] === 'secret' &&
      parsedArgs.commandArgs[1] === 'set';
    const cwdDotEnv = runtimeConfigCwdDotEnvModeForCommand(
      parsedArgs,
      options.env ?? process.env,
    );

    if (secretSetCommand) {
      return await runRuntimePluginSecretSetCommand(
        parsedArgs,
        options,
        cwdDotEnv,
      );
    }

    return await runRuntimeConfigDocumentCommand(
      parsedArgs,
      options,
      cwdDotEnv,
    );
  } catch (error: unknown) {
    return handleRuntimeConfigCliError(error, options);
  }
}

async function runRuntimeConfigCheckCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
): Promise<number> {
  const startup = await resolveRuntimeCliStartup({
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

  if (startup.status === 'character_invalid') {
    throw new RuntimeConfigCliUsageError(
      (startup.characterActivation.status === 'failed'
        ? startup.characterActivation.messages[0]
        : undefined) ?? 'Character activation failed.',
    );
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

async function runRuntimePluginSecretSetCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
  cwdDotEnv: 'always' | 'auto',
): Promise<number> {
  const startup = await resolveRuntimeConfigCliActivationStartup({
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

  if (startup.status === 'character_invalid') {
    throw new RuntimeConfigCliUsageError(
      (startup.characterActivation.status === 'failed'
        ? startup.characterActivation.messages[0]
        : undefined) ?? 'Character activation failed.',
    );
  }

  await assertCommandHomeAdoptable(parsedArgs.location, startup.configEnv);

  // The secret lands at the RESOLVED home's .env — which may differ
  // from the selected one when the config's own storeRoot points
  // elsewhere — so validate the env file where the write will happen.
  await assertRealHomeEnvFile({
    homeRoot: startup.activationPlan.resolvedConfig.project02.storeRoot,
  });

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

async function runRuntimeConfigDocumentCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
  cwdDotEnv: 'always' | 'auto',
): Promise<number> {
  const configStartup = resolveRuntimeCliStartup({
    stage: 'config',
    location: parsedArgs.location,
    cwdDotEnv,
    ...(options.env === undefined ? {} : {env: options.env}),
  });
  const parsed: RuntimeConfigCliArgs = {
    location: parsedArgs.location,
    command: parseRuntimeConfigCommand(
      parsedArgs.commandArgs,
      configStartup.configEnv,
    ),
  };

  // Reads and writes alike treat a --store selection as a home; a
  // directory the runtime would not adopt is refused before any value
  // is reported or written. Standalone --config and env-selected
  // paths keep their file semantics.
  await assertCommandHomeAdoptable(parsed.location, configStartup.configEnv);

  if (parsed.command.kind === 'path') {
    options.stdout.write(
      `${
        configStartup.loadedConfig.path ??
        defaultRuntimeConfigPath(parsed.location.storeRoot)
      }\n`,
    );
    return 0;
  }

  if (parsed.command.kind === 'env_path') {
    assertRuntimeConfigLoadedForEnvPath(configStartup.loadedConfig);
    options.stdout.write(
      `${runtimeConfigEnvPathForLocation({
        loadedConfig: configStartup.loadedConfig,
        ...(parsed.location.storeRoot === undefined
          ? {}
          : {storeRoot: parsed.location.storeRoot}),
      })}\n`,
    );
    return 0;
  }

  if (parsed.command.kind === 'get') {
    assertRuntimeConfigLoaded(configStartup.loadedConfig);
    const value = getRedactedRuntimeConfigValueAtPath(
      configStartup.loadedConfig.config,
      parsed.command.path,
    );

    writeJson(options.stdout, value ?? null);
    return 0;
  }

  if (parsed.command.kind === 'check' || parsed.command.kind === 'secret_set') {
    throw new TypeError('Runtime config command routing drifted.');
  }

  if (isPluginActivationOperation(parsed.command.operation)) {
    return runManifestAwarePluginActivation({
      parsedArgs,
      options,
      cwdDotEnv,
      operation: parsed.command.operation,
    });
  }

  const target = resolveRuntimeConfigScopeTarget({
    ...parsed.location,
    env: configStartup.configEnv,
    scope: 'global',
  });
  const result = applyRuntimeConfigControlOperation({
    target,
    request: {
      kind: 'document',
      operation: parsed.command.operation,
    },
  });

  writeRuntimeConfigMutationResult(options.stdout, result);
  return 0;
}

function isPluginActivationOperation(
  operation: RuntimeConfigCliMutationOperation,
): operation is Extract<
  typeof operation,
  {readonly kind: 'plugin_enable' | 'plugin_disable'}
> {
  return (
    operation.kind === 'plugin_enable' || operation.kind === 'plugin_disable'
  );
}

async function runManifestAwarePluginActivation(options: {
  readonly parsedArgs: RuntimeConfigCliParsedArgs;
  readonly options: RuntimeConfigCliOptions;
  readonly cwdDotEnv: 'always' | 'auto';
  readonly operation: Extract<
    Extract<
      RuntimeConfigCliArgs['command'],
      {readonly kind: 'mutate'}
    >['operation'],
    {readonly kind: 'plugin_enable' | 'plugin_disable'}
  >;
}): Promise<number> {
  const startup = await resolveRuntimeConfigCliActivationStartup({
    parsedArgs: options.parsedArgs,
    options: options.options,
    cwdDotEnv: options.cwdDotEnv,
  });

  if (startup.status === 'character_invalid') {
    throw new RuntimeConfigCliUsageError(
      (startup.characterActivation.status === 'failed'
        ? startup.characterActivation.messages[0]
        : undefined) ?? 'Character activation failed.',
    );
  }

  const definition = ownJsonRecordValue(
    startup.activationPlan.catalogEntries,
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

  const target = resolveRuntimeConfigScopeTarget({
    ...options.parsedArgs.location,
    env: startup.configEnv,
    scope: 'global',
  });
  const result = applyRuntimeConfigControlOperation({
    target,
    request: {
      kind: 'plugin_activation',
      manifest: definition.manifest,
      enabled: options.operation.kind === 'plugin_enable',
    },
  });

  writeRuntimeConfigMutationResult(options.options.stdout, result);
  return 0;
}

/**
 * Verb routing under --character: path/get/set/unset target the named
 * character's overlay; check stays layered-global; secret and env-file
 * verbs are rejected because secrets are shared across characters.
 */
async function runCharacterScopedRuntimeConfigCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
): Promise<number> {
  const characterId = parsedArgs.location.character;

  if (characterId === undefined) {
    throw new TypeError('Character-scoped command routing drifted.');
  }

  assertCharacterScopedRawCommandAllowed(parsedArgs.commandArgs);

  // Secret commands were rejected above and no remaining verb consults
  // the environment while parsing, so the command parses before the one
  // activation startup — the config-stage pre-startup this route used
  // to run existed only to stage env for parsing.
  const command = parseRuntimeConfigCommand(parsedArgs.commandArgs);

  assertCharacterScopedParsedCommandAllowed(command);
  const characterConfigRequest =
    characterConfigStartupRequestForCommand(command);
  const startup = await resolveRuntimeCliStartup({
    location: parsedArgs.location,
    cwdDotEnv: runtimeConfigCwdDotEnvModeForCommand(
      parsedArgs,
      options.env ?? process.env,
    ),
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.factories === undefined ? {} : {factories: options.factories}),
    continueAfterActivationErrors: true,
    ...(characterConfigRequest === undefined ? {} : {characterConfigRequest}),
  });

  if (startup.status === 'character_invalid') {
    throw new RuntimeConfigCliUsageError(
      (startup.characterActivation.status === 'failed'
        ? startup.characterActivation.messages[0]
        : undefined) ?? 'Character activation failed.',
    );
  }

  if (command.kind !== 'check') {
    assertScopedStartupConfigReadable(startup);
  }

  const location = {
    ...(parsedArgs.location.configPath === undefined
      ? {}
      : {configPath: parsedArgs.location.configPath}),
    ...(parsedArgs.location.storeRoot === undefined
      ? {}
      : {storeRoot: parsedArgs.location.storeRoot}),
    env: startup.configEnv,
  };
  const target = resolveRuntimeConfigScopeTarget({
    ...location,
    scope: 'character',
    characterId,
    ...(startup.activationPlan.pluginConfigControl.characterScope === undefined
      ? {}
      : {
          characterScope:
            startup.activationPlan.pluginConfigControl.characterScope,
        }),
  });

  return writeCharacterScopedRuntimeConfigResult({
    stdout: options.stdout,
    command,
    startup,
    target,
  });
}

function assertCharacterScopedRawCommandAllowed(
  commandArgs: readonly string[],
): void {
  // Secret set reads its env var during parsing, so scope rejection
  // intentionally comes first.
  if (commandArgs[0] === 'secret' && commandArgs[1] === 'set') {
    throw new RuntimeConfigCliUsageError(
      'Secrets are shared across characters; run the secret command ' +
        'without --character.',
    );
  }
}

function assertCharacterScopedParsedCommandAllowed(
  command: RuntimeConfigCliArgs['command'],
): void {
  if (command.kind === 'env_path') {
    throw new RuntimeConfigCliUsageError(
      'The secrets env file is shared across characters; run env-path ' +
        'without --character.',
    );
  }
}

function characterConfigStartupRequestForCommand(
  command: RuntimeConfigCliArgs['command'],
) {
  if (command.kind !== 'mutate') {
    return undefined;
  }

  return isPluginActivationOperation(command.operation)
    ? {
        kind: 'plugin_activation' as const,
        pluginId: command.operation.pluginId,
        enabled: command.operation.kind === 'plugin_enable',
      }
    : {
        kind: 'document' as const,
        operation: command.operation,
      };
}

function writeCharacterScopedRuntimeConfigResult(options: {
  readonly stdout: NodeJS.WritableStream;
  readonly command: RuntimeConfigCliArgs['command'];
  readonly startup: CharacterScopedRuntimeCliStartup;
  readonly target: ResolvedRuntimeConfigScopeTarget;
}): number {
  const {command, startup, target} = options;

  if (command.kind === 'check') {
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

  if (command.kind === 'path') {
    options.stdout.write(`${target.configPath}\n`);
    return 0;
  }

  if (command.kind === 'get') {
    return writeCharacterScopedValue({
      stdout: options.stdout,
      target,
      loadedConfig: startup.loadedConfig,
      path: command.path,
    });
  }

  if (command.kind !== 'mutate') {
    throw new TypeError('Runtime config command routing drifted.');
  }

  const result = startup.characterConfigMutation;

  if (result === undefined) {
    throw new TypeError('Character config mutation did not commit.');
  }

  writeRuntimeConfigMutationResult(options.stdout, result);
  return 0;
}

function assertScopedStartupConfigReadable(
  startup: CharacterScopedRuntimeCliStartup,
): void {
  assertGlobalConfigLoadableForCharacterScope(startup.loadedConfig);
  const blocking = startup.activationPlan.resolvedConfig.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (blocking !== undefined) {
    throw new RuntimeConfigCliUsageError(
      `${runtimeConfigDiagnosticAttribution(blocking)}${blocking.message}`,
    );
  }
}

/**
 * A command that treats the selected store as a home — mutations and
 * scoped reads alike — refuses a directory the runtime would not
 * adopt. Explicit --config and env-selected paths are standalone
 * config files with no home semantics.
 */
async function assertCommandHomeAdoptable(
  location: RuntimeLocationCliState,
  configEnv: NodeJS.ProcessEnv,
): Promise<void> {
  // The env-selected file only governs when nothing narrower does:
  // with --store supplied, the loader ignores the env var, so the
  // selected home must still pass the guard.
  if (
    location.configPath !== undefined ||
    (location.storeRoot === undefined &&
      (configEnv[runtimeConfigEnvVarName] ?? '').trim() !== '')
  ) {
    return;
  }

  await assertProject02HomeAdoptable(
    location.storeRoot === undefined ? {} : {homeRoot: location.storeRoot},
  );
  await assertRealHomeEnvFile(
    location.storeRoot === undefined ? {} : {homeRoot: location.storeRoot},
  );
}

function writeCharacterScopedValue(options: {
  readonly stdout: NodeJS.WritableStream;
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly path: string;
}): number {
  // The guarded loader holds the identity and adoptability rules for
  // reads too: a directory marked for another character, or one the
  // writers would refuse, must not report its overlay as this
  // character's config.
  const overlay =
    options.target.characterScope === undefined
      ? undefined
      : loadCharacterOverlayForScope(options.target.characterScope);
  const overlayError = overlay?.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (overlayError !== undefined) {
    throw new RuntimeConfigCliUsageError(
      `${runtimeConfigDiagnosticAttribution(overlayError)}${overlayError.message}`,
    );
  }

  const overlayValue = getRedactedRuntimeConfigValueAtPath(
    overlay?.config,
    options.path,
  );
  const globalValue = getRedactedRuntimeConfigValueAtPath(
    options.loadedConfig.config,
    options.path,
  );

  writeJson(options.stdout, {
    value: overlayValue ?? globalValue ?? null,
    origin:
      overlayValue !== undefined
        ? 'character'
        : globalValue !== undefined
          ? 'global'
          : 'none',
  });
  return 0;
}

async function resolveRuntimeConfigCliActivationStartup(options: {
  readonly parsedArgs: RuntimeConfigCliParsedArgs;
  readonly options: RuntimeConfigCliOptions;
  readonly cwdDotEnv: 'always' | 'auto';
}): Promise<Awaited<ReturnType<typeof resolveRuntimeCliStartup>>> {
  try {
    return await resolveRuntimeCliStartup({
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
  const target = resolveRuntimeConfigScopeTarget({
    ...options.location,
    env: runtimeEnv,
    scope: 'global',
  });

  return applyRuntimeConfigControlOperation({
    target,
    request: {
      kind: 'plugin_config',
      manifest: definition.manifest,
      actor: 'operator',
      fieldOperation: {
        kind: 'secret_set',
        fieldName: options.operation.fieldName,
        envVar: options.operation.envVar,
        secretValue: options.operation.secretValue,
      },
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
