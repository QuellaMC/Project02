import {
  activateProject02Character,
  classifyRuntimePluginCatalogDiscovery,
  discoverRuntimePluginCatalog,
  listProject02Characters,
  type Project02Home,
} from '../app/index.ts';
import {
  installedRuntimePluginCatalogEntry,
  type RuntimePluginCatalogEntry,
  type RuntimePluginManifest,
} from '../plugins/index.ts';
import {
  applyRuntimeConfigControlOperation,
  assertProject02ReloadedConfigUsesBoundHome,
  bindProject02CharacterRuntimeLocation,
  blockingRuntimeConfigLayerDiagnostic,
  createLayeredProject02RuntimeConfigSnapshot,
  createProject02ConfigFieldInspectShapes,
  createRuntimeConfigAuthoredSnapshot,
  createRuntimeConfigFingerprint,
  createRuntimePluginConfigInspectShape,
  layeredRuntimeConfigFingerprintForScope,
  loadRuntimeConfigEnvFile,
  pluginSecretEnvVarName,
  project02RuntimeConfigFieldDefinitions,
  readCharacterOverlayForScope,
  resolveRuntimeConfigScopeTarget,
  resolveRuntimePluginConfigs,
  simulateCharacterOverlayCandidate,
  RuntimeConfigConflictError,
  RuntimeConfigLocationError,
  RuntimeConfigMutationError,
  RuntimeEnvFileError,
  type LayeredProject02RuntimeConfigSnapshot,
  type ResolvedRuntimeConfigScopeTarget,
  type RuntimeConfigControlRequest,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigFieldScope,
  type RuntimePluginActivationStatusShape,
} from '../runtime/config/index.ts';
import {
  ensureCharacterDataDir,
  LocalRuntimeStorageContractError,
} from '../runtime/storage/index.ts';
import type {
  ConfigChange,
  ConfigChangeOutcome,
  ConfigTarget,
  ConfigView,
} from './api/contract.ts';

/**
 * The host fields a client may see and write. The store root is the home
 * the daemon runs in, bound once at start — health names it, and no
 * setting moves a running daemon — so it is not a field over the wire.
 */
const wireFields = project02RuntimeConfigFieldDefinitions().filter(
  field => field.path !== 'project02.storeRoot',
);

/**
 * How long a write waits for a file another writer holds. The lock's own
 * default is ten seconds per file, spent in a synchronous wait: fine for a
 * console, a frozen daemon for everyone else. A person who saved while the
 * console was saving simply tries again.
 */
const writeLockWaitMs = 500;

type ScopeResolution = {
  readonly layeredConfig: LayeredProject02RuntimeConfigSnapshot;
  readonly targetScope: RuntimeConfigFieldScope;
  readonly manifests: readonly RuntimePluginManifest[];
  readonly pluginResolution: Parameters<
    typeof createRuntimePluginConfigInspectShape
  >[0]['pluginResolution'];
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly fingerprint: string;
  readonly env: NodeJS.ProcessEnv;
  readonly activationByPluginId?: Readonly<
    Record<string, RuntimePluginActivationStatusShape>
  >;
  readonly defaultEnabledPluginIds: readonly string[];
};

export function readConfigView(
  home: Project02Home,
  target: ConfigTarget,
): ConfigView {
  try {
    // A document that now names another home describes a daemon that is
    // not this one; a view over it would mix its fields with this home's
    // catalog, and every save would refuse anyway.
    assertProject02ReloadedConfigUsesBoundHome({
      configLocation: home.runtimeLocation,
      loadedConfig: home.loadedConfig,
    });

    const resolution =
      target.scope === 'global'
        ? resolveGlobalScope(home)
        : resolveCharacterScope(home, target.characterId);

    return 'status' in resolution ? resolution : viewOf(resolution);
  } catch (error: unknown) {
    if (unloadable(error)) {
      return refusedView('config_unloadable', error.message);
    }

    throw error;
  }
}

/**
 * Writes one change through the control transaction the console uses, so
 * the daemon and the console never race a live reload with a second
 * writer. Whatever the seam refuses is an outcome; a bug still throws.
 */
