import {
  activateProject02Character,
  classifyRuntimePluginCatalogDiscovery,
  discoverRuntimePluginCatalog,
  prepareProject02CharacterActivation,
  runtimeConfigDiagnosticConcernsCharacter,
  type Project02Home,
} from '../app/index.ts';
import type {
  RuntimePluginCatalogEntry,
  RuntimePluginManifest,
} from '../plugins/index.ts';
import {
  applyRuntimeConfigControlOperation,
  assertResolvedProject02HomeCurrent,
  bindProject02CharacterRuntimeLocation,
  blockingRuntimeConfigLayerDiagnostic,
  createLayeredProject02RuntimeConfigSnapshot,
  createProject02ConfigFieldInspectShapes,
  createRuntimeConfigAuthoredSnapshot,
  createRuntimeConfigFingerprint,
  createRuntimeConfigSections,
  createRuntimeSectionConfigInspectShape,
  layeredRuntimeConfigFingerprintForScope,
  project02RuntimeConfigFieldDefinitions,
  readCharacterOverlayForScope,
  resolveRuntimeConfigScopeTarget,
  resolveRuntimeSectionConfigs,
  runtimeConfigSectionNamespaces,
  runtimeSectionValueAuthorable,
  simulateCharacterOverlayCandidate,
  RuntimeConfigConflictError,
  RuntimeConfigLocationError,
  RuntimeConfigMutationError,
  type LayeredProject02RuntimeConfigSnapshot,
  type ResolvedRuntimeConfigScopeTarget,
  type ResolvedRuntimeSectionConfigs,
  type RuntimeConfigControlRequest,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigFieldScope,
  type RuntimeConfigSectionActivationShape,
  type RuntimeConfigSectionDeclaration,
  type RuntimeConfigSectionInspectShape,
  type RuntimeConfigSectionNamespace,
  type RuntimeConfigSections,
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
 * How long a write waits for a file another writer holds. The lock's own
 * default is ten seconds per file, spent in a synchronous wait: fine for a
 * terminal, a frozen daemon for everyone else. A person who saved while
 * another page was saving simply tries again.
 */
const writeLockWaitMs = 500;

export type ScopeResolution = {
  readonly layeredConfig: LayeredProject02RuntimeConfigSnapshot;
  readonly targetScope: RuntimeConfigFieldScope;
  readonly sections: RuntimeConfigSections;
  readonly sectionResolution: ResolvedRuntimeSectionConfigs;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly fingerprint: string;
  /** A section with no entry here judges its own activation. */
  readonly sectionActivations: Readonly<
    Partial<
      Record<
        RuntimeConfigSectionNamespace,
        Readonly<Record<string, RuntimeConfigSectionActivationShape>>
      >
    >
  >;
  /** A namespace with no set here leaves each section its declared default. */
  readonly defaultEnabledSectionIds: Readonly<
    Partial<Record<RuntimeConfigSectionNamespace, ReadonlySet<string>>>
  >;
};

export function readConfigView(
  home: Project02Home,
  target: ConfigTarget,
): ConfigView {
  const resolution = resolveScope(home, target);

  return 'status' in resolution ? resolution : viewOf(resolution);
}

/**
 * A target's settings resolved, or why they cannot be: the one resolution
 * the settings view and a connector's read are both made from.
 */
export function resolveScope(
  home: Project02Home,
  target: ConfigTarget,
): ScopeResolution | RefusedView {
  try {
    // A home replaced under the daemon belongs to a daemon that is not
    // this one; a view over it would mix its files with this home's
    // catalog, and every save would refuse anyway.
    assertResolvedProject02HomeCurrent(home.runtimeLocation);

    return target.scope === 'global'
      ? resolveGlobalScope(home)
      : resolveCharacterScope(home, target.characterId);
  } catch (error: unknown) {
    if (unloadable(error)) {
      return refusedView('config_unloadable', error.message);
    }

    throw error;
  }
}

/**
 * Writes one change through the one control transaction, so the daemon
 * never races a live reload with a second writer. Whatever the seam
 * refuses is an outcome; a bug still throws.
 */
export async function applyConfigChange(
  home: Project02Home,
  change: ConfigChange,
): Promise<ConfigChangeOutcome> {
  try {
    const catalog = discoverRuntimePluginCatalog({
      storeRoot: home.runtimeLocation.homeRoot,
    });
    const sections = createRuntimeConfigSections({
      plugins: manifestsOf(catalog.catalogEntries),
    });
    const prepared = prepareControlRequest(change.operation, sections);

    if (typeof prepared === 'string') {
      return refusedChange('invalid', prepared);
    }

    const target = await resolveWriteTarget({
      home,
      target: change.target,
      sections,
      request: prepared,
      expectedFingerprint: change.expectedFingerprint,
    });

    if ('status' in target) {
      return target;
    }

    const result = applyRuntimeConfigControlOperation({
      target,
      sections,
      expectedFingerprint: change.expectedFingerprint,
      request: prepared,
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

  // Discovery reads no config, so it goes first: the merge needs its
  // declarations, and classifying what it could not publish needs the merge.
  const discovery = discoverRuntimePluginCatalog({
    storeRoot: home.runtimeLocation.homeRoot,
  });
  const sections = createRuntimeConfigSections({
    plugins: manifestsOf(discovery.catalogEntries),
  });
  const layeredConfig = createLayeredProject02RuntimeConfigSnapshot({
    loadedConfig: loaded,
    sections,
  });
  const catalog = classifyRuntimePluginCatalogDiscovery({
    discovery,
    classificationConfig: layeredConfig.effective,
  });
  const defaultEnabledSectionIds = {
    plugins: new Set(catalog.defaultEnabledPluginIds),
  };
  // Location-free: the global document resolves through no character.
  const resolution = resolveRuntimeSectionConfigs({
    config: layeredConfig.effective.config,
    target: 'global',
    sections,
    validateInactiveSectionConfigs: true,
    defaultEnabledSectionIds,
  });

  return {
    layeredConfig,
    targetScope: 'global',
    sections,
    // As a character's resolution does, it carries what the merge left out.
    sectionResolution: {
      ...resolution,
      diagnostics: [
        ...layeredConfig.effective.diagnostics,
        ...resolution.diagnostics,
      ],
    },
    diagnostics: [
      ...layeredConfig.effective.diagnostics,
      ...catalog.diagnostics,
      ...resolution.diagnostics,
    ],
    fingerprint: createRuntimeConfigFingerprint(
      createRuntimeConfigAuthoredSnapshot(loaded).document,
      sections,
    ),
    // No character is activated here, so every section judges its own.
    sectionActivations: {},
    defaultEnabledSectionIds,
  };
}

function resolveCharacterScope(
  home: Project02Home,
  characterId: string,
): ScopeResolution | RefusedView {
  const missing = notInstalled(home, characterId);

  if (missing !== undefined) {
    return refusedView('unknown_character', missing);
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
  });

  if (startup.status === 'character_invalid') {
    return refusedView(
      'config_unloadable',
      startup.characterActivation.status === 'failed'
        ? startup.characterActivation.messages.join(' ')
        : `Character "${characterId}" could not be resolved.`,
    );
  }

  const plan = startup.activationPlan;
  const {activationByPluginId, defaultEnabledPluginIds = []} =
    plan.pluginConfigControl;
  const sections = createRuntimeConfigSections({
    plugins: manifestsOf(plan.catalogEntries),
  });

  return {
    // The overlay the plan was made from — for a never-started character
    // the one its first start writes — so a toggle and its status agree.
    layeredConfig: createLayeredProject02RuntimeConfigSnapshot({
      loadedConfig: home.loadedConfig,
      overlayConfig: startup.overlayLoadedConfig ?? overlay,
      sections,
    }),
    targetScope: 'character',
    sections,
    sectionResolution: plan.resolvedConfig,
    // The activation carries what the runtime acts on: the resolution's
    // diagnostics that concern the character, and what the catalog could
    // not publish. The rest of the resolution, of the sections resolved
    // beside the character, is the person's to read here too.
    diagnostics: [
      ...plan.activation.diagnostics,
      ...plan.resolvedConfig.diagnostics.filter(
        diagnostic => !runtimeConfigDiagnosticConcernsCharacter(diagnostic),
      ),
    ],
    fingerprint: layeredRuntimeConfigFingerprintForScope({
      globalConfig: createRuntimeConfigAuthoredSnapshot(home.loadedConfig)
        .document,
      characterScope: runtimeLocation.characterScope,
      overlay,
      sections,
    }),
    sectionActivations:
      activationByPluginId === undefined ? {} : {plugins: activationByPluginId},
    defaultEnabledSectionIds: {plugins: new Set(defaultEnabledPluginIds)},
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
      }).filter(field =>
        project02RuntimeConfigFieldDefinitions().some(
          wire => wire.name === field.name,
        ),
      ),
    ),
    sections: Object.freeze(
      runtimeConfigSectionNamespaces.flatMap(namespace =>
        resolution.sections[namespace]
          // A section whose switch a target may not set is not its to show.
          .filter(declaration =>
            runtimeSectionValueAuthorable({declaration, target: targetScope}),
          )
          .map(declaration =>
            sectionViewOf(resolution, namespace, declaration),
          ),
      ),
    ),
  });
}

