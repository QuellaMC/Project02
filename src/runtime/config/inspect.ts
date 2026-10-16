import type {RuntimePluginAccessMap} from '../../plugins/api/index.ts';
import type {
  ResolvedProject02RuntimeConfig,
  RuntimeConfigInspectShape,
  RuntimeConfigEffectiveSource,
  RuntimeConfigFieldInspectShape,
  RuntimeConfigFieldScope,
  RuntimeConfigSectionActivationShape,
  RuntimeConfigSectionDeclaration,
  RuntimeConfigSectionInspectShape,
  RuntimeConfigSectionMap,
  RuntimeConfigSectionNamespace,
  RuntimeConfigValue,
} from './types.ts';
import type {LayeredProject02RuntimeConfigSnapshot} from './resolve-layered.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {getRedactedRuntimeConfigValueAtPath} from './mutate.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import {
  runtimeConfigDiagnosticMatchesSection,
  unauthoredRuntimeConfigField,
  type ResolvedRuntimeSectionConfigs,
} from './resolve.ts';
import {project02RuntimeConfigFieldDefinitions} from './schema.ts';
import {
  runtimeSectionSupplyingLayer,
  runtimeSectionValueAuthorable,
} from './section-scope.ts';

export function createRuntimeConfigInspectShape(
  resolvedConfig: ResolvedProject02RuntimeConfig,
): RuntimeConfigInspectShape {
  return Object.freeze({
    source: resolvedConfig.source,
    ...(resolvedConfig.path === undefined ? {} : {path: resolvedConfig.path}),
    project02: Object.freeze({
      ...resolvedConfig.project02,
      ...(resolvedConfig.project02.nvidiaApiKey === undefined
        ? {}
        : {nvidiaApiKey: '[redacted]'}),
    }),
    diagnostics: Object.freeze([...resolvedConfig.diagnostics]),
    fingerprint: resolvedConfig.effectiveConfigFingerprint,
  } satisfies RuntimeConfigInspectShape);
}

