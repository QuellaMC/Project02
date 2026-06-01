import { SCHEMA_VERSION, type SchemaVersion } from './schema.ts';
import {
  asRecord,
  getOwnField,
  rejectExtraKeys,
  requireLiteral,
  requireOneOf,
  requireString
} from './validation.ts';
import { ContractValidationError } from './errors.ts';
import {
  buildRawLogEntry,
  snapshotRawValue,
  type Clock,
  type IdGenerator,
  type RawEventLogEntry
} from './logging.ts';
import { INCIDENT_COMPLETION, USER_MESSAGE } from './contracts.ts';

export const RUNTIME_OPERATION_STARTED_KIND = 'runtime_operation_started';
export const RUNTIME_OPERATION_COMPLETED_KIND = 'runtime_operation_completed';
export const RUNTIME_OPERATION_REJECTED_KIND = 'runtime_operation_rejected';
export const RUNTIME_OPERATION_SUCCEEDED_WITH_AUDIT_FAILURE_STATUS =
  'succeeded_with_audit_failure';

const OPERATION_CATEGORIES = [
  'read',
  'context_build',
  'model_call',
  'visible_effect',
  'state_write',
  'life_action'
] as const;
const OPERATION_CALL_TYPES = ['user_turn', 'deterministic_event_commit', 'test'] as const;
const OPERATION_EVENT_TYPES = [USER_MESSAGE, INCIDENT_COMPLETION] as const;
const PRIVACY_MODES = ['full', 'redacted', 'omitted'] as const;
const TRANSACTION_MODES = ['none', 'read_only', 'existing_commit_effect_atomic'] as const;
const PERMISSION_POLICY_IDS = ['internal_runtime_only', 'test_only'] as const;
const LOGGING_POLICY_MODES = ['required', 'disabled_for_tests'] as const;
const EXECUTION_MODES = ['sync_in_process'] as const;

type RuntimeOperationCategory = (typeof OPERATION_CATEGORIES)[number];
type RuntimeOperationCallType = (typeof OPERATION_CALL_TYPES)[number];
type RuntimeOperationEventType = (typeof OPERATION_EVENT_TYPES)[number];
type RuntimeOperationPrivacyMode = (typeof PRIVACY_MODES)[number];
type RuntimeOperationTransactionMode = (typeof TRANSACTION_MODES)[number];
type RuntimeOperationPermissionPolicyId = (typeof PERMISSION_POLICY_IDS)[number];
type RuntimeOperationLoggingMode = (typeof LOGGING_POLICY_MODES)[number];
type RuntimeOperationExecutionMode = (typeof EXECUTION_MODES)[number];

export type RuntimeOperationCaller = {
  component_id: string;
  call_type: RuntimeOperationCallType;
};

export type RuntimeOperationRequest = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: RuntimeOperationEventType;
  caller: RuntimeOperationCaller;
  op: string;
  input: unknown;
};

export type RuntimeOperationFailure = {
  stage: string;
  code: string;
  message: string;
};

type RuntimeOperationStatus =
  | 'succeeded'
  | 'rejected'
  | typeof RUNTIME_OPERATION_SUCCEEDED_WITH_AUDIT_FAILURE_STATUS;

export type RuntimeOperationResult = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  op: string;
  owner_component_id: string;
  status: RuntimeOperationStatus;
  output?: unknown;
  failure?: RuntimeOperationFailure;
  committed_log_entry_ids?: string[];
};

type RuntimeOperationRequestIdentity = {
  trace_id: string;
  event_id: string;
  event_type: RuntimeOperationEventType;
  op: string;
};

export type RuntimeOperationPolicy = {
  category: RuntimeOperationCategory;
  permission_policy_id: RuntimeOperationPermissionPolicyId;
  allowed_callers: readonly string[];
  allowed_call_types: readonly RuntimeOperationCallType[];
  allowed_event_types: readonly RuntimeOperationEventType[];
};

