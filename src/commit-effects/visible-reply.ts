import {
  ASSISTANT_VISIBLE_REPLY_KIND,
  DECISION_READY_FOR_COMMIT_STATUS,
  USER_MESSAGE,
  USER_VISIBLE_MESSAGE_KIND,
  USER_VISIBLE_MESSAGE_ROLE,
  VISIBLE_REPLY_ACTION,
  ContractValidationError,
  normalizeRoleModelTurnResult,
  normalizeVisibleReplyDecision,
  validateNormalizedUserMessageEvent,
  type RoleModelTurnResult,
  type UserMessageRuntimeEvent
} from '../runtime/contracts.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../runtime/schema.ts';
import {
  asRecord,
  getOwnField,
  rejectExtraKeys,
  requireLiteral,
  requireString
} from '../runtime/validation.ts';
import {
  buildRawLogEntry,
  clockTimestamp,
  generateId,
  snapshotRawValue,
  type Clock,
  type IdGenerator,
  type RawEventLogEntry
} from '../runtime/logging.ts';

export const VISIBLE_REPLY_COMMITTED_STATUS = 'visible_reply_committed';
export const VISIBLE_REPLY_REJECTED_STATUS = 'visible_reply_rejected';
export const VISIBLE_REPLY_COMMITTED_KIND = 'visible_reply_committed';
export const VISIBLE_REPLY_REJECTED_KIND = 'visible_reply_rejected';
export const COMMIT_VALIDATION_STAGE = 'commit_validation';
export const USER_VISIBLE_MESSAGE_COMMITTED_STATUS = 'user_visible_message_committed';
export const USER_VISIBLE_MESSAGE_REJECTED_STATUS = 'user_visible_message_rejected';
export const USER_VISIBLE_MESSAGE_COMMITTED_KIND = 'user_visible_message_committed';
export const USER_VISIBLE_MESSAGE_REJECTED_KIND = 'user_visible_message_rejected';
export const USER_VISIBLE_MESSAGE_VALIDATION_STAGE = 'user_visible_message_validation';

const SUPPORTED_REJECTION_CODES = [
  'malformed_commit_input',
  'identity_mismatch',
  'unsupported_result_status',
  'unsupported_action',
  'empty_reply_text'
] as const;

const SUPPORTED_USER_VISIBLE_MESSAGE_REJECTION_CODES = ['malformed_commit_input'] as const;

type CommitFailure = {
  stage: string;
  code: string;
  message: string;
};

export type VisibleConversationOutput = {
  output_id: string;
  trace_id: string;
  source_event_id: string;
  kind: typeof ASSISTANT_VISIBLE_REPLY_KIND;
  created_at: string;
  schema_version: SchemaVersion;
  text: string;
  user_id?: string;
  conversation_id?: string;
  source: {
    decision_action: typeof VISIBLE_REPLY_ACTION;
    role_model_status: typeof DECISION_READY_FOR_COMMIT_STATUS;
  };
};

export type UserVisibleMessage = {
  message_id: string;
  trace_id: string;
  source_event_id: string;
  kind: typeof USER_VISIBLE_MESSAGE_KIND;
  role: typeof USER_VISIBLE_MESSAGE_ROLE;
  created_at: string;
  schema_version: SchemaVersion;
  text: string;
  user_id?: string;
  conversation_id?: string;
  source: {
    runtime_event_type: typeof USER_MESSAGE;
  };
};

export type VisibleConversationRecord = {
  [key: string]: unknown;
  trace_id: string;
  source_event_id: string;
  kind: string;
  created_at: string;
  schema_version: SchemaVersion;
  text: string;
  user_id?: string;
  conversation_id?: string;
  output_id?: string;
  message_id?: string;
  role?: string;
  source: Record<string, string>;
};

export type VisibleConversationLog = {
  append: (output: VisibleConversationRecord) => void;
};

export type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export type VisibleReplyCommitResult = {
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  status: typeof VISIBLE_REPLY_COMMITTED_STATUS;
  output: VisibleConversationOutput;
};