export function createRuntimeSectionConfigInspectShape(options: {
  readonly layeredConfig: LayeredProject02RuntimeConfigSnapshot;
  readonly targetScope: RuntimeConfigFieldScope;
  /** The sections' half of a resolution; a location-free one serves too. */
  readonly sectionResolution: Pick<
    ResolvedRuntimeSectionConfigs,
    'redactedSectionConfigs' | 'diagnostics'
  >;
  readonly namespace: RuntimeConfigSectionNamespace;
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly fingerprint: string;
  readonly activation?: RuntimeConfigSectionActivationShape;
  readonly defaultEnabled?: boolean;
}): RuntimeConfigSectionInspectShape {
  const {namespace, declaration} = options;
  const layers = {
    global: ownJsonRecordValue(
      options.layeredConfig.globalConfig?.[namespace],
      declaration.id,
    ),
    character: ownJsonRecordValue(
      options.layeredConfig.characterConfig?.[namespace],
      declaration.id,
    ),
  };
  const authoredSection = layers[options.targetScope];
  const effectiveSection = ownJsonRecordValue(
    options.layeredConfig.effective.config?.[namespace],
    declaration.id,
  );
  const effectiveFields = ownJsonRecordValue(
    options.sectionResolution.redactedSectionConfigs[namespace],
    declaration.id,
  );

  if (effectiveFields === undefined) {
    throw new TypeError(
      `Resolved runtime config is missing manifest metadata for plugin "${declaration.id}".`,
    );
  }

  const configuredEnabled =
    (options.targetScope === 'character'
      ? effectiveSection?.enabled
      : authoredSection?.enabled) ??
    options.defaultEnabled ??
    declaration.activation.defaultEnabled;
  const enabledSource: RuntimeConfigEffectiveSource =
    runtimeSectionSupplyingLayer({declaration, layers}) ?? 'default';
  const diagnostics = Object.freeze(
    options.sectionResolution.diagnostics.filter(
      diagnostic =>
        diagnostic.scope === 'global' ||
        runtimeConfigDiagnosticMatchesSection({
          diagnostic,
          namespace,
          id: declaration.id,
        }),
    ),
  );
  const activation = sectionActivationInspection({
    configuredEnabled,
    diagnostics,
    declaration,
    ...(options.activation === undefined
      ? {}
      : {activation: options.activation}),
  });

  return Object.freeze({
    namespace,
    id: declaration.id,
    displayName: declaration.displayName,
    version: declaration.version,
    enabled: configuredEnabled,
    enabledSource,
    activation,
    fields: Object.freeze(
      declaration.config.fields
        .filter(field =>
          runtimeSectionValueAuthorable({
            declaration,
            field,
            target: options.targetScope,
          }),
        )
        .map(field => {
          const authoredValue = ownJsonRecordValue(
            authoredSection?.config,
            field.name,
          );
          const effective = ownJsonRecordValue(effectiveFields, field.name);

          if (effective === undefined) {
            throw new TypeError(
              `Resolved runtime config is missing field "${field.name}" for plugin "${declaration.id}".`,
            );
          }

          return Object.freeze({
            name: field.name,
            description: field.description,
            required: field.required,
            secret: field.secret,
            ...(field.valueType === undefined
              ? {}
              : {valueType: field.valueType}),
            ...(field.allowedValues === undefined
              ? {}
              : {allowedValues: Object.freeze([...field.allowedValues])}),
            agentMutable: field.agentMutable === true && !field.secret,
            reloadRequired: field.reloadRequired !== false,
            authored: Object.freeze({
              configured: authoredValue !== undefined,
              ...(authoredValue === undefined
                ? {}
                : {
                    value: redactAuthoredPluginConfigValue(
                      authoredValue,
                      field.name,
                      field.secret,
                    ),
                  }),
            }),
            effectiveSource:
              runtimeSectionSupplyingLayer({declaration, field, layers}) ??
              'default',
            effective,
          });
        }),
    ),
    diagnostics,
    fingerprint: options.fingerprint,
  } satisfies RuntimeConfigSectionInspectShape);
}

/**
 * The host fields in the shape plugin fields already take, so a settings
 * page renders one component for both: an unauthored field carries its
 * declared default as its effective value, as a section's field does.
 */
export function createProject02ConfigFieldInspectShapes(options: {
  readonly layeredConfig: LayeredProject02RuntimeConfigSnapshot;
  readonly targetScope: RuntimeConfigFieldScope;
}): readonly RuntimeConfigFieldInspectShape[] {
  const {globalConfig, characterConfig} = options.layeredConfig;
  const targetConfig =
    options.targetScope === 'global' ? globalConfig : characterConfig;

  return Object.freeze(
    project02RuntimeConfigFieldDefinitions().map(field => {
      const authoredValue = getRedactedRuntimeConfigValueAtPath(
        targetConfig,
        field.path,
      );
      const characterValue = getRedactedRuntimeConfigValueAtPath(
        characterConfig,
        field.path,
      );
      const globalValue = getRedactedRuntimeConfigValueAtPath(
        globalConfig,
        field.path,
      );
      const effectiveValue = characterValue ?? globalValue;

      return Object.freeze({
        name: field.name,
        description: field.description,
        required: field.required,
        secret: field.secret,
        ...(field.valueType === undefined ? {} : {valueType: field.valueType}),
        ...(field.allowedValues === undefined
          ? {}
          : {allowedValues: Object.freeze([...field.allowedValues])}),
        agentMutable: field.agentMutable,
        reloadRequired: field.reloadRequired,
        authored: Object.freeze({
          configured: authoredValue !== undefined,
          ...(authoredValue === undefined ? {} : {value: authoredValue}),
        }),
        effectiveSource:
          characterValue !== undefined
            ? 'character'
            : globalValue !== undefined
              ? 'global'
              : 'default',
        effective:
          effectiveValue === undefined
            ? unauthoredRuntimeConfigField(field)
            : Object.freeze({
                name: field.name,
                secret: field.secret,
                source: 'config',
                resolved: true,
                value: effectiveValue,
              }),
      } satisfies RuntimeConfigFieldInspectShape);
    }),
  );
}

