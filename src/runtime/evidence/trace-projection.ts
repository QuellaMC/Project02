import {runtimeEventIdentityKey} from '../../core/index.ts';
import type {
  RawEventLogRecord,
  RawEventLogRecordKind,
  RuntimeTraceEntry,
  RuntimeTraceStepName,
} from './records.ts';
import {isTerminalRawEventLogRecordKind} from './records.ts';

const traceStepByRawEventKind: Readonly<
  Partial<Record<RawEventLogRecordKind, RuntimeTraceStepName>>
> = Object.freeze({
  runtime_event_received: 'runtime_event_received',
  runtime_event_normalized: 'runtime_event_normalized',
  plugin_before_role_model_call_rejected:
    'plugin_before_role_model_call_rejected',
  tool_call_started: 'tool_call_started',
  tool_call_finished: 'tool_call_finished',
  visible_message_committed: 'visible_message_committed',
  input_validation_rejected: 'input_validation_rejected',
  character_reply_rejected: 'character_reply_rejected',
  commit_validation_rejected: 'commit_validation_rejected',
  runtime_turn_completed: 'runtime_turn_completed',
  runtime_turn_rejected: 'runtime_turn_rejected',
});

export function deriveRuntimeTraceEntries(
  rawEvents: readonly RawEventLogRecord[],
): readonly RuntimeTraceEntry[] {
  const entries: RuntimeTraceEntry[] = [];
  const startedTurns = new Set<string>();

  for (const rawEvent of rawEvents) {
    const step = traceStepByRawEventKind[rawEvent.kind];

    if (step === undefined) {
      continue;
    }

    // The terminal record is the last one appended, so the marker that
    // says the log was written belongs immediately before it.
    if (isTerminalRawEventLogRecordKind(rawEvent.kind)) {
      entries.push(traceEntryFor(rawEvent, 'raw_event_log_appended'));
    }

    entries.push(traceEntryFor(rawEvent, step));

    if (rawEvent.kind === 'runtime_event_normalized') {
      const key = runtimeEventIdentityKey(rawEvent);

      if (!startedTurns.has(key)) {
        startedTurns.add(key);
        entries.push(traceEntryFor(rawEvent, 'runtime_turn_started'));
      }
    }
  }

  return Object.freeze(entries);
}

function traceEntryFor(
  rawEvent: RawEventLogRecord,
  step: RuntimeTraceStepName,
): RuntimeTraceEntry {
  return Object.freeze({
    eventId: rawEvent.eventId,
    traceId: rawEvent.traceId,
    createdAt: rawEvent.createdAt,
    step,
  } satisfies RuntimeTraceEntry);
}
