import { SCHEMA_VERSION, type SchemaVersion } from './schema.ts';
import { ContractValidationError } from './errors.ts';
import {
  asRecord,
  getOwnField,
  rejectExtraKeys,
  requireLiteral,
  requireMatchingIdentity,
  requireOneOf,
  requireOptionalString,
  requireString,
  validateIso8601Timestamp,
  validateRemainingSeconds,
  type ValueRecord
} from './validation.ts';

export const USER_MESSAGE = 'USER_MESSAGE';
export const INCIDENT_COMPLETION = 'INCIDENT_COMPLETION';
export const VISIBLE_REPLY_ACTION = 'visible_reply';
export const STATE_PATCH_ACTION = 'state_patch';
export const LIFE_ACTION = 'life_action';
export const START_INCIDENT_ACTION = 'start_incident';
export const CANCEL_INCIDENT_ACTION = 'cancel_incident';
export const COMPLETE_INCIDENT_ACTION = 'complete_incident';
export const DECISION_READY_FOR_COMMIT_STATUS = 'decision_ready_for_commit';
export const ASSISTANT_VISIBLE_REPLY_KIND = 'assistant_visible_reply';
export const USER_VISIBLE_MESSAGE_KIND = 'user_visible_message';
export const ASSISTANT_VISIBLE_REPLY_ROLE = 'assistant';
export const USER_VISIBLE_MESSAGE_ROLE = 'user';
export const USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD =
  'user_message_interrupted_active_incident';

export const ACTIVE_INCIDENT_TYPES = [
  'idle',
  'eat',
  'drink',
  'sleep',
  'rest',
  'work',
  'think',
  'wait',
  'custom'
] as const;

export const ACTIVE_INCIDENT_INTERRUPT_POLICIES = [
  'interruptible',
  'background',
  'protected'
] as const;

export const ACTIVE_INCIDENT_RESUME_POLICIES = ['resume', 'ask_model', 'cancel'] as const;

export { ContractValidationError };

export type UserMessagePayload = {
  text: string;
  user_id?: string;
  conversation_id?: string;
};

export type IncidentCompletionPayload = {
  incident_id: string;
  user_id?: string;
  conversation_id?: string;
};

export type UserMessageRuntimeEvent = {
  event_id: string;
  trace_id: string;
  type: typeof USER_MESSAGE;
  created_at: string;
  schema_version: SchemaVersion;
  payload: UserMessagePayload;
};

export type IncidentCompletionRuntimeEvent = {
  event_id: string;
  trace_id: string;
  type: typeof INCIDENT_COMPLETION;
  created_at: string;
  schema_version: SchemaVersion;
  payload: IncidentCompletionPayload;
};

export type RuntimeEvent = UserMessageRuntimeEvent | IncidentCompletionRuntimeEvent;

export type VisibleReplyDecision = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  action: typeof VISIBLE_REPLY_ACTION;
  visible_reply: { text: string };
  state_patch?: LivingStatePatch;
  life_action?: LifeAction;
};

export type LivingStatePatch = {
  living_state: {
    current_activity?: string;
    mood?: string;
    toward_user?: string;
  };
};

export type StartIncidentLifeAction = {
  type: typeof START_INCIDENT_ACTION;
  incident: {
    type: (typeof ACTIVE_INCIDENT_TYPES)[number];
    title: string;
    remaining_seconds?: number;
    interrupt_policy: (typeof ACTIVE_INCIDENT_INTERRUPT_POLICIES)[number];
    resume_policy: (typeof ACTIVE_INCIDENT_RESUME_POLICIES)[number];
  };
};

export type CancelIncidentLifeAction = {
  type: typeof CANCEL_INCIDENT_ACTION;
  incident_id: string;
  reason: string;
};

export type CompleteIncidentLifeAction = {
  type: typeof COMPLETE_INCIDENT_ACTION;
  incident_id: string;
};

export type LifeAction =
  | StartIncidentLifeAction
  | CancelIncidentLifeAction
  | CompleteIncidentLifeAction;

