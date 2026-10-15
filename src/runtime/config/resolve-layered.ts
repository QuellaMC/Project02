/**
 * Layer precedence: plugin defaults, then global config, then the overlay,
 * each value taken only from the layers its scope permits.
 */
import type {RuntimeConfigFieldDeclaration} from '../../plugins/api/index.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import type {LoadedProject02CharacterOverlayConfig} from './overlay.ts';
import {
  resolveEffectiveProject02RuntimeConfig,
  type ResolveProject02RuntimeConfigOptions,
} from './resolve.ts';
import {
  runtimeSectionScopeDiagnostics,
  runtimeSectionSupplyingLayer,
  type RuntimeSectionLayers,
} from './section-scope.ts';
import {withRuntimeConfigDiagnosticOrigin} from './diagnostic.ts';
import {
  runtimeConfigSectionNamespaces,
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02HostConfig,
  type Project02RuntimeConfig,
  type Project02RuntimeSectionConfig,
  type ResolvedProject02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigSectionDeclaration,
  type RuntimeConfigSectionMap,
  type RuntimeConfigSections,
  type RuntimeConfigValue,
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

/**
 * Keeps authored layers so ownership is never re-derived from the merge.
 * Given an overlay it is that character's effective document; given none,
 * the home's.
 */
export function createLayeredProject02RuntimeConfigSnapshot(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly overlayConfig?: LoadedProject02CharacterOverlayConfig;
  readonly sections: RuntimeConfigSections;
}): LayeredProject02RuntimeConfigSnapshot {
  const {loadedConfig, overlayConfig, sections} = options;
  const globalConfig = loadedConfig.config;
  const characterConfig = overlayConfig?.config;
  const effective = Object.freeze({
    ...(globalConfig === undefined && characterConfig === undefined
      ? {}
      : {
          config: mergeCharacterOverlayDocument({
            globalConfig,
            ...(characterConfig === undefined ? {} : {characterConfig}),
            sections,
          }),
        }),
    diagnostics: Object.freeze([
      ...loadedConfig.diagnostics,
      ...(overlayConfig?.diagnostics ?? []),
      // Judged per raw layer: the merge has already left out what they find.
      ...runtimeSectionScopeDiagnostics({
        config: globalConfig,
        sections,
        authoredScope: 'global',
      }),
      ...(overlayConfig === undefined
        ? []
        : runtimeSectionScopeDiagnostics({
            config: characterConfig,
            sections,
            authoredScope: 'character',
          }).map(diagnostic =>
            withRuntimeConfigDiagnosticOrigin(diagnostic, {
              scope: 'character',
              characterId: overlayConfig.characterId,
              ...(overlayConfig.path === undefined
                ? {}
                : {path: overlayConfig.path}),
            }),
          )),
    ]),
  } satisfies EffectiveProject02RuntimeConfigSnapshot);

  return Object.freeze({
    ...(globalConfig === undefined ? {} : {globalConfig}),
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
    sections: effectiveOptions.sections,
  });

  return Object.freeze({
    layeredConfig,
    resolvedConfig: resolveEffectiveProject02RuntimeConfig({
      ...effectiveOptions,
      config: layeredConfig.effective.config,
      source: loadedConfig.source,
      ...(loadedConfig.path === undefined ? {} : {path: loadedConfig.path}),
      diagnostics: layeredConfig.effective.diagnostics,
    }),
  });
}

/**
 * A character's effective document, and with no overlay the home's.
 * Exported so candidate validation judges exactly what the resolver sees.
 */
export function mergeCharacterOverlayDocument(options: {
  readonly globalConfig: Project02RuntimeConfig | undefined;
  readonly characterConfig?: Project02RuntimeConfig;
  readonly sections: RuntimeConfigSections;
}): Project02RuntimeConfig {
  const project02 = mergedProject02Section(
    options.globalConfig?.project02,
    options.characterConfig?.project02,
  );
  let sections: Partial<
    RuntimeConfigSectionMap<Project02RuntimeSectionConfig>
  > = {};

  for (const namespace of runtimeConfigSectionNamespaces) {
    const merged = mergedSectionConfigs({
      globalSections: options.globalConfig?.[namespace],
      characterSections: options.characterConfig?.[namespace],
      declarations: options.sections[namespace],
    });

    if (merged !== undefined) {
      sections = {...sections, [namespace]: merged};
    }
  }

  return Object.freeze({
    version: runtimeConfigVersion,
    ...(project02 === undefined ? {} : {project02}),
    ...sections,
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

function mergedSectionConfigs(options: {
  readonly globalSections:
    Readonly<Record<string, Project02RuntimeSectionConfig>> | undefined;
  readonly characterSections:
    Readonly<Record<string, Project02RuntimeSectionConfig>> | undefined;
  readonly declarations: readonly RuntimeConfigSectionDeclaration[];
}): Readonly<Record<string, Project02RuntimeSectionConfig>> | undefined {
  const {globalSections, characterSections} = options;

  if (globalSections === undefined && characterSections === undefined) {
    return undefined;
  }

  const ids = [
    ...new Set([
      ...Object.keys(globalSections ?? {}),
      ...Object.keys(characterSections ?? {}),
    ]),
  ].sort((a, b) => a.localeCompare(b));

  return Object.freeze(
    Object.fromEntries(
      ids.map(id => [
        id,
        mergedSection(
          options.declarations.find(declaration => declaration.id === id),
          {
            global: ownJsonRecordValue(globalSections, id),
            character: ownJsonRecordValue(characterSections, id),
          },
        ),
      ]),
    ),
  );
}

/**
 * A declared switch or field takes the value of the layer its scope lets
 * supply it. What no declaration describes, an unknown id or field, keeps
 * the overlay over the home, so its diagnostics keep their evidence.
 */
function mergedSection(
  declaration: RuntimeConfigSectionDeclaration | undefined,
  layers: RuntimeSectionLayers,
): Project02RuntimeSectionConfig {
  const {global, character} = layers;
  const overlayOverHome =
    global?.config === undefined && character?.config === undefined
      ? undefined
      : {...global?.config, ...character?.config};
  const enabled =
    declaration === undefined
      ? (character?.enabled ?? global?.enabled)
      : suppliedSection(declaration, undefined, layers)?.enabled;
  const config =
    overlayOverHome === undefined || declaration === undefined
      ? overlayOverHome
      : Object.fromEntries(
          Object.keys(overlayOverHome).flatMap(
            (name): [string, RuntimeConfigValue][] => {
              const field = declaration.config.fields.find(
                candidate => candidate.name === name,
              );
              const value =
                field === undefined
                  ? overlayOverHome[name]
                  : ownJsonRecordValue(
                      suppliedSection(declaration, field, layers)?.config,
                      name,
                    );

              return value === undefined ? [] : [[name, value]];
            },
          ),
        );

  return Object.freeze({
    ...(enabled === undefined ? {} : {enabled}),
    ...(config === undefined ? {} : {config: Object.freeze(config)}),
  } satisfies Project02RuntimeSectionConfig);
}

function suppliedSection(
  declaration: RuntimeConfigSectionDeclaration,
  field: RuntimeConfigFieldDeclaration | undefined,
  layers: RuntimeSectionLayers,
): Project02RuntimeSectionConfig | undefined {
  const layer = runtimeSectionSupplyingLayer({
    declaration,
    ...(field === undefined ? {} : {field}),
    layers,
  });

  return layer === undefined ? undefined : layers[layer];
}
