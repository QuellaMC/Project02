import {visibleReplyToolCalls} from '../../role-model/index.ts';
import type {
  RawEventLogRecord,
  RuntimeTraceEntry,
  RuntimeTraceStepName,
  RuntimeTurnStatus,
} from './records.ts';

export type ChatTraceSummary = {
  readonly eventId: string;
  readonly traceId: string;
  readonly status: RuntimeTurnStatus;
  readonly steps: readonly RuntimeTraceStepName[];
  readonly provider?: ChatTraceProviderSummary;
  readonly requestedToolCalls?: readonly string[];
  readonly executedToolCalls?: readonly string[];
  readonly terminalToolCalls?: readonly string[];
  readonly error?: string;
};

export type ChatTraceProviderSummary = {
  readonly name: 'nvidia';
  readonly model?: string;
  readonly responseStatus?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

export type TraceIdentity = {
  readonly eventId: string;
  readonly traceId: string;
};

export function sameTraceIdentity(
  evidence: TraceIdentity,
  identity: TraceIdentity,
): boolean {
  return (
    evidence.eventId === identity.eventId &&
    evidence.traceId === identity.traceId
  );
}

export function createTraceSummary(
  identity: TraceIdentity,
  status: RuntimeTurnStatus,
  entries: readonly RuntimeTraceEntry[],
  error?: string,
  rawEvent?: RawEventLogRecord,
  rawEvents?: readonly RawEventLogRecord[],
): ChatTraceSummary {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    status,
    steps: Object.freeze(entries.map(entry => entry.step)),
    ...traceProviderSummaryOption(rawEvents),
    ...traceToolCallSummaryOption(rawEvent, rawEvents),
    ...(error === undefined ? {} : {error}),
  } satisfies ChatTraceSummary);
}

function traceProviderSummaryOption(
  rawEvents: readonly RawEventLogRecord[] | undefined,
): {readonly provider?: ChatTraceProviderSummary} {
  const providerMetadata = modelRounds(rawEvents)
    .map(round => round.roleModelIOSnapshot?.providerMetadata)
    .findLast(metadata => metadata !== undefined);

  if (providerMetadata === undefined) {
    return {};
  }

  return {
    provider: Object.freeze({
      name: providerMetadata.provider,
      ...(providerMetadata.model === undefined
        ? {}
        : {model: providerMetadata.model}),
      ...(providerMetadata.response?.status === undefined
        ? {}
        : {responseStatus: providerMetadata.response.status}),
      ...(providerMetadata.error === undefined
        ? {}
        : {
            errorCode: providerMetadata.error.code,
            errorMessage: providerMetadata.error.message,
          }),
    } satisfies ChatTraceProviderSummary),
  };
}

/**
 * Requested: every call an accepted round asked for, in round order.
 * Executed: every call the host ran. Terminal: what the round the turn
 * ended on asked for.
 */
function traceToolCallSummaryOption(
  terminalRawEvent: RawEventLogRecord | undefined,
  rawEvents: readonly RawEventLogRecord[] | undefined,
): {
  readonly requestedToolCalls?: readonly string[];
  readonly executedToolCalls?: readonly string[];
  readonly terminalToolCalls?: readonly string[];
} {
  const turnRawEvents = rawEvents ?? [];
  const rounds = modelRounds(turnRawEvents);

  if (
    rounds.length === 0 &&
    !turnRawEvents.some(event => event.kind === 'tool_call_finished')
  ) {
    return {};
  }

  const terminal = terminalRound(terminalRawEvent, rounds);

  return {
    requestedToolCalls: Object.freeze(rounds.flatMap(requestedToolCallNames)),
    executedToolCalls: Object.freeze(executedToolCallNames(turnRawEvents)),
    terminalToolCalls: Object.freeze(
      terminal === undefined ? [] : requestedToolCallNames(terminal),
    ),
  };
}

/**
 * The terminal record names the round the turn ended on. Without one the
 * turn was cut short, and its last round ended it only if the loop would
 * have stopped there — a decision with no executable calls.
 */
function terminalRound(
  terminalRawEvent: RawEventLogRecord | undefined,
  rounds: readonly RawEventLogRecord[],
): RawEventLogRecord | undefined {
  if (terminalRawEvent?.round !== undefined) {
    return rounds.find(round => round.round === terminalRawEvent.round);
  }

  const lastRound = rounds.at(-1);
  const result = lastRound?.parsedRoleModelDecisionSnapshot?.result;

  return result?.status === 'accepted' &&
    visibleReplyToolCalls(result.decision).length ===
      result.decision.toolCalls.length
    ? lastRound
    : undefined;
}

function modelRounds(
  rawEvents: readonly RawEventLogRecord[] | undefined,
): readonly RawEventLogRecord[] {
  return (rawEvents ?? []).filter(event => event.kind === 'role_model_round');
}

function requestedToolCallNames(round: RawEventLogRecord): readonly string[] {
  const result = round.parsedRoleModelDecisionSnapshot?.result;

  return result?.status === 'accepted'
    ? result.decision.toolCalls.map(call => call.name)
    : [];
}

function executedToolCallNames(
  turnRawEvents: readonly RawEventLogRecord[],
): string[] {
  const executedToolCalls: string[] = [];
  const seenExecutedToolCallIds = new Set<string>();

  for (const event of turnRawEvents) {
    if (
      event.kind !== 'tool_call_finished' ||
      event.dispatchedToHost !== true ||
      event.toolName === undefined
    ) {
      continue;
    }

    if (
      event.toolCallId !== undefined &&
      seenExecutedToolCallIds.has(event.toolCallId)
    ) {
      continue;
    }

    if (event.toolCallId !== undefined) {
      seenExecutedToolCallIds.add(event.toolCallId);
    }

    executedToolCalls.push(event.toolName);
  }

  return executedToolCalls;
}
