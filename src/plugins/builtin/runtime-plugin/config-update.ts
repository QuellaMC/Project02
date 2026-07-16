import {
  createPreparedRuntimePluginConfigEffect,
  createRuntimePluginEvidenceSnapshot
} from '../../constructors.ts';
import {
  runtimePluginConfigUpdateToolName,
  runtimePluginId
} from '../../contract.ts';
import { runtimeIdentityMatchesContext } from '../../plugin-identity.ts';
import { isApprovalGatedRuntimePluginTool } from '../../tool-contract.ts';
import type {
  PreparedRuntimePluginConfigEffect,
  RuntimePluginConfigField,
  RuntimePluginContext,
  RuntimePluginJsonObject,
  RuntimePluginToolCallExecutionResult,
  RuntimePluginProvidedTool,
  RuntimePluginToolCall
} from '../../plugin-types.ts';
import {
  applyRuntimePluginConfigControlOperation,
  prepareRuntimePluginConfigControlOperation,
  resolveRuntimeConfigControlTargetPath,
  validateRuntimePluginConfigControlOperation,
  type RuntimePluginConfigFieldControlOperation
} from '../../../runtime/config/control.ts';
import { redactRuntimeConfigValue } from '../../../runtime/config/redact.ts';
import { RuntimeConfigConflictError } from '../../../runtime/config/mutate.ts';
import type { RuntimeConfigValue } from '../../../runtime/config/types.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot
} from '../../../shared/json-boundary.ts';
import {
  inspectRuntimePluginConfigForControl,
  nonEmptyPluginConfigInputString,
  pluginConfigErrorMessage,
  rejectedPluginConfigToolCall
} from './config.ts';
import type { RuntimePluginConfigControlHostState } from './state.ts';

export const runtimePluginConfigUpdateExecutionTimeoutMs = 5_000;