export type VisibleReplyRejectResult = {
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  status: typeof VISIBLE_REPLY_REJECTED_STATUS;
  failure: CommitFailure;
};

export type UserVisibleMessageCommitResult = {
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  status: typeof USER_VISIBLE_MESSAGE_COMMITTED_STATUS;
  message: UserVisibleMessage;
};

export type UserVisibleMessageRejectResult = {
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  status: typeof USER_VISIBLE_MESSAGE_REJECTED_STATUS;
  failure: CommitFailure;
};

type SourceIdentity = {
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
};

export class CommitValidationError extends Error {
  readonly code: string;

  constructor(message: string, { code = 'malformed_commit_input' }: { code?: string } = {}) {
    super(message);
    this.name = 'CommitValidationError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function commitVisibleReply(
  sourceEvent: unknown,
  roleModelResult: unknown,
  {
    visibleConversationLog,
    rawEventLog,
    idGenerator,
    clock
  }: {
    visibleConversationLog: VisibleConversationLog;
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): VisibleReplyCommitResult | VisibleReplyRejectResult {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent);
  let output: VisibleConversationOutput;

  try {
    output = buildVisibleConversationOutput(sourceEvent, roleModelResult, {
      idGenerator,
      clock
    });
  } catch (error) {
    if (!(error instanceof CommitValidationError)) {
      throw error;
    }
    const failure = buildFailure(error.code, error.message);
    rawEventLog.append(
      buildVisibleReplyRejectedLogEntry(sourceEvent, {
        roleModelResultSnapshot: roleModelResult,
        failure,
        idGenerator,
        clock
      })
    );
    return {
      trace_id: sourceIdentity.trace_id,
      event_id: sourceIdentity.event_id,
      event_type: sourceIdentity.event_type,
      status: VISIBLE_REPLY_REJECTED_STATUS,
      failure
    };
  }

  const committedLogEntry = buildVisibleReplyCommittedLogEntry(
    sourceEvent,
    roleModelResult,
    output,
    { idGenerator, clock }
  );
  rawEventLog.append(committedLogEntry);
  visibleConversationLog.append(structuredClone(output));
  return {
    trace_id: output.trace_id,
    event_id: output.source_event_id,
    event_type: USER_MESSAGE,
    status: VISIBLE_REPLY_COMMITTED_STATUS,
    output: structuredClone(output)
  };
}

export function commitUserVisibleMessage(
  sourceEvent: unknown,
  {
    visibleConversationLog,
    rawEventLog,
    idGenerator,
    clock
  }: {
    visibleConversationLog: VisibleConversationLog;
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): UserVisibleMessageCommitResult | UserVisibleMessageRejectResult {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent, {
    requireEventType: true
  });
  let message: UserVisibleMessage;

  try {
    message = buildUserVisibleMessage(sourceEvent, { idGenerator });
  } catch (error) {
    if (!(error instanceof CommitValidationError)) {
      throw error;
    }
    const failure = buildUserVisibleMessageFailure(error.code, error.message);
    rawEventLog.append(
      buildUserVisibleMessageRejectedLogEntry(sourceEvent, {
        failure,
        idGenerator,
        clock
      })
    );
    return {
      trace_id: sourceIdentity.trace_id,
      event_id: sourceIdentity.event_id,
      event_type: sourceIdentity.event_type,
      status: USER_VISIBLE_MESSAGE_REJECTED_STATUS,
      failure
    };
  }

  const committedLogEntry = buildUserVisibleMessageCommittedLogEntry(sourceEvent, message, {
    idGenerator,
    clock
  });
  rawEventLog.append(committedLogEntry);
  visibleConversationLog.append(structuredClone(message));
  return {
    trace_id: message.trace_id,
    event_id: message.source_event_id,
    event_type: USER_MESSAGE,
    status: USER_VISIBLE_MESSAGE_COMMITTED_STATUS,
    message: structuredClone(message)
  };
}

export function buildVisibleConversationOutput(
  sourceEvent: unknown,
  roleModelResult: unknown,
  { idGenerator, clock }: { idGenerator: IdGenerator; clock: Clock }
): VisibleConversationOutput {
  const event = validateSourceEvent(sourceEvent);
  const result = validateRoleModelResult(roleModelResult, { sourceEvent: event });
  const output: VisibleConversationOutput = {
    output_id: generateId('output', idGenerator),
    trace_id: event.trace_id,
    source_event_id: event.event_id,
    kind: ASSISTANT_VISIBLE_REPLY_KIND,
    created_at: clockTimestamp(clock),
    schema_version: SCHEMA_VERSION,
    text: result.decision.visible_reply.text,
    source: {
      decision_action: VISIBLE_REPLY_ACTION,
      role_model_status: DECISION_READY_FOR_COMMIT_STATUS
    }
  };
  copyPayloadIdentityFields(event, output);
  return output;
}

export function buildUserVisibleMessage(
  sourceEvent: unknown,
  { idGenerator }: { idGenerator: IdGenerator }
): UserVisibleMessage {
  const event = validateSourceEvent(sourceEvent);
  const message: UserVisibleMessage = {
    message_id: generateId('message', idGenerator),
    trace_id: event.trace_id,
    source_event_id: event.event_id,
    kind: USER_VISIBLE_MESSAGE_KIND,
    role: USER_VISIBLE_MESSAGE_ROLE,
    created_at: event.created_at,
    schema_version: SCHEMA_VERSION,
    text: event.payload.text,
    source: {
      runtime_event_type: event.type
    }
  };
  copyPayloadIdentityFields(event, message);
  return message;
}

export function buildVisibleReplyCommittedLogEntry(
  sourceEvent: unknown,
  roleModelResult: unknown,
  output: unknown,
  { idGenerator, clock }: { idGenerator: IdGenerator; clock: Clock }
): RawEventLogEntry {
  const event = validateSourceEvent(sourceEvent);
  const result = validateRoleModelResult(roleModelResult, { sourceEvent: event });
  const validatedOutput = validateVisibleConversationOutput(output, {
    sourceEvent: event,
    roleModelResult: result
  });

  return buildRawLogEntry({
    trace_id: event.trace_id,
    event_id: event.event_id,
    kind: VISIBLE_REPLY_COMMITTED_KIND,
    data: {
      source_event: event,
      role_model_result: result,
      output: validatedOutput
    },
    idGenerator,
    clock
  });
}

export function buildUserVisibleMessageCommittedLogEntry(
  sourceEvent: unknown,
  message: unknown,
  { idGenerator, clock }: { idGenerator: IdGenerator; clock: Clock }
): RawEventLogEntry {
  const event = validateSourceEvent(sourceEvent);
  const validatedMessage = validateUserVisibleMessage(message, { sourceEvent: event });
  return buildRawLogEntry({
    trace_id: event.trace_id,
    event_id: event.event_id,
    kind: USER_VISIBLE_MESSAGE_COMMITTED_KIND,
    data: {
      source_event: event,
      message: validatedMessage
    },
    idGenerator,
    clock
  });
}

export function buildVisibleReplyRejectedLogEntry(
  sourceEvent: unknown,
  {
    roleModelResultSnapshot,
    failure,
    idGenerator,
    clock,
    decisionSnapshot
  }: {
    roleModelResultSnapshot: unknown;
    failure: unknown;
    idGenerator: IdGenerator;
    clock: Clock;
    decisionSnapshot?: unknown;
  }
): RawEventLogEntry {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent);
  const validatedFailure = validateFailure(failure);
  const data: Record<string, unknown> = {
    source_event: snapshotValue(sourceEvent),
    role_model_result_snapshot: snapshotValue(roleModelResultSnapshot),
    failure: validatedFailure
  };
  if (decisionSnapshot !== undefined && decisionSnapshot !== null) {
    data['decision_snapshot'] = snapshotValue(decisionSnapshot);
  } else if (isPlainRecord(roleModelResultSnapshot) && Object.hasOwn(roleModelResultSnapshot, 'decision')) {
    data['decision_snapshot'] = snapshotValue(roleModelResultSnapshot['decision']);
  }
  return buildRawLogEntry({
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    kind: VISIBLE_REPLY_REJECTED_KIND,
    data,
    idGenerator,
    clock
  });
}

