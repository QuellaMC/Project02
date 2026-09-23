import type {RuntimePluginAccessMap} from '../../plugins/api/index.ts';
import type {
  Project02RuntimeConfig,
  ResolvedProject02RuntimeConfig,
  RuntimeConfigInspectShape,
  RuntimeConfigEffectiveSource,
  RuntimeConfigFieldScope,
  RuntimePluginActivationStatusShape,
  RuntimePluginConfigFieldInspectShape,
  RuntimePluginConfigInspectShape,
  RuntimeConfigValue,
} from './types.ts';
import type {LayeredProject02RuntimeConfigSnapshot} from './resolve-layered.ts';
import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
import {
  runtimePluginScopeViolation,
  type RuntimePluginScopeOperation,
} from './plugin-scope.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {getRedactedRuntimeConfigValueAtPath} from './mutate.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import {
  runtimeConfigDiagnosticMatchesPlugin,
  type ResolvedRuntimePluginConfigs,
} from './resolve.ts';
import {project02RuntimeConfigFieldDefinitions} from './schema.ts';

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

export function createRuntimePluginConfigInspectShape(options: {
  readonly layeredConfig: LayeredProject02RuntimeConfigSnapshot;
  readonly targetScope: RuntimeConfigFieldScope;
  /** The plugin half of a resolution; a location-free one serves too. */
  readonly pluginResolution: Pick<
    ResolvedRuntimePluginConfigs,
    'redactedPluginConfigs' | 'diagnostics'
  >;
  readonly manifest: RuntimePluginManifest;
  readonly fingerprint: string;
  readonly activation?: RuntimePluginActivationStatusShape;
  readonly defaultEnabled?: boolean;
}): RuntimePluginConfigInspectShape {
  const targetConfig =
    options.targetScope === 'global'
      ? options.layeredConfig.globalConfig
      : options.layeredConfig.characterConfig;
  const authoredPlugin = ownJsonRecordValue(
    targetConfig?.plugins,
    options.manifest.id,
  );
  const effectivePlugin = ownJsonRecordValue(
    options.layeredConfig.effective.config?.plugins,
    options.manifest.id,
  );
  const effectiveFields = ownJsonRecordValue(
    options.pluginResolution.redactedPluginConfigs,
    options.manifest.id,
  );

  if (effectiveFields === undefined) {
    throw new TypeError(
      `Resolved runtime config is missing manifest metadata for plugin "${options.manifest.id}".`,
    );
  }

  const configuredEnabled =
    (options.targetScope === 'character'
      ? effectivePlugin?.enabled
      : authoredPlugin?.enabled) ??
    options.defaultEnabled ??
    options.manifest.activation.defaultEnabled;
  const diagnostics = Object.freeze(
    options.pluginResolution.diagnostics.filter(
      diagnostic =>
        diagnostic.scope === 'global' ||
        runtimeConfigDiagnosticMatchesPlugin({
          diagnostic,
          pluginId: options.manifest.id,
        }),
    ),
  );
  const activation = Object.freeze({
    ...runtimePluginConfigActivationInspection({
      configuredEnabled,
      diagnostics,
      manifest: options.manifest,
      ...(options.activation === undefined
        ? {}
        : {activation: options.activation}),
    }),
    editableInScope: scopeAllowsAuthoring(options, {kind: 'activation'}),
  });

  return Object.freeze({
    pluginId: options.manifest.id,
    displayName: options.manifest.displayName,
    version: options.manifest.version,
    enabled: configuredEnabled,
    activation,
    fields: Object.freeze(
      options.manifest.config.fields.map(field => {
        const authoredValue = ownJsonRecordValue(
          authoredPlugin?.config,
          field.name,
        );
        const effective = ownJsonRecordValue(effectiveFields, field.name);

        if (effective === undefined) {
          throw new TypeError(
            `Resolved runtime config is missing field "${field.name}" for plugin "${options.manifest.id}".`,
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
          ...(field.defaultValueSummary === undefined
            ? {}
            : {defaultValueSummary: field.defaultValueSummary}),
          ...(field.allowedValues === undefined
            ? {}
            : {allowedValues: Object.freeze([...field.allowedValues])}),
          agentMutable: field.agentMutable === true && !field.secret,
          // Asked of the one rule that decides it, so an offered setting
          // and an accepted save can never disagree.
          editableInScope: scopeAllowsAuthoring(options, {
            kind: 'field',
            fieldName: field.name,
          }),
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
          effectiveSource: effectivePluginConfigFieldSource({
            layeredConfig: options.layeredConfig,
            pluginId: options.manifest.id,
            fieldName: field.name,
          }),
          effective,
        });
      }),
    ),
    diagnostics,
    fingerprint: options.fingerprint,
  } satisfies RuntimePluginConfigInspectShape);
}