export type RuntimeOperationPrivacyPolicy = {
  input: RuntimeOperationPrivacyMode;
  output: RuntimeOperationPrivacyMode;
};

export type RuntimeOperationLoggingPolicy = {
  mode: RuntimeOperationLoggingMode;
};

export type RuntimeOperationTransactionPolicy = {
  mode: RuntimeOperationTransactionMode;
};

export type RuntimeOperationExecutionPolicy = {
  mode: RuntimeOperationExecutionMode;
};

export type RuntimeOperationDefinition = {
  op: string;
  owner_component_id: string;
  input_contract_id: string;
  output_contract_id: string;
  validate_input: (request: RuntimeOperationRequest) => unknown;
  validate_output: (output: unknown, request: RuntimeOperationRequest) => unknown;
  policy: RuntimeOperationPolicy;
  privacy: RuntimeOperationPrivacyPolicy;
  logging: RuntimeOperationLoggingPolicy;
  transaction: RuntimeOperationTransactionPolicy;
  execution: RuntimeOperationExecutionPolicy;
  handler: (request: RuntimeOperationRequest, input: unknown) => unknown;
};

export type RuntimeOperationRegistry = {
  operations: readonly RuntimeOperationDefinition[];
  get: (op: string) => RuntimeOperationDefinition | undefined;
  isOwnerComponentDisabled: (componentId: string) => boolean;
};

export class RuntimeOperationRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeOperationRegistryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RuntimeOperationExecutionError extends Error {
  readonly stage: string;
  readonly code: string;