export function buildUserVisibleMessageRejectedLogEntry(
  sourceEvent: unknown,
  {
    failure,
    idGenerator,
    clock
  }: {
    failure: unknown;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RawEventLogEntry {
  const sourceIdentity = extractTrustedSourceIdentity(sourceEvent, {
    requireEventType: true
  });
  const validatedFailure = validateUserVisibleMessageFailure(failure);
  return buildRawLogEntry({
    trace_id: sourceIdentity.trace_id,
    event_id: sourceIdentity.event_id,
    kind: USER_VISIBLE_MESSAGE_REJECTED_KIND,
    data: {
      source_event: snapshotValue(sourceEvent),
      failure: validatedFailure
    },
    idGenerator,
    clock
  });
}

function validateSourceEvent(sourceEvent: unknown): UserMessageRuntimeEvent {
  return wrapContractError(() =>
    validateNormalizedUserMessageEvent(sourceEvent, 'source_event')
  );
}

function validateRoleModelResult(
  roleModelResult: unknown,
  { sourceEvent }: { sourceEvent: UserMessageRuntimeEvent }
): RoleModelTurnResult {
  return wrapContractError(() =>
    normalizeRoleModelTurnResult(roleModelResult, {
      sourceEvent,
      decisionNormalizer: (decision) =>
        normalizeVisibleReplyDecision(
          decision,
          {
            traceId: sourceEvent.trace_id,
            eventId: sourceEvent.event_id,
            requireAttachedIds: true
          },
          'CharacterDecision'
        )
    })
  );
}

function validateVisibleConversationOutput(
  output: unknown,
  {
    sourceEvent,
    roleModelResult
  }: {
    sourceEvent: UserMessageRuntimeEvent;
    roleModelResult: RoleModelTurnResult;
  }
): VisibleConversationOutput {
  const outputRecord = asCommitRecord(output, 'VisibleConversationOutput');
  const allowedKeys = [
    'output_id',
    'trace_id',
    'source_event_id',
    'kind',
    'created_at',
    'schema_version',
    'text',
    'source'
  ];
  pushOptionalPayloadKeys(allowedKeys, sourceEvent);
  wrapContractError(() => {
    rejectExtraKeys(outputRecord, allowedKeys, 'VisibleConversationOutput');
  });

  const validated: VisibleConversationOutput = {
    output_id: wrapContractError(() =>
      requireString(getOwnField(outputRecord, 'output_id'), 'output_id')
    ),
    trace_id: requireExactString(
      getOwnField(outputRecord, 'trace_id'),
      sourceEvent.trace_id,
      'trace_id'
    ),
    source_event_id: requireExactString(
      getOwnField(outputRecord, 'source_event_id'),
      sourceEvent.event_id,
      'source_event_id'
    ),
    kind: requireExactString(
      getOwnField(outputRecord, 'kind'),
      ASSISTANT_VISIBLE_REPLY_KIND,
      'kind'
    ),
    created_at: wrapContractError(() =>
      requireString(getOwnField(outputRecord, 'created_at'), 'created_at')
    ),
    schema_version: requireExactString(
      getOwnField(outputRecord, 'schema_version'),
      SCHEMA_VERSION,
      'schema_version'
    ),
    text: requireExactString(
      getOwnField(outputRecord, 'text'),
      roleModelResult.decision.visible_reply.text,
      'text'
    ),
    source: validateOutputSource(getOwnField(outputRecord, 'source'))
  };
  copyValidatedPayloadIdentityFields(sourceEvent, outputRecord, validated);
  return validated;
}

function validateUserVisibleMessage(
  message: unknown,
  { sourceEvent }: { sourceEvent: UserMessageRuntimeEvent }
): UserVisibleMessage {
  const messageRecord = asCommitRecord(message, 'UserVisibleMessage');
  const allowedKeys = [
    'message_id',
    'trace_id',
    'source_event_id',
    'kind',
    'role',
    'created_at',
    'schema_version',
    'text',
    'source'
  ];
  pushOptionalPayloadKeys(allowedKeys, sourceEvent);
  wrapContractError(() => {
    rejectExtraKeys(messageRecord, allowedKeys, 'UserVisibleMessage');
  });

  const validated: UserVisibleMessage = {
    message_id: wrapContractError(() =>
      requireString(getOwnField(messageRecord, 'message_id'), 'message_id')
    ),
    trace_id: requireExactString(
      getOwnField(messageRecord, 'trace_id'),
      sourceEvent.trace_id,
      'trace_id'
    ),
    source_event_id: requireExactString(
      getOwnField(messageRecord, 'source_event_id'),
      sourceEvent.event_id,
      'source_event_id'
    ),
    kind: requireExactString(
      getOwnField(messageRecord, 'kind'),
      USER_VISIBLE_MESSAGE_KIND,
      'kind'
    ),
    role: requireExactString(
      getOwnField(messageRecord, 'role'),
      USER_VISIBLE_MESSAGE_ROLE,
      'role'
    ),
    created_at: requireExactString(
      getOwnField(messageRecord, 'created_at'),
      sourceEvent.created_at,
      'created_at'
    ),
    schema_version: requireExactString(
      getOwnField(messageRecord, 'schema_version'),
      SCHEMA_VERSION,
      'schema_version'
    ),
    text: requireExactString(
      getOwnField(messageRecord, 'text'),
      sourceEvent.payload.text,
      'text'
    ),
    source: validateUserMessageSource(getOwnField(messageRecord, 'source'))
  };
  copyValidatedPayloadIdentityFields(sourceEvent, messageRecord, validated);
  return validated;
}

function validateOutputSource(source: unknown): VisibleConversationOutput['source'] {
  const sourceRecord = asCommitRecord(source, 'VisibleConversationOutput.source');
  wrapContractError(() => {
    rejectExtraKeys(
      sourceRecord,
      ['decision_action', 'role_model_status'],
      'VisibleConversationOutput.source'
    );
  });
  return {
    decision_action: requireExactString(
      getOwnField(sourceRecord, 'decision_action'),
      VISIBLE_REPLY_ACTION,
      'source.decision_action'
    ),
    role_model_status: requireExactString(
      getOwnField(sourceRecord, 'role_model_status'),
      DECISION_READY_FOR_COMMIT_STATUS,
      'source.role_model_status'
    )
  };
}

function validateUserMessageSource(source: unknown): UserVisibleMessage['source'] {
  const sourceRecord = asCommitRecord(source, 'UserVisibleMessage.source');
  wrapContractError(() => {
    rejectExtraKeys(sourceRecord, ['runtime_event_type'], 'UserVisibleMessage.source');
  });
  return {
    runtime_event_type: requireExactString(
      getOwnField(sourceRecord, 'runtime_event_type'),
      USER_MESSAGE,
      'source.runtime_event_type'
    )
  };
}

function extractTrustedSourceIdentity(
  sourceEvent: unknown,
  { requireEventType = false }: { requireEventType?: boolean } = {}
): SourceIdentity {
  const eventRecord = asCommitRecord(sourceEvent, 'source_event');
  const traceId = wrapContractError(() =>
    requireString(getOwnField(eventRecord, 'trace_id'), 'trace_id')
  );
  const eventId = wrapContractError(() =>
    requireString(getOwnField(eventRecord, 'event_id'), 'event_id')
  );
  if (requireEventType) {
    wrapContractError(() => requireString(getOwnField(eventRecord, 'type'), 'type'));
  }
  return {
    trace_id: traceId,
    event_id: eventId,
    event_type: USER_MESSAGE
  };
}

function validateFailure(failure: unknown): CommitFailure {
  return validateFailureForStage(failure, {
    stage: COMMIT_VALIDATION_STAGE,
    supportedCodes: SUPPORTED_REJECTION_CODES
  });
}

function validateUserVisibleMessageFailure(failure: unknown): CommitFailure {
  return validateFailureForStage(failure, {
    stage: USER_VISIBLE_MESSAGE_VALIDATION_STAGE,
    supportedCodes: SUPPORTED_USER_VISIBLE_MESSAGE_REJECTION_CODES
  });
}

function validateFailureForStage(
  failure: unknown,
  { stage, supportedCodes }: { stage: string; supportedCodes: readonly string[] }
): CommitFailure {
  const failureRecord = asCommitRecord(failure, 'failure');
  wrapContractError(() => {
    rejectExtraKeys(failureRecord, ['stage', 'code', 'message'], 'failure');
  });
  requireExactString(getOwnField(failureRecord, 'stage'), stage, 'failure.stage');
  const code = wrapContractError(() =>
    requireString(getOwnField(failureRecord, 'code'), 'failure.code')
  );
  if (!supportedCodes.includes(code)) {
    throw new CommitValidationError('failure.code must be a supported commit validation code.');
  }
  return {
    stage,
    code,
    message: wrapContractError(() =>
      requireString(getOwnField(failureRecord, 'message'), 'failure.message')
    )
  };
}

function buildFailure(code: string, message: string): CommitFailure {
  const supportedCode = SUPPORTED_REJECTION_CODES.includes(
    code as (typeof SUPPORTED_REJECTION_CODES)[number]
  )
    ? code
    : 'malformed_commit_input';
  return {
    stage: COMMIT_VALIDATION_STAGE,
    code: supportedCode,
    message
  };
}

function buildUserVisibleMessageFailure(code: string, message: string): CommitFailure {
  const supportedCode = SUPPORTED_USER_VISIBLE_MESSAGE_REJECTION_CODES.includes(
    code as (typeof SUPPORTED_USER_VISIBLE_MESSAGE_REJECTION_CODES)[number]
  )
    ? code
    : 'malformed_commit_input';
  return {
    stage: USER_VISIBLE_MESSAGE_VALIDATION_STAGE,
    code: supportedCode,
    message
  };
}

function asCommitRecord(value: unknown, fieldName: string): Record<string, unknown> {
  return wrapContractError(() => asRecord(value, fieldName));
}

function wrapContractError<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      const code = error.code === 'invalid_contract' ? 'malformed_commit_input' : error.code;
      throw new CommitValidationError(pythonizeContractMessage(error.message), { code });
    }
    throw error;
  }
}