function sectionActivationInspection(options: {
  readonly configuredEnabled: boolean;
  readonly diagnostics: RuntimeConfigSectionInspectShape['diagnostics'];
  readonly declaration: RuntimeConfigSectionDeclaration;
  readonly activation?: RuntimeConfigSectionActivationShape;
}): RuntimeConfigSectionActivationShape {
  if (options.activation !== undefined) {
    return Object.freeze({
      enabled: options.activation.enabled,
      status: options.activation.status,
      reasons: Object.freeze([...options.activation.reasons]),
    });
  }

  const blockingDiagnosticCodes = options.diagnostics
    .filter(diagnostic => diagnostic.severity === 'error')
    .map(diagnostic => diagnostic.code);

  if (blockingDiagnosticCodes.length > 0) {
    return Object.freeze({
      enabled: false,
      status: 'blocked',
      reasons: Object.freeze(
        blockingDiagnosticCodes.map(code => `runtime_config_error:${code}`),
      ),
    });
  }

  return Object.freeze({
    enabled: options.configuredEnabled,
    status: options.configuredEnabled ? 'active' : 'disabled',
    reasons: Object.freeze(
      options.configuredEnabled
        ? [
            ...options.declaration.activation.reasons,
            'config_inspection_active',
          ]
        : ['config_inspection_disabled'],
    ),
  });
}

function redactAuthoredPluginConfigValue(
  value: RuntimeConfigValue,
  fieldName: string,
  secret: boolean,
): RuntimeConfigValue {
  return secret
    ? '[redacted]'
    : redactRuntimeConfigValue(value, {key: fieldName});
}

export type InspectConfiguredPlugin = {
  readonly pluginId: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly requestedAccess: RuntimePluginAccessMap;
  readonly grantedAccess: RuntimePluginAccessMap;
  readonly activationStatus: string;
  readonly activationReasons: readonly string[];
  readonly diagnostics: readonly unknown[];
  readonly config?: unknown;
};

type ConfiguredPluginActivationView = {
  readonly activation: {
    readonly plugins: readonly {
      readonly pluginId: string;
      readonly kind: string;
      readonly enabled: boolean;
      readonly requestedAccess: InspectConfiguredPlugin['requestedAccess'];
      readonly grantedAccess: InspectConfiguredPlugin['grantedAccess'];
      readonly activationStatus: InspectConfiguredPlugin['activationStatus'];
      readonly activationReasons: readonly string[];
      readonly diagnostics: InspectConfiguredPlugin['diagnostics'];
    }[];
  };
  readonly resolvedConfig: {
    readonly redactedSectionConfigs: RuntimeConfigSectionMap<unknown>;
  };
};

// Structural because runtime/config must not import src/app.
export function inspectConfiguredPlugins(
  runtimeConfig: ConfiguredPluginActivationView,
): readonly InspectConfiguredPlugin[] {
  return Object.freeze(
    runtimeConfig.activation.plugins.map(plugin => {
      const config = ownJsonRecordValue(
        runtimeConfig.resolvedConfig.redactedSectionConfigs.plugins,
        plugin.pluginId,
      );

      return Object.freeze({
        pluginId: plugin.pluginId,
        kind: plugin.kind,
        enabled: plugin.enabled,
        requestedAccess: plugin.requestedAccess,
        grantedAccess: plugin.grantedAccess,
        activationStatus: plugin.activationStatus,
        activationReasons: Object.freeze([...plugin.activationReasons]),
        diagnostics: Object.freeze([...plugin.diagnostics]),
        ...(config === undefined ? {} : {config}),
      } satisfies InspectConfiguredPlugin);
    }),
  );
}
