import type { CharacterProfile, VisibleMessage } from './conversation.ts';
import type {
  RuntimeEventIdentity,
  UserMessageRuntimeEvent
} from './runtime-event.ts';

export const roleModelDecisionContractVersion = 'mvp-005.visible_reply.v1';
export const roleModelVisibleReplyActionName = 'visible_reply';

export type RoleModelAllowedActionName = typeof roleModelVisibleReplyActionName;

export const roleModelAllowedActionNames = Object.freeze([
  roleModelVisibleReplyActionName
] satisfies readonly RoleModelAllowedActionName[]);

export function isRoleModelAllowedActionName(
  value: unknown
): value is RoleModelAllowedActionName {
  return value === roleModelVisibleReplyActionName;
}

export const roleModelDecisionOutputContractText =
  'Return exactly one CharacterDecision JSON object with action.type "visible_reply" and action.text as one visible reply line.';

export type RoleModelOutputContract = {
  readonly version: typeof roleModelDecisionContractVersion;
  readonly text: string;
};

export const roleModelDecisionOutputContract = Object.freeze({
  version: roleModelDecisionContractVersion,
  text: roleModelDecisionOutputContractText
} satisfies RoleModelOutputContract);

export type DecisionContext = {
  readonly sessionId: string;
  readonly characterSnapshot: CharacterProfile;
  readonly recentVisibleMessages: readonly VisibleMessage[];
  readonly runtimeNotes: readonly string[];
};

export type CreateDecisionContextOptions = {
  readonly sessionId: string;
  readonly characterSnapshot: CharacterProfile;
  readonly recentVisibleMessages?: readonly VisibleMessage[];
  readonly runtimeNotes?: readonly string[];
};

export type RoleModelInputEnvelope = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly allowedActions: readonly RoleModelAllowedActionName[];
  readonly outputContract: RoleModelOutputContract;
};

export type CreateRoleModelInputEnvelopeOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly allowedActions?: readonly RoleModelAllowedActionName[];
  readonly outputContract?: RoleModelOutputContract;
};

export type RoleModelVisibleReplyAction = {
  readonly type: typeof roleModelVisibleReplyActionName;
  readonly text: string;
};

export type CharacterDecision = {
  readonly action: RoleModelVisibleReplyAction;
};

export const roleModelMalformedOutputRejectionReason = 'malformed_output';
export const roleModelUnsupportedEffectRejectionReason = 'unsupported_effect';
export const roleModelInvalidVisibleReplyRejectionReason = 'invalid_visible_reply';
export const roleModelCommitValidationFailureRejectionReason =
  'commit_validation_failure';
export const roleModelAdapterRawOutputMissingTextRejectionDetails =
  'Adapter raw output must include string rawOutputText.';

export type RoleModelDecisionRejectionReason =
  | typeof roleModelMalformedOutputRejectionReason
  | typeof roleModelUnsupportedEffectRejectionReason
  | typeof roleModelInvalidVisibleReplyRejectionReason
  | typeof roleModelCommitValidationFailureRejectionReason;

export const roleModelDecisionRejectionReasons = Object.freeze([
  roleModelMalformedOutputRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelCommitValidationFailureRejectionReason
] satisfies readonly RoleModelDecisionRejectionReason[]);

export type RoleModelDecisionRejection = {
  readonly reason: RoleModelDecisionRejectionReason;
  readonly details?: string;
};

export type AcceptedRoleModelDecisionResult = {
  readonly status: 'accepted';
  readonly decision: CharacterDecision;
};

export type RejectedRoleModelDecisionResult = {
  readonly status: 'rejected';
  readonly rejection: RoleModelDecisionRejection;
};

export type RoleModelDecisionResult =
  | AcceptedRoleModelDecisionResult
  | RejectedRoleModelDecisionResult;

export type RoleModelIOSnapshot = RuntimeEventIdentity & {
  readonly kind: 'role_model_io_snapshot';
  readonly sessionId: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly rawOutputText: string;
};

export type CreateRoleModelIOSnapshotOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly rawOutputText: string;
};

export type ParsedRoleModelDecisionSnapshot = RuntimeEventIdentity & {
  readonly kind: 'role_model_decision_snapshot';
  readonly sessionId: string;
  readonly result: RoleModelDecisionResult;
};

