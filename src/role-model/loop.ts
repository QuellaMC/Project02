import {
  ACTIVE_INCIDENT_INTERRUPT_POLICIES,
  ACTIVE_INCIDENT_RESUME_POLICIES,
  ACTIVE_INCIDENT_TYPES,
  CANCEL_INCIDENT_ACTION,
  COMPLETE_INCIDENT_ACTION,
  DECISION_READY_FOR_COMMIT_STATUS,
  LIFE_ACTION,
  START_INCIDENT_ACTION,
  STATE_PATCH_ACTION,
  USER_MESSAGE,
  VISIBLE_REPLY_ACTION,
  ContractValidationError,
  normalizeVisibleReplyDecisionWithOptionalLivingStatePatch,
  validateNormalizedUserMessageEvent,
  type LifeAction,
  type UserMessageRuntimeEvent,
  type VisibleReplyDecision
} from '../runtime/contracts.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../runtime/schema.ts';
import {
  buildRawLogEntry,
  snapshotRawValue,
  type Clock,
  type IdGenerator,
  type RawEventLogEntry
} from '../runtime/logging.ts';
import {
  asRecord,
  getOwnField,
  rejectExtraKeys,
  requireLiteral,
  requireMatchingIdentity,
  requireOptionalString,
  requireString,
  validateIso8601Timestamp
} from '../runtime/validation.ts';
import {
  USER_MESSAGE_VISIBLE_REPLY_CALL,
  buildCharacterDecisionContext,
  validateCharacterDecisionContextForEvent,
  type BuildCharacterDecisionContextOptions,
  type DecisionContext,
  type DecisionContextValidationEvent
} from '../character/state/context.ts';

export { USER_MESSAGE_VISIBLE_REPLY_CALL };

export const ROLE_MODEL_TURN_COMPLETED_KIND = 'role_model_turn_completed';
export const ROLE_MODEL_TURN_FAILED_KIND = 'role_model_turn_failed';

const INCIDENT_TYPE_CONTRACT_VALUES = formatAllowedContractValues(ACTIVE_INCIDENT_TYPES);
const INCIDENT_INTERRUPT_POLICY_CONTRACT_VALUES = formatAllowedContractValues(
  ACTIVE_INCIDENT_INTERRUPT_POLICIES
);
const INCIDENT_RESUME_POLICY_CONTRACT_VALUES = formatAllowedContractValues(
  ACTIVE_INCIDENT_RESUME_POLICIES
);

export const ROLE_MODEL_INSTRUCTIONS =
  "Return one JSON object only. The object must contain schema_version='0.1', " +
  "action='visible_reply', and visible_reply.text as a non-empty string. " +
  'Do not include extra fields.';
export const STATE_PATCH_ROLE_MODEL_INSTRUCTIONS =
  "Return one JSON object only. The object must contain schema_version='0.1', " +
  "action='visible_reply', and visible_reply.text as a non-empty string. " +
  'It may also include optional state_patch.living_state with only ' +
  'current_activity, mood, and toward_user as non-empty strings. ' +
  'Do not include extra fields.';
export const INCIDENT_START_ROLE_MODEL_INSTRUCTIONS =
  "Return one JSON object only. The object must contain schema_version='0.1', " +
  "action='visible_reply', and visible_reply.text as a non-empty string. " +
  "It may also include optional life_action with type='start_incident' and " +
  'incident containing only type, title, optional remaining_seconds, ' +
  'interrupt_policy, and resume_policy. incident.type must be one of: ' +
  `${INCIDENT_TYPE_CONTRACT_VALUES}. interrupt_policy must be one of: ` +
  `${INCIDENT_INTERRUPT_POLICY_CONTRACT_VALUES}. resume_policy must be one ` +
  `of: ${INCIDENT_RESUME_POLICY_CONTRACT_VALUES}. Do not include committed ` +
  'incident fields or extra fields.';
export const INCIDENT_CANCEL_ROLE_MODEL_INSTRUCTIONS =
  "Return one JSON object only. The object must contain schema_version='0.1', " +
  "action='visible_reply', and visible_reply.text as a non-empty string. " +
  "It may also include optional life_action with type='cancel_incident', " +
  'incident_id as the current active incident ID, and reason as a non-empty ' +
  'model-provided explanation. Do not include start_incident, cancelled ' +
  'incident fields, state_patch, or extra fields.';
