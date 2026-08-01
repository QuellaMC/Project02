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
  readonly name: 'local' | 'nvidia';
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
    ...traceProviderSummaryOption(rawEvent, rawEvents),
    ...traceToolCallSummaryOption(rawEvent, rawEvents),
    ...(error === undefined ? {} : {error}),
  } satisfies ChatTraceSummary);
}

export function traceProviderSummaryOption(
  rawEvent: RawEventLogRecord | undefined,
  rawEvents: readonly RawEventLogRecord[] | undefined,
): {readonly provider?: ChatTraceProviderSummary} {
  const providerMetadata =
    rawEvent?.roleModelIOSnapshot?.providerMetadata ??
    [...(rawEvents ?? [])]
      .reverse()
      .find(event => event.roleModelIOSnapshot?.providerMetadata !== undefined)
      ?.roleModelIOSnapshot?.providerMetadata;

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

export function traceToolCallSummaryOption(
  terminalRawEvent: RawEventLogRecord | undefined,
  rawEvents: readonly RawEventLogRecord[] | undefined,
): {
  readonly requestedToolCalls?: readonly string[];
  readonly executedToolCalls?: readonly string[];
  readonly terminalToolCalls?: readonly string[];
} {
  const turnRawEvents = rawEvents ?? [];
  if (!hasTraceToolCallEvidence(terminalRawEvent, turnRawEvents)) {
    return {};
  }

  const requestedToolCalls = requestedToolCallNames(turnRawEvents);
  const executedToolCalls = executedToolCallNames(turnRawEvents);
  const terminalDecision = terminalDecisionEvidenceRawEvent(
    terminalRawEvent,
    turnRawEvents,
  )?.parsedRoleModelDecisionSnapshot?.result;
  const terminalToolCalls =
    terminalDecision?.status === 'accepted'
      ? terminalDecision.decision.toolCalls.map(call => call.name)
      : [];

  if (terminalDecision?.status === 'rejected') {
    requestedToolCalls.push(...(terminalDecision.requestedToolNames ?? []));
  }

  requestedToolCalls.push(...terminalToolCalls);

  return {
    requestedToolCalls: Object.freeze(requestedToolCalls),
    executedToolCalls: Object.freeze(executedToolCalls),
    terminalToolCalls: Object.freeze(terminalToolCalls),
  };
}

export function hasTraceToolCallEvidence(
  terminalRawEvent: RawEventLogRecord | undefined,
  turnRawEvents: readonly RawEventLogRecord[],
): boolean {
  return (
    terminalRawEvent?.parsedRoleModelDecisionSnapshot !== undefined ||
    turnRawEvents.some(
      event =>
        event.parsedRoleModelDecisionSnapshot !== undefined ||
        event.kind === 'tool_call_finished',
    )
  );
}

export function requestedToolCallNames(
  turnRawEvents: readonly RawEventLogRecord[],
): string[] {
  const requestedToolCalls: string[] = [];
  const seenRequestedDecisions = new Set<string>();

  for (const event of turnRawEvents) {
    if (
      event.kind !== 'tool_call_started' &&
      event.kind !== 'visible_message_committed'
    ) {
      continue;
    }

    // The terminal decision's calls are appended once by the summary
    // composer; scanning its commit event here would double-count them.
    if (
      event.kind === 'visible_message_committed' &&
      rawEventDecisionIsTerminal(event)
    ) {
      continue;
    }

    const decisionSnapshot = event.parsedRoleModelDecisionSnapshot;
    const decisionEvidenceKey = requestedDecisionEvidenceKey(event);

    if (
      decisionSnapshot?.result.status !== 'accepted' ||
      decisionEvidenceKey === undefined ||
      seenRequestedDecisions.has(decisionEvidenceKey)
    ) {
      continue;
    }

    seenRequestedDecisions.add(decisionEvidenceKey);
    requestedToolCalls.push(
      ...decisionSnapshot.result.decision.toolCalls.map(call => call.name),
    );
  }

  return requestedToolCalls;
}

export function executedToolCallNames(
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

export function requestedDecisionEvidenceKey(
  event: RawEventLogRecord,
): string | undefined {
  const roleModelIOSnapshot = event.roleModelIOSnapshot;

  if (
    roleModelIOSnapshot === undefined ||
    event.parsedRoleModelDecisionSnapshot === undefined
  ) {
    return undefined;
  }

  // Every executable round appends at least one observation before the next
  // model invocation. That makes the prior-observation count plus raw output a
  // stable key shared by the interim event and every tool-start event for the
  // same decision, including after durable decoding.
  return `${String(
    roleModelIOSnapshot.inputEnvelope.toolObservations.length,
  )}:${roleModelIOSnapshot.rawOutputText}`;
}

export function terminalDecisionEvidenceRawEvent(
  terminalRawEvent: RawEventLogRecord | undefined,
  turnRawEvents: readonly RawEventLogRecord[],
): RawEventLogRecord | undefined {
  if (terminalRawEvent !== undefined) {
    return terminalRawEvent;
  }

  const reverseEvents = [...turnRawEvents].reverse();
  const persistedTerminalEvent = reverseEvents.find(
    event =>
      (event.kind === 'runtime_turn_completed' ||
        event.kind === 'runtime_turn_rejected') &&
      event.parsedRoleModelDecisionSnapshot !== undefined,
  );

  // Commit events exist for every visible message. Only one carrying a
  // decision with no executable tool calls is the terminal decision — the
  // same rule the loop uses to stop; interim commits carry executable
  // calls and user-message commits carry no decision at all.
  return (
    persistedTerminalEvent ??
    reverseEvents.find(
      event =>
        event.kind === 'visible_message_committed' &&
        rawEventDecisionIsTerminal(event),
    )
  );
}

function rawEventDecisionIsTerminal(event: RawEventLogRecord): boolean {
  const result = event.parsedRoleModelDecisionSnapshot?.result;

  return (
    result?.status === 'accepted' &&
    result.decision.toolCalls.every(call => call.name === 'visible_reply')
  );
}