/** A section as the target's screen shows it, and as a connector's read judges it. */
export function sectionViewOf(
  resolution: ScopeResolution,
  namespace: RuntimeConfigSectionNamespace,
  declaration: RuntimeConfigSectionDeclaration,
): RuntimeConfigSectionInspectShape {
  const activation = resolution.sectionActivations[namespace]?.[declaration.id];
  const defaultEnabled = resolution.defaultEnabledSectionIds[namespace]?.has(
    declaration.id,
  );

  return createRuntimeSectionConfigInspectShape({
    layeredConfig: resolution.layeredConfig,
    targetScope: resolution.targetScope,
    sectionResolution: resolution.sectionResolution,
    namespace,
    declaration,
    fingerprint: resolution.fingerprint,
    ...(activation === undefined ? {} : {activation}),
    ...(defaultEnabled === undefined ? {} : {defaultEnabled}),
  });
}

/** A wire operation becomes the control seam's own request, ids resolved. */
function prepareControlRequest(
  operation: ConfigChange['operation'],
  sections: RuntimeConfigSections,
): RuntimeConfigControlRequest | string {
  if (operation.kind === 'set' || operation.kind === 'unset') {
    if (
      !project02RuntimeConfigFieldDefinitions().some(
        field => field.path === operation.path,
      )
    ) {
      return (
        `Unknown config field "${operation.path}". Fields: ` +
        `${project02RuntimeConfigFieldDefinitions()
          .map(field => field.path)
          .join(', ')}.`
      );
    }

    return {kind: 'document', operation};
  }

  const declaration = sections[operation.namespace].find(
    candidate => candidate.id === operation.id,
  );

  if (declaration === undefined) {
    return `Section "${operation.id}" under ${operation.namespace} does not exist.`;
  }

  if (operation.kind === 'section_enabled') {
    return {
      kind: 'section_activation',
      namespace: operation.namespace,
      declaration,
      ...(operation.enabled === undefined ? {} : {enabled: operation.enabled}),
    };
  }

  return {
    kind: 'section_field',
    namespace: operation.namespace,
    declaration,
    actor: 'operator',
    fieldOperation:
      operation.kind === 'section_field_set'
        ? {kind: 'set', fieldName: operation.field, value: operation.value}
        : {kind: 'unset', fieldName: operation.field},
  };
}