export const INCIDENT_COMPLETE_ROLE_MODEL_INSTRUCTIONS =
  "Return one JSON object only. The object must contain schema_version='0.1', " +
  "action='visible_reply', and visible_reply.text as a non-empty string. " +
  "It may also include optional life_action with type='complete_incident' " +
  'and incident_id as the current active incident ID. Do not include ' +
  'start_incident, cancel_incident, completed incident fields, state_patch, ' +
  'or extra fields.';

export class RoleModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleModelValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type AllowedActions =
  | [typeof VISIBLE_REPLY_ACTION]
  | [typeof VISIBLE_REPLY_ACTION, typeof STATE_PATCH_ACTION]
  | [typeof VISIBLE_REPLY_ACTION, typeof LIFE_ACTION];

export type RoleModelInputEventContext = {
  type: typeof USER_MESSAGE;
  text: string;
  created_at: string;
  user_id?: string;
  conversation_id?: string;
};

export type RoleModelInputEnvelope = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  call_type: typeof USER_MESSAGE_VISIBLE_REPLY_CALL;
  event: RoleModelInputEventContext;
  allowed_actions: AllowedActions;
  allowed_life_action_type?: LifeAction['type'];
  instructions: string;
  decision_context: DecisionContext;
};

export type RoleModelAdapterOutput = {
  model_id: string;
  created_at: string;
  raw_text: string;
};

export type RoleModelAdapter = {
  generate: (modelInput: RoleModelInputEnvelope) => unknown;
};

export type CharacterDecision = VisibleReplyDecision;

export type RoleModelTurnResult = {
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  model_called: true;
  status: typeof DECISION_READY_FOR_COMMIT_STATUS;
  decision: CharacterDecision;
};

export type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

type RoleModelStage = 'context_build' | 'adapter_call' | 'parse_output';
type RoleModelFailure = {
  stage: RoleModelStage;
  code: string;
  message: string;
};

type RoleModelOptions = BuildCharacterDecisionContextOptions & {
  allowStatePatch?: boolean;
  allowIncidentStart?: boolean;
  allowIncidentCancel?: boolean;
  allowIncidentComplete?: boolean;
};

const FAILURE_CODES_BY_STAGE = {
  context_build: ['malformed_context'],
  adapter_call: ['adapter_exception'],
  parse_output: ['malformed_model_output']
} as const;

export function buildDecisionContext(event: unknown, options: RoleModelOptions = {}): DecisionContext {
  requireSupportedWriteActionOptIn(options);
  if (options.allowStatePatch === true && options.currentStateSource === undefined) {
    throw new RoleModelValidationError('allow_state_patch requires current_state_source.');
  }
  if (options.allowIncidentCancel === true && options.activeIncidentSource === undefined) {
    throw new RoleModelValidationError('allow_incident_cancel requires active_incident_source.');
  }
  if (options.allowIncidentComplete === true && options.activeIncidentSource === undefined) {
    throw new RoleModelValidationError('allow_incident_complete requires active_incident_source.');
  }
  return wrapContractError(() =>
    buildCharacterDecisionContext(
      validateNormalizedUserMessageEvent(event, 'event'),
      buildCharacterContextOptions(options)
    )
  );
}

export function buildRoleModelInputEnvelope(
  event: unknown,
  decisionContext: unknown,
  options: RoleModelOptions = {}
): RoleModelInputEnvelope {
  const normalizedEvent = wrapContractError(() =>
    validateNormalizedUserMessageEvent(event, 'event')
  );
  const allowedActions = allowedActionsForCall(options);
  const allowedLifeActionType = allowedLifeActionTypeForCall(options);
  const eventContext = buildUserMessageEventContext(normalizedEvent);
  const validatedContext = validateDecisionContext(decisionContext, {
    eventContext,
    requireLivingStateBrief: statePatchAllowed(allowedActions)
  });
  wrapContractError(() => {
    requireMatchingIdentity(validatedContext.trace_id, normalizedEvent.trace_id, 'trace_id');
  });
  wrapContractError(() => {
    requireMatchingIdentity(validatedContext.event_id, normalizedEvent.event_id, 'event_id');
  });

  const envelope: RoleModelInputEnvelope = {
    schema_version: SCHEMA_VERSION,
    trace_id: validatedContext.trace_id,
    event_id: validatedContext.event_id,
    call_type: USER_MESSAGE_VISIBLE_REPLY_CALL,
    event: eventContext,
    allowed_actions: allowedActions,
    instructions: instructionsForAllowedActions(allowedActions, {
      allowedLifeActionType
    }),
    decision_context: structuredClone(validatedContext)
  };
  if (allowedLifeActionType !== undefined) {
    envelope.allowed_life_action_type = allowedLifeActionType;
  }
  return envelope;
}

