import {
  CharacterReplyValidationError,
  normalizeCharacterAgentReply,
  rollbackLastCharacterTurn,
  runCharacterTurn,
  type CharacterAgent,
  type CharacterAgentReply,
  type CharacterTurnResult
} from '../../core/conversation.ts';
import {
  createRuntimePluginAfterTurnCommittedContext,
  type RuntimePluginContextItem,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult,
  type RuntimePluginToolInvocationSnapshot
} from '../../plugins/types.ts';
import type {
  RuntimePluginHealthHostResult,
  RuntimePluginHost
} from '../../plugins/index.ts';
import {
  createRoleModelCommitValidationSnapshot,
  runtimePluginEvidenceOption,
  runtimePluginTurnEvidenceOption
} from '../log.ts';
import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RawEventLogRecordInput,
  RuntimeTraceEntry,
  RuntimeTraceStepName
} from '../log.ts';
import type {
  DecisionContext,
  ParsedRoleModelDecisionSnapshot,
  RoleModelIOSnapshot
} from '../../role-model/contracts.ts';
import type { RoleModelLoopResult } from '../../role-model/loop.ts';
import { findValidatedTerminalRawEventForSession } from '../storage/file-runtime-log-store.ts';
import type {
  AppendVisibleReplyOptions,
  LocalRuntimeTurnProgressEvent,
  LocalRuntimeUserMessageCompletedResult,
  RuntimeTurnState
} from './contracts.ts';

type AcceptedRoleModelLoopResult = Extract<
  RoleModelLoopResult,
  { readonly status: 'accepted' }
>;

export class IncompleteConversationRollbackError extends AggregateError {
  constructor(cleanupErrors: readonly unknown[], originalError: unknown) {
    super(
      cleanupErrors,
      'Runtime conversation commit failed and rollback was incomplete.',
      { cause: originalError }
    );
    this.name = 'IncompleteConversationRollbackError';
  }
}

export type CompleteRuntimeTurnOptions = {
  readonly state: RuntimeTurnState;
  readonly decisionContext: DecisionContext;
  readonly pluginHost: RuntimePluginHost;
  readonly contextItems: readonly RuntimePluginContextItem[];
  readonly roleModelResult: AcceptedRoleModelLoopResult;
  readonly roleModelPluginEvidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly roleModelPluginToolInvocations: readonly RuntimePluginToolInvocationSnapshot[];
  readonly preCommitHealthResult: RuntimePluginHealthHostResult;
  readonly visibleReplyText: string | undefined;
};

export function initializeRuntimeTurnEvidence(state: RuntimeTurnState): void {
  appendTrace(state, 'runtime_event_received');
  appendRawEvent(state, {
    ...state.identity,
    kind: 'runtime_event_received',
    eventType: state.event.type,
    payloadSummary: state.payloadSummary
  });
  appendTrace(state, 'runtime_event_normalized');
  appendRawEvent(state, {
    ...state.identity,
    kind: 'runtime_event_normalized',
    eventType: state.event.type,
    payloadSummary: state.payloadSummary
  });
  appendTrace(state, 'runtime_turn_started');
}

export function appendTrace(
  state: RuntimeTurnState,
  step: RuntimeTraceStepName
): RuntimeTraceEntry {
  const traceEntry = state.options.logStore.appendTrace({
    ...state.identity,
    step
  });

  state.traceEntries.push(traceEntry);
  return traceEntry;
}

export function appendRawEvent(
  state: RuntimeTurnState,
  record: RawEventLogRecordInput
): RawEventLogRecord {
  const rawEvent = state.options.logStore.appendRawEvent(record);

  state.rawEventLogRecords.push(rawEvent);
  return rawEvent;
}

export async function emitProgress(
  state: RuntimeTurnState,
  progressEvent: LocalRuntimeTurnProgressEvent
): Promise<void> {
  try {
    await state.options.onProgress?.(progressEvent);
  } catch {
    // Progress callbacks are observers; they must not change runtime commit semantics.
  }
}

export function beginPluginFileStoreTransaction(
  state: RuntimeTurnState,
  pluginHost: RuntimePluginHost
): void {
  pluginHost.beginFileStoreTransaction?.();
  state.pluginFileStoreTransactionActive =
    pluginHost.beginFileStoreTransaction !== undefined;
}

export function preparePluginFileStoreTransaction(
  state: RuntimeTurnState
): void {
  if (!state.pluginFileStoreTransactionActive) {
    return;
  }

  state.preparedPluginFileStoreTransaction =
    state.runtimePluginHostForTurn?.prepareFileStoreTransaction?.(
      state.identity
    );
  state.pluginFileStoreTransactionActive = false;
}

