/**
 * What one stored record may say about a model round. A role_model_round
 * record carries the round's snapshots; every other kind that judges or
 * belongs to a round names it by number. The rules that need the round
 * record itself live in the evidence gate.
 */
import {
  runtimeEventIdentityKey,
  type RuntimeEventIdentity,
  type VisibleMessage,
} from '../../core/index.ts';
import {
  isRoleModelRawOutputReplayableDecisionEvidence,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelIOSnapshot,
} from '../../role-model/index.ts';
import {
  isTerminalRawEventLogRecordKind,
  type RawEventLogPayloadSummary,
  type RawEventLogRecordKind,
  type RoleModelCommitValidationSnapshot,
  type RuntimeTurnRejectionReason,
  type RuntimeTurnStatus,
} from '../evidence/records.ts';
import {throwMalformedRecord} from './codec-primitives.ts';

type RawEventRoundSemantics = {
  readonly identity: RuntimeEventIdentity;
  readonly kind: RawEventLogRecordKind;
  readonly status: RuntimeTurnStatus | undefined;
  readonly reason: RuntimeTurnRejectionReason | undefined;
  readonly message: string | undefined;
  readonly round: number | undefined;
  readonly visibleMessage: VisibleMessage | undefined;
  readonly payloadSummary: RawEventLogPayloadSummary | undefined;
  readonly roleModelIOSnapshot: RoleModelIOSnapshot | undefined;
  readonly parsedRoleModelDecisionSnapshot:
    ParsedRoleModelDecisionSnapshot | undefined;
  readonly commitValidation: RoleModelCommitValidationSnapshot | undefined;
};

export function assertRoundRawEventSemantics(
  options: RawEventRoundSemantics,
): void {
  assertRejectionFields(options);

  if (options.kind === 'role_model_round') {
    assertRoleModelRoundRecord(options);
    return;
  }

  if (
    options.roleModelIOSnapshot !== undefined ||
    options.parsedRoleModelDecisionSnapshot !== undefined
  ) {
    throwMalformedRecord('roleModelIOSnapshot');
  }

  if (options.kind === 'visible_message_committed') {
    assertCommitRoundReference(options);
    return;
  }

  if (isTerminalRawEventLogRecordKind(options.kind)) {
    assertTerminalRoundReference(options);
    return;
  }

  if (options.commitValidation !== undefined) {
    throwMalformedRecord('commitValidation');
  }

  if (
    options.round !== undefined &&
    options.kind !== 'tool_call_started' &&
    options.kind !== 'tool_call_finished'
  ) {
    throwMalformedRecord('round');
  }
}

/** The reason and its message belong to runtime_turn_rejected alone. */
function assertRejectionFields(options: RawEventRoundSemantics): void {
  if (options.kind === 'runtime_turn_rejected') {
    if (options.reason === undefined || options.message === undefined) {
      throwMalformedRecord('reason');
    }

    return;
  }

  if (options.reason !== undefined || options.message !== undefined) {
    throwMalformedRecord('reason');
  }
}

function assertRoleModelRoundRecord(options: RawEventRoundSemantics): void {
  if (
    options.round === undefined ||
    options.roleModelIOSnapshot === undefined ||
    options.parsedRoleModelDecisionSnapshot === undefined
  ) {
    throwMalformedRecord('roleModelIOSnapshot');
  }

  if (options.commitValidation !== undefined || options.status !== undefined) {
    throwMalformedRecord('commitValidation');
  }

  const {roleModelIOSnapshot, parsedRoleModelDecisionSnapshot} = options;

  assertSameIdentity(
    roleModelIOSnapshot,
    options.identity,
    'roleModelIOSnapshot',
  );
  assertSameIdentity(
    roleModelIOSnapshot.inputEnvelope.event,
    options.identity,
    'roleModelIOSnapshot.inputEnvelope.event',
  );
  assertSameIdentity(
    parsedRoleModelDecisionSnapshot,
    options.identity,
    'parsedRoleModelDecisionSnapshot',
  );

  const normalizedCurrentUserMessage =
    options.payloadSummary?.normalizedCurrentUserMessage;

  if (
    normalizedCurrentUserMessage !== undefined &&
    roleModelIOSnapshot.inputEnvelope.event.payload.currentUserMessage !==
      normalizedCurrentUserMessage
  ) {
    throwMalformedRecord(
      'roleModelIOSnapshot.inputEnvelope.event.payload.currentUserMessage',
    );
  }

  if (
    roleModelIOSnapshot.inputEnvelope.decisionContext.sessionId !==
    roleModelIOSnapshot.sessionId
  ) {
    throwMalformedRecord(
      'roleModelIOSnapshot.inputEnvelope.decisionContext.sessionId',
    );
  }

  if (
    parsedRoleModelDecisionSnapshot.sessionId !== roleModelIOSnapshot.sessionId
  ) {
    throwMalformedRecord('parsedRoleModelDecisionSnapshot.sessionId');
  }

  if (
    !isRoleModelRawOutputReplayableDecisionEvidence({
      rawOutputText: roleModelIOSnapshot.rawOutputText,
      decisionResult: parsedRoleModelDecisionSnapshot.result,
    })
  ) {
    throwMalformedRecord('parsedRoleModelDecisionSnapshot.result');
  }
}

/**
 * A character row names the round that said it and anchors the reply text
 * it committed; the user row is what the model was asked and carries neither.
 */
function assertCommitRoundReference(options: RawEventRoundSemantics): void {
  if (options.visibleMessage?.role !== 'character') {
    if (options.round !== undefined || options.commitValidation !== undefined) {
      throwMalformedRecord('commitValidation');
    }

    return;
  }

  if (options.round === undefined) {
    throwMalformedRecord('round');
  }

  const commitResult = options.commitValidation?.result;

  if (
    options.commitValidation === undefined ||
    commitResult?.status !== 'accepted' ||
    commitResult.acceptedVisibleReplyText !== options.visibleMessage.text
  ) {
    throwMalformedRecord('commitValidation');
  }

  assertSameIdentity(
    options.commitValidation,
    options.identity,
    'commitValidation',
  );
}

/** A terminal record judges a round when there was one: both or neither. */
function assertTerminalRoundReference(options: RawEventRoundSemantics): void {
  if (
    (options.round === undefined) !==
    (options.commitValidation === undefined)
  ) {
    throwMalformedRecord('commitValidation');
  }

  if (options.commitValidation === undefined) {
    return;
  }

  assertSameIdentity(
    options.commitValidation,
    options.identity,
    'commitValidation',
  );

  const commitResult = options.commitValidation.result;

  if (options.kind === 'runtime_turn_completed') {
    if (commitResult.status !== 'accepted') {
      throwMalformedRecord('commitValidation.result.status');
    }

    return;
  }

  if (
    commitResult.status !== 'rejected' ||
    commitResult.rejection.reason !== options.reason
  ) {
    throwMalformedRecord('commitValidation.result.status');
  }
}

function assertSameIdentity(
  actual: RuntimeEventIdentity,
  expected: RuntimeEventIdentity,
  field: string,
): void {
  if (runtimeEventIdentityKey(actual) !== runtimeEventIdentityKey(expected)) {
    throwMalformedRecord(field);
  }
}
