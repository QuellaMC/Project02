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
  };

export function resolveLayeredProject02RuntimeConfig(
  options: ResolveLayeredProject02RuntimeConfigOptions,
): ResolvedProject02RuntimeConfig {
  const {overlayConfig, ...globalOptions} = options;

  // No overlay file and nothing to report: the layered resolve is the
  // global resolve, fingerprint included.
  if (
    overlayConfig === undefined ||
    (overlayConfig.config === undefined &&
      overlayConfig.diagnostics.length === 0)
  ) {
    return resolveProject02RuntimeConfig(globalOptions);
  }

  const globalDocument = globalOptions.loadedConfig.config;
  const merged =
    overlayConfig.config === undefined
      ? globalDocument
      : mergeCharacterOverlayDocument(globalDocument, overlayConfig.config);

  return resolveProject02RuntimeConfig({
    ...globalOptions,
    loadedConfig: Object.freeze({
      source: globalOptions.loadedConfig.source,
      ...(globalOptions.loadedConfig.path === undefined
        ? {}
        : {path: globalOptions.loadedConfig.path}),
      ...(merged === undefined ? {} : {config: merged}),
      diagnostics: Object.freeze([
        ...globalOptions.loadedConfig.diagnostics,
        ...overlayConfig.diagnostics,
      ]),
    } satisfies LoadedProject02RuntimeConfig),
  });
}

function mergeCharacterOverlayDocument(
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