export function createRuntimePluginConfigUpdateTool(): RuntimePluginProvidedTool {
  return {
    name: runtimePluginConfigUpdateToolName,
    description:
      'Set or unset one declared non-secret, agent-mutable plugin config field after exact user approval. This cannot change activation, permissions, paths, secrets, or Project02 host settings, and applies only to later host construction.',
    requiredForUserTurn: false,
    callLimit: {
      scope: 'user_turn',
      maxCalls: 1
    },
    inputContract: {
      type: 'object',
      fields: [
        {
          name: 'pluginId',
          description: 'Exact installed plugin id to update.',
          required: true,
          valueType: 'string'
        },
        {
          name: 'fieldName',
          description: 'Exact manifest-declared config field name.',
          required: true,
          valueType: 'string'
        },
        {
          name: 'operation',
          description: 'Apply exactly one set or unset operation.',
          required: true,
          valueType: 'string',
          allowedValues: ['set', 'unset']
        },
        {
          name: 'value',
          description: 'New JSON value. Required for set and unavailable for unset.',
          required: false
        },
        {
          name: 'expectedFingerprint',
          description:
            'Authored config fingerprint returned by runtime.plugin.config.',
          required: true,
          valueType: 'string'
        }
      ],
      additionalFields: false
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'runtime_config_write',
    requiresConfirmation: true,
    sourceReferencesRequired: false
  };
}

export function reconcilePreparedRuntimePluginConfigEffect(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly state: RuntimePluginConfigControlHostState;
  readonly storeRoot?: string;
}) {
  const manifest = options.state.pluginManifests.find(
    (candidate) => candidate.id === options.effect.targetPluginId
  );

  if (manifest === undefined) {
    throw new TypeError(
      `Prepared config effect target plugin "${options.effect.targetPluginId}" is not installed.`
    );
  }

  const operation: RuntimePluginConfigFieldControlOperation =
    options.effect.operation.kind === 'set'
      ? {
          kind: 'set',
          fieldName: options.effect.fieldName,
          value: options.effect.operation.value
        }
      : {
          kind: 'unset',
          fieldName: options.effect.fieldName
        };
  const field = validateRuntimePluginConfigControlOperation({
    manifest,
    actor: 'agent',
    operation
  });
  const targetConfigPath = resolveRuntimeConfigControlTargetPath({
    ...(options.state.configPath === undefined
      ? {}
      : { configPath: options.state.configPath }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    ...(options.state.env === undefined ? {} : { env: options.state.env })
  });

  if (targetConfigPath !== options.effect.targetConfigPath) {
    throw new RuntimeConfigConflictError(
      `Prepared config effect "${options.effect.effectId}" targets another runtime config path.`
    );
  }

  const inspection = inspectRuntimePluginConfigForControl({
    manifest,
    state: options.state,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });
  let reconciliation: 'already_applied' | 'applied';

  if (inspection.fingerprint === options.effect.resultFingerprint) {
    reconciliation = 'already_applied';
  } else {
    if (inspection.fingerprint !== options.effect.expectedFingerprint) {
      throw new RuntimeConfigConflictError(
        `Prepared config effect "${options.effect.effectId}" cannot be reconciled because authored config changed.`
      );
    }

    const prepared = prepareRuntimePluginConfigControlOperation({
      manifest,
      actor: 'agent',
      expectedFingerprint: options.effect.expectedFingerprint,
      operation,
      ...(options.state.configPath === undefined
        ? {}
        : { configPath: options.state.configPath }),
      ...(options.storeRoot === undefined
        ? {}
        : { storeRoot: options.storeRoot }),
      ...(options.state.env === undefined ? {} : { env: options.state.env })
    });

    if (
      prepared.targetConfigPath !== options.effect.targetConfigPath ||
      prepared.resultFingerprint !== options.effect.resultFingerprint
    ) {
      throw new Error(
        `Prepared config effect "${options.effect.effectId}" does not match its validated config candidate.`
      );
    }

    const result = applyRuntimePluginConfigControlOperation({
      manifest,
      actor: 'agent',
      expectedFingerprint: options.effect.expectedFingerprint,
      operation,
      ...(options.state.configPath === undefined
        ? {}
        : { configPath: options.state.configPath }),
      ...(options.storeRoot === undefined
        ? {}
        : { storeRoot: options.storeRoot }),
      ...(options.state.env === undefined ? {} : { env: options.state.env })
    });

    if (result.fingerprint !== options.effect.resultFingerprint) {
      throw new Error(
        `Prepared config effect "${options.effect.effectId}" produced an unexpected config fingerprint.`
      );
    }

    reconciliation = 'applied';
  }

  return createRuntimePluginEvidenceSnapshot({
    eventId: options.effect.eventId,
    traceId: options.effect.traceId,
    createdAt: options.effect.createdAt,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: runtimePluginId,
    evidenceKind: 'after_turn_committed',
    status: 'accepted',
    summary:
      reconciliation === 'applied'
        ? `Applied approved plugin "${manifest.id}" config field "${field.name}".`
        : `Reconciled already-applied plugin "${manifest.id}" config field "${field.name}".`,
    sourceReferences: [
      {
        kind: 'runtime',
        id: options.effect.effectId
      }
    ],
    redactionLabels: field.redactionLabels,
    configFingerprint: options.effect.resultFingerprint
  });
}

export function normalizePreparedRuntimePluginConfigEffect(options: {
  readonly providedTool: RuntimePluginProvidedTool;
  readonly context: RuntimePluginContext;
  readonly value: unknown;
}): PreparedRuntimePluginConfigEffect | undefined {
  if (options.value === undefined) {
    return undefined;
  }

  if (!isApprovalGatedRuntimePluginTool(options.providedTool)) {
    throw new TypeError(
      'Only an approval-gated runtime config tool can prepare a config effect.'
    );
  }

  const effect = createPreparedRuntimePluginConfigEffect(options.value);

  if (!runtimeIdentityMatchesContext(effect, options.context)) {
    throw new TypeError(
      'Prepared plugin config effect identity must match current runtime event identity.'
    );
  }

  return effect;
}

export function closeConflictedPreparedRuntimePluginConfigEffect(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly reason: string;
}) {
  return createRuntimePluginEvidenceSnapshot({
    eventId: options.effect.eventId,
    traceId: options.effect.traceId,
    createdAt: options.effect.createdAt,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: runtimePluginId,
    evidenceKind: 'after_turn_committed',
    status: 'rejected',
    summary: `Closed conflicted plugin "${options.effect.targetPluginId}" config effect "${options.effect.effectId}" without applying it: ${options.reason}`,
    sourceReferences: [
      {
        kind: 'runtime',
        id: options.effect.effectId
      }
    ],
    redactionLabels: []
  });
}

