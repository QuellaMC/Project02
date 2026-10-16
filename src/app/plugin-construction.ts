import {
  createRuntimePluginFileStore,
  type RuntimePluginFileStoreProvider,
} from '../runtime/storage/index.ts';
import {
  createRuntimePluginContext,
  runRuntimePluginSessionEndHooksForTargets,
  runRuntimePluginShutdownHooksForTargets,
  runtimePluginAccessSnapshot,
  runtimePluginLifecycleTarget,
  type RuntimePlugin,
  type RuntimePluginAccessSnapshot,
  type RuntimePluginCatalogEntry,
  type RuntimePluginLifecycleTarget,
  type RuntimePluginSessionEndOptions,
} from '../plugins/index.ts';
import {
  type ResolvedProject02RuntimeConfig,
  type ResolvedProject02RuntimeLocation,
} from '../runtime/config/index.ts';
import {ownJsonRecordValue} from '../shared/json-boundary.ts';

export const configuredRuntimePluginFileStoreProvider: RuntimePluginFileStoreProvider =
  Object.freeze({
    createFileStore: createRuntimePluginFileStore,
  });

type InstantiatedRuntimePluginPackages = {
  readonly plugins: readonly RuntimePlugin[];
  readonly lifecycleTargets: readonly RuntimePluginLifecycleTarget[];
  readonly accessByPluginId: Readonly<
    Record<string, RuntimePluginAccessSnapshot>
  >;
};

export async function instantiateRuntimePluginPackages(options: {
  readonly catalogEntries: Readonly<Record<string, RuntimePluginCatalogEntry>>;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly enabledPluginIds: readonly string[];
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions | undefined;
}): Promise<InstantiatedRuntimePluginPackages> {
  const lifecycleTargets: RuntimePluginLifecycleTarget[] = [];
  const accessByPluginId: Record<string, RuntimePluginAccessSnapshot> = {};
  const enabledPluginIds = new Set(options.enabledPluginIds);
  const retainCandidate = (
    plugin: RuntimePlugin,
    entry: RuntimePluginCatalogEntry,
  ): void => {
    lifecycleTargets.push(runtimePluginLifecycleTarget(plugin, entry.manifest));
    accessByPluginId[entry.manifest.id] = runtimePluginAccessSnapshot({
      requestedAccess: entry.manifest.requestedAccess,
      enabled: true,
      fieldPrefix: entry.manifest.id,
    });
  };

  try {
    for (const entry of Object.values(options.catalogEntries)) {
      if (
        entry.catalogKind === 'host_service' ||
        !enabledPluginIds.has(entry.manifest.id)
      ) {
        continue;
      }

      const plugin = await entry.load(
        {
          pluginId: entry.manifest.id,
          manifest: entry.manifest,
          storeRoot: options.runtimeLocation.characterScope.dataRoot,
          characterId: options.runtimeLocation.characterScope.characterId,
          userDisplayName: options.resolvedConfig.project02.userDisplayName,
          resolvedConfig:
            ownJsonRecordValue(
              options.resolvedConfig.sectionConfigs.plugins,
              entry.manifest.id,
            ) ?? {},
          redactedConfig:
            ownJsonRecordValue(
              options.resolvedConfig.redactedSectionConfigs.plugins,
              entry.manifest.id,
            ) ?? {},
        },
        {
          retainRejectedCandidate: candidate => {
            retainCandidate(candidate, entry);
          },
        },
      );
      retainCandidate(plugin, entry);
    }
  } catch (error: unknown) {
    await cleanupPartiallyInstantiatedPlugins({
      targets: lifecycleTargets,
      accessByPluginId,
      runtimeLocation: options.runtimeLocation,
      sessionId: options.sessionId,
      sessionIdentity: options.sessionIdentity,
      constructionCleanup: options.constructionCleanup,
    });
    throw error;
  }

  return Object.freeze({
    plugins: Object.freeze(lifecycleTargets.map(target => target.plugin)),
    lifecycleTargets: Object.freeze([...lifecycleTargets]),
    accessByPluginId: Object.freeze({...accessByPluginId}),
  });
}

export async function cleanupPartiallyInstantiatedPlugins(options: {
  readonly targets: readonly RuntimePluginLifecycleTarget[];
  readonly accessByPluginId: Readonly<
    Record<string, RuntimePluginAccessSnapshot>
  >;
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly constructionCleanup?: RuntimePluginSessionEndOptions | undefined;
}): Promise<void> {
  if (options.targets.length === 0) {
    return;
  }

  const sessionId =
    options.sessionId ?? configuredPluginConstructionCleanupSessionId;
  const context = createRuntimePluginContext({
    eventId: 'evt_configured_plugin_construction_cleanup',
    traceId: 'trace_configured_plugin_construction_cleanup',
    createdAt: '1970-01-01T00:00:00.000Z',
    sessionId,
    eventType: 'USER_MESSAGE',
    currentUserMessage: configuredPluginConstructionCleanupMessage,
    character: configuredPluginConstructionCleanupCharacter,
  });

  try {
    await runRuntimePluginSessionEndHooksForTargets({
      targets: options.targets,
      accessByPluginId: options.accessByPluginId,
      context,
      storeRoot: options.runtimeLocation.characterScope.dataRoot,
      createFileStore: configuredRuntimePluginFileStoreProvider.createFileStore,
      sessionId,
      sessionIdentity: options.sessionIdentity,
      hookOptions: {
        ...options.constructionCleanup,
        allowFileStoreWrites: false,
      },
    });
  } catch {
    // Cleanup is best-effort and must not mask the construction error.
  }

  try {
    await runRuntimePluginShutdownHooksForTargets({
      targets: options.targets,
      accessByPluginId: options.accessByPluginId,
      context,
      storeRoot: options.runtimeLocation.characterScope.dataRoot,
      createFileStore: configuredRuntimePluginFileStoreProvider.createFileStore,
      sessionId,
      sessionIdentity: options.sessionIdentity,
    });
  } catch {
    // Shutdown is best-effort and must not mask the construction error.
  }
}

/** Cleanup context for plugin lifecycles that end before a session exists. */
export const configuredPluginConstructionCleanupSessionId =
  'configured-plugin-construction-cleanup';
const configuredPluginConstructionCleanupMessage =
  'configured plugin construction failed before host creation';
const configuredPluginConstructionCleanupCharacter = Object.freeze({
  id: 'project02-runtime-config',
  displayName: 'Project02 Runtime Config',
});
