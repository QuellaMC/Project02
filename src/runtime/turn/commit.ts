import {conversationMessageForRawEvent} from '../evidence/cache.ts';
import {
  appendCommittedMessage,
  createCharacterMessage,
  createUserMessage,
  normalizeCharacterAgentReply,
  type VisibleMessage,
} from '../../core/index.ts';
import {
  createRuntimePluginAfterTurnCommittedContext,
  type PreparedRuntimePluginConfigEffect,
  type RuntimePluginContextItem,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult,
  type RuntimePluginToolInvocationSnapshot,
} from '../../plugins/api/index.ts';
import type {
  RuntimePluginHealthHostResult,
  RuntimePluginHost,
} from '../../plugins/index.ts';
import {
  applyCompletedRuntimeConfigReloads,
  assertRuntimeConfigEffectsCanCommit,
  reconcileCompletedRuntimeConfigEffects,
  runtimeConfigEffectsForCompletedTurn,
  runtimePostCommitFailureMessage,
} from './config-effects.ts';
import {createRoleModelCommitValidationSnapshot} from '../evidence/records.ts';
import {
  runtimePluginEvidenceOption,
  runtimePluginTurnEvidenceOption,
} from './plugin-evidence.ts';
import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RawEventLogRecordInput,
} from '../evidence/records.ts';
import type {
  DecisionContext,
  ParsedRoleModelDecisionSnapshot,
  RoleModelIOSnapshot,
} from '../../role-model/index.ts';
import {
  executionVisibleReplyTexts,
  type RoleModelLoopResult,
} from '../../role-model/index.ts';
import {findValidatedTerminalRawEventForSession} from '../storage/file-runtime-log-store.ts';
import type {
  AppendVisibleReplyOptions,
  LocalRuntimeTurnProgressEvent,
  LocalRuntimeUserMessageCompletedResult,
  RuntimeTurnState,
} from './contracts.ts';
import {roleModelIOSnapshotSessionId} from './contracts.ts';

type AcceptedRoleModelLoopResult = Extract<
  RoleModelLoopResult,
  {readonly status: 'accepted'}
>;

export type CompleteRuntimeTurnOptions = {
  readonly state: RuntimeTurnState;
  readonly decisionContext: DecisionContext;
  readonly pluginHost: RuntimePluginHost;
  readonly contextItems: readonly RuntimePluginContextItem[];
  readonly roleModelResult: AcceptedRoleModelLoopResult;
  readonly roleModelPluginEvidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly roleModelPluginToolInvocations: readonly RuntimePluginToolInvocationSnapshot[];
  readonly preCommitHealthResult: RuntimePluginHealthHostResult;
};

export function initializeRuntimeTurnEvidence(state: RuntimeTurnState): void {
  appendRawEvent(state, {
    ...state.identity,
    kind: 'runtime_event_received',
    eventType: state.event.type,
    payloadSummary: state.payloadSummary,
  });
  appendRawEvent(state, {
    ...state.identity,
    kind: 'runtime_event_normalized',
    eventType: state.event.type,
    payloadSummary: state.payloadSummary,
  });
}

export function appendRawEvent(
  state: RuntimeTurnState,
  record: RawEventLogRecordInput,
): RawEventLogRecord {
  const rawEvent = state.options.logStore.appendRawEvent(record);

  state.rawEventLogRecords.push(rawEvent);
  return rawEvent;
}

export async function emitProgress(
  state: RuntimeTurnState,
  progressEvent: LocalRuntimeTurnProgressEvent,
): Promise<void> {
  try {
    await state.options.onProgress?.(progressEvent);
  } catch {
    // Progress callbacks are observers; they must not change runtime commit semantics.
  }
}

export async function commitUserMessage(
  state: RuntimeTurnState,
): Promise<ConversationLogRecord> {
  const message = createUserMessage(
    state.options.session,
    state.event.payload.currentUserMessage,
  );

  return await commitVisibleMessage(state, message, {});
}

export async function appendVisibleReplyForDecision(
  state: RuntimeTurnState,
  optionsForReply: AppendVisibleReplyOptions,
): Promise<ConversationLogRecord> {
  const normalizedReply = normalizeCharacterAgentReply({
    text: optionsForReply.text,
  });
  const commitValidation = createRoleModelCommitValidationSnapshot({
    ...state.identity,
    sessionId: roleModelIOSnapshotSessionId(
      optionsForReply.roleModelIOSnapshot,
    ),
    result: {
      status: 'accepted',
      acceptedVisibleReplyText: normalizedReply.text,
    },
  });
  const message = createCharacterMessage(
    state.options.session,
    normalizedReply,
  );

  return await commitVisibleMessage(state, message, {
    roleModelIOSnapshot: optionsForReply.roleModelIOSnapshot,
    parsedRoleModelDecisionSnapshot:
      optionsForReply.parsedRoleModelDecisionSnapshot,
    commitValidation,
    decisionRound: optionsForReply.round,
    ...runtimePluginEvidenceOption(optionsForReply.runtimePluginEvidence),
  });
}

