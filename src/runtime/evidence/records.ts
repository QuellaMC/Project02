import {
  assertCanonicalRuntimeTimestamp,
  type RuntimeEventIdentity,
  type RuntimeEventType,
  type VisibleMessage,
} from '../../core/index.ts';
import {
  roleModelDecisionRejectionReasons,
  type ConversationTurn,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelDecisionRejection,
  type RoleModelIOSnapshot,
} from '../../role-model/index.ts';
import {
  runtimePluginBeforeRoleModelCallRejectionReason,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginJsonObject,
  type RuntimePluginToolCallResult,
  type RuntimePluginTurnEvidenceSnapshot,
} from '../../plugins/api/index.ts';

export const runtimeTurnStatusValues = [
  'completed',
  'completed_with_failures',
  'rejected',
] as const;

export type RuntimeTurnStatus = (typeof runtimeTurnStatusValues)[number];

export const rawEventLogRecordKindValues = [
  'runtime_event_received',
  'runtime_event_normalized',
  'role_model_round',
  'tool_call_started',
  'tool_call_finished',
  'visible_message_committed',
  'runtime_turn_completed',
  'after_turn_committed',
  'runtime_turn_rejected',
  'session_continued',
] as const;

export type RawEventLogRecordKind =
  (typeof rawEventLogRecordKindValues)[number];

/**
 * Why a turn was rejected, as the log records it. A plugin health rejection
 * is a commit validation failure here; the runtime result names the health
 * gate, the record names the seam that refused.
 */
export const runtimeTurnRejectionReasonValues = Object.freeze([
  'input_validation_rejected',
  runtimePluginBeforeRoleModelCallRejectionReason,
  ...roleModelDecisionRejectionReasons,
  'runtime_failure',
] as const);

export type RuntimeTurnRejectionReason =
  (typeof runtimeTurnRejectionReasonValues)[number];

/**
 * A trace replays the raw event log, so its steps are the raw kinds minus the
 * post-commit record, plus the two steps the projection synthesizes.
 */
export type RuntimeTraceStepName =
  | Exclude<RawEventLogRecordKind, 'after_turn_committed'>
  | 'runtime_turn_started'
  | 'raw_event_log_appended';

export type RuntimeTraceEntry = RuntimeEventIdentity & {
  readonly step: RuntimeTraceStepName;
};

export type RawEventLogPayloadSummary = {
  readonly rawInput?: string;
  readonly normalizedCurrentUserMessage?: string;
};

export type RawEventLogRecord = RuntimeEventIdentity & {
  readonly kind: RawEventLogRecordKind;
  readonly eventType: RuntimeEventType;
  readonly status?: RuntimeTurnStatus;
  /** Present exactly on runtime_turn_rejected, with the message. */
  readonly reason?: RuntimeTurnRejectionReason;
  readonly message?: string;
  readonly visibleMessageIds?: readonly string[];
  /** The message this event commits; present exactly on commit events. */
  readonly visibleMessage?: VisibleMessage;
  readonly committedAt?: string;
  /**
   * The model round a record belongs to. A role_model_round record is that
   * round; a tool call, a character commit, or a terminal record judging a
   * decision references the round it came from.
   */
  readonly round?: number;
  readonly toolCallIds?: readonly string[];
  readonly toolCallId?: string;
  readonly dispatchedToHost?: boolean;
  readonly toolName?: string;
  readonly toolPluginId?: string;
  readonly toolInput?: RuntimePluginJsonObject;
  readonly toolResult?: RuntimePluginToolCallResult;
  readonly pluginStoreRevision?: number;
  readonly payloadSummary?: RawEventLogPayloadSummary;
  /** What the model was shown and what it wrote; present exactly on role_model_round. */
  readonly roleModelIOSnapshot?: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot?: ParsedRoleModelDecisionSnapshot;
  readonly commitValidation?: RoleModelCommitValidationSnapshot;
  readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[];
  readonly runtimePluginTurnEvidence?: RuntimePluginTurnEvidenceSnapshot;
  /** Present exactly on session_continued, a session's first record. */
  readonly sessionContinuation?: SessionContinuationSnapshot;
};

export const maxContextSummaryChars = 6000;

export type ContextSummarizer =
  | {
      readonly status: 'model';
      readonly provider: {readonly name: string; readonly model?: string};
    }
  | {readonly status: 'fallback'; readonly reason: string};

/**
 * How a session began as the continuation of another: what the earlier
 * conversation amounted to, and the newest turns carried over verbatim so the
 * character keeps its footing. Carried turns keep their original identities;
 * they are context here, evidence in the session that produced them.
 */
export type SessionContinuationSnapshot = RuntimeEventIdentity & {
  readonly kind: 'session_continuation_snapshot';
  readonly sessionId: string;
  readonly continuedFrom: {
    readonly sessionId: string;
    readonly lastEventId: string;
  };
  readonly summary: string;
  readonly summarizedTurnCount: number;
  readonly carriedTurns: readonly ConversationTurn[];
  readonly summarizer: ContextSummarizer;
};

/** What a continuation decides before the new session's identity exists. */
export type SessionContinuationPlan = {
  readonly continuedFrom: {
    readonly sessionId: string;
    readonly lastEventId: string;
  };
  readonly summary: string;
  readonly summarizedTurnCount: number;
  readonly carriedTurns: readonly ConversationTurn[];
  readonly summarizer: ContextSummarizer;
};