  constructor(
    message: string,
    { stage, code }: { stage: string; code: string }
  ) {
    super(message);
    this.name = 'RuntimeOperationExecutionError';
    this.stage = stage;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type RuntimeAccessDependencies = {
  rawEventLog: {
    append: (entry: RawEventLogEntry) => void;
  };
  idGenerator: IdGenerator;
  clock: Clock;
};

export function createRuntimeOperationRegistry(
  operations: readonly RuntimeOperationDefinition[],
  {
    disabledOwnerComponentIds = []
  }: { disabledOwnerComponentIds?: readonly string[] } = {}
): RuntimeOperationRegistry {
  const operationByName = new Map<string, RuntimeOperationDefinition>();
  const frozenOperations: RuntimeOperationDefinition[] = [];
  for (const operation of operations) {
    validateOperationDefinition(operation);
    const frozenOperation = freezeRuntimeOperationDefinition(operation);
    if (operationByName.has(frozenOperation.op)) {
      throw new RuntimeOperationRegistryError(`duplicate operation: ${frozenOperation.op}`);
    }
    operationByName.set(frozenOperation.op, frozenOperation);
    frozenOperations.push(frozenOperation);
  }
  const disabledOwners = new Set(disabledOwnerComponentIds);
  return Object.freeze({
    operations: Object.freeze(frozenOperations),
    get: (op: string) => operationByName.get(op),
    isOwnerComponentDisabled: (componentId: string) => disabledOwners.has(componentId)
  });
}

export function freezeRuntimeOperationDefinition(
  operation: RuntimeOperationDefinition
): RuntimeOperationDefinition {
  return Object.freeze({
    ...operation,
    policy: Object.freeze({
      ...operation.policy,
      allowed_callers: Object.freeze([...operation.policy.allowed_callers]),
      allowed_call_types: Object.freeze([...operation.policy.allowed_call_types]),
      allowed_event_types: Object.freeze([...operation.policy.allowed_event_types])
    }),
    privacy: Object.freeze({ ...operation.privacy }),
    logging: Object.freeze({ ...operation.logging }),
    transaction: Object.freeze({ ...operation.transaction }),
    execution: Object.freeze({ ...operation.execution })
  });
}

export class RuntimeAccess {
  readonly #registry: RuntimeOperationRegistry;
  readonly #rawEventLog: RuntimeAccessDependencies['rawEventLog'];
  readonly #idGenerator: IdGenerator;
  readonly #clock: Clock;

  constructor(
    registry: RuntimeOperationRegistry,
    { rawEventLog, idGenerator, clock }: RuntimeAccessDependencies
  ) {
    this.#registry = registry;
    this.#rawEventLog = rawEventLog;
    this.#idGenerator = idGenerator;
    this.#clock = clock;
  }

  execute(request: RuntimeOperationRequest): RuntimeOperationResult {
    let operationRequest: RuntimeOperationRequest;
    try {
      operationRequest = validateRuntimeOperationRequest(request);
    } catch (error) {
      const requestIdentity = extractRuntimeOperationRequestIdentity(request);
      if (requestIdentity === undefined) {
        throw error;
      }
      return this.#rejectMalformedRequest(
        requestIdentity,
        operationFailureFromError(error, {
          stage: 'request_validation',
          code: 'malformed_operation_request'
        })
      );
    }
    const operation = this.#registry.get(operationRequest.op);
    if (operation === undefined) {
      return this.#rejectOperation(operationRequest, 'runtime', {
        stage: 'lookup',
        code: 'unknown_operation',
        message: `operation is not registered: ${operationRequest.op}`
      });
    }
    if (this.#registry.isOwnerComponentDisabled(operation.owner_component_id)) {
      return this.#rejectOperation(operationRequest, operation.owner_component_id, {
        stage: 'lookup',
        code: 'disabled_owner_component',
        message: `operation owner component is disabled: ${operation.owner_component_id}`
      }, operation);
    }

    const policyFailure = validateOperationPolicy(operation, operationRequest);
    if (policyFailure !== undefined) {
      return this.#rejectOperation(
        operationRequest,
        operation.owner_component_id,
        policyFailure,
        operation
      );
    }

    let input: unknown;
    try {
      input = operation.validate_input(operationRequest);
    } catch (error) {
      return this.#rejectOperation(
        operationRequest,
        operation.owner_component_id,
        operationFailureFromError(error, {
          stage: 'input_validation',
          code: 'malformed_input'
        }),
        operation
      );
    }

    const startedLogFailure = this.#tryAppendAuditLog(
      RUNTIME_OPERATION_STARTED_KIND,
      operation,
      operationRequest,
      {
        input
      }
    );
    if (startedLogFailure !== undefined) {
      return this.#rejectedResult(
        operationRequest,
        operation.owner_component_id,
        startedLogFailure
      );
    }

    let output: unknown;
    try {
      output = operation.handler(operationRequest, input);
    } catch (error) {
      return this.#rejectOperation(
        operationRequest,
        operation.owner_component_id,
        operationFailureFromError(error, {
          stage: 'handler',
          code: 'handler_exception'
        }),
        operation
      );
    }
    if (isPromiseLike(output)) {
      return this.#rejectOperation(
        operationRequest,
        operation.owner_component_id,
        {
          stage: 'handler',
          code: 'async_operation_not_supported',
          message:
            `operation ${operation.op} returned a Promise, but only ` +
            `${operation.execution.mode} execution is supported in MVP-022.`
        },
        operation
      );
    }

    let validatedOutput: unknown;
    try {
      validatedOutput = operation.validate_output(output, operationRequest);
    } catch (error) {
      return this.#rejectOperation(
        operationRequest,
        operation.owner_component_id,
        operationFailureFromError(error, {
          stage: 'output_validation',
          code: 'malformed_output'
        }),
        operation
      );
    }

    let clonedOutput: unknown;
    try {
      clonedOutput = structuredClone(validatedOutput);
    } catch (error) {
      return this.#rejectOperation(
        operationRequest,
        operation.owner_component_id,
        operationFailureFromError(error, {
          stage: 'output_validation',
          code: 'malformed_output'
        }),
        operation
      );
    }

    const completedLogFailure = this.#tryAppendAuditLog(
      RUNTIME_OPERATION_COMPLETED_KIND,
      operation,
      operationRequest,
      {
        output: clonedOutput
      }
    );
    if (completedLogFailure !== undefined) {
      return {
        schema_version: SCHEMA_VERSION,
        trace_id: operationRequest.trace_id,
        event_id: operationRequest.event_id,
        op: operationRequest.op,
        owner_component_id: operation.owner_component_id,
        status: RUNTIME_OPERATION_SUCCEEDED_WITH_AUDIT_FAILURE_STATUS,
        output: clonedOutput,
        failure: structuredClone(completedLogFailure)
      };
    }
    return {
      schema_version: SCHEMA_VERSION,
      trace_id: operationRequest.trace_id,
      event_id: operationRequest.event_id,
      op: operationRequest.op,
      owner_component_id: operation.owner_component_id,
      status: 'succeeded',
      output: clonedOutput
    };
  }

  #rejectMalformedRequest(
    requestIdentity: RuntimeOperationRequestIdentity,
    failure: RuntimeOperationFailure
  ): RuntimeOperationResult {
    const loggingFailure = this.#tryAppendMalformedRequestRejectionLog(
      requestIdentity,
      failure
    );
    return {
      schema_version: SCHEMA_VERSION,
      trace_id: requestIdentity.trace_id,
      event_id: requestIdentity.event_id,
      op: requestIdentity.op,
      owner_component_id: 'runtime',
      status: 'rejected',
      failure: structuredClone(loggingFailure ?? failure)
    };
  }

  #rejectOperation(
    request: RuntimeOperationRequest,
    ownerComponentId: string,
    failure: RuntimeOperationFailure,
    operation?: RuntimeOperationDefinition
  ): RuntimeOperationResult {
    if (failure.stage === 'logging') {
      return this.#rejectedResult(request, ownerComponentId, failure);
    }
    const loggingFailure =
      operation === undefined
        ? this.#tryAppendRawRejectionLog(request, ownerComponentId, failure)
        : this.#tryAppendAuditLog(RUNTIME_OPERATION_REJECTED_KIND, operation, request, {
            failure
          });
    return this.#rejectedResult(request, ownerComponentId, loggingFailure ?? failure);
  }

  #rejectedResult(
    request: RuntimeOperationRequest,
    ownerComponentId: string,
    failure: RuntimeOperationFailure
  ): RuntimeOperationResult {
    return {
      schema_version: SCHEMA_VERSION,
      trace_id: request.trace_id,
      event_id: request.event_id,
      op: request.op,
      owner_component_id: ownerComponentId,
      status: 'rejected',
      failure: structuredClone(failure)
    };
  }

  #tryAppendMalformedRequestRejectionLog(
    requestIdentity: RuntimeOperationRequestIdentity,
    failure: RuntimeOperationFailure
  ): RuntimeOperationFailure | undefined {
    try {
      this.#rawEventLog.append(
        buildRawLogEntry({
          trace_id: requestIdentity.trace_id,
          event_id: requestIdentity.event_id,
          kind: RUNTIME_OPERATION_REJECTED_KIND,
          data: {
            op: requestIdentity.op,
            owner_component_id: 'runtime',
            event_type: requestIdentity.event_type,
            failure: structuredClone(failure)
          },
          idGenerator: this.#idGenerator,
          clock: this.#clock
        })
      );
      return undefined;
    } catch (error) {
      return loggingFailureFromError(error, RUNTIME_OPERATION_REJECTED_KIND);
    }
  }

  #tryAppendRawRejectionLog(
    request: RuntimeOperationRequest,
    ownerComponentId: string,
    failure: RuntimeOperationFailure
  ): RuntimeOperationFailure | undefined {
    try {
      this.#rawEventLog.append(
        buildRawLogEntry({
          trace_id: request.trace_id,
          event_id: request.event_id,
          kind: RUNTIME_OPERATION_REJECTED_KIND,
          data: {
            op: request.op,
            owner_component_id: ownerComponentId,
            caller: structuredClone(request.caller),
            event_type: request.event_type,
            failure: structuredClone(failure)
          },
          idGenerator: this.#idGenerator,
          clock: this.#clock
        })
      );
      return undefined;
    } catch (error) {
      return loggingFailureFromError(error, RUNTIME_OPERATION_REJECTED_KIND);
    }
  }

  #tryAppendAuditLog(
    kind: string,
    operation: RuntimeOperationDefinition,
    request: RuntimeOperationRequest,
    {
      input,
      output,
      failure
    }: { input?: unknown; output?: unknown; failure?: RuntimeOperationFailure } = {}
  ): RuntimeOperationFailure | undefined {
    if (operation.logging.mode === 'disabled_for_tests') {
      return undefined;
    }
    try {
      const data: Record<string, unknown> = {
        op: operation.op,
        owner_component_id: operation.owner_component_id,
        caller: structuredClone(request.caller),
        event_type: request.event_type,
        input_contract_id: operation.input_contract_id,
        output_contract_id: operation.output_contract_id,
        permission_policy_id: operation.policy.permission_policy_id,
        operation_category: operation.policy.category,
        logging_policy: operation.logging.mode,
        transaction_policy: operation.transaction.mode,
        execution_policy: operation.execution.mode
      };
      if (input !== undefined) {
        data['input_snapshot'] = snapshotByPrivacy(input, operation.privacy.input);
      }
      if (output !== undefined) {
        data['output_snapshot'] = snapshotByPrivacy(output, operation.privacy.output);
      }
      if (failure !== undefined) {
        data['failure'] = structuredClone(failure);
      }
      this.#rawEventLog.append(
        buildRawLogEntry({
          trace_id: request.trace_id,
          event_id: request.event_id,
          kind,
          data,
          idGenerator: this.#idGenerator,
          clock: this.#clock
        })
      );
      return undefined;
    } catch (error) {
      return loggingFailureFromError(error, kind);
    }
  }

}