async function resolveWriteTarget(options: {
  readonly home: Project02Home;
  readonly target: ConfigTarget;
  readonly sections: RuntimeConfigSections;
  readonly request: RuntimeConfigControlRequest;
  readonly expectedFingerprint: string;
}): Promise<ResolvedRuntimeConfigScopeTarget | RefusedChange> {
  const {home, target} = options;

  if (target.scope === 'global') {
    return resolveRuntimeConfigScopeTarget({
      runtimeLocation: home.runtimeLocation,
      scope: 'global',
    });
  }

  const missing = notInstalled(home, target.characterId);

  if (missing !== undefined) {
    return refusedChange('unknown_character', missing);
  }

  const scopeTarget = resolveRuntimeConfigScopeTarget({
    runtimeLocation: bindProject02CharacterRuntimeLocation({
      configLocation: home.runtimeLocation,
      characterId: target.characterId,
    }),
    scope: 'character',
  });
  // The commit's own preparation and expectation check, run without
  // locking or writing, so a change the seam will refuse creates no data
  // directory for a character that never started.
  const candidate = simulateCharacterOverlayCandidate({
    target: scopeTarget,
    sections: options.sections,
    request: options.request,
    expectedFingerprint: options.expectedFingerprint,
  });

  if (candidate.status !== 'valid') {
    return refusedChange(candidate.status, candidate.message);
  }

  // A character's first valid write claims its data directory, as its
  // first start does; the transaction then verifies the marker under its lock.
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
    error instanceof LocalRuntimeStorageContractError
  );
}

/**
 * The resolution a start uses, so a package that fails discovery is
 * reported by its own diagnostic, never as a character that is missing.
 */
function notInstalled(
  home: Project02Home,
  characterId: string,
): string | undefined {
  const resolution = prepareProject02CharacterActivation({
    storeRoot: home.runtimeLocation.homeRoot,
    configuredCharacterId: characterId,
  });

  return resolution.status === 'failed'
    ? resolution.messages.join(' ')
    : undefined;
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
