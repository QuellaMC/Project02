import {
  applyRuntimeConfigControlOperation,
  applyRuntimePluginConfigControlOperation,
  applyScopedRuntimeConfigControlOperation,
  assertRuntimeConfigSecretScopeAllowed,
  createRuntimeConfigInspectShape,
  defaultRuntimeConfigPath,
  diagnosticsHaveErrors,
  getRedactedRuntimeConfigValueAtPath,
  inspectRuntimePluginConfig,
  loadCharacterOverlayForScope,
  resolveRuntimeConfigScopeTarget,
  runtimeConfigDiagnosticAttribution,
  RuntimeConfigMutationError,
  runtimeConfigEnvPathForLocation,
  RuntimeEnvFileError,
  storeRootForLoadedDefaultConfigPath,
  type LoadedProject02RuntimeConfig,
  type ResolvedRuntimeConfigScopeTarget,
  type RuntimeConfigMutationResult,
} from '../../runtime/config/index.ts';
import {ensureCharacterDataStamp} from '../../runtime/storage/index.ts';
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

export function runRuntimeConfigCliFromArgs(
  args: readonly string[],
  options: RuntimeConfigCliOptions,
): Promise<number> {
  return Promise.resolve()
    .then(() => {
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

      // A scoped console may write the character's first overlay; the
      // binding stamp lands before any control-file lock.
      const scopedConsoleEnsure =
        parsedArgs.location.character === undefined
          ? Promise.resolve()
          : ensureCharacterScopedMutationTarget(
              resolveRuntimeConfigScopeTarget({
                ...(parsedArgs.location.configPath === undefined
                  ? {}
                  : {configPath: parsedArgs.location.configPath}),
                ...(parsedArgs.location.storeRoot === undefined
                  ? {}
                  : {storeRoot: parsedArgs.location.storeRoot}),
                ...(options.env === undefined ? {} : {env: options.env}),
                scope: 'character',
                characterId: parsedArgs.location.character,
              }),
            );
      const startup = resolveRuntimeCliStartup({
        location: parsedArgs.location,
        ...(options.env === undefined ? {} : {env: options.env}),
        ...(options.factories === undefined
          ? {}
          : {factories: options.factories}),
        continueAfterActivationErrors: true,
      });

      return scopedConsoleEnsure.then(() =>
        runRuntimeConfigConsole({
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
        }),
      );
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

  // Before command parsing: secret set reads its env var during parse,
  // and the scope rejection must come first.
  if (
    parsedArgs.commandArgs[0] === 'secret' &&
    parsedArgs.commandArgs[1] === 'set'
  ) {
    assertRuntimeConfigSecretScopeAllowed('character');
  }

  const startup = resolveRuntimeCliStartup({
    stage: 'config',
    location: parsedArgs.location,
    cwdDotEnv: runtimeConfigCwdDotEnvModeForCommand(
      parsedArgs,
      options.env ?? process.env,
    ),
    ...(options.env === undefined ? {} : {env: options.env}),
  });
  const command = parseRuntimeConfigCommand(
    parsedArgs.commandArgs,
    startup.configEnv,
  );
  const location = {
    ...(parsedArgs.location.configPath === undefined
      ? {}
      : {configPath: parsedArgs.location.configPath}),
    ...(parsedArgs.location.storeRoot === undefined
      ? {}
      : {storeRoot: parsedArgs.location.storeRoot}),
    env: startup.configEnv,
  };

  if (command.kind === 'check') {
    throw new RuntimeConfigCliUsageError(
      '--character does not apply to check; check always evaluates the ' +
        'layered config.',
    );
  }

  if (command.kind === 'env_path') {
    throw new RuntimeConfigCliUsageError(
      'The secrets env file is shared across characters; run env-path ' +
        'without --character.',
    );
  }

  const target = resolveRuntimeConfigScopeTarget({
    ...location,
    scope: 'character',
    characterId,
  });

  if (command.kind === 'path') {
    options.stdout.write(`${target.configPath}\n`);
    return 0;
  }

  if (command.kind === 'get') {
    assertRuntimeConfigLoaded(startup.loadedConfig);
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

  await ensureCharacterScopedMutationTarget(target);

  const result = applyScopedRuntimeConfigControlOperation({
    ...location,
    scope: 'character',
    characterId,
    operation: command.operation,
  });

  writeRuntimeConfigMutationResult(options.stdout, result);
  return 0;
}

function writeCharacterScopedValue(options: {
  readonly stdout: NodeJS.WritableStream;
  readonly target: ResolvedRuntimeConfigScopeTarget;
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly path: string;
}): number {
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

/**
 * Binding stamp before control-file lock, per the storage lock order: a
 * scoped mutation may be the first write into a fresh character-data
 * directory, and a copied directory must be rejected before any config
 * lands in it.
 */
async function ensureCharacterScopedMutationTarget(
  target: ResolvedRuntimeConfigScopeTarget,
): Promise<void> {
  if (target.characterScope === undefined) {
    return;
  }

  const stamp = await ensureCharacterDataStamp({
    storageOptions: {storeRoot: target.characterScope.dataRoot},
    characterId: target.characterScope.characterId,
  });

  if (stamp.status === 'rejected') {
    throw new RuntimeConfigCliUsageError(stamp.message);
  }
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
