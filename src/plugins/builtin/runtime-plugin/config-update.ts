import { createRuntimePluginEvidenceSnapshot } from '../../constructors.ts';
import {
  runtimePluginConfigUpdateToolName,
  runtimePluginId
} from '../../contract.ts';
import type {
  RuntimePluginConfigField,
  RuntimePluginContext,
  RuntimePluginJsonObject,
  RuntimePluginProvidedTool,
  RuntimePluginToolCall,
  RuntimePluginToolCallResult
} from '../../plugin-types.ts';
import type {
  RuntimePluginToolConfirmationDecision,
  RuntimePluginToolConfirmationHandler
} from '../../tool-confirmation.ts';
import {
  applyRuntimePluginConfigControlOperation,
  validateRuntimePluginConfigControlOperation,
  type RuntimePluginConfigFieldControlOperation
} from '../../../runtime/config/control.ts';
import { redactRuntimeConfigValue } from '../../../runtime/config/redact.ts';
import {
  RuntimeConfigConflictError,
  type RuntimeConfigMutationResult
} from '../../../runtime/config/mutate.ts';
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

export const runtimePluginConfigUpdateTimeoutMs = 5_000;

export function createRuntimePluginConfigUpdateTool(): RuntimePluginProvidedTool {
  return {
    name: runtimePluginConfigUpdateToolName,
    description:
      'Set or unset one declared non-secret, agent-mutable plugin config field after exact user approval. This cannot change activation, permissions, paths, secrets, or Project02 host settings, and applies only to later host construction.',
    requiredForUserTurn: false,
    callLimit: {
      scope: 'user_turn',
      maxCalls: 2
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

export async function handleRuntimePluginConfigUpdateToolCall(options: {
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly state: RuntimePluginConfigControlHostState;
  readonly confirmationHandler: RuntimePluginToolConfirmationHandler;
  readonly storeRoot?: string;
}): Promise<RuntimePluginToolCallResult> {
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

  const inspectedField = inspection.fields.find(
    (candidate) => candidate.name === field.name
  );

  if (inspectedField === undefined) {
    return rejectedPluginConfigToolCall(
      'plugin_config_update_invalid',
      `Plugin config inspection is missing field "${field.name}".`
    );
  }

  const preview = pluginConfigChangePreview({
    pluginId: manifest.id,
    field,
    operation,
    expectedFingerprint,
    authored: inspectedField.authored
  });
  let confirmationStatus:
    | 'approved'
    | 'denied'
    | 'cancelled'
    | 'timed_out'
    | undefined;

  try {
    confirmationStatus = runtimePluginToolConfirmationStatus(
      await runtimePluginConfigConfirmationBeforeDeadline({
        confirmationHandler: options.confirmationHandler,
        timeoutMs: runtimePluginConfigUpdateTimeoutMs,
        request: Object.freeze({
          pluginId: runtimePluginId,
          toolName: runtimePluginConfigUpdateToolName,
          summary: `Update plugin "${manifest.id}" config field "${field.name}" with one ${operation.kind} operation.`,
          preview
        })
      })
    );
  } catch {
    return rejectedPluginConfigToolCall(
      'plugin_config_approval_unavailable',
      'Plugin config update approval could not be completed.'
    );
  }

  if (confirmationStatus === 'timed_out') {
    return rejectedPluginConfigToolCall(
      'plugin_config_approval_timeout',
      `Plugin config update approval timed out after ${String(runtimePluginConfigUpdateTimeoutMs)}ms.`
    );
  }

  if (confirmationStatus === 'denied') {
    return rejectedPluginConfigToolCall(
      'plugin_config_approval_denied',
      'Plugin config update was denied by the user.'
    );
  }

  if (confirmationStatus === 'cancelled') {
    return rejectedPluginConfigToolCall(
      'plugin_config_approval_cancelled',
      'Plugin config update approval was cancelled.'
    );
  }

  if (confirmationStatus !== 'approved') {
    return rejectedPluginConfigToolCall(
      'plugin_config_approval_unavailable',
      'Plugin config update approval returned an unsupported decision.'
    );
  }

  let mutationResult: RuntimeConfigMutationResult;

  try {
    mutationResult = applyRuntimePluginConfigControlOperation({
      manifest,
      actor: 'agent',
      expectedFingerprint,
      operation,
      ...(options.state.configPath === undefined
        ? {}
        : { configPath: options.state.configPath }),
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      ...(options.state.env === undefined ? {} : { env: options.state.env })
    });
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
        status: 'updated',
        appliesTo: 'future_host_construction',
        pluginId: manifest.id,
        fieldName: field.name,
        operation: operation.kind,
        fingerprint: mutationResult.fingerprint,
        reloadRequired: field.reloadRequired === true
      },
      { field: 'Committed plugin config update' }
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
        summary: `Updated plugin "${manifest.id}" config field "${field.name}" for future host construction.`,
        redactionLabels: options.context.privacy.redactionLabels,
        configFingerprint: mutationResult.fingerprint
      })
    ]
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

function runtimePluginToolConfirmationStatus(
  value: unknown
): 'approved' | 'denied' | 'cancelled' | 'timed_out' | undefined {
  if (!isUnknownRecord(value)) {
    return undefined;
  }

  const status = value['status'];

  return status === 'approved' ||
    status === 'denied' ||
    status === 'cancelled' ||
    status === 'timed_out'
    ? status
    : undefined;
}

async function runtimePluginConfigConfirmationBeforeDeadline(options: {
  readonly confirmationHandler: RuntimePluginToolConfirmationHandler;
  readonly request: Parameters<RuntimePluginToolConfirmationHandler>[0];
  readonly timeoutMs: number;
}): Promise<RuntimePluginToolConfirmationDecision | { readonly status: 'timed_out' }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const abortController = new AbortController();
  const deadlineAt = Date.now() + options.timeoutMs;

  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        options.confirmationHandler(options.request, {
          signal: abortController.signal,
          deadlineAt
        })
      ),
      new Promise<{ readonly status: 'timed_out' }>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(Object.freeze({ status: 'timed_out' as const }));
          abortController.abort();
        }, options.timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    abortController.abort();
  }
}

function isUnknownRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
