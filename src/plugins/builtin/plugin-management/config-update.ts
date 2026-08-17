import {
  createPreparedRuntimePluginConfigEffect,
  createRuntimePluginEvidenceSnapshot,
} from '../../api/constructors.ts';
import {
  runtimePluginConfigUpdateToolName,
  runtimePluginId,
} from '../../api/contract.ts';
import {runtimeIdentityMatchesContext} from '../../api/identity.ts';
import type {
  PreparedRuntimePluginConfigEffect,
  RuntimePluginConfigField,
  RuntimePluginContext,
  RuntimePluginJsonObject,
  RuntimePluginToolCallExecutionResult,
  RuntimePluginProvidedTool,
  RuntimePluginToolCall,
} from '../../api/types.ts';
import type {
  RuntimeConfigValue,
  RuntimePluginConfigControlCapability,
  RuntimePluginConfigFieldControlOperation,
} from '../../../runtime/config/index.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
} from '../../../shared/json-boundary.ts';
import {
  inspectRuntimePluginConfigForControl,
  nonEmptyPluginConfigInputString,
  pluginConfigErrorMessage,
  rejectedPluginConfigToolCall,
} from './config.ts';
import {
  isRuntimeConfigConflictError,
  requiredRuntimePluginConfigControl,
  type RuntimePluginConfigControlHostState,
} from './state.ts';

export const runtimePluginConfigUpdateExecutionTimeoutMs = 5_000;

export function createRuntimePluginConfigUpdateTool(): RuntimePluginProvidedTool {
  return {
    name: runtimePluginConfigUpdateToolName,
    description:
      'Set or unset one declared non-secret, agent-mutable plugin config field after exact user approval. This cannot change activation, permissions, paths, secrets, or Project02 host settings. An approved change is written at once and takes effect right away when the host can rebuild the plugin live (reported per update as appliesTo), otherwise at the next launch.',
    inputContract: {
      type: 'object',
      properties: {
        pluginId: {
          type: 'string',
          description: 'Exact installed plugin id to update.',
        },
        fieldName: {
          type: 'string',
          description: 'Exact manifest-declared config field name.',
        },
        operation: {
          type: 'string',
          description: 'Apply exactly one set or unset operation.',
          enum: ['set', 'unset'],
        },
        value: {
          description:
            "New JSON value. Required for set and unavailable for unset. Must match the target field's declared valueType and allowedValues as returned by runtime.plugin.config (e.g. a plain string for a string field, not a JSON-encoded array).",
        },
        expectedFingerprint: {
          type: 'string',
          description:
            'Authored config fingerprint returned by runtime.plugin.config.',
        },
      },
      required: ['pluginId', 'fieldName', 'operation', 'expectedFingerprint'],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    concurrency: 'exclusive',
    requiresConfirmation: true,
  };
}

/**
 * Writes an approved change. Runs inside the tool call, right after the person
 * approved it: the fingerprint the change was prepared against must still be
 * the file's, or the change is refused rather than written over someone
 * else's edit.
 */
export function applyPreparedRuntimePluginConfigEffect(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly state: RuntimePluginConfigControlHostState;
}): RuntimePluginConfigField {
  const manifest = options.state.pluginManifests.find(
    candidate => candidate.id === options.effect.targetPluginId,
  );

  if (manifest === undefined) {
    throw new TypeError(
      `Prepared config effect target plugin "${options.effect.targetPluginId}" is not installed.`,
    );
  }

  const operation: RuntimePluginConfigFieldControlOperation =
    options.effect.operation.kind === 'set'
      ? {
          kind: 'set',
          fieldName: options.effect.fieldName,
          value: options.effect.operation.value,
        }
      : {
          kind: 'unset',
          fieldName: options.effect.fieldName,
        };
  const control = requiredRuntimePluginConfigControl(options.state);
  const field = control.validateOperation({
    manifest,
    actor: 'agent',
    operation,
  });
  const target = options.state.configControl.target;

  if (target.canonicalConfigPath !== options.effect.targetConfigPath) {
    throw control.createConflictError(
      `Prepared config effect "${options.effect.effectId}" targets another runtime config path.`,
    );
  }

  const result = control.applyOperation({
    target,
    pluginManifests: options.state.pluginManifests,
    expectedFingerprint: options.effect.expectedFingerprint,
    request: {
      kind: 'plugin_config',
      manifest,
      actor: 'agent',
      fieldOperation: operation,
    },
  });

  if (result.fingerprint !== options.effect.resultFingerprint) {
    throw new Error(
      `Prepared config effect "${options.effect.effectId}" produced an unexpected config fingerprint.`,
    );
  }

  return field;
}