export function rollbackPluginFileStoreTransaction(
  state: RuntimeTurnState
): void {
  if (state.pluginFileStoreTransactionActive) {
    state.runtimePluginHostForTurn?.rollbackFileStoreTransaction?.();
    state.pluginFileStoreTransactionActive = false;
  }

  state.preparedPluginFileStoreTransaction?.discard();
  state.preparedPluginFileStoreTransaction = undefined;
}

function finalizePluginFileStoreTransaction(state: RuntimeTurnState): void {
  const prepared = state.preparedPluginFileStoreTransaction;

  state.preparedPluginFileStoreTransaction = undefined;
  prepared?.finalize();
}

export async function appendVisibleReplyForDecision(
  state: RuntimeTurnState,
  optionsForReply: AppendVisibleReplyOptions
): Promise<CharacterTurnResult | undefined> {
  const normalizedReply = normalizeCharacterAgentReply({
    text: optionsForReply.text
  });

  if (!optionsForReply.final) {
    appendInterimVisibleReply(state, optionsForReply);
    await emitProgress(state, {
      kind: 'visible_reply',
      final: false,
      text: normalizedReply.text
    });
    return undefined;
  }

  if (state.userConversationMessage !== undefined) {
    throw new CharacterReplyValidationError(
      'Runtime cannot commit more than one final visible reply per turn.'
    );
  }

  const turn = await commitFinalVisibleReply(
    state,
    optionsForReply,
    normalizedReply.text
  );
  await emitProgress(state, {
    kind: 'visible_reply',
    final: true,
    text: turn.reply.text
  });
  return turn;
}

function appendInterimVisibleReply(
  state: RuntimeTurnState,
  optionsForReply: AppendVisibleReplyOptions
): void {
  appendRawEvent(state, {
    ...state.identity,
    kind: 'interim_visible_reply_emitted',
    eventType: state.event.type,
    payloadSummary: state.payloadSummary,
    roleModelIOSnapshot: optionsForReply.roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot:
      optionsForReply.parsedRoleModelDecisionSnapshot,
    ...runtimePluginEvidenceOption(optionsForReply.runtimePluginEvidence)
  });
  appendTrace(state, 'interim_visible_reply_emitted');
}

async function commitFinalVisibleReply(
  state: RuntimeTurnState,
  optionsForReply: AppendVisibleReplyOptions,
  replyText: string
): Promise<CharacterTurnResult> {
  const commitValidation = createRoleModelCommitValidationSnapshot({
    ...state.identity,
    sessionId: decisionContextSessionIdFromEvidence(
      optionsForReply.roleModelIOSnapshot
    ),
    result: {
      status: 'accepted',
      acceptedVisibleReplyText: replyText
    }
  });
  const turn = await runCharacterTurn(
    state.options.session,
    state.event.payload.currentUserMessage,
    createFixedReplyAgent(replyText),
    state.options.characterTurnOptions
  );
  const visibleMessages = appendConversationTurn(state, turn);

  try {
    appendRawEvent(state, {
      ...state.identity,
      kind: 'visible_reply_committed',
      eventType: state.event.type,
      visibleMessageIds: visibleMessages.map((message) => message.id),
      payloadSummary: state.payloadSummary,
      roleModelIOSnapshot: optionsForReply.roleModelIOSnapshot,
      parsedRoleModelDecisionSnapshot:
        optionsForReply.parsedRoleModelDecisionSnapshot,
      commitValidation,
      ...runtimePluginEvidenceOption(optionsForReply.runtimePluginEvidence)
    });
  } catch (error: unknown) {
    rollbackFailedConversationCommit(state, turn, error);
    throw error;
  }

  state.userConversationMessage = visibleMessages[0];
  state.committedVisibleMessages.push(...visibleMessages);
  appendTrace(state, 'visible_reply_committed');
  return turn;
}

function appendConversationTurn(
  state: RuntimeTurnState,
  turn: CharacterTurnResult
): readonly [ConversationLogRecord, ConversationLogRecord] {
  const committedAt =
    state.options.committedAt ?? state.options.event.createdAt;
  let userRecord: ConversationLogRecord | undefined;
  let characterRecord: ConversationLogRecord;

  try {
    userRecord = state.options.logStore.appendConversationMessage(
      {
        ...turn.userMessage,
        ...state.identity,
        committedAt
      },
      state.options.session.character
    );
    characterRecord = state.options.logStore.appendConversationMessage(
      {
        ...turn.characterMessage,
        ...state.identity,
        committedAt
      },
      state.options.session.character
    );
  } catch (error: unknown) {
    rollbackFailedConversationCommit(state, turn, error);
    throw error;
  }

  return Object.freeze([userRecord, characterRecord]);
}