export async function applyConfigChange(
  home: Project02Home,
  change: ConfigChange,
): Promise<ConfigChangeOutcome> {
  try {
    const catalog = discoverRuntimePluginCatalog({
      storeRoot: home.runtimeLocation.homeRoot,
    });
    const prepared = prepareControlRequest(
      change.operation,
      catalog.catalogEntries,
    );

    if (typeof prepared === 'string') {
      return refusedChange('invalid', prepared);
    }

    // The env the daemon was launched with wins over the home's env file,
    // so a secret written there under a name the launch env already sets
    // would be applied to nothing; a character's own secrets file wins
    // over both, so only a global write can be shadowed.
    const shadowed =
      change.target.scope === 'global'
        ? Object.keys(prepared.env).find(
            name => (home.suppliedEnv[name] ?? '') !== '',
          )
        : undefined;

    if (shadowed !== undefined) {
      return refusedChange(
        'invalid',
        `${shadowed} is set in the daemon's own environment, which wins ` +
          "over the home's env file; unset it and restart the daemon " +
          'before writing this secret.',
      );
    }

    const pluginManifests = manifestsOf(catalog.catalogEntries);
    const target = await resolveWriteTarget({
      home,
      target: change.target,
      env: {...runtimeEnv(home), ...prepared.env},
      pluginManifests,
      request: prepared.request,
      expectedFingerprint: change.expectedFingerprint,
    });

    if ('status' in target) {
      return target;
    }

    const result = applyRuntimeConfigControlOperation({
      target,
      pluginManifests,
      expectedFingerprint: change.expectedFingerprint,
      request: prepared.request,
      lockWaitTimeoutMs: writeLockWaitMs,
    });

    return Object.freeze({
      status: 'applied' as const,
      fingerprint: result.fingerprint,
    });
  } catch (error: unknown) {
    return changeFailure(error);
  }
}

function resolveGlobalScope(
  home: Project02Home,
): ScopeResolution | RefusedView {
  const loaded = home.loadedConfig;
  const blocking = blockingRuntimeConfigLayerDiagnostic(loaded, false);

  if (blocking !== undefined) {
    return refusedView('config_unloadable', blocking.message);
  }

  const layeredConfig = createLayeredProject02RuntimeConfigSnapshot({
    loadedConfig: loaded,
  });
  const catalog = classifyRuntimePluginCatalogDiscovery({
    discovery: discoverRuntimePluginCatalog({
      storeRoot: home.runtimeLocation.homeRoot,
    }),
    classificationConfig: layeredConfig.effective,
  });
  const manifests = manifestsOf(catalog.catalogEntries);
  const env = runtimeEnv(home);
  // Location-free: the global document resolves through no character.
  const pluginResolution = resolveRuntimePluginConfigs({
    config: layeredConfig.effective.config,
    pluginManifests: manifests,
    env,
    validateInactivePluginConfigs: true,
    defaultEnabledPluginIds: new Set(catalog.defaultEnabledPluginIds),
  });

  return {
    layeredConfig,
    targetScope: 'global',
    manifests,
    pluginResolution,
    env,
    diagnostics: [
      ...loaded.diagnostics,
      ...catalog.diagnostics,
      ...pluginResolution.diagnostics,
    ],
    fingerprint: createRuntimeConfigFingerprint(
      createRuntimeConfigAuthoredSnapshot(loaded).document,
      manifests,
    ),
    defaultEnabledPluginIds: catalog.defaultEnabledPluginIds,
  };
}