function validateRuntimeOperationRequest(request: unknown): RuntimeOperationRequest {
  const record = asRecord(request, 'RuntimeOperationRequest');
  rejectExtraKeys(
    record,
    ['schema_version', 'trace_id', 'event_id', 'event_type', 'caller', 'op', 'input'],
    'RuntimeOperationRequest'
  );
  const callerRecord = asRecord(getOwnField(record, 'caller'), 'RuntimeOperationRequest.caller');
  rejectExtraKeys(
    callerRecord,
    ['component_id', 'call_type'],
    'RuntimeOperationRequest.caller'
  );
  return {
    schema_version: requireLiteral(
      getOwnField(record, 'schema_version'),
      SCHEMA_VERSION,
      'RuntimeOperationRequest.schema_version'
    ),
    trace_id: requireString(getOwnField(record, 'trace_id'), 'RuntimeOperationRequest.trace_id'),
    event_id: requireString(getOwnField(record, 'event_id'), 'RuntimeOperationRequest.event_id'),
    event_type: requireOneOf(
      getOwnField(record, 'event_type'),
      OPERATION_EVENT_TYPES,
      'RuntimeOperationRequest.event_type'
    ),
    caller: {
      component_id: requireString(
        getOwnField(callerRecord, 'component_id'),
        'RuntimeOperationRequest.caller.component_id'
      ),
      call_type: requireOneOf(
        getOwnField(callerRecord, 'call_type'),
        OPERATION_CALL_TYPES,
        'RuntimeOperationRequest.caller.call_type'
      )
    },
    op: requireString(getOwnField(record, 'op'), 'RuntimeOperationRequest.op'),
    input: getOwnField(record, 'input')
  };
}