function rollbackFailedConversationCommit(
  state: RuntimeTurnState,
  turn: CharacterTurnResult,
  originalError: unknown
): void {
  const cleanupErrors: unknown[] = [];

  try {
    state.options.logStore.removeConversationMessages([
      turn.userMessage.id,
      turn.characterMessage.id
    ]);
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }

  try {
    rollbackLastCharacterTurn(state.options.session, turn);
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length > 0) {
    throw new IncompleteConversationRollbackError(
      cleanupErrors,
      originalError
    );
  }
}

export function appendToolCallStarted(
  state: RuntimeTurnState,
  optionsForTool: {
    readonly callId: string;
    readonly round: number;
    readonly call: RuntimePluginToolCall;
    readonly roleModelIOSnapshot: RoleModelIOSnapshot;
    readonly parsedRoleModelDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  }
): void {
  appendRawEvent(state, {
    ...state.identity,
    kind: 'tool_call_started',
    eventType: state.event.type,
    toolCallId: optionsForTool.callId,
    toolRound: optionsForTool.round,
    toolName: optionsForTool.call.toolName,
    toolPluginId: optionsForTool.call.pluginId,
    toolInput: optionsForTool.call.input,
    roleModelIOSnapshot: optionsForTool.roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot:
      optionsForTool.parsedRoleModelDecisionSnapshot,
    payloadSummary: state.payloadSummary
  });
  appendTrace(state, 'tool_call_started');
}

export function appendToolCallFinished(
  state: RuntimeTurnState,
  optionsForTool: {
    readonly callId: string;
    readonly dispatchedToHost: boolean;
    readonly round: number;
    readonly pluginId: string;
    readonly toolName: string;
    readonly result: RuntimePluginToolCallResult;
  }
): void {
  appendRawEvent(state, {
    ...state.identity,
    kind: 'tool_call_finished',
    eventType: state.event.type,
    toolCallId: optionsForTool.callId,
    dispatchedToHost: optionsForTool.dispatchedToHost,
    toolRound: optionsForTool.round,
    toolName: optionsForTool.toolName,
    toolPluginId: optionsForTool.pluginId,
    toolResult: optionsForTool.result,
    ...pluginStoreRevisionOption(optionsForTool.result),
    payloadSummary: state.payloadSummary
  });
  state.finishedToolCallIds.push(optionsForTool.callId);
  appendTrace(state, 'tool_call_finished');
}

export async function completeRuntimeTurn(
  options: CompleteRuntimeTurnOptions
): Promise<LocalRuntimeUserMessageCompletedResult> {
  const { state } = options;

  preparePluginFileStoreTransaction(state);
  const turn = await commitTerminalVisibleReply(options);
  const terminalPluginEvidence = Object.freeze([
    ...options.roleModelPluginEvidence,
    ...options.preCommitHealthResult.evidence
  ]);
  const terminalAppend = appendCompletedTerminalRawEvent({
    ...options,
    terminalPluginEvidence,
    turn
  });
  const durability = finalizeCompletedDurability(
    state,
    terminalAppend.terminalAppendFailure
  );

  await recordAfterTurnCommitted(options, durability.postCommitFailures);

  return Object.freeze({
    status: 'completed',
    event: state.event,
    ...(turn === undefined ? {} : { turn }),
    conversationMessages: Object.freeze([...state.committedVisibleMessages]),
    rawEvent: terminalAppend.rawEvent,
    rawEventLogRecords: Object.freeze([...state.rawEventLogRecords]),
    traceEntries: Object.freeze([...state.traceEntries]),
    ...(durability.pluginFileStoreRecoveryPending
      ? { pluginFileStoreRecoveryPending: true }
      : {}),
    ...(durability.postCommitFailures.length === 0
      ? {}
      : {
          postCommitFailures: Object.freeze(durability.postCommitFailures)
        })
  } satisfies LocalRuntimeUserMessageCompletedResult);
}

async function commitTerminalVisibleReply(
  options: CompleteRuntimeTurnOptions
): Promise<CharacterTurnResult | undefined> {
  if (options.visibleReplyText === undefined) {
    return undefined;
  }

  return await appendVisibleReplyForDecision(options.state, {
    runtimePluginEvidence: options.roleModelPluginEvidence,
    final: true,
    roleModelIOSnapshot: options.roleModelResult.ioSnapshot,
    parsedRoleModelDecisionSnapshot:
      options.roleModelResult.parsedDecisionSnapshot,
    text: options.visibleReplyText
  });
}

