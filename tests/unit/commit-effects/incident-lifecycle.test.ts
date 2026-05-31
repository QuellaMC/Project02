import { describe, expect, it } from 'vitest';

import { runStagedCommitTransaction } from '../../../src/commit-effects/incident-lifecycle.ts';
import {
  InMemoryRawEventLog,
  buildRawLogEntry,
  type RawEventLogEntry
} from '../../../src/runtime/logging.ts';

type FinalizeRequest = {
  trace_id: string;
  event_id: string;
  event_type: 'USER_MESSAGE';
  committed_log_entry: RawEventLogEntry;
};

class TestTransactionError extends Error {
  readonly code: string;

  constructor(message: string, { code }: { code: string }) {
    super(message);
    this.name = 'TestTransactionError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function committedEntry(): RawEventLogEntry {
  return buildRawLogEntry({
    trace_id: 'trace-helper',
    event_id: 'event-helper',
    kind: 'life_incident_completed',
    data: { source_event: { event_id: 'event-helper' } },
    idGenerator: (kind) => `${kind}-1`,
    clock: () => new Date('2026-05-31T09:00:00Z')
  });
}

function finalizeRequest(entry = committedEntry()): FinalizeRequest {
  return {
    trace_id: 'trace-helper',
    event_id: 'event-helper',
    event_type: 'USER_MESSAGE',
    committed_log_entry: entry
  };
}

describe('staged commit transaction helper', () => {
  it('validates, confirms visibility, and runs post-visible hooks with cloned requests', () => {
    const rawLog = new InMemoryRawEventLog();
    const entry = committedEntry();
    const request = finalizeRequest(entry);
    const finalizedRequests: FinalizeRequest[] = [];
    const completedRequests: FinalizeRequest[] = [];

    const result = runStagedCommitTransaction({
      rawEventLog: rawLog,
      committedLogEntry: entry,
      finalizeRequest: request,
      finalize: (candidateRequest) => {
        finalizedRequests.push(candidateRequest);
        rawLog.exposeCommittedSuccessEntry(candidateRequest.committed_log_entry);
        return {
          schema_version: '0.1',
          trace_id: candidateRequest.trace_id,
          event_id: candidateRequest.event_id,
          event_type: candidateRequest.event_type,
          committed_log_entry_id: candidateRequest.committed_log_entry.log_id
        };
      },
      validateFinalizeResult: (candidateResult) => candidateResult,
      completeAfterLogVisible: (candidateRequest) => {
        completedRequests.push(candidateRequest);
      },
      isTransactionError: (error): error is TestTransactionError =>
        error instanceof TestTransactionError,
      makeMalformedFinalizeError: (message) =>
        new TestTransactionError(message, { code: 'malformed_finalize_result' }),
      makeFinalizeRejectedError: (message) =>
        new TestTransactionError(message, { code: 'finalize_rejected' })
    });

    request.committed_log_entry.data['mutated_after_commit'] = true;

    expect(result).toMatchObject({ committed_log_entry_id: 'log-1' });
    expect(finalizedRequests).toHaveLength(1);
    expect(completedRequests).toHaveLength(1);
    expect(finalizedRequests[0]).not.toBe(request);
    expect(completedRequests[0]).not.toBe(request);
    expect(rawLog.query({ trace_id: 'trace-helper' }).entries.map((log) => log.kind)).toEqual([
      'life_incident_completed'
    ]);
    expect(
      rawLog.query({ trace_id: 'trace-helper' }).entries[0]?.data
    ).not.toHaveProperty('mutated_after_commit');
  });

  it('discards staged success visibility before rethrowing malformed finalize results', () => {
    const rawLog = new InMemoryRawEventLog();
    const entry = committedEntry();
    const request = finalizeRequest(entry);
    const discardedRequests: FinalizeRequest[] = [];

    expect(() => {
      runStagedCommitTransaction({
        rawEventLog: rawLog,
        committedLogEntry: entry,
        finalizeRequest: request,
        finalize: (candidateRequest) => {
          rawLog.exposeCommittedSuccessEntry(candidateRequest.committed_log_entry);
          return {
            schema_version: '0.1',
            trace_id: candidateRequest.trace_id,
            event_id: candidateRequest.event_id,
            event_type: candidateRequest.event_type,
            committed_log_entry_id: 'wrong-log-id'
          };
        },
        validateFinalizeResult: () => {
          throw new TestTransactionError('log id mismatch', {
            code: 'malformed_finalize_result'
          });
        },
        discardAfterLogNotVisible: (candidateRequest) => {
          discardedRequests.push(candidateRequest);
        },
        isTransactionError: (error): error is TestTransactionError =>
          error instanceof TestTransactionError,
        makeMalformedFinalizeError: (message) =>
          new TestTransactionError(message, { code: 'malformed_finalize_result' }),
        makeFinalizeRejectedError: (message) =>
          new TestTransactionError(message, { code: 'finalize_rejected' })
      });
    }).toThrow('log id mismatch');

    expect(discardedRequests).toHaveLength(1);
    expect(rawLog.query({ trace_id: 'trace-helper' }).entries).toEqual([]);
  });
});