export function normalizePreparedRuntimePluginConfigEffect(options: {
  readonly providedTool: RuntimePluginProvidedTool;
  /** Decided by the host, which holds the manifest this depends on. */
  readonly approvalGatedTool: boolean;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
}): PreparedRuntimePluginConfigEffect | undefined {
  if (options.value === undefined) {
    return undefined;
  }

  if (!options.approvalGatedTool) {
    throw new TypeError(
      'Only an approval-gated runtime config tool can prepare a config effect.',
    );
  }

  const effect = createPreparedRuntimePluginConfigEffect(options.value);

  if (!runtimeIdentityMatchesContext(effect, options.context)) {
    throw new TypeError(
      'Prepared plugin config effect identity must match current runtime event identity.',
    );
  }

  return effect;
}

function preparedRuntimePluginConfigEffectIsStillCurrent(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly state: RuntimePluginConfigControlHostState;
}): boolean {
  const manifest = options.state.pluginManifests.find(
    candidate => candidate.id === options.effect.targetPluginId,
  );

  if (manifest === undefined) {
    return false;
  }

  const target = options.state.configControl.target;
  const inspection = inspectRuntimePluginConfigForControl({
    manifest,
    state: options.state,
  });

  return !(
    target.canonicalConfigPath !== options.effect.targetConfigPath ||
    inspection.fingerprint !== options.effect.expectedFingerprint
  );
}

export function createPreparedRuntimePluginConfigEffectConfirmationPreview(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly state: RuntimePluginConfigControlHostState;
}): RuntimePluginJsonObject {
  const manifest = options.state.pluginManifests.find(
    candidate => candidate.id === options.effect.targetPluginId,
  );

  if (
    manifest === undefined ||
    !preparedRuntimePluginConfigEffectIsStillCurrent(options)
  ) {
    throw requiredRuntimePluginConfigControl(options.state).createConflictError(
      'Prepared plugin config effect is no longer current for approval.',
    );
  }

  const operation: RuntimePluginConfigFieldControlOperation =
    options.effect.operation.kind === 'set'
      ? {
          kind: 'set',
          fieldName: options.effect.fieldName,
          value: options.effect.operation.value,
        }
      : {
          kind: 'unset',
          fieldName: options.effect.fieldName,
        };
  const field = requiredRuntimePluginConfigControl(
    options.state,
  ).validateOperation({
    manifest,
    actor: 'agent',
    operation,
  });
  const inspection = inspectRuntimePluginConfigForControl({
    manifest,
    state: options.state,
  });
  const inspectedField = inspection.fields.find(
    candidate => candidate.name === field.name,
  );

  if (inspectedField === undefined) {
    throw requiredRuntimePluginConfigControl(options.state).createConflictError(
      `Plugin config inspection is missing field "${field.name}".`,
    );
  }

  return createJsonBoundaryObjectSnapshot(
    pluginConfigChangePreview({
      pluginId: manifest.id,
      field,
      operation,
      expectedFingerprint: options.effect.expectedFingerprint,
      authored: inspectedField.authored,
      redactValue: requiredRuntimePluginConfigControl(options.state)
        .redactValue,
    }),
    {field: 'Prepared plugin config approval preview'},
  );
}

