import type {RuntimePluginAccessMap} from '../../plugins/api/index.ts';
import type {
  LoadedProject02RuntimeConfig,
  ResolvedProject02RuntimeConfig,
  RuntimeConfigInspectShape,
  RuntimePluginConfigActivationInspectShape,
  RuntimePluginConfigInspectShape,
  RuntimeConfigValue,
} from './types.ts';
import type {RuntimePluginManifest} from '../../plugins/api/index.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {redactRuntimeConfigValue} from './redact.ts';
import {runtimeConfigDiagnosticMatchesPlugin} from './resolve.ts';

export function createRuntimeConfigInspectShape(
  resolvedConfig: ResolvedProject02RuntimeConfig,
): RuntimeConfigInspectShape {
  return Object.freeze({
    source: resolvedConfig.source,
    ...(resolvedConfig.path === undefined ? {} : {path: resolvedConfig.path}),
    project02: resolvedConfig.project02,
    diagnostics: Object.freeze([...resolvedConfig.diagnostics]),
    fingerprint: resolvedConfig.effectiveConfigFingerprint,
  } satisfies RuntimeConfigInspectShape);
}

export function createRuntimePluginConfigInspectShape(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly resolvedConfig: ResolvedProject02RuntimeConfig;
  readonly manifest: RuntimePluginManifest;
  readonly fingerprint: string;
  readonly activation?: RuntimePluginConfigActivationInspectShape;
  readonly defaultEnabled?: boolean;
}): RuntimePluginConfigInspectShape {
  const authoredPlugin = ownJsonRecordValue(
    options.loadedConfig.config?.plugins,
    options.manifest.id,
  );
  const effectiveFields = ownJsonRecordValue(
    options.resolvedConfig.redactedPluginConfigs,
    options.manifest.id,
  );

  if (effectiveFields === undefined) {
    throw new TypeError(
      `Resolved runtime config is missing manifest metadata for plugin "${options.manifest.id}".`,
    );
  }

  const configuredEnabled =
    authoredPlugin?.enabled ??
    options.defaultEnabled ??
    options.manifest.activation.defaultEnabled;
  const diagnostics = Object.freeze(
    options.resolvedConfig.diagnostics.filter(
      diagnostic =>
        diagnostic.scope === 'global' ||
        runtimeConfigDiagnosticMatchesPlugin({
          diagnostic,
          pluginId: options.manifest.id,
        }),
    ),
  );
  const activation = runtimePluginConfigActivationInspection({
    configuredEnabled,
    diagnostics,
    manifest: options.manifest,
    ...(options.activation === undefined
      ? {}
      : {activation: options.activation}),
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
          reloadRequired: field.reloadRequired === true,
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
          effective,
        });
      }),
    ),
    diagnostics,
    fingerprint: options.fingerprint,
  } satisfies RuntimePluginConfigInspectShape);
}

function runtimePluginConfigActivationInspection(options: {
  readonly configuredEnabled: boolean;
  readonly diagnostics: RuntimePluginConfigInspectShape['diagnostics'];
  readonly manifest: RuntimePluginManifest;
  readonly activation?: RuntimePluginConfigActivationInspectShape;
}): RuntimePluginConfigActivationInspectShape {
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

// Structural view of the app-layer activation result: runtime/config must
// not import src/app, and the join only needs these fields.
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