export type RoleModelTurnResult = {
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  model_called: true;
  status: typeof DECISION_READY_FOR_COMMIT_STATUS;
  decision: VisibleReplyDecision;
};

type DecisionNormalizer = (decision: unknown) => VisibleReplyDecision;

type VisibleReplyOptions = {
  traceId: string;
  eventId: string;
  requireAttachedIds: boolean;
};

type OptionalExtensionOptions = VisibleReplyOptions & {
  allowStatePatch?: boolean;
  allowLifeAction?: boolean;
  allowedLifeActionType?: LifeAction['type'];
};

export function validateNormalizedUserMessageEvent(
  event: unknown,
  sourceName = 'RuntimeEvent'
): UserMessageRuntimeEvent {
  const eventRecord = asRecord(event, sourceName);
  const payload = asRecord(getOwnField(eventRecord, 'payload'), `${sourceName}.payload`);
  const normalizedPayload: UserMessagePayload = {
    text: requireString(getOwnField(payload, 'text'), `${sourceName}.payload.text`)
  };
  for (const fieldName of ['user_id', 'conversation_id'] as const) {
    if (Object.hasOwn(payload, fieldName)) {
      normalizedPayload[fieldName] = requireOptionalString(
        payload[fieldName],
        `${sourceName}.payload.${fieldName}`
      );
    }
  }
  return {
    event_id: requireString(getOwnField(eventRecord, 'event_id'), `${sourceName}.event_id`),
    trace_id: requireString(getOwnField(eventRecord, 'trace_id'), `${sourceName}.trace_id`),
    type: requireLiteral(getOwnField(eventRecord, 'type'), USER_MESSAGE, `${sourceName}.type`),
    created_at: validateIso8601Timestamp(
      getOwnField(eventRecord, 'created_at'),
      `${sourceName}.created_at`
    ),
    schema_version: requireLiteral(
      getOwnField(eventRecord, 'schema_version'),
      SCHEMA_VERSION,
      `${sourceName}.schema_version`
    ),
    payload: normalizedPayload
  };
}

export function validateNormalizedIncidentCompletionEvent(
  event: unknown,
  sourceName = 'RuntimeEvent'
): IncidentCompletionRuntimeEvent {
  const eventRecord = asRecord(event, sourceName);
  const payload = asRecord(getOwnField(eventRecord, 'payload'), `${sourceName}.payload`);
  rejectExtraKeys(
    payload,
    ['incident_id', 'user_id', 'conversation_id'],
    `${sourceName}.payload`
  );
  const normalizedPayload: IncidentCompletionPayload = {
    incident_id: requireString(
      getOwnField(payload, 'incident_id'),
      `${sourceName}.payload.incident_id`
    ).trim()
  };
  for (const fieldName of ['user_id', 'conversation_id'] as const) {
    if (Object.hasOwn(payload, fieldName)) {
      normalizedPayload[fieldName] = requireOptionalString(
        payload[fieldName],
        `${sourceName}.payload.${fieldName}`
      );
    }
  }
  return {
    event_id: requireString(getOwnField(eventRecord, 'event_id'), `${sourceName}.event_id`),
    trace_id: requireString(getOwnField(eventRecord, 'trace_id'), `${sourceName}.trace_id`),
    type: requireLiteral(
      getOwnField(eventRecord, 'type'),
      INCIDENT_COMPLETION,
      `${sourceName}.type`
    ),
    created_at: validateIso8601Timestamp(
      getOwnField(eventRecord, 'created_at'),
      `${sourceName}.created_at`
    ),
    schema_version: requireLiteral(
      getOwnField(eventRecord, 'schema_version'),
      SCHEMA_VERSION,
      `${sourceName}.schema_version`
    ),
    payload: normalizedPayload
  };
}

