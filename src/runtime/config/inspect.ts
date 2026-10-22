import type {RuntimePluginAccessMap} from '../../plugins/api/index.ts';
import type {
  RedactedRuntimeSectionConfig,
  ResolvedProject02RuntimeConfig,
  RuntimeConfigInspectShape,
  RuntimeConfigDiagnostic,
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
import type {
  EffectiveProject02RuntimeConfigSnapshot,
  LayeredProject02RuntimeConfigSnapshot,
} from './resolve-layered.ts';
import {ownJsonRecordValue} from '../../shared/json-boundary.ts';
import {builtInConnectors} from './connectors.ts';
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

  const switchedEnabled =
    options.targetScope === 'character'
      ? effectiveSection?.enabled
      : authoredSection?.enabled;
  const configuredEnabled =
    switchedEnabled ??
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
    switched: switchedEnabled !== undefined,
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
            ? unauthoredRuntimeConfigField(field, field.required)
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

/**
 * A section's activation where no activation decision was made for it, in
 * the words a decision uses: blocked by an error in its settings, or on or
 * off and why, by a document's switch or by its default.
 */
function sectionActivationInspection(options: {
  readonly configuredEnabled: boolean;
  /** Whether a document switches it, rather than its default. */
  readonly switched: boolean;
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

  if (options.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    return Object.freeze({
      enabled: false,
      status: 'blocked',
      reasons: Object.freeze(['blocked_by_config_errors']),
    });
  }

  if (!options.configuredEnabled) {
    return Object.freeze({
      enabled: false,
      status: 'disabled',
      reasons: Object.freeze([
        options.switched ? 'disabled_by_config' : 'not_enabled',
      ]),
    });
  }

  return Object.freeze({
    enabled: true,
    status: 'active',
    reasons: Object.freeze([
      ...options.declaration.activation.reasons,
      options.switched ? 'enabled_by_config' : 'enabled_by_default',
    ]),
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

export type InspectConfiguredConnector = {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly activation: RuntimeConfigSectionActivationShape;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly config?: RedactedRuntimeSectionConfig;
};

export function inspectConfiguredConnectors(
  resolvedConfig: Pick<
    ResolvedProject02RuntimeConfig,
    'redactedSectionConfigs' | 'diagnostics'
  >,
  effectiveConfig: EffectiveProject02RuntimeConfigSnapshot,
): readonly InspectConfiguredConnector[] {
  return Object.freeze(
    builtInConnectors.map(connector => {
      const switchedEnabled = ownJsonRecordValue(
        effectiveConfig.config?.connectors,
        connector.id,
      )?.enabled;
      const enabled = switchedEnabled ?? connector.activation.defaultEnabled;
      const diagnostics = Object.freeze(
        resolvedConfig.diagnostics.filter(diagnostic =>
          runtimeConfigDiagnosticMatchesSection({
            diagnostic,
            namespace: 'connectors',
            id: connector.id,
          }),
        ),
      );
      const config = ownJsonRecordValue(
        resolvedConfig.redactedSectionConfigs.connectors,
        connector.id,
      );

      return Object.freeze({
        id: connector.id,
        displayName: connector.displayName,
        version: connector.version,
        enabled,
        activation: sectionActivationInspection({
          configuredEnabled: enabled,
          switched: switchedEnabled !== undefined,
          diagnostics,
          declaration: connector,
        }),
        diagnostics,
        ...(config === undefined ? {} : {config}),
      } satisfies InspectConfiguredConnector);
    }),
  );
}
