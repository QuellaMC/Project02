import {
  createAcceptedRoleModelDecisionResult,
  createRejectedRoleModelDecisionResult,
  createVisibleReplyModelToolCall,
  roleModelDecisionContractVersion,
  roleModelDecisionRejectionReasons,
  visibleReplyModelToolName,
  type CharacterDecision,
  type ModelToolCall,
  type PluginModelToolCall,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelDecisionResult,
} from '../../role-model/index.ts';
import type {
  AcceptedRoleModelCommitValidationResult,
  RejectedRoleModelCommitValidationResult,
  RoleModelCommitValidationResult,
} from '../evidence/records.ts';
import {
  isOneOf,
  optionalRecordString,
  optionalRecordStringAllowingEmpty,
  requiredArray,
  requiredBoundedJsonObject,
  requiredNormalizedVisibleMessageText,
  requiredRecordStringAllowingEmpty,
  throwMalformedRecord,
} from './codec-primitives.ts';
import {isRecord, requiredRecordString} from './layout-contract.ts';

export function requiredRoleModelDecisionResult(
  value: unknown,
): RoleModelDecisionResult {
  if (!isRecord(value)) {
    throwMalformedRecord('roleModelDecisionResult');
  }

  const status = requiredRecordString(value, 'status', 'malformed_record');

  if (status === 'accepted') {
    return createAcceptedRoleModelDecisionResult(
      requiredCharacterDecision(value['decision']),
    );
  }

  if (status === 'rejected') {
    const rejection = requiredRoleModelDecisionRejection(value['rejection']);

    return createRejectedRoleModelDecisionResult(
      rejection.reason,
      rejection.details,
    );
  }

  throwMalformedRecord('status');
}

export function requiredCharacterDecision(value: unknown): CharacterDecision {
  if (!isRecord(value)) {
    throwMalformedRecord('decision');
  }

  if (value['version'] === roleModelDecisionContractVersion) {
    const text = optionalRecordString(value, 'text', 'malformed_record');

    return Object.freeze({
      version: roleModelDecisionContractVersion,
      toolCalls: Object.freeze(
        requiredArray(value['toolCalls'], 'decision.toolCalls').map(
          requiredModelToolCall,
        ),
      ),
      ...(text === undefined ? {} : {text}),
    } satisfies CharacterDecision);
  }

  throwMalformedRecord('decision.version');
}
function requiredModelToolCall(value: unknown): ModelToolCall {
  if (!isRecord(value)) {
    throwMalformedRecord('decision.toolCalls');
  }

  const name = requiredRecordString(value, 'name', 'malformed_record');
  const input = value['input'];

  if (!isRecord(input)) {
    throwMalformedRecord('decision.toolCalls.input');
  }

  if (name === visibleReplyModelToolName) {
    const text = requiredRecordStringAllowingEmpty(
      input,
      'text',
      'malformed_record',
    );

    return createVisibleReplyModelToolCall(text);
  }

  return Object.freeze({
    name,
    input: requiredBoundedJsonObject(input, 'decision.toolCalls.input'),
  } satisfies PluginModelToolCall);
}
export function requiredRoleModelCommitValidationResult(
  value: unknown,
): RoleModelCommitValidationResult {
  if (!isRecord(value)) {
    throwMalformedRecord('commitValidation.result');
  }

  const status = requiredRecordString(value, 'status', 'malformed_record');

  if (status === 'accepted') {
    const acceptedVisibleReplyText =
      value['acceptedVisibleReplyText'] === undefined
        ? undefined
        : requiredNormalizedVisibleMessageText(
            value,
            'acceptedVisibleReplyText',
          );

    return Object.freeze({
      status: 'accepted',
      ...(acceptedVisibleReplyText === undefined
        ? {}
        : {acceptedVisibleReplyText}),
    } satisfies AcceptedRoleModelCommitValidationResult);
  }

  if (status === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      rejection: requiredRoleModelDecisionRejection(value['rejection']),
    } satisfies RejectedRoleModelCommitValidationResult);
  }

  throwMalformedRecord('status');
}
export function requiredRoleModelDecisionRejection(
  value: unknown,
): RoleModelDecisionRejection {
  if (!isRecord(value)) {
    throwMalformedRecord('rejection');
  }

  const reason = requiredRoleModelDecisionRejectionReason(value['reason']);
  const details = optionalRecordStringAllowingEmpty(
    value,
    'details',
    'malformed_record',
  );
  return Object.freeze({
    reason,
    ...(details === undefined ? {} : {details}),
  } satisfies RoleModelDecisionRejection);
}
export function requiredRoleModelDecisionRejectionReason(
  value: unknown,
): RoleModelDecisionRejectionReason {
  if (isOneOf(value, roleModelDecisionRejectionReasons)) {
    return value;
  }

  throwMalformedRecord('rejection.reason');
}