export function handleRuntimePluginConfigUpdateToolCall(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly state: RuntimePluginConfigControlHostState;
}): RuntimePluginToolCallExecutionResult {
  let pluginId: string;

  try {
    pluginId = nonEmptyPluginConfigInputString(options.call.input['pluginId']);
  } catch (error: unknown) {
    return rejectedPluginConfigToolCall(
      'plugin_config_update_invalid',
      pluginConfigErrorMessage(error),
    );
  }

  const manifest = options.state.pluginManifests.find(
    candidate => candidate.id === pluginId,
  );

  if (manifest === undefined) {
    return rejectedPluginConfigToolCall(
      'plugin_config_unknown_plugin',
      `Plugin "${pluginId}" is not installed in the current host catalog.`,
    );
  }

  let operation: RuntimePluginConfigFieldControlOperation;
  let expectedFingerprint: string;
  let field: RuntimePluginConfigField;

  try {
    operation = pluginConfigOperationFromInput(options.call.input);
    expectedFingerprint = nonEmptyPluginConfigInputString(
      options.call.input['expectedFingerprint'],
    );
    field = requiredRuntimePluginConfigControl(options.state).validateOperation(
      {
        manifest,
        actor: 'agent',
        operation,
      },
    );
  } catch (error: unknown) {
    return rejectedPluginConfigToolCall(
      'plugin_config_update_invalid',
      pluginConfigErrorMessage(error),
    );
  }

  const inspection = inspectRuntimePluginConfigForControl({
    manifest,
    state: options.state,
  });
  const blockingDiagnostic = inspection.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (blockingDiagnostic !== undefined) {
    return rejectedPluginConfigToolCall(
      'plugin_config_update_invalid',
      `Plugin config cannot be updated while its current authored config is invalid: ${blockingDiagnostic.message}`,
    );
  }

  if (inspection.fingerprint !== expectedFingerprint) {
    return rejectedPluginConfigToolCall(
      'plugin_config_fingerprint_conflict',
      'Plugin config changed after it was inspected. Inspect again before requesting an update.',
    );
  }

  let resultFingerprint: string;
  let targetConfigPath: string;

  try {
    const target = options.state.configControl.target;
    const prepared = requiredRuntimePluginConfigControl(
      options.state,
    ).prepareOperation({
      target,
      pluginManifests: options.state.pluginManifests,
      expectedFingerprint,
      request: {
        kind: 'plugin_config',
        manifest,
        actor: 'agent',
        fieldOperation: operation,
      },
    });

    resultFingerprint = prepared.resultFingerprint;
    targetConfigPath = prepared.targetConfigPath;
  } catch (error: unknown) {
    if (isRuntimeConfigConflictError(error)) {
      return rejectedPluginConfigToolCall(
        'plugin_config_fingerprint_conflict',
        'Plugin config changed after it was inspected and no update was prepared. Inspect runtime.plugin.config again for the current fingerprint, then retry.',
      );
    }

    return rejectedPluginConfigToolCall(
      'plugin_config_update_failed',
      pluginConfigErrorMessage(error),
    );
  }

  return preparedRuntimePluginConfigUpdateResult({
    call: options.call,
    context: options.context,
    manifest,
    field,
    operation,
    expectedFingerprint,
    resultFingerprint,
    targetConfigPath,
  });
}

/**
 * The tool's own result only says what it validated; the host asks the
 * person, writes the change, and answers the model with what happened
 * (`appliedRuntimePluginConfigUpdateOutput`).
 */
