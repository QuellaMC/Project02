import {
  createUserMessageRuntimeEvent,
  RuntimeEventInputError,
  type RuntimeEventIdentity,
  type UserMessageRuntimeEvent
} from '../event.ts';
import type {
  RawEventLogPayloadSummary,
  RuntimeTraceEntry,
  RuntimeTraceStepName
} from '../log.ts';
import type {
  LocalRuntimeUserMessageInputRejectedResult,
  NormalizeUserMessageRuntimeEventResult,
  RecordLocalUserMessageInputRejectionOptions,
  RunLocalUserMessageEventOptions,
  RuntimeTurnState
} from './contracts.ts';

export function recordLocalUserMessageInputRejection(
  options: RecordLocalUserMessageInputRejectionOptions
): LocalRuntimeUserMessageInputRejectedResult {
  const identity = freezeRuntimeEventIdentity(options.identity);
  const payloadSummary = createRawInputPayloadSummary(options.rawInput);
  const traceEntries: RuntimeTraceEntry[] = [];

  function appendTrace(step: RuntimeTraceStepName): RuntimeTraceEntry {
    const traceEntry = options.logStore.appendTrace({
      ...identity,
      step
    });

    traceEntries.push(traceEntry);
    return traceEntry;
  }

  appendTrace('runtime_event_received');
  options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE',
    ...(payloadSummary === undefined ? {} : { payloadSummary })
  });
  appendTrace('input_validation_rejected');
  options.logStore.appendRawEvent({
    ...identity,
    kind: 'input_validation_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: options.message,
    ...(payloadSummary === undefined ? {} : { payloadSummary })
  });

  const rawEvent = options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_turn_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: options.message,
    ...(payloadSummary === undefined ? {} : { payloadSummary })
  });

  appendTrace('raw_event_log_appended');
  appendTrace('runtime_turn_rejected');

  return Object.freeze({
    status: 'rejected',
    identity,
    eventType: 'USER_MESSAGE',
    reason: 'input_validation_rejected',
    message: options.message,
    rawEvent,
    traceEntries: Object.freeze([...traceEntries])
  } satisfies LocalRuntimeUserMessageInputRejectedResult);
}

export function createRuntimeTurnState(
  options: RunLocalUserMessageEventOptions
): RuntimeTurnState {
  const identity = freezeRuntimeEventIdentity({
    eventId: options.event.eventId,
    traceId: options.event.traceId,
    createdAt: options.event.createdAt
  });
  const normalizedEventResult = normalizeUserMessageRuntimeEvent(options.event);
  const event =
    normalizedEventResult.status === 'accepted'
      ? normalizedEventResult.event
      : options.event;
  const payloadSummary = createNormalizedPayloadSummary({
    normalizedCurrentUserMessage: event.payload.currentUserMessage,
    ...(options.rawInput === undefined ? {} : { rawInput: options.rawInput })
  });

  return {
    options,
    traceEntries: [],
    rawEventLogRecords: [],
    identity,
    normalizedEventResult,
    event,
    payloadSummary,
    runtimePluginContextForTurn: undefined,
    runtimePluginHostForTurn: undefined,
    pluginFileStoreTransactionActive: false,
    preparedPluginFileStoreTransaction: undefined,
    terminalRawEventMayBeDurable: false,
    committedVisibleMessages: [],
    startedPluginToolCalls: new Map(),
    finishedToolCallIds: [],
    finishedPluginToolResults: [],
    preparedConfigEffectsByToolCallId: new Map(),
    userConversationMessage: undefined
  } satisfies RuntimeTurnState;
}

function freezeRuntimeEventIdentity(
  identity: RuntimeEventIdentity
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    createdAt: identity.createdAt
  } satisfies RuntimeEventIdentity);
}

function createRawInputPayloadSummary(
  rawInput: string | undefined
): RawEventLogPayloadSummary | undefined {
  if (rawInput === undefined) {
    return undefined;
  }

  return Object.freeze({
    rawInput
  } satisfies RawEventLogPayloadSummary);
}

function createNormalizedPayloadSummary(options: {
  readonly normalizedCurrentUserMessage: string;
  readonly rawInput?: string;
}): RawEventLogPayloadSummary {
  return Object.freeze({
    ...(options.rawInput === undefined ? {} : { rawInput: options.rawInput }),
    normalizedCurrentUserMessage: options.normalizedCurrentUserMessage
  } satisfies RawEventLogPayloadSummary);
}

function normalizeUserMessageRuntimeEvent(
  event: UserMessageRuntimeEvent
): NormalizeUserMessageRuntimeEventResult {
  try {
    return Object.freeze({
      status: 'accepted',
      event: createUserMessageRuntimeEvent(event.payload.currentUserMessage, event)
    } satisfies NormalizeUserMessageRuntimeEventResult);
  } catch (error: unknown) {
    if (error instanceof RuntimeEventInputError) {
      return Object.freeze({
        status: 'rejected',
        message: error.message
      } satisfies NormalizeUserMessageRuntimeEventResult);
    }

    throw error;
  }
}
