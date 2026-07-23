import {
  applyRuntimeConfigControlOperation,
  applyRuntimePluginConfigControlOperation,
  applyScopedRuntimeConfigControlOperation,
  assertGlobalConfigLoadableForCharacterScope,
  assertRuntimeConfigSecretScopeAllowed,
  assertScopedGlobalLayerLoadable,
  assertScopedMutationOperationAllowed,
  createRuntimeConfigInspectShape,
  ensureCharacterDataDir,
  defaultRuntimeConfigPath,
  diagnosticsHaveErrors,
  getRedactedRuntimeConfigValueAtPath,
  inspectRuntimePluginConfig,
  loadCharacterOverlayForScope,
  loadScopedGlobalLayerConfig,
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
  assertCharacterDataDirReadable,
  assertProject02HomeAdoptable,
  assertRealHomeEnvFile,
  homeRootForCharacterDataDir,
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

  await assertMutationHomeAdoptable(parsedArgs.location, startup.configEnv);

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

  await assertMutationHomeAdoptable(parsed.location, startup.configEnv);

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
    // The global fallback comes from the OWNING home even when
    // --config aliases the overlay itself — and a home that cannot
    // load rejects the read, exactly like check and scoped writes. An
    // absent overlay is fine: it simply contributes no character layer.
    const globalLayer = loadScopedGlobalLayerConfig({...location, characterId});

    assertGlobalConfigLoadableForCharacterScope(globalLayer);

    return writeCharacterScopedValue({
      stdout: options.stdout,
      target,
      loadedConfig: globalLayer,
      path: command.path,
    });
  }

  if (command.kind !== 'mutate') {
    throw new TypeError('Runtime config command routing drifted.');
  }

  // Dialect violations, a broken global layer, and an existing invalid
  // overlay all fail before ensure materializes the stamp or data
  // marker for the character.
  assertScopedMutationOperationAllowed(command.operation);
  assertScopedGlobalLayerLoadable({...location, characterId});
  assertExistingOverlayLoadable(target);
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

/**
 * A global mutation authors settings for a home; refuse a directory
 * the runtime would not adopt. Explicit --config and env-selected
 * paths are standalone config files with no home semantics.
 */
async function assertMutationHomeAdoptable(
  location: RuntimeLocationCliState,
  configEnv: NodeJS.ProcessEnv,
): Promise<void> {
  if (
    location.configPath !== undefined ||
    (configEnv[runtimeConfigEnvVarName] ?? '').trim() !== ''
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
  // The binding and adoptability rules hold for reads too: a directory
  // stamped for another character, or one the writers would refuse,
  // must not have its overlay reported as this character's config.
  if (options.target.characterScope !== undefined) {
    assertCharacterDataDirReadable({
      storageOptions: {storeRoot: options.target.characterScope.dataRoot},
      characterId: options.target.characterScope.characterId,
    });
  }

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
 * Home guard, then binding stamp, then the control-file lock inside
 * the mutation — the same order the writer CLIs use. A scoped mutation
 * may be the first write into a fresh character-data directory; a
 * foreign --store directory or a copied data dir must be rejected
 * before any config lands in it.
 */
/**
 * An existing overlay that cannot load rejects the scoped edit before
 * ensure materializes anything; the mutation would only fail on it
 * afterwards, leaving a fresh stamp behind for a rejected change.
 */
function assertExistingOverlayLoadable(
  target: ResolvedRuntimeConfigScopeTarget,
): void {
  if (target.characterScope === undefined) {
    return;
  }

  const overlay = loadCharacterOverlayForScope(target.characterScope);
  const overlayError = overlay.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (overlayError !== undefined) {
    throw new RuntimeConfigCliUsageError(
      `${runtimeConfigDiagnosticAttribution(overlayError)}${overlayError.message}`,
    );
  }
}

async function ensureCharacterScopedMutationTarget(
  target: ResolvedRuntimeConfigScopeTarget,
): Promise<void> {
  if (target.characterScope === undefined) {
    return;
  }

  await ensureCharacterDataDir({
    homeRoot: homeRootForCharacterDataDir(target.characterScope.dataRoot),
    characterId: target.characterScope.characterId,
  });
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