export type CreateParsedRoleModelDecisionSnapshotOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly result: RoleModelDecisionResult;
};

export function createDecisionContext(
  options: CreateDecisionContextOptions
): DecisionContext {
  return Object.freeze({
    sessionId: options.sessionId,
    characterSnapshot: freezeCharacterProfileSnapshot(options.characterSnapshot),
    recentVisibleMessages: freezeVisibleMessageSnapshots(
      options.recentVisibleMessages ?? []
    ),
    runtimeNotes: Object.freeze([...(options.runtimeNotes ?? [])])
  } satisfies DecisionContext);
}

export function createRoleModelInputEnvelope(
  options: CreateRoleModelInputEnvelopeOptions
): RoleModelInputEnvelope {
  return Object.freeze({
    event: freezeUserMessageRuntimeEventSnapshot(options.event),
    decisionContext: createDecisionContext(options.decisionContext),
    allowedActions: freezeAllowedActions(
      options.allowedActions ?? roleModelAllowedActionNames
    ),
    outputContract: freezeRoleModelOutputContract(
      options.outputContract ?? roleModelDecisionOutputContract
    )
  } satisfies RoleModelInputEnvelope);
}

export function createVisibleReplyCharacterDecision(
  text: string
): CharacterDecision {
  return freezeCharacterDecision({
    action: {
      type: roleModelVisibleReplyActionName,
      text
    }
  });
}

export function createAcceptedRoleModelDecisionResult(
  decision: CharacterDecision
): AcceptedRoleModelDecisionResult {
  return Object.freeze({
    status: 'accepted',
    decision: freezeCharacterDecision(decision)
  } satisfies AcceptedRoleModelDecisionResult);
}

export function createRejectedRoleModelDecisionResult(
  reason: RoleModelDecisionRejectionReason,
  details?: string
): RejectedRoleModelDecisionResult {
  return Object.freeze({
    status: 'rejected',
    rejection: freezeRoleModelDecisionRejection({
      reason,
      ...(details === undefined ? {} : { details })
    })
  } satisfies RejectedRoleModelDecisionResult);
}

export function createRoleModelIOSnapshot(
  options: CreateRoleModelIOSnapshotOptions
): RoleModelIOSnapshot {
  const identity = freezeRuntimeEventIdentitySnapshot(options);

  return Object.freeze({
    ...identity,
    kind: 'role_model_io_snapshot',
    sessionId: options.sessionId,
    inputEnvelope: createRoleModelInputEnvelope(options.inputEnvelope),
    rawOutputText: options.rawOutputText
  } satisfies RoleModelIOSnapshot);
}

export function createParsedRoleModelDecisionSnapshot(
  options: CreateParsedRoleModelDecisionSnapshotOptions
): ParsedRoleModelDecisionSnapshot {
  const identity = freezeRuntimeEventIdentitySnapshot(options);

  return Object.freeze({
    ...identity,
    kind: 'role_model_decision_snapshot',
    sessionId: options.sessionId,
    result: freezeRoleModelDecisionResult(options.result)
  } satisfies ParsedRoleModelDecisionSnapshot);
}

export function parseRoleModelDecision(
  rawOutputText: string
): RoleModelDecisionResult {
  let parsedOutput: unknown;

  try {
    parsedOutput = JSON.parse(rawOutputText);
  } catch {
    return createMalformedOutputResult('Adapter output must be valid JSON.');
  }

  if (!isJsonRecord(parsedOutput)) {
    return createMalformedOutputResult(
      'Adapter output must be a CharacterDecision JSON object.'
    );
  }

  if (hasEffectShape(parsedOutput)) {
    return createUnsupportedOutputResult(
      'Decision includes unsupported effect fields.'
    );
  }

  const action = parsedOutput['action'];

  if (!isJsonRecord(action)) {
    return createMalformedOutputResult('Decision action must be an object.');
  }

  const actionType = action['type'];

  if (typeof actionType !== 'string') {
    return createMalformedOutputResult('Decision action.type must be a string.');
  }

  if (actionType !== roleModelVisibleReplyActionName) {
    return createUnsupportedOutputResult(
      `Decision action.type "${actionType}" is not supported.`
    );
  }

  const replyText = action['text'];

  if (typeof replyText !== 'string') {
    return createMalformedOutputResult('Decision action.text must be a string.');
  }

  const unsupportedTopLevelKeys = findUnsupportedKeys(parsedOutput, ['action']);

  if (unsupportedTopLevelKeys.length > 0) {
    return createUnsupportedOutputResult(
      `Decision includes unsupported fields: ${unsupportedTopLevelKeys.join(', ')}.`
    );
  }

  const unsupportedActionKeys = findUnsupportedKeys(action, ['type', 'text']);

  if (unsupportedActionKeys.length > 0) {
    return createUnsupportedOutputResult(
      `Decision action includes unsupported fields: ${unsupportedActionKeys.join(
        ', '
      )}.`
    );
  }

  return createAcceptedRoleModelDecisionResult(
    createVisibleReplyCharacterDecision(replyText)
  );
}