function appendCompletedTerminalRawEvent(
  options: CompleteRuntimeTurnOptions & {
    readonly terminalPluginEvidence: readonly RuntimePluginEvidenceSnapshot[];
    readonly turn: CharacterTurnResult | undefined;
  }
): {
  readonly rawEvent: RawEventLogRecord;
  readonly terminalAppendFailure?: string;
} {
  const { state } = options;
  const terminalRawEventInput = createTerminalRawEventInput(options);

  try {
    const rawEvent = appendRawEvent(state, terminalRawEventInput);

    state.terminalRawEventMayBeDurable = true;
    return { rawEvent };
  } catch (error: unknown) {
    return recoverCompletedTerminalRawEvent(state, error);
  }
}

function createTerminalRawEventInput(
  options: CompleteRuntimeTurnOptions & {
    readonly terminalPluginEvidence: readonly RuntimePluginEvidenceSnapshot[];
    readonly turn: CharacterTurnResult | undefined;
  }
): RawEventLogRecordInput {
  const { state } = options;

  return {
    ...state.identity,
    kind: 'runtime_turn_completed',
    eventType: state.event.type,
    status: 'completed',
    ...visibleMessageIdsForTurnOption(state.committedVisibleMessages),
    toolCallIds: Object.freeze([...state.finishedToolCallIds]),
    payloadSummary: state.payloadSummary,
    roleModelIOSnapshot: options.roleModelResult.ioSnapshot,
    parsedRoleModelDecisionSnapshot:
      options.roleModelResult.parsedDecisionSnapshot,
    commitValidation: createRoleModelCommitValidationSnapshot({
      ...state.identity,
      sessionId: options.decisionContext.sessionId,
      result: {
        status: 'accepted',
        ...(options.turn === undefined
          ? {}
          : { acceptedVisibleReplyText: options.turn.reply.text })
      }
    }),
    ...runtimePluginEvidenceOption(options.terminalPluginEvidence),
    ...runtimePluginTurnEvidenceOption({
      identity: state.identity,
      pluginHost: options.pluginHost,
      contextItems: options.contextItems,
      toolInvocations: options.roleModelPluginToolInvocations,
      evidence: options.terminalPluginEvidence,
      health: options.preCommitHealthResult.snapshots
    })
  } satisfies RawEventLogRecordInput;
}

function recoverCompletedTerminalRawEvent(
  state: RuntimeTurnState,
  error: unknown
): {
  readonly rawEvent: RawEventLogRecord;
  readonly terminalAppendFailure?: string;
} {
  const sessionPaths = state.options.logStore.localRuntimeSessionPaths;

  if (sessionPaths === undefined) {
    throw error;
  }

  let durableTerminal: RawEventLogRecord | undefined;

  try {
    durableTerminal = findValidatedTerminalRawEventForSession(
      sessionPaths,
      state.identity
    );
  } catch {
    state.terminalRawEventMayBeDurable = true;
    throw error;
  }

  if (durableTerminal?.kind !== 'runtime_turn_completed') {
    if (durableTerminal !== undefined) {
      state.terminalRawEventMayBeDurable = true;
    }

    throw error;
  }

  state.rawEventLogRecords.push(durableTerminal);
  state.terminalRawEventMayBeDurable = true;
  return {
    rawEvent: durableTerminal,
    terminalAppendFailure: runtimePostCommitFailureMessage(error)
  };
}

function finalizeCompletedDurability(
  state: RuntimeTurnState,
  terminalAppendFailure: string | undefined
): {
  readonly pluginFileStoreRecoveryPending: boolean;
  readonly postCommitFailures: string[];
} {
  const postCommitFailures =
    terminalAppendFailure === undefined ? [] : [terminalAppendFailure];
  let pluginFileStoreRecoveryPending = false;

  try {
    finalizePluginFileStoreTransaction(state);
  } catch (error: unknown) {
    pluginFileStoreRecoveryPending = true;
    postCommitFailures.push(runtimePostCommitFailureMessage(error));
  }

  try {
    appendTrace(state, 'raw_event_log_appended');
    appendTrace(state, 'runtime_turn_completed');
  } catch (error: unknown) {
    reconcileCompletedTerminalTrace(state, error, postCommitFailures);
  }

  return { pluginFileStoreRecoveryPending, postCommitFailures };
}