function pythonizeContractMessage(message: string): string {
  return message.replace(/"([^"]+)"/g, "'$1'");
}

function requireExactString<const Expected extends string>(
  value: unknown,
  expected: Expected,
  fieldName: string
): Expected {
  return wrapContractError(() => requireLiteral(value, expected, fieldName));
}

function copyPayloadIdentityFields(
  event: UserMessageRuntimeEvent,
  record: VisibleConversationOutput | UserVisibleMessage
): void {
  if (event.payload.user_id !== undefined) {
    record.user_id = event.payload.user_id;
  }
  if (event.payload.conversation_id !== undefined) {
    record.conversation_id = event.payload.conversation_id;
  }
}

function copyValidatedPayloadIdentityFields(
  event: UserMessageRuntimeEvent,
  sourceRecord: Record<string, unknown>,
  target: VisibleConversationOutput | UserVisibleMessage
): void {
  if (event.payload.user_id !== undefined) {
    target.user_id = requireExactString(
      getOwnField(sourceRecord, 'user_id'),
      event.payload.user_id,
      'user_id'
    );
  }
  if (event.payload.conversation_id !== undefined) {
    target.conversation_id = requireExactString(
      getOwnField(sourceRecord, 'conversation_id'),
      event.payload.conversation_id,
      'conversation_id'
    );
  }
}

function pushOptionalPayloadKeys(keys: string[], event: UserMessageRuntimeEvent): void {
  if (event.payload.user_id !== undefined) {
    keys.push('user_id');
  }
  if (event.payload.conversation_id !== undefined) {
    keys.push('conversation_id');
  }
}

function snapshotValue(value: unknown): unknown {
  return snapshotRawValue(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
