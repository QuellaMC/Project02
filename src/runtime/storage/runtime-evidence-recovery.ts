import {
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionPaths
} from './layout-contract.ts';
import { encodeConversationLogRecord } from './conversation-codec.ts';
import {
  decodeRawEventLogRecord,
  encodeRawEventLogRecord
} from './raw-event-codec.ts';
import {
  decodeRuntimeTraceEntry,
  encodeRuntimeTraceEntry
} from './trace-codec.ts';
import {
  isTerminalRawEventLogRecord,
  type RuntimeSessionEvidenceSnapshot
} from '../log.ts';
import { runtimeEventIdentityKey } from '../event.ts';
import { atomicReplaceFileSync } from './atomic-file.ts';
import type { DurableRuntimeSessionEvidence } from './runtime-evidence-contract.ts';
import {
  assertDurableRuntimeSessionEvidence,
  deriveTerminalRawTraceEvidence,
  reconcileTerminalRawTraceEvidence,
  startedRawEventIdentitiesWithoutTerminal
} from './runtime-evidence-validation.ts';

export function createRuntimeSessionEvidenceSnapshot(
  stored: DurableRuntimeSessionEvidence
): RuntimeSessionEvidenceSnapshot {
  const derivedTraceEntries = deriveTerminalRawTraceEvidence(stored);

  return Object.freeze({
    stored: Object.freeze({
      traceEntries: Object.freeze([...stored.traceEntries]),
      rawEvents: Object.freeze([...stored.rawEvents]),
      conversationMessages: Object.freeze([...stored.conversationMessages])
    }),
    derived: Object.freeze({
      traceEntries: derivedTraceEntries
    })
  } satisfies RuntimeSessionEvidenceSnapshot);
}

export function recoverAbandonedRuntimeWriterEvidence(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly evidence: DurableRuntimeSessionEvidence;
}): DurableRuntimeSessionEvidence | undefined {
  const openIdentities = startedRawEventIdentitiesWithoutTerminal(
    options.evidence.rawEvents
  );

  if (openIdentities.size === 0) {
    return recoverLatestTerminalRawTraceEvidence(options);
  }

  if (openIdentities.size !== 1) {
    throwPriorWriterPartialWrite(options.paths);
  }

  const identityKey = openIdentities.values().next().value;

  if (typeof identityKey !== 'string') {
    throwPriorWriterPartialWrite(options.paths);
  }

  const evidenceWithDerivedTrace = evidenceWithDerivedTerminalTrace(
    options.evidence
  );

  try {
    assertDurableRuntimeSessionEvidence({
      paths: options.paths,
      evidence: evidenceWithDerivedTrace,
      mode: 'appendConversation'
    });
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'partial_write',
      `Local runtime evidence cannot safely recover the abandoned writer for session "${options.paths.sessionId}".`,
      { cause: error }
    );
  }

  const openRawEvents = options.evidence.rawEvents.filter(
    (record) => runtimeEventIdentityKey(record) === identityKey
  );
  const finalOpenRawEvent = openRawEvents.at(-1);

  if (
    finalOpenRawEvent === undefined ||
    openRawEvents.some((record) => (record.visibleMessageIds?.length ?? 0) > 0)
  ) {
    throwPriorWriterPartialWrite(options.paths);
  }

  const rejectedTerminal = decodeRawEventLogRecord(
    encodeRawEventLogRecord({
      eventId: finalOpenRawEvent.eventId,
      traceId: finalOpenRawEvent.traceId,
      createdAt: finalOpenRawEvent.createdAt,
      kind: 'runtime_turn_rejected',
      eventType: finalOpenRawEvent.eventType,
      status: 'rejected',
      reason: 'writer_process_terminated'
    })
  );
  const storedTraceSteps = new Set(
    options.evidence.traceEntries
      .filter((entry) => runtimeEventIdentityKey(entry) === identityKey)
      .map((entry) => entry.step)
  );
  const recoveredTraceEntries = [...options.evidence.traceEntries];

  for (const step of [
    'raw_event_log_appended',
    'runtime_turn_rejected'
  ] as const) {
    if (storedTraceSteps.has(step)) {
      continue;
    }

    recoveredTraceEntries.push(
      decodeRuntimeTraceEntry(
        encodeRuntimeTraceEntry({
          eventId: rejectedTerminal.eventId,
          traceId: rejectedTerminal.traceId,
          createdAt: rejectedTerminal.createdAt,
          step
        })
      )
    );
  }

  const recovered = Object.freeze({
    traceEntries: Object.freeze(recoveredTraceEntries),
    rawEvents: Object.freeze([...options.evidence.rawEvents, rejectedTerminal]),
    conversationMessages: Object.freeze(
      options.evidence.conversationMessages.filter(
        (message) => runtimeEventIdentityKey(message) !== identityKey
      )
    )
  } satisfies DurableRuntimeSessionEvidence);

  assertDurableRuntimeSessionEvidence({
    paths: options.paths,
    evidence: evidenceWithDerivedTerminalTrace(recovered),
    mode: 'public'
  });

  writeJsonLines({
    filePath: options.paths.conversationPath,
    lines: recovered.conversationMessages.map(encodeConversationLogRecord)
  });
  writeJsonLines({
    filePath: options.paths.rawEventsPath,
    lines: recovered.rawEvents.map(encodeRawEventLogRecord)
  });
  writeJsonLines({
    filePath: options.paths.tracePath,
    lines: recovered.traceEntries.map(encodeRuntimeTraceEntry)
  });

  return recovered;
}