export function normalizeVisibleReplyDecision(
  decision: unknown,
  options: VisibleReplyOptions,
  sourceName = 'CharacterDecision'
): VisibleReplyDecision {
  const decisionRecord = asRecord(decision, sourceName);
  const allowedKeys = ['schema_version', 'action', 'visible_reply'];
  if (options.requireAttachedIds) {
    allowedKeys.push('trace_id', 'event_id');
  }
  rejectExtraKeys(decisionRecord, allowedKeys, sourceName);
  requireLiteral(getOwnField(decisionRecord, 'schema_version'), SCHEMA_VERSION, 'schema_version');
  if (options.requireAttachedIds) {
    requireMatchingIdentity(getOwnField(decisionRecord, 'trace_id'), options.traceId, 'trace_id');
    requireMatchingIdentity(getOwnField(decisionRecord, 'event_id'), options.eventId, 'event_id');
  }
  if (getOwnField(decisionRecord, 'action') !== VISIBLE_REPLY_ACTION) {
    throw new ContractValidationError(
      `action must be ${JSON.stringify(VISIBLE_REPLY_ACTION)}.`,
      'unsupported_action'
    );
  }
  const visibleReply = asRecord(getOwnField(decisionRecord, 'visible_reply'), 'visible_reply');
  rejectExtraKeys(visibleReply, ['text'], 'visible_reply');
  const visibleReplyText = getOwnField(visibleReply, 'text');
  if (typeof visibleReplyText !== 'string' || visibleReplyText.trim().length === 0) {
    throw new ContractValidationError(
      'visible_reply.text must be a non-empty string.',
      'empty_reply_text'
    );
  }
  const replyText = visibleReplyText.trim();
  return {
    schema_version: SCHEMA_VERSION,
    trace_id: options.traceId,
    event_id: options.eventId,
    action: VISIBLE_REPLY_ACTION,
    visible_reply: { text: replyText }
  };
}

export function normalizeVisibleReplyDecisionWithOptionalLivingStatePatch(
  decision: unknown,
  options: OptionalExtensionOptions,
  sourceName = 'CharacterDecision'
): VisibleReplyDecision {
  return normalizeVisibleReplyDecisionWithOptionalExtensions(decision, options, sourceName);
}

export function normalizeVisibleReplyDecisionWithOptionalLifeAction(
  decision: unknown,
  options: OptionalExtensionOptions,
  sourceName = 'CharacterDecision'
): VisibleReplyDecision {
  return normalizeVisibleReplyDecisionWithOptionalExtensions(
    decision,
    { ...options, allowStatePatch: false },
    sourceName
  );
}

function normalizeVisibleReplyDecisionWithOptionalExtensions(
  decision: unknown,
  options: OptionalExtensionOptions,
  sourceName: string
): VisibleReplyDecision {
  const allowStatePatch = options.allowStatePatch === true;
  const allowLifeAction = options.allowLifeAction === true;
  if (allowStatePatch && allowLifeAction) {
    throw new ContractValidationError(
      'state_patch and life_action cannot both be allowed in this contract.'
    );
  }
  if (!allowStatePatch && !allowLifeAction) {
    return normalizeVisibleReplyDecision(decision, options, sourceName);
  }

  const decisionRecord = asRecord(decision, sourceName);
  const allowedKeys = ['schema_version', 'action', 'visible_reply'];
  if (allowStatePatch) {
    allowedKeys.push('state_patch');
  }
  if (allowLifeAction) {
    allowedKeys.push('life_action');
  }
  if (options.requireAttachedIds) {
    allowedKeys.push('trace_id', 'event_id');
  }
  rejectExtraKeys(decisionRecord, allowedKeys, sourceName);

  const visibleReplyDecision: ValueRecord = {
    schema_version: getOwnField(decisionRecord, 'schema_version'),
    action: getOwnField(decisionRecord, 'action'),
    visible_reply: getOwnField(decisionRecord, 'visible_reply')
  };
  if (options.requireAttachedIds) {
    visibleReplyDecision['trace_id'] = getOwnField(decisionRecord, 'trace_id');
    visibleReplyDecision['event_id'] = getOwnField(decisionRecord, 'event_id');
  }
  const normalized = normalizeVisibleReplyDecision(visibleReplyDecision, options, sourceName);
  if (Object.hasOwn(decisionRecord, 'state_patch')) {
    return {
      ...normalized,
      state_patch: normalizeLivingStatePatch(
        getOwnField(decisionRecord, 'state_patch'),
        `${sourceName}.state_patch`
      )
    };
  }
  if (Object.hasOwn(decisionRecord, 'life_action')) {
    return {
      ...normalized,
      life_action: normalizeLifeAction(getOwnField(decisionRecord, 'life_action'), {
        allowedLifeActionType: options.allowedLifeActionType ?? START_INCIDENT_ACTION,
        sourceName: `${sourceName}.life_action`
      })
    };
  }
  return normalized;
}