function preparedRuntimePluginConfigUpdateResult(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly manifest: {readonly id: string};
  readonly field: RuntimePluginConfigField;
  readonly operation: RuntimePluginConfigFieldControlOperation;
  readonly expectedFingerprint: string;
  readonly resultFingerprint: string;
  readonly targetConfigPath: string;
}): RuntimePluginToolCallExecutionResult {
  const {call, context, manifest, field, operation, resultFingerprint} =
    options;

  return {
    status: 'accepted',
    output: createJsonBoundaryObjectSnapshot(
      {
        status: 'prepared',
        pluginId: manifest.id,
        fieldName: field.name,
        operation: operation.kind,
        fingerprint: resultFingerprint,
      },
      {field: 'Prepared plugin config update'},
    ),
    evidence: [
      createRuntimePluginEvidenceSnapshot({
        eventId: context.eventId,
        traceId: context.traceId,
        createdAt: context.timestamp,
        kind: 'runtime_plugin_evidence_snapshot',
        pluginId: runtimePluginId,
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: `Prepared plugin "${manifest.id}" config field "${field.name}" for approval.`,
        redactionLabels: context.privacy.redactionLabels,
        configFingerprint: resultFingerprint,
      }),
    ],
    preparedConfigEffect: Object.freeze({
      eventId: call.eventId,
      traceId: call.traceId,
      createdAt: call.createdAt,
      kind: 'runtime_plugin_config_effect',
      effectId:
        call.toolCallId ??
        `${call.eventId}.${call.traceId}.${runtimePluginConfigUpdateToolName}`,
      targetPluginId: manifest.id,
      targetConfigPath: options.targetConfigPath,
      fieldName: field.name,
      expectedFingerprint: options.expectedFingerprint,
      resultFingerprint,
      operation:
        operation.kind === 'set'
          ? Object.freeze({
              kind: 'set',
              value: createJsonBoundarySnapshot(operation.value, {
                field: 'Prepared plugin config update value',
              }),
            })
          : Object.freeze({kind: 'unset'}),
    }),
  };
}

/** What the model hears once the change is written: whether it is already in effect. */
export function appliedRuntimePluginConfigUpdateOutput(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly field: RuntimePluginConfigField;
  readonly appliesTo: 'now' | 'next_launch';
  readonly note?: string;
}): RuntimePluginJsonObject {
  return createJsonBoundaryObjectSnapshot(
    {
      status: 'applied',
      appliesTo: options.appliesTo,
      ...(options.note === undefined ? {} : {appliesToNote: options.note}),
      pluginId: options.effect.targetPluginId,
      fieldName: options.field.name,
      operation: options.effect.operation.kind,
      fingerprint: options.effect.resultFingerprint,
      reloadRequired: options.field.reloadRequired !== false,
    },
    {field: 'Applied plugin config update'},
  );
}

function pluginConfigOperationFromInput(
  input: RuntimePluginJsonObject,
): RuntimePluginConfigFieldControlOperation {
  const fieldName = nonEmptyPluginConfigInputString(input['fieldName']);
  const operation = nonEmptyPluginConfigInputString(input['operation']);
  const value = input['value'];

  if (operation === 'set') {
    if (value === undefined) {
      throw new TypeError('Plugin config set input must include value.');
    }

    return {
      kind: 'set',
      fieldName,
      value: createJsonBoundarySnapshot(value, {
        field: 'Plugin config update value',
      }),
    };
  }

  if (operation === 'unset') {
    if (value !== undefined) {
      throw new TypeError('Plugin config unset input must not include value.');
    }

    return {kind: 'unset', fieldName};
  }

  throw new TypeError('Plugin config operation must be "set" or "unset".');
}

function pluginConfigChangePreview(options: {
  readonly pluginId: string;
  readonly field: RuntimePluginConfigField;
  readonly operation: RuntimePluginConfigFieldControlOperation;
  readonly expectedFingerprint: string;
  readonly authored: {
    readonly configured: boolean;
    readonly value?: RuntimeConfigValue;
  };
  readonly redactValue: RuntimePluginConfigControlCapability['redactValue'];
}) {
  return Object.freeze({
    kind: 'runtime_plugin_config_change',
    targetPluginId: options.pluginId,
    fieldName: options.field.name,
    operation: options.operation.kind,
    expectedFingerprint: options.expectedFingerprint,
    before: Object.freeze({
      configured: options.authored.configured,
      ...(options.authored.value === undefined
        ? {}
        : {value: options.authored.value}),
    }),
    after:
      options.operation.kind === 'set'
        ? Object.freeze({
            configured: true,
            value: options.redactValue(options.operation.value, {
              key: options.field.name,
            }),
          })
        : Object.freeze({configured: false}),
  });
}