function extractRuntimeOperationRequestIdentity(
  request: unknown
): RuntimeOperationRequestIdentity | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return undefined;
  }
  const prototype: unknown = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  const record = request as Record<string, unknown>;
  if (record['schema_version'] !== SCHEMA_VERSION) {
    return undefined;
  }
  const traceId = record['trace_id'];
  const eventId = record['event_id'];
  const eventType = record['event_type'];
  const op = record['op'];
  if (
    typeof traceId !== 'string' ||
    traceId.trim().length === 0 ||
    typeof eventId !== 'string' ||
    eventId.trim().length === 0 ||
    !isRuntimeOperationEventType(eventType) ||
    typeof op !== 'string' ||
    op.trim().length === 0
  ) {
    return undefined;
  }
  return {
    trace_id: traceId,
    event_id: eventId,
    event_type: eventType,
    op
  };
}

function validateOperationDefinition(operation: RuntimeOperationDefinition): void {
  requireNonEmpty(operation.op, 'RuntimeOperationDefinition.op');
  requireNonEmpty(operation.owner_component_id, 'RuntimeOperationDefinition.owner_component_id');
  requireNonEmpty(operation.input_contract_id, 'RuntimeOperationDefinition.input_contract_id');
  requireNonEmpty(operation.output_contract_id, 'RuntimeOperationDefinition.output_contract_id');
  requireOneOf(operation.policy.category, OPERATION_CATEGORIES, 'RuntimeOperationPolicy.category');
  requireOneOf(
    operation.policy.permission_policy_id,
    PERMISSION_POLICY_IDS,
    'RuntimeOperationPolicy.permission_policy_id'
  );
  requireNonEmptyList(operation.policy.allowed_callers, 'RuntimeOperationPolicy.allowed_callers');
  requireNonEmptyList(
    operation.policy.allowed_call_types,
    'RuntimeOperationPolicy.allowed_call_types'
  );
  requireNonEmptyList(
    operation.policy.allowed_event_types,
    'RuntimeOperationPolicy.allowed_event_types'
  );
  for (const caller of operation.policy.allowed_callers) {
    requireNonEmpty(caller, 'RuntimeOperationPolicy.allowed_callers[]');
  }
  for (const callType of operation.policy.allowed_call_types) {
    requireOneOf(callType, OPERATION_CALL_TYPES, 'RuntimeOperationPolicy.allowed_call_types[]');
  }
  for (const eventType of operation.policy.allowed_event_types) {
    requireOneOf(eventType, OPERATION_EVENT_TYPES, 'RuntimeOperationPolicy.allowed_event_types[]');
  }
  requireOneOf(
    operation.privacy.input,
    PRIVACY_MODES,
    'RuntimeOperationPrivacyPolicy.input'
  );
  requireOneOf(
    operation.privacy.output,
    PRIVACY_MODES,
    'RuntimeOperationPrivacyPolicy.output'
  );
  requireOneOf(
    operation.transaction.mode,
    TRANSACTION_MODES,
    'RuntimeOperationTransactionPolicy.mode'
  );
  requireOneOf(
    operation.logging.mode,
    LOGGING_POLICY_MODES,
    'RuntimeOperationLoggingPolicy.mode'
  );
  requireOneOf(
    operation.execution.mode,
    EXECUTION_MODES,
    'RuntimeOperationExecutionPolicy.mode'
  );
  validatePolicyContractConsistency(operation);
}

