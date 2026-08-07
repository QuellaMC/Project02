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
      'Set or unset one declared non-secret, agent-mutable plugin config field after exact user approval. This cannot change activation, permissions, paths, secrets, or Project02 host settings. Committed changes apply by the next turn when the host can live-reload the plugin (reported per update as appliesTo), otherwise at a later host construction.',
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
    annotations: {readOnlyHint: false, destructiveHint: true},
    concurrency: 'exclusive',
    requiresConfirmation: true,
  };
}

export function reconcilePreparedRuntimePluginConfigEffect(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly state: RuntimePluginConfigControlHostState;
}) {
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
  const field = requiredRuntimePluginConfigControl(
    options.state,
  ).validateOperation({
    manifest,
    actor: 'agent',
    operation,
  });
  const target = options.state.configControl.target;

  if (target.canonicalConfigPath !== options.effect.targetConfigPath) {
    throw requiredRuntimePluginConfigControl(options.state).createConflictError(
      `Prepared config effect "${options.effect.effectId}" targets another runtime config path.`,
    );
  }

  const inspection = inspectRuntimePluginConfigForControl({
    manifest,
    state: options.state,
  });
  let reconciliation: 'already_applied' | 'applied';

  if (inspection.fingerprint === options.effect.resultFingerprint) {
    reconciliation = 'already_applied';
  } else {
    if (inspection.fingerprint !== options.effect.expectedFingerprint) {
      throw requiredRuntimePluginConfigControl(
        options.state,
      ).createConflictError(
        `Prepared config effect "${options.effect.effectId}" cannot be reconciled because authored config changed.`,
      );
    }

    const prepared = requiredRuntimePluginConfigControl(
      options.state,
    ).prepareOperation({
      target,
      expectedFingerprint: options.effect.expectedFingerprint,
      request: {
        kind: 'plugin_config',
        manifest,
        actor: 'agent',
        fieldOperation: operation,
      },
    });

    if (
      prepared.targetConfigPath !== options.effect.targetConfigPath ||
      prepared.resultFingerprint !== options.effect.resultFingerprint
    ) {
      throw new Error(
        `Prepared config effect "${options.effect.effectId}" does not match its validated config candidate.`,
      );
    }

    const result = requiredRuntimePluginConfigControl(
      options.state,
    ).applyOperation({
      target,
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
        id: options.effect.effectId,
      },
    ],
    redactionLabels: field.redactionLabels,
    configFingerprint: options.effect.resultFingerprint,
  });
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

export function preparedRuntimePluginConfigEffectIsStillCurrent(options: {
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
  readonly canLiveReload?: (pluginId: string) => boolean;
  /**
   * Host-kept turn record: true when this turn already CONFIRMED a
   * session-scoped update for the plugin. Committed same-plugin changes
   * reload as one group and a mixed group always defers, so a live-field
   * update must stop promising appliesTo: next_turn in that case.
   */
  readonly sessionScopedUpdateConfirmedThisTurn?: (pluginId: string) => boolean;
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
        'Plugin config changed after approval and was not updated. Inspect runtime.plugin.config again for the current fingerprint, then retry.',
      );
    }

    return rejectedPluginConfigToolCall(
      'plugin_config_update_failed',
      pluginConfigErrorMessage(error),
    );
  }

  return approvedRuntimePluginConfigUpdateResult({
    call: options.call,
    context: options.context,
    manifest,
    field,
    operation,
    expectedFingerprint,
    resultFingerprint,
    targetConfigPath,
    ...(options.canLiveReload === undefined
      ? {}
      : {canLiveReload: options.canLiveReload}),
    ...(options.sessionScopedUpdateConfirmedThisTurn === undefined
      ? {}
      : {
          sessionScopedUpdateConfirmedThisTurn:
            options.sessionScopedUpdateConfirmedThisTurn,
        }),
  });
}

function approvedRuntimePluginConfigUpdateResult(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly manifest: {readonly id: string};
  readonly field: RuntimePluginConfigField;
  readonly operation: RuntimePluginConfigFieldControlOperation;
  readonly expectedFingerprint: string;
  readonly resultFingerprint: string;
  readonly targetConfigPath: string;
  readonly canLiveReload?: (pluginId: string) => boolean;
  readonly sessionScopedUpdateConfirmedThisTurn?: (pluginId: string) => boolean;
}): RuntimePluginToolCallExecutionResult {
  const {call, context, manifest, field, operation, resultFingerprint} =
    options;
  const liveField = field.reloadRequired === false;
  // Backward-looking on purpose. A later same-turn update cannot break an
  // earlier next_turn promise: config mutations are compare-and-swap on the
  // whole-file fingerprint, so once a fingerprint-CHANGING live update is
  // approved, any later update prepared this turn conflict-closes at commit
  // and never joins the group. The one sequence where both commit is a
  // value-preserving (no-op) live update first — whose next_turn promise is
  // vacuous, since there is no observable change to apply.
  const mixedTurnGroup =
    liveField &&
    options.sessionScopedUpdateConfirmedThisTurn?.(manifest.id) === true;

  return {
    status: 'accepted',
    output: createJsonBoundaryObjectSnapshot(
      {
        status: 'approved_pending_commit',
        appliesTo:
          liveField &&
          !mixedTurnGroup &&
          options.canLiveReload?.(manifest.id) === true
            ? 'next_turn'
            : 'future_host_construction',
        ...(mixedTurnGroup
          ? {
              appliesToNote:
                'Not promised for the next turn: this turn already approved a session-scoped update for this plugin, and committed same-plugin changes are never live-applied as a mixed group.',
            }
          : {}),
        pluginId: manifest.id,
        fieldName: field.name,
        operation: operation.kind,
        fingerprint: resultFingerprint,
        reloadRequired: field.reloadRequired !== false,
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
        summary: `Approved plugin "${manifest.id}" config field "${field.name}" for turn commit.`,
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