/**
 * The host fields in the shape plugin fields already take, so a settings
 * page renders one component for both. Defaults are not resolved here: an
 * unauthored field reads `missing`, and `defaultValueSummary` names what
 * applies — the runtime applies it, a page only shows it.
 */
export function createProject02ConfigFieldInspectShapes(options: {
  readonly layeredConfig: LayeredProject02RuntimeConfigSnapshot;
  readonly targetScope: RuntimeConfigFieldScope;
}): readonly RuntimePluginConfigFieldInspectShape[] {
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
        ...(field.defaultValueSummary === undefined
          ? {}
          : {defaultValueSummary: field.defaultValueSummary}),
        ...(field.allowedValues === undefined
          ? {}
          : {allowedValues: Object.freeze([...field.allowedValues])}),
        agentMutable: field.agentMutable,
        editableInScope: field.scopes.includes(options.targetScope),
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
        effective: Object.freeze({
          name: field.name,
          secret: field.secret,
          source: effectiveValue === undefined ? 'missing' : 'config',
          resolved: true,
          ...(effectiveValue === undefined ? {} : {value: effectiveValue}),
        }),
      } satisfies RuntimePluginConfigFieldInspectShape);
    }),
  );
}

function effectivePluginConfigFieldSource(options: {
  readonly layeredConfig: LayeredProject02RuntimeConfigSnapshot;
  readonly pluginId: string;
  readonly fieldName: string;
}): RuntimeConfigEffectiveSource {
  if (
    authoredPluginConfigField(
      options.layeredConfig.characterConfig,
      options.pluginId,
      options.fieldName,
    ) !== undefined
  ) {
    return 'character';
  }

  return authoredPluginConfigField(
    options.layeredConfig.globalConfig,
    options.pluginId,
    options.fieldName,
  ) === undefined
    ? 'default'
    : 'global';
}

function authoredPluginConfigField(
  config: Project02RuntimeConfig | undefined,
  pluginId: string,
  fieldName: string,
): RuntimeConfigValue | undefined {
  return ownJsonRecordValue(
    ownJsonRecordValue(config?.plugins, pluginId)?.config,
    fieldName,
  );
}

/**
 * Asks the one rule that decides authoring, so an offered setting and an
 * accepted save can never disagree.
 */
function scopeAllowsAuthoring(
  options: {
    readonly manifest: RuntimePluginManifest;
    readonly targetScope: RuntimeConfigFieldScope;
  },
  operation: RuntimePluginScopeOperation,
): boolean {
  return (
    runtimePluginScopeViolation({
      manifest: options.manifest,
      authoredScope: options.targetScope,
      operation,
    }) === undefined
  );
}

function runtimePluginConfigActivationInspection(options: {
  readonly configuredEnabled: boolean;
  readonly diagnostics: RuntimePluginConfigInspectShape['diagnostics'];
  readonly manifest: RuntimePluginManifest;
  readonly activation?: RuntimePluginActivationStatusShape;
}): RuntimePluginActivationStatusShape {
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
        ? [...options.manifest.activation.reasons, 'config_inspection_active']
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
    readonly redactedPluginConfigs: Readonly<Record<string, unknown>>;
  };
};

// Structural because runtime/config must not import src/app.
export function inspectConfiguredPlugins(
  runtimeConfig: ConfiguredPluginActivationView,
): readonly InspectConfiguredPlugin[] {
  return Object.freeze(
    runtimeConfig.activation.plugins.map(plugin => {
      const config = ownJsonRecordValue(
        runtimeConfig.resolvedConfig.redactedPluginConfigs,
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
