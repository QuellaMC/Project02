import { createRuntimePluginEvidenceSnapshot } from '../../api/constructors.ts';
import { runtimePluginConfigReadToolName, runtimePluginId } from '../../api/contract.ts';
import type {
  RuntimePluginContext,
  RuntimePluginJsonObject,
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
  RuntimePluginToolCall,
  RuntimePluginToolCallResult
} from '../../api/types.ts';
import type { RuntimePluginConfigControlCapability } from '../../../runtime/config/index.ts';
import { requiredRuntimePluginConfigControl } from './state.ts';

type RuntimePluginConfigInspection = ReturnType<
  RuntimePluginConfigControlCapability['inspectConfig']
>;
import {
  createJsonBoundaryObjectSnapshot,
  ownJsonRecordValue
} from '../../../shared/json-boundary.ts';
import type { RuntimePluginConfigControlHostState } from './state.ts';

export function createRuntimePluginConfigReadTool(): RuntimePluginProvidedTool {
  return {
    name: runtimePluginConfigReadToolName,
    description:
      'Inspect one installed plugin config using manifest metadata and redacted authored and effective values. Secret values are never returned.',
    requiredForUserTurn: false,
    inputContract: {
      type: 'object',
      fields: [
        {
          name: 'pluginId',
          description: 'Exact installed plugin id to inspect.',
          required: true,
          valueType: 'string'
        }
      ],
      additionalFields: false
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'runtime_read',
    requiresConfirmation: false,
    sourceReferencesRequired: false
  };
}

export function handleRuntimePluginConfigReadToolCall(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly state: RuntimePluginConfigControlHostState;
  readonly storeRoot?: string;
}): RuntimePluginToolCallResult {
  let pluginId: string;

  try {
    pluginId = nonEmptyPluginConfigInputString(options.call.input['pluginId']);
  } catch (error: unknown) {
    return rejectedPluginConfigToolCall(
      'plugin_config_inspect_invalid',
      pluginConfigErrorMessage(error)
    );
  }

  const manifest = options.state.pluginManifests.find(
    (candidate) => candidate.id === pluginId
  );

  if (manifest === undefined) {
    return rejectedPluginConfigToolCall(
      'plugin_config_unknown_plugin',
      `Plugin "${pluginId}" is not installed in the current host catalog.`
    );
  }

  const inspection = inspectRuntimePluginConfigForControl({
    manifest,
    state: options.state,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });

  return {
    status: 'accepted',
    output: createJsonBoundaryObjectSnapshot(
      modelVisiblePluginConfigInspection(inspection),
      { field: 'Plugin config inspection' }
    ),
    evidence: [
      createRuntimePluginEvidenceSnapshot({
        eventId: options.context.eventId,
        traceId: options.context.traceId,
        createdAt: options.context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: runtimePluginId,
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: `Inspected redacted config for plugin "${manifest.id}".`,
        redactionLabels: options.context.privacy.redactionLabels,
        configFingerprint: inspection.fingerprint
      })
    ]
  };
}

export function inspectRuntimePluginConfigForControl(options: {
  readonly manifest: RuntimePluginManifest;
  readonly state: RuntimePluginConfigControlHostState;
  readonly storeRoot?: string;
}): RuntimePluginConfigInspection {
  const activation = ownJsonRecordValue(
    options.state.activationByPluginId,
    options.manifest.id
  );

  return requiredRuntimePluginConfigControl(options.state).inspectConfig({
    manifest: options.manifest,
    pluginManifests: options.state.pluginManifests,
    ...(activation === undefined ? {} : { activation }),
    ...(options.state.defaultEnabledPluginIds === undefined
      ? {}
      : {
          defaultEnabled: options.state.defaultEnabledPluginIds.includes(
            options.manifest.id
          )
        }),
    ...(options.state.configPath === undefined
      ? {}
      : { configPath: options.state.configPath }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    ...(options.state.env === undefined ? {} : { env: options.state.env })
  });
}

export function nonEmptyPluginConfigInputString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Plugin config tool input must be a non-empty string.');
  }

  return value;
}

export function pluginConfigErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Plugin config update failed.';
}

export function rejectedPluginConfigToolCall(
  reason: string,
  message: string
): RuntimePluginToolCallResult {
  return {
    status: 'rejected',
    reason,
    message,
    evidence: Object.freeze([])
  };
}

function modelVisiblePluginConfigInspection(
  inspection: RuntimePluginConfigInspection
): RuntimePluginJsonObject {
  return {
    ...inspection,
    fields: inspection.fields.map((field) => ({
      name: field.name,
      description: field.description,
      required: field.required,
      sensitive: field.secret,
      ...(field.valueType === undefined ? {} : { valueType: field.valueType }),
      ...(field.defaultValueSummary === undefined
        ? {}
        : { defaultValueSummary: field.defaultValueSummary }),
      ...(field.allowedValues === undefined
        ? {}
        : { allowedValues: field.allowedValues }),
      agentMutable: field.agentMutable && !field.secret,
      reloadRequired: field.reloadRequired,
      authored: field.authored,
      effective: {
        name: field.effective.name,
        sensitive: field.effective.secret,
        source: field.effective.source,
        resolved: field.effective.resolved,
        ...(field.effective.value === undefined
          ? {}
          : { value: field.effective.value })
      }
    }))
  };
}