/**
 * Saying something is what makes it real, so the message enters the
 * session and reaches the user before it reaches disk. A storage failure
 * after that point is reported, never un-said: the conversation happened.
 */
async function commitVisibleMessage(
  state: RuntimeTurnState,
  message: VisibleMessage,
  evidence: Partial<RawEventLogRecordInput>,
): Promise<ConversationLogRecord> {
  const rawEvent = state.options.logStore.prepareRawEvent(
    {
      ...state.identity,
      kind: 'visible_message_committed',
      eventType: state.event.type,
      visibleMessageIds: [message.id],
      visibleMessage: message,
      committedAt: state.options.committedAt ?? state.options.event.createdAt,
      payloadSummary: state.payloadSummary,
      ...evidence,
    },
    state.options.session.character,
  );
  const record = conversationMessageForRawEvent(rawEvent);

  if (record === undefined) {
    throw new TypeError('Visible message commit lost its message.');
  }

  appendCommittedMessage(state.options.session, message);

  if (message.role === 'character') {
    await emitProgress(state, {kind: 'visible_reply', text: message.text});
  }

  // Evidence bookkeeping describes the log, so it follows the write: a
  // terminal event must never reference a record that failed to land.
  state.options.logStore.persistPreparedRawEvent(
    rawEvent,
    state.options.session.character,
  );
  state.rawEventLogRecords.push(rawEvent);
  state.committedVisibleMessages.push(record);
  return record;
}

export function appendToolCallStarted(
  state: RuntimeTurnState,
  optionsForTool: {
    readonly callId: string;
    readonly round: number;
    readonly call: RuntimePluginToolCall;
    readonly roleModelIOSnapshot: RoleModelIOSnapshot;
    readonly parsedRoleModelDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  },
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
    payloadSummary: state.payloadSummary,
  });
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
  },
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
    payloadSummary: state.payloadSummary,
  });
  state.finishedToolCallIds.push(optionsForTool.callId);
}

export async function completeRuntimeTurn(
  options: CompleteRuntimeTurnOptions,
): Promise<LocalRuntimeUserMessageCompletedResult> {
  const {state} = options;
  const runtimeConfigEffects = runtimeConfigEffectsForCompletedTurn(options);

  assertRuntimeConfigEffectsCanCommit({
    state,
    pluginHost: options.pluginHost,
    effects: runtimeConfigEffects,
  });

  const terminalPluginEvidence = Object.freeze([
    ...options.roleModelPluginEvidence,
    ...options.preCommitHealthResult.evidence,
  ]);
  const terminalAppend = appendCompletedTerminalRawEvent({
    ...options,
    terminalPluginEvidence,
    runtimeConfigEffects,
  });
  const durability = {
    postCommitFailures:
      terminalAppend.terminalAppendFailure === undefined
        ? []
        : [terminalAppend.terminalAppendFailure],
  };
  const configEffectEvidence = reconcileCompletedRuntimeConfigEffects({
    pluginHost: options.pluginHost,
    effects: runtimeConfigEffects,
    postCommitFailures: durability.postCommitFailures,
  });

  await recordAfterTurnCommitted(
    options,
    durability.postCommitFailures,
    configEffectEvidence,
    runtimeConfigEffects,
  );

  return Object.freeze({
    status: 'completed',
    event: state.event,
    conversationMessages: Object.freeze([...state.committedVisibleMessages]),
    rawEvent: terminalAppend.rawEvent,
    rawEventLogRecords: Object.freeze([...state.rawEventLogRecords]),
    ...(durability.postCommitFailures.length === 0
      ? {}
      : {
          postCommitFailures: Object.freeze(durability.postCommitFailures),
        }),
  } satisfies LocalRuntimeUserMessageCompletedResult);
}

function appendCompletedTerminalRawEvent(
  options: CompleteRuntimeTurnOptions & {
    readonly terminalPluginEvidence: readonly RuntimePluginEvidenceSnapshot[];
    readonly runtimeConfigEffects: readonly PreparedRuntimePluginConfigEffect[];
  },
): {
  readonly rawEvent: RawEventLogRecord;
  readonly terminalAppendFailure?: string;
} {
  const {state} = options;
  const terminalRawEventInput = createTerminalRawEventInput(options);

  try {
    const rawEvent = appendRawEvent(state, terminalRawEventInput);

    state.terminalRawEventMayBeDurable = true;
    return {rawEvent};
  } catch (error: unknown) {
    return recoverCompletedTerminalRawEvent(state, error);
  }
}