export function normalizeLifeAction(
  lifeAction: unknown,
  {
    allowedLifeActionType,
    sourceName = 'life_action'
  }: { allowedLifeActionType: string; sourceName?: string }
): LifeAction {
  switch (allowedLifeActionType) {
    case START_INCIDENT_ACTION:
      return normalizeStartIncidentLifeAction(lifeAction, sourceName);
    case CANCEL_INCIDENT_ACTION:
      return normalizeCancelIncidentLifeAction(lifeAction, sourceName);
    case COMPLETE_INCIDENT_ACTION:
      return normalizeCompleteIncidentLifeAction(lifeAction, sourceName);
    default:
      throw new ContractValidationError(
        "allowed_life_action_type must be 'start_incident', 'cancel_incident', or 'complete_incident'."
      );
  }
}

export function normalizeStartIncidentLifeAction(
  lifeAction: unknown,
  sourceName = 'life_action'
): StartIncidentLifeAction {
  const lifeActionRecord = asRecord(lifeAction, sourceName);
  const actionType = requireLiteral(
    getOwnField(lifeActionRecord, 'type'),
    START_INCIDENT_ACTION,
    `${sourceName}.type`
  );
  rejectExtraKeys(lifeActionRecord, ['type', 'incident'], sourceName);
  const incident = asRecord(getOwnField(lifeActionRecord, 'incident'), `${sourceName}.incident`);
  rejectExtraKeys(
    incident,
    ['type', 'title', 'remaining_seconds', 'interrupt_policy', 'resume_policy'],
    `${sourceName}.incident`
  );
  const normalizedIncident: StartIncidentLifeAction['incident'] = {
    type: requireOneOf(
      getOwnField(incident, 'type'),
      ACTIVE_INCIDENT_TYPES,
      `${sourceName}.incident.type`
    ),
    title: requireString(getOwnField(incident, 'title'), `${sourceName}.incident.title`).trim(),
    interrupt_policy: requireOneOf(
      getOwnField(incident, 'interrupt_policy'),
      ACTIVE_INCIDENT_INTERRUPT_POLICIES,
      `${sourceName}.incident.interrupt_policy`
    ),
    resume_policy: requireOneOf(
      getOwnField(incident, 'resume_policy'),
      ACTIVE_INCIDENT_RESUME_POLICIES,
      `${sourceName}.incident.resume_policy`
    )
  };
  if (Object.hasOwn(incident, 'remaining_seconds')) {
    normalizedIncident.remaining_seconds = validateRemainingSeconds(
      getOwnField(incident, 'remaining_seconds'),
      `${sourceName}.incident.remaining_seconds`
    );
  }
  return { type: actionType, incident: normalizedIncident };
}

export function normalizeCancelIncidentLifeAction(
  lifeAction: unknown,
  sourceName = 'life_action'
): CancelIncidentLifeAction {
  const lifeActionRecord = asRecord(lifeAction, sourceName);
  const actionType = requireLiteral(
    getOwnField(lifeActionRecord, 'type'),
    CANCEL_INCIDENT_ACTION,
    `${sourceName}.type`
  );
  rejectExtraKeys(lifeActionRecord, ['type', 'incident_id', 'reason'], sourceName);
  return {
    type: actionType,
    incident_id: requireString(
      getOwnField(lifeActionRecord, 'incident_id'),
      `${sourceName}.incident_id`
    ).trim(),
    reason: requireString(getOwnField(lifeActionRecord, 'reason'), `${sourceName}.reason`).trim()
  };
}

