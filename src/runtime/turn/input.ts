import {
  createUserMessageRuntimeEvent,
  RuntimeEventInputError,
  type RuntimeEventIdentity,
  type UserMessageRuntimeEvent,
} from '../../core/index.ts';
import type {RawEventLogPayloadSummary} from '../evidence/records.ts';
import type {
  LocalRuntimeUserMessageInputRejectedResult,
  NormalizeUserMessageRuntimeEventResult,
  RecordLocalUserMessageInputRejectionOptions,
  RunLocalUserMessageEventOptions,
  RuntimeTurnState,
} from './contracts.ts';

export function recordLocalUserMessageInputRejection(
  options: RecordLocalUserMessageInputRejectionOptions,
): LocalRuntimeUserMessageInputRejectedResult {
  const identity = freezeRuntimeEventIdentity(options.identity);
  const payloadSummary = createRawInputPayloadSummary(options.rawInput);
  const receivedRawEvent = options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE',
    ...(payloadSummary === undefined ? {} : {payloadSummary}),
  });
  const validationRawEvent = options.logStore.appendRawEvent({
    ...identity,
    kind: 'input_validation_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: options.message,
    ...(payloadSummary === undefined ? {} : {payloadSummary}),
  });
  const rawEvent = options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_turn_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: options.message,
    ...(payloadSummary === undefined ? {} : {payloadSummary}),
  });

  return Object.freeze({
    status: 'rejected',
    identity,
    eventType: 'USER_MESSAGE',
    reason: 'input_validation_rejected',
    message: options.message,
    rawEvent,
    rawEventLogRecords: Object.freeze([
      receivedRawEvent,
      validationRawEvent,
      rawEvent,
    ]),
  } satisfies LocalRuntimeUserMessageInputRejectedResult);
}

export function createRuntimeTurnState(
  options: RunLocalUserMessageEventOptions,
): RuntimeTurnState {
  const identity = freezeRuntimeEventIdentity({
    eventId: options.event.eventId,
    traceId: options.event.traceId,
    createdAt: options.event.createdAt,
  });
  const normalizedEventResult = normalizeUserMessageRuntimeEvent(options.event);
  const event =
    normalizedEventResult.status === 'accepted'
      ? normalizedEventResult.event
      : options.event;
  const payloadSummary = createNormalizedPayloadSummary({
    normalizedCurrentUserMessage: event.payload.currentUserMessage,
    ...(options.rawInput === undefined ? {} : {rawInput: options.rawInput}),
  });

  return {
    options,
    rawEventLogRecords: [],
    identity,
    normalizedEventResult,
    event,
    payloadSummary,
    runtimePluginContextForTurn: undefined,
    terminalRawEventMayBeDurable: false,
    committedVisibleMessages: [],
    finishedToolCallIds: [],
  } satisfies RuntimeTurnState;
}

function freezeRuntimeEventIdentity(
  identity: RuntimeEventIdentity,
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    createdAt: identity.createdAt,
  } satisfies RuntimeEventIdentity);
}

function createRawInputPayloadSummary(
  rawInput: string | undefined,
): RawEventLogPayloadSummary | undefined {
  if (rawInput === undefined) {
    return undefined;
  }

  return Object.freeze({
    rawInput,
  } satisfies RawEventLogPayloadSummary);
}

function createNormalizedPayloadSummary(options: {
  readonly normalizedCurrentUserMessage: string;
  readonly rawInput?: string;
}): RawEventLogPayloadSummary {
  return Object.freeze({
    ...(options.rawInput === undefined ? {} : {rawInput: options.rawInput}),
    normalizedCurrentUserMessage: options.normalizedCurrentUserMessage,
  } satisfies RawEventLogPayloadSummary);
}

function normalizeUserMessageRuntimeEvent(
  event: UserMessageRuntimeEvent,
): NormalizeUserMessageRuntimeEventResult {
  try {
    return Object.freeze({
      status: 'accepted',
      event: createUserMessageRuntimeEvent(
        event.payload.currentUserMessage,
        event,
      ),
    } satisfies NormalizeUserMessageRuntimeEventResult);
  } catch (error: unknown) {
    if (error instanceof RuntimeEventInputError) {
      return Object.freeze({
        status: 'rejected',
        message: error.message,
      } satisfies NormalizeUserMessageRuntimeEventResult);
    }

    throw error;
  }
}
