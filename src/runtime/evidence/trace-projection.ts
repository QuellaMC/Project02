import {runtimeEventIdentityKey} from '../../core/index.ts';
import type {
  RawEventLogRecord,
  RuntimeTraceEntry,
  RuntimeTraceStepName,
} from './records.ts';
import {isTerminalRawEventLogRecordKind} from './records.ts';

export function deriveRuntimeTraceEntries(
  rawEvents: readonly RawEventLogRecord[],
): readonly RuntimeTraceEntry[] {
  const entries: RuntimeTraceEntry[] = [];
  const startedTurns = new Set<string>();

  for (const rawEvent of rawEvents) {
    const step = rawEvent.kind;

    // Post-commit work lands after the turn's terminal step, so it has no
    // place on the turn's trace.
    if (step === 'after_turn_committed') {
      continue;
    }

    // The terminal record is the last one appended, so the marker that
    // says the log was written belongs immediately before it.
    if (isTerminalRawEventLogRecordKind(step)) {
      entries.push(traceEntryFor(rawEvent, 'raw_event_log_appended'));
    }

    entries.push(traceEntryFor(rawEvent, step));

    if (step === 'runtime_event_normalized') {
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