function reconcileCompletedTerminalTrace(
  state: RuntimeTurnState,
  originalError: unknown,
  postCommitFailures: string[]
): void {
  try {
    const terminalSteps = [
      'raw_event_log_appended',
      'runtime_turn_completed'
    ] as const;
    const persisted = [
      ...state.options.logStore.readSessionEvidence().stored.traceEntries
    ];

    for (const step of terminalSteps) {
      if (!hasTerminalTraceEntry(state, persisted, step)) {
        persisted.push(appendTrace(state, step));
      }
    }

    for (const step of terminalSteps) {
      restoreTerminalTraceEntry(state, persisted, step);
    }
  } catch (reconciliationError: unknown) {
    postCommitFailures.push(
      `${runtimePostCommitFailureMessage(originalError)} ` +
      `Trace reconciliation failed: ${runtimePostCommitFailureMessage(reconciliationError)}`
    );
  }
}

function hasTerminalTraceEntry(
  state: RuntimeTurnState,
  entries: readonly RuntimeTraceEntry[],
  step: RuntimeTraceStepName
): boolean {
  return entries.some(
    (entry) =>
      entry.eventId === state.identity.eventId &&
      entry.traceId === state.identity.traceId &&
      entry.step === step
  );
}

function restoreTerminalTraceEntry(
  state: RuntimeTurnState,
  persisted: readonly RuntimeTraceEntry[],
  step: RuntimeTraceStepName
): void {
  if (state.traceEntries.some((entry) => entry.step === step)) {
    return;
  }

  const storedEntry = persisted.find(
    (entry) =>
      entry.eventId === state.identity.eventId &&
      entry.traceId === state.identity.traceId &&
      entry.step === step
  );

  if (storedEntry === undefined) {
    throw new Error(`Completed runtime trace is missing ${step}.`);
  }

  state.traceEntries.push(storedEntry);
}

async function recordAfterTurnCommitted(
  options: CompleteRuntimeTurnOptions,
  postCommitFailures: string[]
): Promise<void> {
  const { state } = options;

  try {
    const afterCommitPluginContext =
      createRuntimePluginAfterTurnCommittedContext({
        ...state.identity,
        sessionId: options.decisionContext.sessionId,
        eventType: state.event.type,
        currentUserMessage: state.event.payload.currentUserMessage,
        character: options.decisionContext.characterSnapshot,
        committedAt:
          state.options.committedAt ?? state.options.event.createdAt,
        visibleMessages: state.committedVisibleMessages
      });
    const afterCommitResult = await options.pluginHost.afterTurnCommitted(
      afterCommitPluginContext
    );

    if (shouldRecordAfterTurnCommittedEvent(afterCommitResult)) {
      appendRawEvent(state, {
        ...state.identity,
        kind: 'after_turn_committed',
        eventType: state.event.type,
        status: afterCommitResult.status,
        ...visibleMessageIdsForTurnOption(state.committedVisibleMessages),
        toolCallIds: Object.freeze([...state.finishedToolCallIds]),
        payloadSummary: state.payloadSummary,
        ...runtimePluginEvidenceOption(afterCommitResult.evidence)
      });
    }
  } catch (error: unknown) {
    // The completed turn is already durable; follow-up work cannot change the
    // terminal decision or append a contradictory rejection.
    postCommitFailures.push(runtimePostCommitFailureMessage(error));
  }
}

export function visibleMessageIdsForTurnOption(
  messages: readonly ConversationLogRecord[]
): { readonly visibleMessageIds?: readonly string[] } {
  if (messages.length === 0) {
    return {};
  }

  return {
    visibleMessageIds: Object.freeze(messages.map((message) => message.id))
  };
}

function pluginStoreRevisionOption(
  result: RuntimePluginToolCallResult
): { readonly pluginStoreRevision?: number } {
  if (result.status !== 'accepted') {
    return {};
  }

  const output = result.output;

  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return {};
  }

  const revision = (output as Readonly<Record<string, unknown>>)[
    'pluginStoreRevision'
  ];

  if (typeof revision !== 'number') {
    return {};
  }

  if (!Number.isSafeInteger(revision) || revision < 1) {
    return {};
  }

  return { pluginStoreRevision: revision };
}

function shouldRecordAfterTurnCommittedEvent(afterCommitResult: {
  readonly status: 'completed' | 'completed_with_failures';
  readonly evidence: readonly unknown[];
}): boolean {
  return (
    afterCommitResult.status === 'completed_with_failures' ||
    afterCommitResult.evidence.length > 0
  );
}

function runtimePostCommitFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Runtime post-commit work failed.';
}

function decisionContextSessionIdFromEvidence(
  snapshot: RoleModelIOSnapshot
): string {
  return snapshot.inputEnvelope.decisionContext.sessionId;
}

function createFixedReplyAgent(replyText: string): CharacterAgent {
  return Object.freeze({
    reply(): CharacterAgentReply {
      return { text: replyText };
    }
  } satisfies CharacterAgent);
}