function recoverLatestTerminalRawTraceEvidence(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly evidence: DurableRuntimeSessionEvidence;
}): DurableRuntimeSessionEvidence | undefined {
  const missingTraceEntries = deriveTerminalRawTraceEvidence(options.evidence);

  if (missingTraceEntries.length === 0) {
    return undefined;
  }

  const latestTerminalRawEvent = options.evidence.rawEvents
    .filter(isTerminalRawEventLogRecord)
    .at(-1);

  if (
    latestTerminalRawEvent === undefined ||
    missingTraceEntries.some(
      (entry) =>
        entry.eventId !== latestTerminalRawEvent.eventId ||
        entry.traceId !== latestTerminalRawEvent.traceId ||
        entry.createdAt !== latestTerminalRawEvent.createdAt
    )
  ) {
    throwPriorWriterPartialWrite(options.paths);
  }

  const recovered = reconcileTerminalRawTraceEvidence(options.evidence);

  try {
    assertDurableRuntimeSessionEvidence({
      paths: options.paths,
      evidence: recovered,
      mode: 'public'
    });
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'partial_write',
      `Local runtime evidence cannot safely recover terminal trace evidence for session "${options.paths.sessionId}".`,
      { cause: error }
    );
  }

  writeJsonLines({
    filePath: options.paths.tracePath,
    lines: recovered.traceEntries.map(encodeRuntimeTraceEntry)
  });

  return recovered;
}

function evidenceWithDerivedTerminalTrace(
  evidence: DurableRuntimeSessionEvidence
): DurableRuntimeSessionEvidence {
  return Object.freeze({
    traceEntries: Object.freeze([
      ...evidence.traceEntries,
      ...deriveTerminalRawTraceEvidence(evidence)
    ]),
    rawEvents: evidence.rawEvents,
    conversationMessages: evidence.conversationMessages
  });
}

export function throwPriorWriterPartialWrite(paths: LocalRuntimeSessionPaths): never {
  throw new LocalRuntimeStorageContractError(
    'partial_write',
    `Local runtime evidence cannot safely recover the abandoned writer for session "${paths.sessionId}".`
  );
}

function writeJsonLines(options: {
  readonly filePath: string;
  readonly lines: readonly string[];
}): void {
  try {
    atomicReplaceFileSync({
      targetPath: options.filePath,
      content: options.lines.map((line) => `${line}\n`).join(''),
      mode: 0o600
    });
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not rewrite local runtime log file: ${options.filePath}.`,
      { cause: error }
    );
  }
}

export function removeConversationLogRecords(options: {
  readonly paths: LocalRuntimeSessionPaths;
  readonly evidence: DurableRuntimeSessionEvidence;
  readonly messageIds: readonly string[];
}): DurableRuntimeSessionEvidence | undefined {
  const ids = new Set(options.messageIds);

  if (ids.size === 0) {
    return undefined;
  }

  const conversationMessages = options.evidence.conversationMessages.filter(
    (message) => !ids.has(message.id)
  );

  if (
    conversationMessages.length ===
    options.evidence.conversationMessages.length
  ) {
    return undefined;
  }

  const updatedEvidence = Object.freeze({
    traceEntries: options.evidence.traceEntries,
    rawEvents: options.evidence.rawEvents,
    conversationMessages: Object.freeze(conversationMessages)
  } satisfies DurableRuntimeSessionEvidence);

  assertDurableRuntimeSessionEvidence({
    paths: options.paths,
    evidence: updatedEvidence,
    mode: 'appendConversation'
  });

  writeJsonLines({
    filePath: options.paths.conversationPath,
    lines: conversationMessages.map(encodeConversationLogRecord)
  });

  return updatedEvidence;
}