type CreateSessionContinuationSnapshotOptions = RuntimeEventIdentity &
  SessionContinuationPlan & {
    readonly sessionId: string;
  };

/** The one validator for writers and the codec alike. */
export function createSessionContinuationSnapshot(
  options: CreateSessionContinuationSnapshotOptions,
): SessionContinuationSnapshot {
  const summary = options.summary.trim();

  if (summary.length === 0 || summary.length > maxContextSummaryChars) {
    throw new TypeError(
      `Session continuation summary must be 1 to ${String(
        maxContextSummaryChars,
      )} characters.`,
    );
  }

  if (
    !Number.isSafeInteger(options.summarizedTurnCount) ||
    options.summarizedTurnCount < 1
  ) {
    throw new TypeError(
      'Session continuation must summarize at least one turn.',
    );
  }

  if (
    options.continuedFrom.sessionId.length === 0 ||
    options.continuedFrom.sessionId === options.sessionId ||
    options.continuedFrom.lastEventId.length === 0
  ) {
    throw new TypeError(
      'Session continuation must name a different session and its last event.',
    );
  }

  if (
    options.summarizer.status === 'model'
      ? options.summarizer.provider.name.length === 0 ||
        options.summarizer.provider.model?.length === 0
      : options.summarizer.reason.length === 0
  ) {
    throw new TypeError(
      'Session continuation must name its summariser, or say why there was none.',
    );
  }

  return Object.freeze({
    eventId: options.eventId,
    traceId: options.traceId,
    createdAt: assertCanonicalRuntimeTimestamp(
      options.createdAt,
      'Session continuation createdAt',
    ),
    kind: 'session_continuation_snapshot',
    sessionId: options.sessionId,
    continuedFrom: Object.freeze({
      sessionId: options.continuedFrom.sessionId,
      lastEventId: options.continuedFrom.lastEventId,
    }),
    summary,
    summarizedTurnCount: options.summarizedTurnCount,
    carriedTurns: Object.freeze([...options.carriedTurns]),
    summarizer: Object.freeze(
      options.summarizer.status === 'model'
        ? {
            status: 'model',
            provider: Object.freeze({
              name: options.summarizer.provider.name,
              ...(options.summarizer.provider.model === undefined
                ? {}
                : {model: options.summarizer.provider.model}),
            }),
          }
        : {status: 'fallback', reason: options.summarizer.reason},
    ),
  } satisfies SessionContinuationSnapshot);
}

export type ConversationLogRecord = VisibleMessage &
  RuntimeEventIdentity & {
    readonly committedAt: string;
  };

/** What a caller hands the log store; the store returns the stored record. */
export type RawEventLogRecordInput = RawEventLogRecord;

export type AcceptedRoleModelCommitValidationResult = {
  readonly status: 'accepted';
  readonly acceptedVisibleReplyText?: string;
};

export type RejectedRoleModelCommitValidationResult = {
  readonly status: 'rejected';
  readonly rejection: RoleModelDecisionRejection;
};

export type RoleModelCommitValidationResult =
  | AcceptedRoleModelCommitValidationResult
  | RejectedRoleModelCommitValidationResult;

export type RoleModelCommitValidationSnapshot = RuntimeEventIdentity & {
  readonly kind: 'role_model_commit_validation_snapshot';
  readonly sessionId: string;
  readonly result: RoleModelCommitValidationResult;
};

type CreateRoleModelCommitValidationSnapshotOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly result: RoleModelCommitValidationResult;
};

export function createRoleModelCommitValidationSnapshot(
  options: CreateRoleModelCommitValidationSnapshotOptions,
): RoleModelCommitValidationSnapshot {
  return Object.freeze({
    eventId: options.eventId,
    traceId: options.traceId,
    createdAt: assertCanonicalRuntimeTimestamp(
      options.createdAt,
      'Role-model commit validation createdAt',
    ),
    kind: 'role_model_commit_validation_snapshot',
    sessionId: options.sessionId,
    result: freezeRoleModelCommitValidationResult(options.result),
  } satisfies RoleModelCommitValidationSnapshot);
}

export function isTerminalRawEventLogRecordKind(
  kind: RawEventLogRecordKind,
): boolean {
  return kind === 'runtime_turn_completed' || kind === 'runtime_turn_rejected';
}

export function isTerminalRawEventLogRecord(
  record: Pick<RawEventLogRecord, 'kind'>,
): boolean {
  return isTerminalRawEventLogRecordKind(record.kind);
}

function freezeRoleModelCommitValidationResult(
  result: RoleModelCommitValidationResult,
): RoleModelCommitValidationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      ...(result.acceptedVisibleReplyText === undefined
        ? {}
        : {
            acceptedVisibleReplyText: result.acceptedVisibleReplyText,
          }),
    } satisfies AcceptedRoleModelCommitValidationResult);
  }

  return Object.freeze({
    status: 'rejected',
    rejection: Object.freeze({
      reason: result.rejection.reason,
      ...(result.rejection.details === undefined
        ? {}
        : {details: result.rejection.details}),
    } satisfies RoleModelDecisionRejection),
  } satisfies RejectedRoleModelCommitValidationResult);
}