function createMalformedOutputResult(
  details: string
): RejectedRoleModelDecisionResult {
  return createRejectedRoleModelDecisionResult(
    roleModelMalformedOutputRejectionReason,
    details
  );
}

function createUnsupportedOutputResult(
  details: string
): RejectedRoleModelDecisionResult {
  return createRejectedRoleModelDecisionResult(
    roleModelUnsupportedEffectRejectionReason,
    details
  );
}

function freezeRuntimeEventIdentitySnapshot(
  identity: RuntimeEventIdentity
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    createdAt: identity.createdAt
  } satisfies RuntimeEventIdentity);
}

function freezeUserMessageRuntimeEventSnapshot(
  event: UserMessageRuntimeEvent
): UserMessageRuntimeEvent {
  const identity = freezeRuntimeEventIdentitySnapshot(event);

  return Object.freeze({
    ...identity,
    type: event.type,
    payload: Object.freeze({
      currentUserMessage: event.payload.currentUserMessage
    })
  } satisfies UserMessageRuntimeEvent);
}

function freezeCharacterProfileSnapshot(
  character: CharacterProfile
): CharacterProfile {
  return Object.freeze({
    id: character.id,
    displayName: character.displayName
  } satisfies CharacterProfile);
}

function freezeVisibleMessageSnapshots(
  visibleMessages: readonly VisibleMessage[]
): readonly VisibleMessage[] {
  return Object.freeze(visibleMessages.map(freezeVisibleMessageSnapshot));
}

function freezeVisibleMessageSnapshot(message: VisibleMessage): VisibleMessage {
  return Object.freeze({
    id: message.id,
    role: message.role,
    speakerId: message.speakerId,
    speakerName: message.speakerName,
    text: message.text
  } satisfies VisibleMessage);
}

function freezeAllowedActions(
  allowedActions: readonly unknown[]
): readonly RoleModelAllowedActionName[] {
  const validatedActions: RoleModelAllowedActionName[] = [];

  for (const action of allowedActions) {
    if (!isRoleModelAllowedActionName(action)) {
      throw new TypeError(
        'Role-model allowedActions must contain only supported actions.'
      );
    }

    validatedActions.push(action);
  }

  return Object.freeze(validatedActions);
}

function freezeRoleModelOutputContract(
  outputContract: RoleModelOutputContract
): RoleModelOutputContract {
  return Object.freeze({
    version: outputContract.version,
    text: outputContract.text
  } satisfies RoleModelOutputContract);
}

function freezeCharacterDecision(decision: CharacterDecision): CharacterDecision {
  return Object.freeze({
    action: Object.freeze({
      type: decision.action.type,
      text: decision.action.text
    } satisfies RoleModelVisibleReplyAction)
  } satisfies CharacterDecision);
}

function freezeRoleModelDecisionRejection(
  rejection: RoleModelDecisionRejection
): RoleModelDecisionRejection {
  return Object.freeze({
    reason: rejection.reason,
    ...(rejection.details === undefined ? {} : { details: rejection.details })
  } satisfies RoleModelDecisionRejection);
}

function freezeRoleModelDecisionResult(
  result: RoleModelDecisionResult
): RoleModelDecisionResult {
  if (result.status === 'accepted') {
    return createAcceptedRoleModelDecisionResult(result.decision);
  }

  return createRejectedRoleModelDecisionResult(
    result.rejection.reason,
    result.rejection.details
  );
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasEffectShape(record: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(record, 'effect') || Object.hasOwn(record, 'effects');
}

function findUnsupportedKeys(
  record: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[]
): string[] {
  return Object.keys(record).filter((key) => !allowedKeys.includes(key));
}