export function preparedRuntimePluginConfigEffectIsStillCurrent(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly state: RuntimePluginConfigControlHostState;
  readonly storeRoot?: string;
}): boolean {
  const manifest = options.state.pluginManifests.find(
    (candidate) => candidate.id === options.effect.targetPluginId
  );

  if (manifest === undefined) {
    return false;
  }

  const targetConfigPath = resolveRuntimeConfigControlTargetPath({
    ...(options.state.configPath === undefined
      ? {}
      : { configPath: options.state.configPath }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    ...(options.state.env === undefined ? {} : { env: options.state.env })
  });
  const inspection = inspectRuntimePluginConfigForControl({
    manifest,
    state: options.state,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });

  return !(
    targetConfigPath !== options.effect.targetConfigPath ||
    inspection.fingerprint !== options.effect.expectedFingerprint
  );
}

export function createPreparedRuntimePluginConfigEffectConfirmationPreview(
  options: {
    readonly effect: PreparedRuntimePluginConfigEffect;
    readonly state: RuntimePluginConfigControlHostState;
    readonly storeRoot?: string;
  }
): RuntimePluginJsonObject {
  const manifest = options.state.pluginManifests.find(
    (candidate) => candidate.id === options.effect.targetPluginId
  );

  if (
    manifest === undefined ||
    !preparedRuntimePluginConfigEffectIsStillCurrent(options)
  ) {
    throw new RuntimeConfigConflictError(
      'Prepared plugin config effect is no longer current for approval.'
    );
  }

  const operation: RuntimePluginConfigFieldControlOperation =
    options.effect.operation.kind === 'set'
      ? {
          kind: 'set',
          fieldName: options.effect.fieldName,
          value: options.effect.operation.value
        }
      : {
          kind: 'unset',
          fieldName: options.effect.fieldName
        };
  const field = validateRuntimePluginConfigControlOperation({
    manifest,
    actor: 'agent',
    operation
  });
  const inspection = inspectRuntimePluginConfigForControl({
    manifest,
    state: options.state,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });
  const inspectedField = inspection.fields.find(
    (candidate) => candidate.name === field.name
  );

  if (inspectedField === undefined) {
    throw new RuntimeConfigConflictError(
      `Plugin config inspection is missing field "${field.name}".`
    );
  }

  return createJsonBoundaryObjectSnapshot(
    pluginConfigChangePreview({
      pluginId: manifest.id,
      field,
      operation,
      expectedFingerprint: options.effect.expectedFingerprint,
      authored: inspectedField.authored
    }),
    { field: 'Prepared plugin config approval preview' }
  );
}

export function handleRuntimePluginConfigUpdateToolCall(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly state: RuntimePluginConfigControlHostState;
  readonly storeRoot?: string;
}): RuntimePluginToolCallExecutionResult {
  let pluginId: string;

  try {
    pluginId = nonEmptyPluginConfigInputString(options.call.input['pluginId']);
  } catch (error: unknown) {
    return rejectedPluginConfigToolCall(
      'plugin_config_update_invalid',
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

  let operation: RuntimePluginConfigFieldControlOperation;
  let expectedFingerprint: string;
  let field: RuntimePluginConfigField;

  try {
    operation = pluginConfigOperationFromInput(options.call.input);
    expectedFingerprint = nonEmptyPluginConfigInputString(
      options.call.input['expectedFingerprint']
    );
    field = validateRuntimePluginConfigControlOperation({
      manifest,
      actor: 'agent',
      operation
    });
  } catch (error: unknown) {
    return rejectedPluginConfigToolCall(
      'plugin_config_update_invalid',
      pluginConfigErrorMessage(error)
    );
  }

  const inspection = inspectRuntimePluginConfigForControl({
    manifest,
    state: options.state,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });
  const blockingDiagnostic = inspection.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error'
  );

  if (blockingDiagnostic !== undefined) {
    return rejectedPluginConfigToolCall(
      'plugin_config_update_invalid',
      `Plugin config cannot be updated while its current authored config is invalid: ${blockingDiagnostic.message}`
    );
  }

  if (inspection.fingerprint !== expectedFingerprint) {
    return rejectedPluginConfigToolCall(
      'plugin_config_fingerprint_conflict',
      'Plugin config changed after it was inspected. Inspect again before requesting an update.'
    );
  }

  let resultFingerprint: string;
  let targetConfigPath: string;

  try {
    const prepared = prepareRuntimePluginConfigControlOperation({
      manifest,
      actor: 'agent',
      expectedFingerprint,
      operation,
      ...(options.state.configPath === undefined
        ? {}
        : { configPath: options.state.configPath }),
      ...(options.storeRoot === undefined
        ? {}
        : { storeRoot: options.storeRoot }),
      ...(options.state.env === undefined ? {} : { env: options.state.env })
    });

    resultFingerprint = prepared.resultFingerprint;
    targetConfigPath = prepared.targetConfigPath;
  } catch (error: unknown) {
    if (error instanceof RuntimeConfigConflictError) {
      return rejectedPluginConfigToolCall(
        'plugin_config_fingerprint_conflict',
        'Plugin config changed after approval and was not updated.'
      );
    }

    return rejectedPluginConfigToolCall(
      'plugin_config_update_failed',
      pluginConfigErrorMessage(error)
    );
  }

  return {
    status: 'accepted',
    output: createJsonBoundaryObjectSnapshot(
      {
        status: 'approved_pending_commit',
        appliesTo: 'future_host_construction',
        pluginId: manifest.id,
        fieldName: field.name,
        operation: operation.kind,
        fingerprint: resultFingerprint,
        reloadRequired: field.reloadRequired === true
      },
      { field: 'Prepared plugin config update' }
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
        summary: `Approved plugin "${manifest.id}" config field "${field.name}" for turn commit.`,
        redactionLabels: options.context.privacy.redactionLabels,
        configFingerprint: resultFingerprint
      })
    ],
    preparedConfigEffect: Object.freeze({
      eventId: options.call.eventId,
      traceId: options.call.traceId,
      createdAt: options.call.createdAt,
      kind: 'runtime_plugin_config_effect',
      effectId:
        options.call.toolCallId ??
        `${options.call.eventId}.${options.call.traceId}.${runtimePluginConfigUpdateToolName}`,
      targetPluginId: manifest.id,
      targetConfigPath,
      fieldName: field.name,
      expectedFingerprint,
      resultFingerprint,
      operation:
        operation.kind === 'set'
          ? Object.freeze({
              kind: 'set',
              value: createJsonBoundarySnapshot(operation.value, {
                field: 'Prepared plugin config update value'
              })
            })
          : Object.freeze({ kind: 'unset' })
    })
  };
}

function pluginConfigOperationFromInput(
  input: RuntimePluginJsonObject
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
        field: 'Plugin config update value'
      })
    };
  }

  if (operation === 'unset') {
    if (value !== undefined) {
      throw new TypeError('Plugin config unset input must not include value.');
    }

    return { kind: 'unset', fieldName };
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
        : { value: options.authored.value })
    }),
    after:
      options.operation.kind === 'set'
        ? Object.freeze({
            configured: true,
            value: redactRuntimeConfigValue(options.operation.value, {
              key: options.field.name
            })
          })
        : Object.freeze({ configured: false })
  });
}
