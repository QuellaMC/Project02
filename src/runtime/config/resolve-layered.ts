/** Layer precedence: plugin defaults, then global config, then the overlay. */
import type {LoadedProject02CharacterOverlayConfig} from './overlay.ts';
import {
  resolveEffectiveProject02RuntimeConfig,
  type ResolveProject02RuntimeConfigOptions,
} from './resolve.ts';
import {runtimePluginScopeDiagnostics} from './plugin-scope.ts';
import {withRuntimeConfigDiagnosticOrigin} from './diagnostic.ts';
import {
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02HostConfig,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type ResolvedProject02RuntimeConfig,
  type RuntimeConfigDiagnostic,
} from './types.ts';

export type EffectiveProject02RuntimeConfigSnapshot = {
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

export type LayeredProject02RuntimeConfigSnapshot = {
  readonly globalConfig?: Project02RuntimeConfig;
  readonly characterConfig?: Project02RuntimeConfig;
  readonly effective: EffectiveProject02RuntimeConfigSnapshot;
};

export type ResolvedLayeredProject02RuntimeConfigSnapshot = {
  readonly layeredConfig: LayeredProject02RuntimeConfigSnapshot;
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
};

export type ResolveLayeredProject02RuntimeConfigOptions =
  ResolveProject02RuntimeConfigOptions & {
    readonly overlayConfig?: LoadedProject02CharacterOverlayConfig;
  };

/** Keeps authored layers so ownership is never re-derived from the merge. */
export function createLayeredProject02RuntimeConfigSnapshot(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly overlayConfig?: LoadedProject02CharacterOverlayConfig;
}): LayeredProject02RuntimeConfigSnapshot {
  const characterConfig = options.overlayConfig?.config;
  const effectiveConfig =
    characterConfig === undefined
      ? options.loadedConfig.config
      : mergeCharacterOverlayDocument(
          options.loadedConfig.config,
          characterConfig,
        );
  const effective = Object.freeze({
    ...(effectiveConfig === undefined ? {} : {config: effectiveConfig}),
    diagnostics: Object.freeze([
      ...options.loadedConfig.diagnostics,
      ...(options.overlayConfig?.diagnostics ?? []),
    ]),
  } satisfies EffectiveProject02RuntimeConfigSnapshot);

  return Object.freeze({
    ...(options.loadedConfig.config === undefined
      ? {}
      : {globalConfig: options.loadedConfig.config}),
    ...(characterConfig === undefined ? {} : {characterConfig}),
    effective,
  });
}

export function resolveLayeredProject02RuntimeConfig(
  options: ResolveLayeredProject02RuntimeConfigOptions,
): ResolvedProject02RuntimeConfig {
  return resolveLayeredProject02RuntimeConfigWithSnapshot(options)
    .resolvedConfig;
}

export function resolveLayeredProject02RuntimeConfigWithSnapshot(
  options: ResolveLayeredProject02RuntimeConfigOptions,
): ResolvedLayeredProject02RuntimeConfigSnapshot {
  const {overlayConfig, loadedConfig, ...effectiveOptions} = options;
  const layeredConfig = createLayeredProject02RuntimeConfigSnapshot({
    loadedConfig,
    ...(overlayConfig === undefined ? {} : {overlayConfig}),
  });
  const source = loadedConfig.source;
  const path = loadedConfig.path;

  // With no overlay this must equal the global resolve, fingerprint included.
  if (
    overlayConfig === undefined ||
    (overlayConfig.config === undefined &&
      overlayConfig.diagnostics.length === 0)
  ) {
    return Object.freeze({
      layeredConfig,
      resolvedConfig: resolveEffectiveProject02RuntimeConfig({
        ...effectiveOptions,
        config: layeredConfig.effective.config,
        source,
        ...(path === undefined ? {} : {path}),
        diagnostics: layeredConfig.effective.diagnostics,
      }),
    });
  }

  const manifests = effectiveOptions.pluginManifests ?? [];
  const scopeDiagnostics = [
    ...runtimePluginScopeDiagnostics({
      config: loadedConfig.config,
      manifests,
      authoredScope: 'global',
    }),
    ...runtimePluginScopeDiagnostics({
      config: overlayConfig.config,
      manifests,
      authoredScope: 'character',
    }).map(diagnostic =>
      withRuntimeConfigDiagnosticOrigin(diagnostic, {
        scope: 'character',
        characterId: overlayConfig.characterId,
        ...(overlayConfig.path === undefined ? {} : {path: overlayConfig.path}),
      }),
    ),
  ];

  return Object.freeze({
    layeredConfig,
    resolvedConfig: resolveEffectiveProject02RuntimeConfig({
      ...effectiveOptions,
      config: layeredConfig.effective.config,
      source,
      ...(path === undefined ? {} : {path}),
      diagnostics: Object.freeze([
        ...layeredConfig.effective.diagnostics,
        ...scopeDiagnostics,
      ]),
      skipPluginScopeValidation: true,
    }),
  });
}

/** Exported so candidate validation judges exactly what the resolver sees. */
export function mergeCharacterOverlayDocument(
  globalDocument: Project02RuntimeConfig | undefined,
  overlayDocument: Project02RuntimeConfig,
): Project02RuntimeConfig {
  const project02 = mergedProject02Section(
    globalDocument?.project02,
    overlayDocument.project02,
  );
  const plugins = mergedPluginSections(
    globalDocument?.plugins,
    overlayDocument.plugins,
  );

  return Object.freeze({
    version: runtimeConfigVersion,
    ...(project02 === undefined ? {} : {project02}),
    ...(plugins === undefined ? {} : {plugins}),
  } satisfies Project02RuntimeConfig);
}

function mergedProject02Section(
  globalSection: Project02HostConfig | undefined,
  overlaySection: Project02HostConfig | undefined,
): Project02HostConfig | undefined {
  return overlaySection === undefined
    ? globalSection
    : Object.freeze({...globalSection, ...overlaySection});
}

function mergedPluginSections(
  globalSection:
    Readonly<Record<string, Project02RuntimePluginConfig>> | undefined,
  overlaySection:
    Readonly<Record<string, Project02RuntimePluginConfig>> | undefined,
): Readonly<Record<string, Project02RuntimePluginConfig>> | undefined {
  if (overlaySection === undefined) {
    return globalSection;
  }

  const pluginIds = [
    ...new Set([
      ...Object.keys(globalSection ?? {}),
      ...Object.keys(overlaySection),
    ]),
  ].sort((a, b) => a.localeCompare(b));

  return Object.freeze(
    Object.fromEntries(
      pluginIds.map(pluginId => {
        const globalPlugin = globalSection?.[pluginId];
        const overlayPlugin = overlaySection[pluginId];
        const enabled = overlayPlugin?.enabled ?? globalPlugin?.enabled;
        const config =
          globalPlugin?.config === undefined &&
          overlayPlugin?.config === undefined
            ? undefined
            : Object.freeze({
                ...globalPlugin?.config,
                ...overlayPlugin?.config,
              });

        return [
          pluginId,
          Object.freeze({
            ...(enabled === undefined ? {} : {enabled}),
            ...(config === undefined ? {} : {config}),
          } satisfies Project02RuntimePluginConfig),
        ];
      }),
    ),
  );
}