function validateOperationPolicy(
  operation: RuntimeOperationDefinition,
  request: RuntimeOperationRequest
): RuntimeOperationFailure | undefined {
  if (!operation.policy.allowed_callers.includes(request.caller.component_id)) {
    return {
      stage: 'policy',
      code: 'unsupported_caller',
      message: `operation ${operation.op} does not allow caller ${request.caller.component_id}`
    };
  }
  if (!operation.policy.allowed_call_types.includes(request.caller.call_type)) {
    return {
      stage: 'policy',
      code: 'unsupported_call_type',
      message: `operation ${operation.op} does not allow call type ${request.caller.call_type}`
    };
  }
  if (!operation.policy.allowed_event_types.includes(request.event_type)) {
    return {
      stage: 'policy',
      code: 'unsupported_event_type',
      message: `operation ${operation.op} does not allow event type ${request.event_type}`
    };
  }
  if (
    operation.policy.permission_policy_id === 'internal_runtime_only' &&
    !request.caller.component_id.startsWith('runtime.')
  ) {
    return {
      stage: 'policy',
      code: 'permission_denied',
      message:
        `operation ${operation.op} permission internal_runtime_only rejects ` +
        `caller ${request.caller.component_id}`
    };
  }
  if (
    operation.policy.permission_policy_id === 'test_only' &&
    request.caller.call_type !== 'test'
  ) {
    return {
      stage: 'policy',
      code: 'permission_denied',
      message: `operation ${operation.op} permission test_only requires call type test`
    };
  }
  return undefined;
}