export function renderRoleModelInput(
  event: unknown,
  decisionContext: unknown,
  options: RoleModelOptions = {}
): RoleModelInputEnvelope {
  return buildRoleModelInputEnvelope(event, decisionContext, options);
}

export function parseCharacterDecision(
  roleModelInput: unknown,
  modelOutput: unknown
): CharacterDecision {
  const validatedModelInput = validateRoleModelInput(roleModelInput);
  const rawText = validateAdapterOutput(modelOutput).raw_text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    throw new RoleModelValidationError('raw_text must contain a JSON object.');
  }
  if (!isParsedJsonObject(parsed)) {
    throw new RoleModelValidationError('raw_text must contain a JSON object.');
  }
  return wrapContractError(() =>
    normalizeVisibleReplyDecisionWithOptionalLivingStatePatch(
      parsed,
      {
        traceId: validatedModelInput.trace_id,
        eventId: validatedModelInput.event_id,
        requireAttachedIds: false,
        allowStatePatch: statePatchAllowed(validatedModelInput.allowed_actions),
        allowLifeAction: lifeActionAllowed(validatedModelInput.allowed_actions),
        allowedLifeActionType: allowedLifeActionType(validatedModelInput)
      },
      'model output'
    )
  );
}

export function runRoleModelTurn(
  event: unknown,
  {
    adapter,
    rawEventLog,
    idGenerator,
    clock,
    ...options
  }: RoleModelOptions & {
    adapter: RoleModelAdapter;
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RoleModelTurnResult {
  let modelInput: RoleModelInputEnvelope;
  try {
    const decisionContext = buildDecisionContext(event, options);
    modelInput = renderRoleModelInput(event, decisionContext, options);
  } catch (error) {
    if (error instanceof RoleModelValidationError) {
      rawEventLog.append(
        buildRoleModelContextFailedLogEntry(event, {
          stage: 'context_build',
          code: 'malformed_context',
          message: error.message,
          idGenerator,
          clock
        })
      );
    }
    throw error;
  }

  let modelOutput: unknown;
  try {
    modelOutput = adapter.generate(structuredClone(modelInput));
  } catch (error) {
    rawEventLog.append(
      buildRoleModelTurnFailedLogEntry(modelInput, {
        stage: 'adapter_call',
        code: 'adapter_exception',
        message: errorMessage(error),
        idGenerator,
        clock
      })
    );
    throw error;
  }

  let decision: CharacterDecision;
  try {
    decision = parseCharacterDecision(modelInput, modelOutput);
  } catch (error) {
    if (error instanceof RoleModelValidationError) {
      rawEventLog.append(
        buildRoleModelTurnFailedLogEntry(modelInput, {
          modelOutput,
          stage: 'parse_output',
          code: 'malformed_model_output',
          message: error.message,
          idGenerator,
          clock
        })
      );
    }
    throw error;
  }

  rawEventLog.append(
    buildRoleModelTurnCompletedLogEntry(modelInput, modelOutput, decision, {
      idGenerator,
      clock
    })
  );
  return {
    trace_id: modelInput.trace_id,
    event_id: modelInput.event_id,
    event_type: modelInput.event.type,
    model_called: true,
    status: DECISION_READY_FOR_COMMIT_STATUS,
    decision: structuredClone(decision)
  };
}

export function buildRoleModelContextFailedLogEntry(
  event: unknown,
  {
    stage,
    code,
    message,
    idGenerator,
    clock
  }: {
    stage: string;
    code: string;
    message: string;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RawEventLogEntry {
  const normalizedEvent = wrapContractError(() =>
    validateNormalizedUserMessageEvent(event, 'event')
  );
  const failure = validateFailure({ stage, code, message });
  return buildRawLogEntry({
    trace_id: normalizedEvent.trace_id,
    event_id: normalizedEvent.event_id,
    kind: ROLE_MODEL_TURN_FAILED_KIND,
    data: {
      event: normalizedEvent,
      failure
    },
    idGenerator,
    clock
  });
}

export function buildRoleModelTurnCompletedLogEntry(
  modelInput: unknown,
  modelOutput: unknown,
  decision: unknown,
  { idGenerator, clock }: { idGenerator: IdGenerator; clock: Clock }
): RawEventLogEntry {
  const validatedModelInput = validateRoleModelInput(modelInput);
  const validatedModelOutput = validateAdapterOutput(modelOutput);
  const validatedDecision = validateCharacterDecision(decision, {
    modelInput: validatedModelInput
  });
  return buildRawLogEntry({
    trace_id: validatedModelInput.trace_id,
    event_id: validatedModelInput.event_id,
    kind: ROLE_MODEL_TURN_COMPLETED_KIND,
    data: {
      model_input: validatedModelInput,
      model_output: validatedModelOutput,
      decision: validatedDecision
    },
    idGenerator,
    clock
  });
}

export function buildRoleModelTurnFailedLogEntry(
  modelInput: unknown,
  {
    stage,
    code,
    message,
    idGenerator,
    clock,
    modelOutput
  }: {
    stage: string;
    code: string;
    message: string;
    idGenerator: IdGenerator;
    clock: Clock;
    modelOutput?: unknown;
  }
): RawEventLogEntry {
  const validatedModelInput = validateRoleModelInput(modelInput);
  const failure = validateFailure({ stage, code, message });
  const data: Record<string, unknown> = {
    model_input: validatedModelInput,
    failure
  };
  if (modelOutput !== undefined && modelOutput !== null) {
    try {
      data['model_output'] = validateAdapterOutput(modelOutput);
    } catch {
      data['raw_model_output_snapshot'] = snapshotFailureModelOutput(modelOutput);
    }
  }
  return buildRawLogEntry({
    trace_id: validatedModelInput.trace_id,
    event_id: validatedModelInput.event_id,
    kind: ROLE_MODEL_TURN_FAILED_KIND,
    data,
    idGenerator,
    clock
  });
}

function validateRoleModelInput(modelInput: unknown): RoleModelInputEnvelope {
  const inputRecord = asRoleModelRecord(modelInput, 'RoleModelInput');
  wrapContractError(() => {
    rejectExtraKeys(
      inputRecord,
      [
        'schema_version',
        'trace_id',
        'event_id',
        'call_type',
        'event',
        'allowed_actions',
        'allowed_life_action_type',
        'instructions',
        'decision_context'
      ],
      'RoleModelInput'
    );
  });
  wrapContractError(() => requireLiteral(getOwnField(inputRecord, 'schema_version'), SCHEMA_VERSION, 'schema_version'));
  wrapContractError(() =>
    requireLiteral(getOwnField(inputRecord, 'call_type'), USER_MESSAGE_VISIBLE_REPLY_CALL, 'call_type')
  );
  const eventContext = validateEventContext(getOwnField(inputRecord, 'event'));
  const allowedActions = validateAllowedActions(getOwnField(inputRecord, 'allowed_actions'));
  const lifeActionType = validateAllowedLifeActionType(
    getOwnField(inputRecord, 'allowed_life_action_type'),
    allowedActions
  );
  const decisionContext = validateDecisionContext(getOwnField(inputRecord, 'decision_context'), {
    eventContext,
    requireLivingStateBrief: statePatchAllowed(allowedActions)
  });
  const instructions = validateInstructionsForAllowedActions(
    getOwnField(inputRecord, 'instructions'),
    allowedActions,
    { allowedLifeActionType: lifeActionType }
  );
  const traceId = wrapContractError(() =>
    requireString(getOwnField(inputRecord, 'trace_id'), 'trace_id')
  );
  const eventId = wrapContractError(() =>
    requireString(getOwnField(inputRecord, 'event_id'), 'event_id')
  );
  wrapContractError(() => {
    requireMatchingIdentity(traceId, decisionContext.trace_id, 'trace_id');
  });
  wrapContractError(() => {
    requireMatchingIdentity(eventId, decisionContext.event_id, 'event_id');
  });

  const normalizedInput: RoleModelInputEnvelope = {
    schema_version: SCHEMA_VERSION,
    trace_id: traceId,
    event_id: eventId,
    call_type: USER_MESSAGE_VISIBLE_REPLY_CALL,
    event: eventContext,
    allowed_actions: allowedActions,
    instructions,
    decision_context: decisionContext
  };
  if (lifeActionType !== undefined) {
    normalizedInput.allowed_life_action_type = lifeActionType;
  }
  return normalizedInput;
}

function validateDecisionContext(
  decisionContext: unknown,
  {
    eventContext,
    requireLivingStateBrief
  }: { eventContext: RoleModelInputEventContext; requireLivingStateBrief: boolean }
): DecisionContext {
  const contextRecord = asRoleModelRecord(decisionContext, 'DecisionContext');
  const validationEvent: DecisionContextValidationEvent = {
    trace_id: '',
    event_id: '',
    created_at: eventContext.created_at
  };
  if (eventContext.conversation_id !== undefined) {
    validationEvent.conversation_id = eventContext.conversation_id;
  }
  const validatedContext = wrapContractError(() =>
    validateCharacterDecisionContextForEvent(decisionContext, {
      event: {
        ...validationEvent,
        trace_id: requireString(
          getOwnField(contextRecord, 'trace_id'),
          'trace_id'
        ),
        event_id: requireString(
          getOwnField(contextRecord, 'event_id'),
          'event_id'
        )
      }
    })
  );
  if (
    requireLivingStateBrief &&
    validatedContext.character_snapshot.living_state_brief === undefined
  ) {
    throw new RoleModelValidationError(
      'allowed state_patch requires character_snapshot.living_state_brief.'
    );
  }
  return validatedContext;
}

function validateCharacterDecision(
  decision: unknown,
  { modelInput }: { modelInput: RoleModelInputEnvelope }
): CharacterDecision {
  return wrapContractError(() =>
    normalizeVisibleReplyDecisionWithOptionalLivingStatePatch(
      decision,
      {
        traceId: modelInput.trace_id,
        eventId: modelInput.event_id,
        requireAttachedIds: true,
        allowStatePatch: statePatchAllowed(modelInput.allowed_actions),
        allowLifeAction: lifeActionAllowed(modelInput.allowed_actions),
        allowedLifeActionType: allowedLifeActionType(modelInput)
      },
      'CharacterDecision'
    )
  );
}

function validateAdapterOutput(modelOutput: unknown): RoleModelAdapterOutput {
  const outputRecord = asRoleModelRecord(modelOutput, 'RoleModelAdapterOutput');
  return {
    model_id: wrapContractError(() => requireString(getOwnField(outputRecord, 'model_id'), 'model_id')),
    created_at: wrapContractError(() => requireString(getOwnField(outputRecord, 'created_at'), 'created_at')),
    raw_text: wrapContractError(() => requireString(getOwnField(outputRecord, 'raw_text'), 'raw_text'))
  };
}

function buildUserMessageEventContext(event: UserMessageRuntimeEvent): RoleModelInputEventContext {
  const eventContext: RoleModelInputEventContext = {
    type: event.type,
    text: event.payload.text,
    created_at: event.created_at
  };
  if (event.payload.user_id !== undefined) {
    eventContext.user_id = event.payload.user_id;
  }
  if (event.payload.conversation_id !== undefined) {
    eventContext.conversation_id = event.payload.conversation_id;
  }
  return eventContext;
}

function validateEventContext(event: unknown): RoleModelInputEventContext {
  const eventRecord = asRoleModelRecord(event, 'event');
  wrapContractError(() => {
    rejectExtraKeys(
      eventRecord,
      ['type', 'text', 'created_at', 'user_id', 'conversation_id'],
      'RoleModelInput.event'
    );
  });
  const eventContext: RoleModelInputEventContext = {
    type: wrapContractError(() => requireLiteral(getOwnField(eventRecord, 'type'), USER_MESSAGE, 'event.type')),
    text: wrapContractError(() => requireString(getOwnField(eventRecord, 'text'), 'event.text')),
    created_at: wrapContractError(() =>
      validateIso8601Timestamp(getOwnField(eventRecord, 'created_at'), 'event.created_at')
    )
  };
  if (Object.hasOwn(eventRecord, 'user_id')) {
    eventContext.user_id = wrapContractError(() =>
      requireOptionalString(getOwnField(eventRecord, 'user_id'), 'event.user_id')
    );
  }
  if (Object.hasOwn(eventRecord, 'conversation_id')) {
    eventContext.conversation_id = wrapContractError(() =>
      requireOptionalString(getOwnField(eventRecord, 'conversation_id'), 'event.conversation_id')
    );
  }
  return eventContext;
}

function buildCharacterContextOptions(options: RoleModelOptions): BuildCharacterDecisionContextOptions {
  const contextOptions: BuildCharacterDecisionContextOptions = {};
  if (options.recentVisibleMessagesSource !== undefined) {
    contextOptions.recentVisibleMessagesSource = options.recentVisibleMessagesSource;
  }
  if (options.currentStateSource !== undefined) {
    contextOptions.currentStateSource = options.currentStateSource;
  }
  if (options.activeIncidentSource !== undefined) {
    contextOptions.activeIncidentSource = options.activeIncidentSource;
  }
  if (options.interruptedIncidentSource !== undefined) {
    contextOptions.interruptedIncidentSource = options.interruptedIncidentSource;
  }
  if (options.contextSectionProviders !== undefined) {
    contextOptions.contextSectionProviders = options.contextSectionProviders;
  }
  return contextOptions;
}

function allowedActionsForCall(options: RoleModelOptions): AllowedActions {
  requireSupportedWriteActionOptIn(options);
  if (options.allowStatePatch === true) {
    return [VISIBLE_REPLY_ACTION, STATE_PATCH_ACTION];
  }
  if (
    options.allowIncidentStart === true ||
    options.allowIncidentCancel === true ||
    options.allowIncidentComplete === true
  ) {
    return [VISIBLE_REPLY_ACTION, LIFE_ACTION];
  }
  return [VISIBLE_REPLY_ACTION];
}

function requireSupportedWriteActionOptIn(options: RoleModelOptions): void {
  const enabledCount = [
    options.allowStatePatch,
    options.allowIncidentStart,
    options.allowIncidentCancel,
    options.allowIncidentComplete
  ].filter((enabled) => enabled === true).length;
  if (enabledCount > 1) {
    throw new RoleModelValidationError(
      'Only one write-action opt-in may be enabled for a USER_MESSAGE turn: ' +
        'state_patch, start_incident, cancel_incident, or complete_incident.'
    );
  }
}

function allowedLifeActionTypeForCall(options: RoleModelOptions): LifeAction['type'] | undefined {
  if (options.allowIncidentStart === true) {
    return START_INCIDENT_ACTION;
  }
  if (options.allowIncidentCancel === true) {
    return CANCEL_INCIDENT_ACTION;
  }
  if (options.allowIncidentComplete === true) {
    return COMPLETE_INCIDENT_ACTION;
  }
  return undefined;
}

function validateAllowedActions(value: unknown): AllowedActions {
  if (!Array.isArray(value)) {
    throw new RoleModelValidationError(
      "allowed_actions must be ['visible_reply'], ['visible_reply', 'state_patch'], " +
        "or ['visible_reply', 'life_action']."
    );
  }
  if (value.length === 1 && value[0] === VISIBLE_REPLY_ACTION) {
    return [VISIBLE_REPLY_ACTION];
  }
  if (
    value.length === 2 &&
    value[0] === VISIBLE_REPLY_ACTION &&
    value[1] === STATE_PATCH_ACTION
  ) {
    return [VISIBLE_REPLY_ACTION, STATE_PATCH_ACTION];
  }
  if (value.length === 2 && value[0] === VISIBLE_REPLY_ACTION && value[1] === LIFE_ACTION) {
    return [VISIBLE_REPLY_ACTION, LIFE_ACTION];
  }
  throw new RoleModelValidationError(
    "allowed_actions must be ['visible_reply'], ['visible_reply', 'state_patch'], " +
      "or ['visible_reply', 'life_action']."
  );
}

function statePatchAllowed(allowedActions: AllowedActions): boolean {
  return allowedActions.length === 2 && allowedActions[1] === STATE_PATCH_ACTION;
}

function lifeActionAllowed(allowedActions: AllowedActions): boolean {
  return allowedActions.length === 2 && allowedActions[1] === LIFE_ACTION;
}

function validateAllowedLifeActionType(
  value: unknown,
  allowedActions: AllowedActions
): LifeAction['type'] | undefined {
  if (!lifeActionAllowed(allowedActions)) {
    if (value !== undefined && value !== null) {
      throw new RoleModelValidationError(
        'allowed_life_action_type is only valid when life_action is allowed.'
      );
    }
    return undefined;
  }
  if (
    value === START_INCIDENT_ACTION ||
    value === CANCEL_INCIDENT_ACTION ||
    value === COMPLETE_INCIDENT_ACTION
  ) {
    return value;
  }
  throw new RoleModelValidationError(
    'allowed_life_action_type must match the selected life_action subtype.'
  );
}

function instructionsForAllowedActions(
  allowedActions: AllowedActions,
  { allowedLifeActionType }: { allowedLifeActionType: LifeAction['type'] | undefined }
): string {
  if (statePatchAllowed(allowedActions)) {
    return STATE_PATCH_ROLE_MODEL_INSTRUCTIONS;
  }
  if (lifeActionAllowed(allowedActions)) {
    if (allowedLifeActionType === CANCEL_INCIDENT_ACTION) {
      return INCIDENT_CANCEL_ROLE_MODEL_INSTRUCTIONS;
    }
    if (allowedLifeActionType === COMPLETE_INCIDENT_ACTION) {
      return INCIDENT_COMPLETE_ROLE_MODEL_INSTRUCTIONS;
    }
    return INCIDENT_START_ROLE_MODEL_INSTRUCTIONS;
  }
  return ROLE_MODEL_INSTRUCTIONS;
}

function validateInstructionsForAllowedActions(
  value: unknown,
  allowedActions: AllowedActions,
  { allowedLifeActionType }: { allowedLifeActionType: LifeAction['type'] | undefined }
): string {
  const expectedInstructions = instructionsForAllowedActions(allowedActions, {
    allowedLifeActionType
  });
  if (value === expectedInstructions) {
    return expectedInstructions;
  }
  if (lifeActionAllowed(allowedActions)) {
    throw new RoleModelValidationError('instructions must match the allowed life_action subtype.');
  }
  return wrapContractError(() => requireLiteral(value, expectedInstructions, 'instructions'));
}

function allowedLifeActionType(modelInput: RoleModelInputEnvelope): LifeAction['type'] {
  if (!lifeActionAllowed(modelInput.allowed_actions)) {
    return START_INCIDENT_ACTION;
  }
  if (modelInput.allowed_life_action_type === undefined) {
    throw new RoleModelValidationError(
      'allowed_life_action_type must match the selected life_action subtype.'
    );
  }
  return modelInput.allowed_life_action_type;
}

function validateFailure({
  stage,
  code,
  message
}: {
  stage: string;
  code: string;
  message: string;
}): RoleModelFailure {
  if (!Object.hasOwn(FAILURE_CODES_BY_STAGE, stage)) {
    throw new RoleModelValidationError('failure.stage must be a supported failure stage.');
  }
  const supportedCodes = FAILURE_CODES_BY_STAGE[stage as RoleModelStage];
  if (!supportedCodes.some((supportedCode) => supportedCode === code)) {
    throw new RoleModelValidationError('failure.code must match failure.stage.');
  }
  return {
    stage: stage as RoleModelStage,
    code,
    message: wrapContractError(() => requireOptionalString(message, 'failure.message'))
  };
}

function snapshotFailureModelOutput(modelOutput: unknown): unknown {
  try {
    return structuredClone(asRecord(modelOutput, 'RoleModelAdapterOutput'));
  } catch {
    return snapshotRawValue(modelOutput);
  }
}

function isParsedJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRoleModelRecord(value: unknown, fieldName: string): Record<string, unknown> {
  try {
    return asRecord(value, fieldName);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new RoleModelValidationError(error.message);
    }
    throw error;
  }
}

function wrapContractError<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new RoleModelValidationError(error.message);
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAllowedContractValues(values: readonly string[]): string {
  return [...values]
    .sort()
    .map((value) => `'${value}'`)
    .join(', ');
}
