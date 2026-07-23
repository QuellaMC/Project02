/**
 * Layered config resolution: plugin-manifest defaults < global config <
 * character overlay. The merge produces one plain runtime-config
 * document and delegates to the untouched global resolver, so every
 * downstream consumer keeps seeing exactly one config shape. The merged
 * document keeps the global path and store root: an overlay can only
 * override the character-scoped project02 fields plus per-plugin
 * enablement and field-level plugin config.
 */
import type {LoadedProject02CharacterOverlayConfig} from './overlay.ts';
import {
  resolveProject02RuntimeConfig,
  type ResolveProject02RuntimeConfigOptions,
} from './resolve.ts';
import {project02RuntimeConfigFieldDefinitions} from './schema.ts';
import {runtimePluginScopeDiagnostics} from './plugin-scope.ts';
import {withRuntimeConfigDiagnosticOrigin} from './diagnostic.ts';
import {
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02HostConfig,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type ResolvedProject02RuntimeConfig,
  type RuntimeConfigValue,
} from './types.ts';

export type ResolveLayeredProject02RuntimeConfigOptions =
  ResolveProject02RuntimeConfigOptions & {
    readonly overlayConfig?: LoadedProject02CharacterOverlayConfig;
    /**
     * Active character override (e.g. a --character flag): stamped into
     * the merged document's project02.character so the resolved config
     * — data root, fingerprint, everything downstream — follows the
     * flag, not the authored global selection.
     */
    readonly characterId?: string;
  };

export function resolveLayeredProject02RuntimeConfig(
  options: ResolveLayeredProject02RuntimeConfigOptions,
): ResolvedProject02RuntimeConfig {
  const {overlayConfig, characterId, ...globalOptions} = options;

  // No overlay file, no override, nothing to report: the layered
  // resolve is the global resolve, fingerprint included.
  if (
    (overlayConfig === undefined ||
      (overlayConfig.config === undefined &&
        overlayConfig.diagnostics.length === 0)) &&
    characterId === undefined
  ) {
    return resolveProject02RuntimeConfig(globalOptions);
  }

  const merged =
    overlayConfig === undefined
      ? globalOptions.loadedConfig
      : mergedLoadedConfigForOverlay(globalOptions.loadedConfig, overlayConfig);
  const manifests = globalOptions.pluginManifests ?? [];
  const scopeDiagnostics =
    overlayConfig === undefined
      ? runtimePluginScopeDiagnostics({
          config: globalOptions.loadedConfig.config,
          manifests,
          authoredScope: 'global',
        })
      : [
          ...runtimePluginScopeDiagnostics({
            config: globalOptions.loadedConfig.config,
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
              ...(overlayConfig.path === undefined
                ? {}
                : {path: overlayConfig.path}),
            }),
          ),
        ];
  const scopedMerged = Object.freeze({
    ...merged,
    diagnostics: Object.freeze([...merged.diagnostics, ...scopeDiagnostics]),
  } satisfies LoadedProject02RuntimeConfig);

  return resolveProject02RuntimeConfig({
    ...globalOptions,
    skipPluginScopeValidation: true,
    loadedConfig:
      characterId === undefined
        ? scopedMerged
        : withActiveCharacter(scopedMerged, characterId),
  });
}

function withActiveCharacter(
  loadedConfig: LoadedProject02RuntimeConfig,
  characterId: string,
): LoadedProject02RuntimeConfig {
  return Object.freeze({
    ...loadedConfig,
    config: Object.freeze({
      version: runtimeConfigVersion,
      ...loadedConfig.config,
      project02: Object.freeze({
        ...loadedConfig.config?.project02,
        character: characterId,
      }),
    } satisfies Project02RuntimeConfig),
  });
}

/**
 * The loaded-config view over both layers: the merged document plus the
 * combined diagnostics, with the global path kept. The resolver and the
 * activation ladder both judge this one shape, so an overlay's explicit
 * enablement rung carries the same weight as a global one.
 */
export function mergedLoadedConfigForOverlay(
  loadedConfig: LoadedProject02RuntimeConfig,
  overlayConfig: LoadedProject02CharacterOverlayConfig,
): LoadedProject02RuntimeConfig {
  const globalDocument = loadedConfig.config;
  const merged =
    overlayConfig.config === undefined
      ? globalDocument
      : mergeCharacterOverlayDocument(globalDocument, overlayConfig.config);

  return Object.freeze({
    source: loadedConfig.source,
    ...(loadedConfig.path === undefined ? {} : {path: loadedConfig.path}),
    ...(merged === undefined ? {} : {config: merged}),
    diagnostics: Object.freeze([
      ...loadedConfig.diagnostics,
      ...overlayConfig.diagnostics,
    ]),
  } satisfies LoadedProject02RuntimeConfig);
}

/**
 * Merges one overlay document over the global document; exported for
 * scope-aware candidate validation, which must judge exactly what the
 * layered resolver would see.
 */
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
  if (overlaySection === undefined) {
    return globalSection;
  }

  const merged: Record<string, RuntimeConfigValue | undefined> = {
    ...globalSection,
  };

  // Only character-scoped fields cross from the overlay. The loader has
  // already rejected the rest; the merge does not trust it anyway.
  for (const field of project02RuntimeConfigFieldDefinitions()) {
    const value = overlaySection[field.name];

    if (!field.scopes.includes('character') || value === undefined) {
      continue;
    }

    merged[field.name] = value;
  }

  return Object.freeze(merged);
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
