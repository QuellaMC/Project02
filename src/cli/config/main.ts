import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
import {
  applyRuntimeConfigControlOperation,
  characterSecretsEnvPath,
  assertGlobalConfigLoadableForCharacterScope,
  assertResolvedProject02HomeAdoptable,
  assertSelectedProject02HomeAdoptable,
  createRuntimeConfigInspectShape,
  diagnosticsHaveErrors,
  getRedactedRuntimeConfigValueAtPath,
  inspectConfiguredPlugins,
  readCharacterOverlayForScope,
  resolveRuntimeConfigScopeTarget,
  runtimeConfigDiagnosticAttribution,
  runtimeConfigDiagnosticIsReadinessFailure,
  RuntimeConfigMutationError,
  runtimeConfigEnvPathForLocation,
  runtimeConfigLocationUsesDefaultConfigPath,
  RuntimeEnvFileError,
  type LoadedProject02RuntimeConfig,
  type ResolvedProject02ConfigLocation,
  type ResolvedProject02RuntimeLocation,
  type ResolvedRuntimeConfigScopeTarget,
  type RuntimeConfigMutationResult,
} from '../../runtime/config/index.ts';
import {
  resolveRuntimeCliStartup,
  type RuntimePluginFactoryDefinition,
} from '../../app/index.ts';
import {
  installedRuntimePluginCatalogEntry,
  type RuntimePluginCatalogEntry,
} from '../../plugins/index.ts';
import {
  isCliTerminalError,
  formatCliTerminalErrorMessage,
} from '../shared/terminal-errors.ts';
import {writeJson} from '../shared/output.ts';
import type {CliPromptAdapter} from '../shared/prompt.ts';
import {characterActivationFailureMessage} from '../shared/startup-outcome.ts';
import {assertProject02StoreConsent} from '../shared/store-consent.ts';
import {CliUsageError} from '../shared/usage-error.ts';
import {runRuntimeConfigConsole} from './console.ts';
import {runtimeConfigSecretSetCommandPrefix} from './console-shared.ts';
import {
  assertNoExtraArgs,
  parseRuntimeConfigCliArgs,
  parseRuntimeConfigCommand,
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
  readonly prompt?: CliPromptAdapter;
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

      if (parsedArgs.commandArgs[0] !== 'ui') {
        return parsedArgs.location.character === undefined
          ? await runGlobalRuntimeConfigCommand(parsedArgs, options)
          : await runCharacterScopedRuntimeConfigCommand(parsedArgs, options);
      }

      assertNoExtraArgs(parsedArgs.commandArgs, 0, 'ui');
      await assertRuntimeConfigCliStoreConsent(parsedArgs, options);
      const startup = await resolveRuntimeCliStartup({
        location: parsedArgs.location,
        ...(options.env === undefined ? {} : {env: options.env}),
        ...(options.factories === undefined
          ? {}
          : {factories: options.factories}),
        continueAfterActivationErrors: true,
      });

      if (startup.status === 'character_invalid') {
        throw new CliUsageError(characterActivationFailureMessage(startup));
      }

      return await runRuntimeConfigConsole({
        stdout: options.stdout,
        loadedConfig: startup.loadedConfig,
        runtimeLocation: startup.runtimeLocation,
        ...(options.stdin === undefined ? {} : {stdin: options.stdin}),
        env: startup.configEnv,
        runtimeEnv:
          startup.status === 'resolved'
            ? startup.runtimeEnv
            : startup.configEnv,
        scope:
          parsedArgs.location.character === undefined ? 'global' : 'character',
        secretSetCommandPrefix: runtimeConfigSecretSetCommandPrefix(
          parsedArgs.location,
        ),
        catalogSnapshot: startup.catalogSnapshot,
        ...(options.prompt === undefined ? {} : {prompt: options.prompt}),
      });
    })
    .catch((error: unknown) => handleRuntimeConfigCliError(error, options));
}

/**
 * Called after the command has parsed: a malformed command line is a
 * usage error whatever store it names. Read verbs never call it at all.
 */
function assertRuntimeConfigCliStoreConsent(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
  creates: 'home' | 'selected-config' = 'home',
): Promise<void> {
  return assertProject02StoreConsent({
    location: parsedArgs.location,
    init: parsedArgs.init,
    stdout: options.stdout,
    creates,
    // The same env staging the command uses, so the gate judges the same home.
    cwdDotEnv: runtimeConfigCwdDotEnvModeForCommand(
      parsedArgs,
      options.env ?? process.env,
    ),
    ...(options.stdin === undefined ? {} : {stdin: options.stdin}),
    ...(options.env === undefined ? {} : {env: options.env}),
  });
}

async function runGlobalRuntimeConfigCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
): Promise<number> {
  if (parsedArgs.commandArgs[0] === 'check') {
    return await runRuntimeConfigCheckCommand(parsedArgs, options);
  }

  const cwdDotEnv = runtimeConfigCwdDotEnvModeForCommand(
    parsedArgs,
    options.env ?? process.env,
  );

  if (
    parsedArgs.commandArgs[0] === 'secret' &&
    parsedArgs.commandArgs[1] === 'set'
  ) {
    return await runRuntimePluginSecretSetCommand(
      parsedArgs,
      options,
      cwdDotEnv,
    );
  }

  return await runRuntimeConfigDocumentCommand(parsedArgs, options, cwdDotEnv);
}

async function runRuntimeConfigCheckCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
): Promise<number> {
  // Parsing first rejects a malformed command line before anything is created.
  const command = parseRuntimeConfigCommand(parsedArgs.commandArgs);

  if (command.kind !== 'check') {
    throw new TypeError('Runtime config check command parsing drifted.');
  }

  await assertRuntimeConfigCliStoreConsent(parsedArgs, options);
  const startup = await resolveRuntimeCliStartup({
    location: parsedArgs.location,
    ...(options.env === undefined ? {} : {env: options.env}),
    ...(options.factories === undefined ? {} : {factories: options.factories}),
  });

  if (startup.status === 'character_invalid') {
    throw new CliUsageError(characterActivationFailureMessage(startup));
  }

  return writeRuntimeConfigCheckResult(options.stdout, startup.activationPlan);
}

/** One plugin shape for `check` and `inspect`, so they cannot disagree. */
function writeRuntimeConfigCheckResult(
  stdout: NodeJS.WritableStream,
  activationPlan: CharacterScopedRuntimeCliStartup['activationPlan'],
): number {
  writeJson(stdout, {
    runtimeConfig: createRuntimeConfigInspectShape(
      activationPlan.resolvedConfig,
    ),
    activationDiagnostics: activationPlan.activation.diagnostics,
    plugins: inspectConfiguredPlugins(activationPlan),
  });

  return diagnosticsHaveErrors(activationPlan.activation.diagnostics) ? 1 : 0;
}

async function runRuntimePluginSecretSetCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
  cwdDotEnv: 'always' | 'auto',
): Promise<number> {
  // Secret set is the one verb that reads env while parsing; the
  // config-stage startup stages it without creating anything.
  const command = parseRuntimeConfigCommand(
    parsedArgs.commandArgs,
    resolveRuntimeCliStartup({
      stage: 'config',
      location: parsedArgs.location,
      cwdDotEnv,
      ...(options.env === undefined ? {} : {env: options.env}),
    }).configEnv,
  );

  if (command.kind !== 'secret_set') {
    throw new TypeError('Runtime config secret-set command parsing drifted.');
  }

  await assertRuntimeConfigCliStoreConsent(parsedArgs, options);
  const startup = await resolveRuntimeConfigCliActivationStartup({
    parsedArgs,
    options,
    cwdDotEnv,
  });

  if (startup.status === 'character_invalid') {
    throw new CliUsageError(characterActivationFailureMessage(startup));
  }

  const result = applyRuntimePluginSecretSetCommand({
    runtimeLocation: startup.runtimeLocation,
    runtimeEnv:
      startup.status === 'resolved' ? startup.runtimeEnv : startup.configEnv,
    catalogEntries: startup.activationPlan.catalogEntries,
    operation: command.operation,
    scope: parsedArgs.location.character === undefined ? 'global' : 'character',
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

  if (parsed.command.kind === 'path') {
    assertReadableSelectedHome(configStartup.runtimeLocation);
    options.stdout.write(
      `${configStartup.runtimeLocation.selectedConfig.path}\n`,
    );
    return 0;
  }

  if (parsed.command.kind === 'env_path') {
    assertReadableSelectedHome(configStartup.runtimeLocation);
    assertResolvedProject02HomeAdoptable(configStartup.runtimeLocation, {
      requireRealEnvFile: true,
    });
    assertRuntimeConfigLoadedForEnvPath(
      configStartup.loadedConfig,
      configStartup.runtimeLocation,
    );
    options.stdout.write(
      `${runtimeConfigEnvPathForLocation(configStartup.runtimeLocation)}\n`,
    );
    return 0;
  }

  if (parsed.command.kind === 'get') {
    assertReadableSelectedHome(configStartup.runtimeLocation);
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

  // Every read verb returned above, so what is left writes.
  if (isPluginActivationOperation(parsed.command.operation)) {
    await assertRuntimeConfigCliStoreConsent(parsedArgs, options);

    return runManifestAwarePluginActivation({
      parsedArgs,
      options,
      cwdDotEnv,
      operation: parsed.command.operation,
    });
  }

  await assertRuntimeConfigCliStoreConsent(
    parsedArgs,
    options,
    'selected-config',
  );
  const target = resolveRuntimeConfigScopeTarget({
    runtimeLocation: configStartup.runtimeLocation,
    env: configStartup.configEnv,
    scope: 'global',
  });
  const result = applyRuntimeConfigControlOperation({
    target,
    // Document commands run before plugin discovery and round-trip no
    // expectation, so there are no manifests to redact against here.
    pluginManifests: [],
    request: {
      kind: 'document',
      operation: parsed.command.operation,
    },
  });

  writeRuntimeConfigMutationResult(options.stdout, result);
  return 0;
}

function catalogManifests(
  catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>,
): readonly RuntimePluginManifest[] {
  return Object.values(catalogEntries).map(entry => entry.manifest);
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
    throw new CliUsageError(characterActivationFailureMessage(startup));
  }

  const definition = installedRuntimePluginCatalogEntry(
    startup.activationPlan.catalogEntries,
    options.operation.pluginId,
  );

  if (definition === undefined) {
    throw new CliUsageError(
      `Plugin "${options.operation.pluginId}" is not installed.`,
    );
  }

  const target = resolveRuntimeConfigScopeTarget({
    runtimeLocation: startup.runtimeLocation,
    env: startup.configEnv,
    scope: 'global',
  });
  const result = applyRuntimeConfigControlOperation({
    target,
    pluginManifests: catalogManifests(startup.activationPlan.catalogEntries),
    request: {
      kind: 'plugin_activation',
      manifest: definition.manifest,
      enabled: options.operation.kind === 'plugin_enable',
    },
  });

  writeRuntimeConfigMutationResult(options.options.stdout, result);
  return 0;
}

/** Under `--character`, `check` alone stays layered-global. */
async function runCharacterScopedRuntimeConfigCommand(
  parsedArgs: RuntimeConfigCliParsedArgs,
  options: RuntimeConfigCliOptions,
): Promise<number> {
  const characterId = parsedArgs.location.character;

  if (characterId === undefined) {
    throw new TypeError('Character-scoped command routing drifted.');
  }

  // Secret set reads env while parsing, so it routes before parsing.
  if (
    parsedArgs.commandArgs[0] === 'secret' &&
    parsedArgs.commandArgs[1] === 'set'
  ) {
    return await runRuntimePluginSecretSetCommand(
      parsedArgs,
      options,
      runtimeConfigCwdDotEnvModeForCommand(
        parsedArgs,
        options.env ?? process.env,
      ),
    );
  }

  // No remaining verb reads env while parsing, so this parses before startup.
  const command = parseRuntimeConfigCommand(parsedArgs.commandArgs);

  // Every scoped verb materializes character data, so reads consent too.
  await assertRuntimeConfigCliStoreConsent(parsedArgs, options);
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
    throw new CliUsageError(characterActivationFailureMessage(startup));
  }

  if (command.kind !== 'check') {
    assertScopedStartupConfigReadable(startup);
  }

  const target = resolveRuntimeConfigScopeTarget({
    runtimeLocation: startup.runtimeLocation,
    env: startup.configEnv,
    scope: 'character',
  });

  return writeCharacterScopedRuntimeConfigResult({
    stdout: options.stdout,
    command,
    startup,
    target,
  });
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
  readonly target: Extract<
    ResolvedRuntimeConfigScopeTarget,
    {readonly scope: 'character'}
  >;
}): number {
  const {command, startup, target} = options;

  if (command.kind === 'check') {
    return writeRuntimeConfigCheckResult(
      options.stdout,
      startup.activationPlan,
    );
  }

  if (command.kind === 'path') {
    options.stdout.write(`${target.configPath}\n`);
    return 0;
  }

  if (command.kind === 'env_path') {
    options.stdout.write(
      `${characterSecretsEnvPath(target.runtimeLocation.characterScope.dataRoot)}\n`,
    );
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

/**
 * Blocks on an invalid authored document, not on an incomplete
 * environment — the state an operator runs these verbs to repair.
 */
function assertScopedStartupConfigReadable(
  startup: CharacterScopedRuntimeCliStartup,
): void {
  assertGlobalConfigLoadableForCharacterScope(startup.loadedConfig);
  const blocking = startup.activationPlan.resolvedConfig.diagnostics.find(
    diagnostic =>
      diagnostic.severity === 'error' &&
      !runtimeConfigDiagnosticIsReadinessFailure(diagnostic),
  );

  if (blocking !== undefined) {
    throw new CliUsageError(
      `${runtimeConfigDiagnosticAttribution(blocking)}${blocking.message}`,
    );
  }
}

/** Mutations are admitted by the transaction target; only reads need this. */
function assertReadableSelectedHome(
  runtimeLocation: ResolvedProject02ConfigLocation,
): void {
  assertSelectedProject02HomeAdoptable(runtimeLocation, {
    requireRealEnvFile: true,
  });
}

function writeCharacterScopedValue(options: {
  readonly stdout: NodeJS.WritableStream;
  readonly target: Extract<
    ResolvedRuntimeConfigScopeTarget,
    {readonly scope: 'character'}
  >;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly path: string;
}): number {
  // A directory marked for another character must not report its overlay here.
  const overlay = readCharacterOverlayForScope(
    options.target.runtimeLocation.characterScope,
  ).overlay;
  const overlayError = overlay.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (overlayError !== undefined) {
    throw new CliUsageError(
      `${runtimeConfigDiagnosticAttribution(overlayError)}${overlayError.message}`,
    );
  }

  const overlayValue = getRedactedRuntimeConfigValueAtPath(
    overlay.config,
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
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly runtimeEnv: NodeJS.ProcessEnv;
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly operation: Extract<
    RuntimeConfigCliArgs['command'],
    {readonly kind: 'secret_set'}
  >['operation'];
  readonly scope: 'global' | 'character';
}) {
  const definition = installedRuntimePluginCatalogEntry(
    options.catalogEntries,
    options.operation.pluginId,
  );

  if (definition === undefined) {
    throw new CliUsageError(
      `Plugin "${options.operation.pluginId}" is not installed.`,
    );
  }

  const runtimeEnv = {
    ...options.runtimeEnv,
    [options.operation.envVar]: options.operation.secretValue,
  };
  const target = resolveRuntimeConfigScopeTarget({
    runtimeLocation: options.runtimeLocation,
    env: runtimeEnv,
    scope: options.scope,
  });

  return applyRuntimeConfigControlOperation({
    target,
    pluginManifests: catalogManifests(options.catalogEntries),
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

  throw new CliUsageError(
    loaded.diagnostics.find(diagnostic => diagnostic.severity === 'error')
      ?.message ?? 'Runtime config is invalid.',
  );
}

function assertRuntimeConfigLoadedForEnvPath(
  loaded: LoadedProject02RuntimeConfig,
  runtimeLocation: ResolvedProject02ConfigLocation,
): void {
  if (!diagnosticsHaveErrors(loaded.diagnostics)) {
    return;
  }

  const errorDiagnostic = loaded.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (
    errorDiagnostic?.code === 'runtime_config_missing' &&
    runtimeConfigLocationUsesDefaultConfigPath(runtimeLocation)
  ) {
    return;
  }

  throw new CliUsageError(
    errorDiagnostic?.message ?? 'Runtime config is invalid.',
  );
}

/**
 * The mutation seam rejects an unwritable document with a TypeError carrying
 * the operator's message ("Unsupported runtime config path", a field's
 * invalid-value message), so this verb reports those too.
 */
function handleRuntimeConfigCliError(
  error: unknown,
  options: RuntimeConfigCliOptions,
): number {
  if (isCliTerminalError(error) || error instanceof TypeError) {
    options.stderr.write(`Error: ${formatCliTerminalErrorMessage(error)}\n`);
    return 1;
  }

  throw error;
}

if (isMainModule(import.meta.url)) {
  const exitCode = await runRuntimeConfigCliFromArgs(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });

  process.exitCode = exitCode;
}