export function normalizeCompleteIncidentLifeAction(
  lifeAction: unknown,
  sourceName = 'life_action'
): CompleteIncidentLifeAction {
  const lifeActionRecord = asRecord(lifeAction, sourceName);
  const actionType = requireLiteral(
    getOwnField(lifeActionRecord, 'type'),
    COMPLETE_INCIDENT_ACTION,
    `${sourceName}.type`
  );
  rejectExtraKeys(lifeActionRecord, ['type', 'incident_id'], sourceName);
  return {
    type: actionType,
    incident_id: requireString(
      getOwnField(lifeActionRecord, 'incident_id'),
      `${sourceName}.incident_id`
    ).trim()
  };
}

export function normalizeLivingStatePatch(
  patch: unknown,
  sourceName = 'state_patch'
): LivingStatePatch {
  const patchRecord = asRecord(patch, sourceName);
  rejectExtraKeys(patchRecord, ['living_state'], sourceName);
  const livingState = asRecord(
    getOwnField(patchRecord, 'living_state'),
    `${sourceName}.living_state`
  );
  rejectExtraKeys(
    livingState,
    ['current_activity', 'mood', 'toward_user'],
    `${sourceName}.living_state`
  );
  if (Object.keys(livingState).length === 0) {
    throw new ContractValidationError(
      `${sourceName}.living_state must include at least one field.`
    );
  }
  const normalizedLivingState: LivingStatePatch['living_state'] = {};
  for (const fieldName of ['current_activity', 'mood', 'toward_user'] as const) {
    if (Object.hasOwn(livingState, fieldName)) {
      normalizedLivingState[fieldName] = requireString(
        getOwnField(livingState, fieldName),
        `${sourceName}.living_state.${fieldName}`
      ).trim();
    }
  }
  if (Object.keys(normalizedLivingState).length === 0) {
    throw new ContractValidationError(
      `${sourceName}.living_state must include at least one field.`
    );
  }
  return { living_state: normalizedLivingState };
}

export function normalizeRoleModelTurnResult(
  roleModelResult: unknown,
  {
    sourceEvent,
    decisionNormalizer,
    sourceName = 'RoleModelTurnResult'
  }: {
    sourceEvent: unknown;
    decisionNormalizer: DecisionNormalizer;
    sourceName?: string;
  }
): RoleModelTurnResult {
  const event = validateNormalizedUserMessageEvent(sourceEvent, 'source_event');
  const result = asRecord(roleModelResult, sourceName);
  rejectExtraKeys(
    result,
    ['trace_id', 'event_id', 'event_type', 'model_called', 'status', 'decision'],
    sourceName
  );
  requireMatchingIdentity(getOwnField(result, 'trace_id'), event.trace_id, 'trace_id');
  requireMatchingIdentity(getOwnField(result, 'event_id'), event.event_id, 'event_id');
  const eventType = requireLiteral(getOwnField(result, 'event_type'), USER_MESSAGE, 'event_type');
  if (getOwnField(result, 'model_called') !== true) {
    throw new ContractValidationError(
      'model_called must be True.',
      'unsupported_result_status'
    );
  }
  if (getOwnField(result, 'status') !== DECISION_READY_FOR_COMMIT_STATUS) {
    throw new ContractValidationError(
      `status must be ${JSON.stringify(DECISION_READY_FOR_COMMIT_STATUS)}.`,
      'unsupported_result_status'
    );
  }
  return {
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: eventType,
    model_called: true,
    status: DECISION_READY_FOR_COMMIT_STATUS,
    decision: decisionNormalizer(getOwnField(result, 'decision'))
  };
}