function resolveCharacterScope(
  home: Project02Home,
  characterId: string,
): ScopeResolution | RefusedView {
  if (!installed(home, characterId)) {
    return refusedView('unknown_character', notInstalledMessage(characterId));
  }

  const runtimeLocation = bindProject02CharacterRuntimeLocation({
    configLocation: home.runtimeLocation,
    characterId,
  });
  const overlay = readCharacterOverlayForScope(
    runtimeLocation.characterScope,
  ).overlay;
  const blocking =
    blockingRuntimeConfigLayerDiagnostic(home.loadedConfig, false) ??
    blockingRuntimeConfigLayerDiagnostic(overlay, false);

  if (blocking !== undefined) {
    return refusedView('config_unloadable', blocking.message);
  }

  // The plan a start would make, without the write: for a character that
  // never started it carries what its package materializes — the plugins
  // it requires, the defaults it supplies — so the view says what will
  // run. What is authored, and the fingerprint a write verifies against,
  // stay the overlay on disk.
  const startup = activateProject02Character(home, {
    characterId,
    stage: 'report',
    continueAfterActivationErrors: true,
  });

  if (startup.status === 'character_invalid') {
    return refusedView(
      'config_unloadable',
      startup.characterActivation.status === 'failed'
        ? startup.characterActivation.messages.join(' ')
        : notInstalledMessage(characterId),
    );
  }

  const plan = startup.activationPlan;
  const manifests = manifestsOf(plan.catalogEntries);

  return {
    // The overlay the plan was made from — for a never-started character
    // the one its first start writes — so a toggle and its status agree.
    layeredConfig: createLayeredProject02RuntimeConfigSnapshot({
      loadedConfig: home.loadedConfig,
      overlayConfig: startup.overlayLoadedConfig ?? overlay,
    }),
    targetScope: 'character',
    manifests,
    pluginResolution: plan.resolvedConfig,
    env: runtimeEnv(home),
    // The activation's diagnostics carry the resolution's plus what the
    // catalog could not publish — the errors the runtime itself acts on.
    diagnostics: plan.activation.diagnostics,
    fingerprint: layeredRuntimeConfigFingerprintForScope({
      globalConfig: createRuntimeConfigAuthoredSnapshot(home.loadedConfig)
        .document,
      characterScope: runtimeLocation.characterScope,
      overlay,
      pluginManifests: manifests,
    }),
    ...(plan.pluginConfigControl.activationByPluginId === undefined
      ? {}
      : {activationByPluginId: plan.pluginConfigControl.activationByPluginId}),
    defaultEnabledPluginIds:
      plan.pluginConfigControl.defaultEnabledPluginIds ?? [],
  };
}

function viewOf(resolution: ScopeResolution): ConfigView {
  const {layeredConfig, targetScope, fingerprint} = resolution;

  return Object.freeze({
    status: 'ok' as const,
    fingerprint,
    diagnostics: Object.freeze([...resolution.diagnostics]),
    project02: Object.freeze(
      createProject02ConfigFieldInspectShapes({
        layeredConfig,
        targetScope,
        env: resolution.env,
      }).filter(field => wireFields.some(wire => wire.name === field.name)),
    ),
    plugins: Object.freeze(
      resolution.manifests.map(manifest => {
        const activation = resolution.activationByPluginId?.[manifest.id];

        return createRuntimePluginConfigInspectShape({
          layeredConfig,
          targetScope,
          pluginResolution: resolution.pluginResolution,
          manifest,
          fingerprint,
          ...(activation === undefined ? {} : {activation}),
          defaultEnabled: resolution.defaultEnabledPluginIds.includes(
            manifest.id,
          ),
        });
      }),
    ),
  });
}

/** A wire operation becomes the control seam's own request, ids resolved. */
function prepareControlRequest(
  operation: ConfigChange['operation'],
  catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>,
):
  | {
      readonly request: RuntimeConfigControlRequest;
      readonly env: NodeJS.ProcessEnv;
    }
  | string {
  if (operation.kind === 'set' || operation.kind === 'unset') {
    if (!wireFields.some(field => field.path === operation.path)) {
      return (
        `Unknown config field "${operation.path}". Fields: ` +
        `${wireFields.map(field => field.path).join(', ')}.`
      );
    }

    return {request: {kind: 'document', operation}, env: {}};
  }

  const manifest = installedRuntimePluginCatalogEntry(
    catalogEntries,
    operation.pluginId,
  )?.manifest;

  if (manifest === undefined) {
    return `Plugin "${operation.pluginId}" is not installed.`;
  }

  switch (operation.kind) {
    case 'plugin_enabled':
      return {
        request: {
          kind: 'plugin_activation',
          manifest,
          ...(operation.enabled === undefined
            ? {}
            : {enabled: operation.enabled}),
        },
        env: {},
      };
    case 'plugin_field_set':
    case 'plugin_field_unset':
      return {
        request: {
          kind: 'plugin_config',
          manifest,
          actor: 'operator',
          fieldOperation:
            operation.kind === 'plugin_field_set'
              ? {
                  kind: 'set',
                  fieldName: operation.field,
                  value: operation.value,
                }
              : {kind: 'unset', fieldName: operation.field},
        },
        env: {},
      };
    case 'plugin_secret_set': {
      const field = manifest.config.fields.find(
        candidate => candidate.name === operation.field,
      );

      if (field === undefined) {
        return `Plugin "${manifest.id}" does not declare config field "${operation.field}".`;
      }

      const envVar = pluginSecretEnvVarName(manifest.id, field);

      return {
        request: {
          kind: 'plugin_config',
          manifest,
          actor: 'operator',
          fieldOperation: {
            kind: 'secret_set',
            fieldName: field.name,
            envVar,
            secretValue: operation.value,
          },
        },
        // The value the write is about to put in the env file, so the
        // candidate resolves against it.
        env: {[envVar]: operation.value},
      };
    }
  }
}