function createTerminalRawEventInput(
  options: CompleteRuntimeTurnOptions & {
    readonly terminalPluginEvidence: readonly RuntimePluginEvidenceSnapshot[];
    readonly runtimeConfigEffects: readonly PreparedRuntimePluginConfigEffect[];
  },
): RawEventLogRecordInput {
  const {state} = options;
  // Commit validation describes the terminal decision, not the turn's
  // message history: a terminal round carrying only non-committed text
  // has no accepted reply even when earlier rounds committed one.
  const terminalVisibleReplyText = executionVisibleReplyTexts(
    options.roleModelResult.decision,
  ).at(-1);

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
    ...(options.runtimeConfigEffects.length === 0
      ? {}
      : {runtimeConfigEffects: options.runtimeConfigEffects}),
    commitValidation: createRoleModelCommitValidationSnapshot({
      ...state.identity,
      sessionId: options.decisionContext.sessionId,
      result: {
        status: 'accepted',
        ...(terminalVisibleReplyText === undefined
          ? {}
          : {
              acceptedVisibleReplyText: normalizeCharacterAgentReply({
                text: terminalVisibleReplyText,
              }).text,
            }),
      },
    }),
    ...runtimePluginEvidenceOption(options.terminalPluginEvidence),
    ...runtimePluginTurnEvidenceOption({
      identity: state.identity,
      pluginHost: options.pluginHost,
      contextItems: options.contextItems,
      toolInvocations: options.roleModelPluginToolInvocations,
      evidence: options.terminalPluginEvidence,
      health: options.preCommitHealthResult.snapshots,
    }),
  } satisfies RawEventLogRecordInput;
}

function recoverCompletedTerminalRawEvent(
  state: RuntimeTurnState,
  error: unknown,
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
      state.identity,
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
    terminalAppendFailure: runtimePostCommitFailureMessage(error),
  };
}

async function recordAfterTurnCommitted(
  options: CompleteRuntimeTurnOptions,
  postCommitFailures: string[],
  configEffectEvidence: readonly RuntimePluginEvidenceSnapshot[],
  runtimeConfigEffects: readonly PreparedRuntimePluginConfigEffect[],
): Promise<void> {
  const {state} = options;
  let afterCommitResult:
    | {
        readonly status: 'completed' | 'completed_with_failures';
        readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
      }
    | undefined;

  try {
    const afterCommitPluginContext =
      createRuntimePluginAfterTurnCommittedContext({
        ...state.identity,
        sessionId: options.decisionContext.sessionId,
        eventType: state.event.type,
        currentUserMessage: state.event.payload.currentUserMessage,
        character: options.decisionContext.characterSnapshot,
        committedAt: state.options.committedAt ?? state.options.event.createdAt,
        visibleMessages: state.committedVisibleMessages,
      });
    afterCommitResult = await options.pluginHost.afterTurnCommitted(
      afterCommitPluginContext,
    );
  } catch (error: unknown) {
    // The completed turn is already durable; follow-up work cannot change the
    // terminal decision or append a contradictory rejection.
    postCommitFailures.push(runtimePostCommitFailureMessage(error));
  }

  // Live reloads run only after the committing turn's own after-commit
  // hooks, so the instance that served this turn finalizes its state and
  // the swapped instance starts serving strictly at the next turn.
  const configReload = await applyCompletedRuntimeConfigReloads({
    pluginHost: options.pluginHost,
    effects: runtimeConfigEffects,
    reconcileEvidence: configEffectEvidence,
  });

  postCommitFailures.push(...configReload.failures);

  const evidence = Object.freeze([
    ...(afterCommitResult?.evidence ?? []),
    ...configEffectEvidence,
    ...configReload.evidence,
  ]);
  const status =
    configReload.failures.length > 0
      ? 'completed_with_failures'
      : (afterCommitResult?.status ??
        (configEffectEvidence.length === 0
          ? undefined
          : 'completed_with_failures'));

  if (
    status === undefined ||
    !shouldRecordAfterTurnCommittedEvent({status, evidence})
  ) {
    return;
  }

  try {
    appendRawEvent(state, {
      ...state.identity,
      kind: 'after_turn_committed',
      eventType: state.event.type,
      status,
      ...visibleMessageIdsForTurnOption(state.committedVisibleMessages),
      toolCallIds: Object.freeze([...state.finishedToolCallIds]),
      payloadSummary: state.payloadSummary,
      ...runtimePluginEvidenceOption(evidence),
    });
  } catch (error: unknown) {
    postCommitFailures.push(runtimePostCommitFailureMessage(error));
  }
}

export function visibleMessageIdsForTurnOption(
  messages: readonly ConversationLogRecord[],
): {readonly visibleMessageIds?: readonly string[]} {
  if (messages.length === 0) {
    return {};
  }

  return {
    visibleMessageIds: Object.freeze(messages.map(message => message.id)),
  };
}

function pluginStoreRevisionOption(result: RuntimePluginToolCallResult): {
  readonly pluginStoreRevision?: number;
} {
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

  return {pluginStoreRevision: revision};
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