function validatePolicyContractConsistency(operation: RuntimeOperationDefinition): void {
  if (
    operation.logging.mode === 'disabled_for_tests' &&
    operation.policy.permission_policy_id !== 'test_only'
  ) {
    throw new RuntimeOperationRegistryError(
      'RuntimeOperationLoggingPolicy.mode disabled_for_tests requires test_only permission.'
    );
  }
  const category = operation.policy.category;
  if (category === 'read' && operation.transaction.mode !== 'read_only') {
    throw new RuntimeOperationRegistryError('read operations must use read_only transaction.');
  }
  if (
    (category === 'context_build' || category === 'model_call') &&
    operation.transaction.mode !== 'none'
  ) {
    throw new RuntimeOperationRegistryError(
      `${category} operations must use none transaction.`
    );
  }
  if (
    (category === 'visible_effect' ||
      category === 'state_write' ||
      category === 'life_action') &&
    operation.transaction.mode !== 'existing_commit_effect_atomic'
  ) {
    throw new RuntimeOperationRegistryError(
      `${category} operations must use existing_commit_effect_atomic transaction.`
    );
  }
}

function operationFailureFromError(
  error: unknown,
  fallback: { stage: string; code: string }
): RuntimeOperationFailure {
  if (error instanceof RuntimeOperationExecutionError) {
    return {
      stage: error.stage,
      code: error.code,
      message: error.message
    };
  }
  if (error instanceof ContractValidationError || error instanceof Error) {
    return {
      stage: fallback.stage,
      code: fallback.code,
      message: error.message
    };
  }
  return {
    stage: fallback.stage,
    code: fallback.code,
    message: 'operation failed with a non-error value.'
  };
}

function loggingFailureFromError(error: unknown, kind: string): RuntimeOperationFailure {
  if (error instanceof Error) {
    return {
      stage: 'logging',
      code: 'audit_log_append_failed',
      message: `failed to append ${kind}: ${error.message}`
    };
  }
  return {
    stage: 'logging',
    code: 'audit_log_append_failed',
    message: `failed to append ${kind}: non-error value thrown`
  };
}

function snapshotByPrivacy(value: unknown, mode: RuntimeOperationPrivacyMode): unknown {
  if (mode === 'omitted') {
    return { omitted: true };
  }
  if (mode === 'redacted') {
    return { redacted: true };
  }
  return snapshotRawValue(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function isRuntimeOperationEventType(value: unknown): value is RuntimeOperationEventType {
  return (
    typeof value === 'string' &&
    OPERATION_EVENT_TYPES.some((eventType) => eventType === value)
  );
}

function requireNonEmptyList(value: readonly unknown[], fieldName: string): void {
  if (value.length === 0) {
    throw new RuntimeOperationRegistryError(`${fieldName} must not be empty.`);
  }
}

function requireNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new RuntimeOperationRegistryError(`${fieldName} must be a non-empty string.`);
  }
}
