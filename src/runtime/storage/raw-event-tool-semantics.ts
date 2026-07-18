import type {
  RuntimePluginJsonObject,
  RuntimePluginToolCallResult,
} from '../../plugins/api/index.ts';
import type {RuntimeEventIdentity} from '../../core/index.ts';
import type {RawEventLogRecordKind} from '../evidence/records.ts';
import {throwMalformedRecord} from './codec-primitives.ts';

type RawEventToolSemantics = {
  readonly identity: RuntimeEventIdentity;
  readonly kind: RawEventLogRecordKind;
  readonly toolCallId: string | undefined;
  readonly dispatchedToHost: boolean | undefined;
  readonly toolRound: number | undefined;
  readonly toolName: string | undefined;
  readonly toolPluginId: string | undefined;
  readonly toolInput: RuntimePluginJsonObject | undefined;
  readonly toolResult: RuntimePluginToolCallResult | undefined;
};

export function assertToolRawEventSemantics(
  options: RawEventToolSemantics,
): void {
  if (!isToolRawEvent(options.kind)) {
    assertNonToolRawEventHasNoToolFields(options);
    return;
  }

  assertRequiredToolIdentity(options);

  if (options.kind === 'tool_call_started') {
    assertStartedToolRawEvent(options);
    return;
  }

  assertFinishedToolRawEvent(options);
}

function isToolRawEvent(kind: RawEventLogRecordKind): boolean {
  return kind === 'tool_call_started' || kind === 'tool_call_finished';
}

function assertNonToolRawEventHasNoToolFields(
  options: RawEventToolSemantics,
): void {
  if (
    options.toolCallId !== undefined ||
    options.dispatchedToHost !== undefined ||
    options.toolRound !== undefined ||
    options.toolName !== undefined ||
    options.toolPluginId !== undefined ||
    options.toolInput !== undefined ||
    options.toolResult !== undefined
  ) {
    throwMalformedRecord('toolCallId');
  }
}

function assertRequiredToolIdentity(options: RawEventToolSemantics): void {
  if (
    options.toolCallId === undefined ||
    options.toolRound === undefined ||
    options.toolName === undefined ||
    options.toolPluginId === undefined
  ) {
    throwMalformedRecord('toolCallId');
  }
}

function assertStartedToolRawEvent(options: RawEventToolSemantics): void {
  if (options.dispatchedToHost !== undefined) {
    throwMalformedRecord('dispatchedToHost');
  }

  if (options.toolInput === undefined || options.toolResult !== undefined) {
    throwMalformedRecord('toolInput');
  }
}

function assertFinishedToolRawEvent(options: RawEventToolSemantics): void {
  if (options.toolResult === undefined || options.toolInput !== undefined) {
    throwMalformedRecord('toolResult');
  }

  assertToolResultEvidenceIdentity({
    identity: options.identity,
    pluginId: options.toolPluginId,
    result: options.toolResult,
  });
}

function assertToolResultEvidenceIdentity(options: {
  readonly identity: RuntimeEventIdentity;
  readonly pluginId: string | undefined;
  readonly result: RuntimePluginToolCallResult;
}): void {
  for (const evidence of options.result.evidence) {
    if (
      evidence.eventId !== options.identity.eventId ||
      evidence.traceId !== options.identity.traceId ||
      evidence.createdAt !== options.identity.createdAt ||
      evidence.pluginId !== options.pluginId
    ) {
      throwMalformedRecord('toolResult.evidence');
    }
  }
}