async function resolveWriteTarget(options: {
  readonly home: Project02Home;
  readonly target: ConfigTarget;
  readonly env: NodeJS.ProcessEnv;
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly request: RuntimeConfigControlRequest;
  readonly expectedFingerprint: string;
}): Promise<ResolvedRuntimeConfigScopeTarget | RefusedChange> {
  const {home, target, env} = options;

  if (target.scope === 'global') {
    return resolveRuntimeConfigScopeTarget({
      runtimeLocation: home.runtimeLocation,
      scope: 'global',
      env,
    });
  }

  if (!installed(home, target.characterId)) {
    return refusedChange(
      'unknown_character',
      notInstalledMessage(target.characterId),
    );
  }

  const scopeTarget = resolveRuntimeConfigScopeTarget({
    runtimeLocation: bindProject02CharacterRuntimeLocation({
      configLocation: home.runtimeLocation,
      characterId: target.characterId,
    }),
    scope: 'character',
    env,
  });
  // The commit's own preparation and expectation check, run without
  // locking or writing, so a change the seam will refuse creates no data
  // directory for a character that never started.
  const candidate = simulateCharacterOverlayCandidate({
    target: scopeTarget,
    pluginManifests: options.pluginManifests,
    request: options.request,
    expectedFingerprint: options.expectedFingerprint,
  });

  if (candidate.status !== 'valid') {
    return refusedChange(candidate.status, candidate.message);
  }

  // A character's first valid write claims its data directory, as the
  // console's does; the transaction then verifies the marker under its lock.
  await ensureCharacterDataDir({
    homeRoot: home.runtimeLocation.homeRoot,
    characterId: target.characterId,
  });

  return scopeTarget;
}

/**
 * The seam's own vocabulary, mapped once: a moved fingerprint, an
 * unacceptable change (the two classes control raises for one), and a
 * write that could not be made. Anything else is a bug.
 */
function changeFailure(error: unknown): ConfigChangeOutcome {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof RuntimeConfigConflictError) {
    return refusedChange('conflict', message);
  }

  if (error instanceof RuntimeConfigMutationError) {
    return error.cause === undefined
      ? refusedChange('invalid', message)
      : failedChange(message);
  }

  if (error instanceof TypeError) {
    return refusedChange('invalid', message);
  }

  if (unloadable(error)) {
    return failedChange(message);
  }

  throw error;
}

function unloadable(error: unknown): error is Error {
  return (
    error instanceof RuntimeConfigLocationError ||
    error instanceof RuntimeEnvFileError ||
    error instanceof LocalRuntimeStorageContractError
  );
}

/** The env the daemon's characters resolve with: the home's env file over the run's. */
function runtimeEnv(home: Project02Home): NodeJS.ProcessEnv {
  return loadRuntimeConfigEnvFile({
    runtimeLocation: home.runtimeLocation,
    env: home.suppliedEnv,
    envDefaults: home.cwdDotEnv,
  });
}

function installed(home: Project02Home, characterId: string): boolean {
  return listProject02Characters(home).characters.some(
    character => character.id === characterId,
  );
}

function notInstalledMessage(characterId: string): string {
  return `Character "${characterId}" is not installed.`;
}

function manifestsOf(
  catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>,
): readonly RuntimePluginManifest[] {
  return Object.freeze(
    Object.values(catalogEntries)
      .map(entry => entry.manifest)
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

type RefusedView = Extract<ConfigView, {status: 'refused'}>;

function refusedView(
  reason: RefusedView['reason'],
  message: string,
): RefusedView {
  return Object.freeze({status: 'refused' as const, reason, message});
}

type RefusedChange = Extract<ConfigChangeOutcome, {status: 'refused'}>;

function refusedChange(
  reason: RefusedChange['reason'],
  message: string,
): RefusedChange {
  return Object.freeze({status: 'refused' as const, reason, message});
}

function failedChange(message: string): ConfigChangeOutcome {
  return Object.freeze({status: 'failed' as const, message});
}
