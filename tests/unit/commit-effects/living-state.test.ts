import { describe, expect, it } from 'vitest';

import {
  LIVING_STATE_PATCH_COMMITTED_STATUS,
  LIVING_STATE_PATCH_FINALIZE_STAGE,
  LIVING_STATE_PATCH_REJECTED_STATUS,
  LIVING_STATE_PATCH_SKIPPED_STATUS,
  LivingStatePatchFinalizerError,
  LivingStatePatchStoreError,
  buildLivingStatePatchCommitRequest,
  buildLivingStatePatchCommittedLogEntry,
  buildLivingStatePatchRejectedLogEntry,
  commitLivingStatePatch,
  type LivingStatePatchCommittedResult,
  type LivingStatePatchFinalizeRequest,
  type LivingStatePatchPrepareRequest,
  type LivingStatePatchRejectedResult
} from '../../../src/commit-effects/living-state.ts';
import {
  InMemoryRawEventLog,
  type IdGenerator,
  type RawEventLogEntry
} from '../../../src/runtime/logging.ts';

function fixedClock(): Date {
  return new Date('2026-05-17T09:00:00.000Z');
}

class SequenceIdGenerator {
  readonly calls: string[] = [];

  generate: IdGenerator = (kind: string): string => {
    this.calls.push(kind);
    return `${kind}-generated-${String(this.calls.length)}`;
  };
}

class RecordingRawEventLog {
  readonly entries: RawEventLogEntry[] = [];

  append(entry: RawEventLogEntry): void {
    this.entries.push(structuredClone(entry));
  }
}

class RecordingLivingStatePatchStore {
  readonly requests: LivingStatePatchPrepareRequest[] = [];
  snapshot: unknown;
  error: LivingStatePatchStoreError | undefined;

  constructor({
    snapshot = committedSnapshot(),
    error
  }: { snapshot?: unknown; error?: LivingStatePatchStoreError } = {}) {
    this.snapshot = structuredClone(snapshot);
    this.error = error;
  }

  prepareLivingStatePatchCommit(request: LivingStatePatchPrepareRequest): unknown {
    this.requests.push(structuredClone(request));
    if (this.error !== undefined) {
      throw this.error;
    }
    return structuredClone(this.snapshot);
  }
}

class RecordingLivingStatePatchFinalizer {
  readonly requests: LivingStatePatchFinalizeRequest[] = [];
  readonly durableStateSnapshots: unknown[] = [];
  readonly durableSuccessLogs: RawEventLogEntry[] = [];
  error: LivingStatePatchFinalizerError | undefined;
  resultOverride: unknown;
  rawLogVisibility: InMemoryRawEventLog | undefined;
  exposeBeforeResultOverride: boolean;

  constructor({
    error,
    resultOverride,
    rawLogVisibility,
    exposeBeforeResultOverride = false
  }: {
    error?: LivingStatePatchFinalizerError;
    resultOverride?: unknown;
    rawLogVisibility?: InMemoryRawEventLog;
    exposeBeforeResultOverride?: boolean;
  } = {}) {
    this.error = error;
    this.resultOverride = structuredClone(resultOverride);
    this.rawLogVisibility = rawLogVisibility;
    this.exposeBeforeResultOverride = exposeBeforeResultOverride;
  }

  finalizeLivingStatePatchCommit(request: LivingStatePatchFinalizeRequest): unknown {
    this.requests.push(structuredClone(request));
    if (this.error !== undefined) {
      throw this.error;
    }
    if (this.resultOverride !== undefined) {
      if (this.exposeBeforeResultOverride && this.rawLogVisibility !== undefined) {
        this.rawLogVisibility.exposeCommittedSuccessEntry(request.committed_log_entry);
      }
      return structuredClone(this.resultOverride);
    }
    if (this.rawLogVisibility !== undefined) {
      this.rawLogVisibility.exposeCommittedSuccessEntry(request.committed_log_entry);
    }
    this.durableStateSnapshots.push(structuredClone(request.committed_snapshot));
    this.durableSuccessLogs.push(structuredClone(request.committed_log_entry));
    return {
      schema_version: '0.1',
      trace_id: request.trace_id,
      event_id: request.event_id,
      event_type: request.event_type,
      committed_log_entry_id: request.committed_log_entry.log_id
    };
  }
}

function normalizedUserMessage(): Record<string, unknown> {
  return {
    event_id: 'event-1',
    trace_id: 'trace-1',
    type: 'USER_MESSAGE',
    created_at: '2026-05-17T08:59:00+00:00',
    schema_version: '0.1',
    payload: {
      text: 'hello',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    }
  };
}

function roleModelResultWithPatch(): Record<string, unknown> {
  return {
    trace_id: 'trace-1',
    event_id: 'event-1',
    event_type: 'USER_MESSAGE',
    model_called: true,
    status: 'decision_ready_for_commit',
    decision: {
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      action: 'visible_reply',
      visible_reply: { text: 'hello back' },
      state_patch: {
        living_state: {
          current_activity: ' answering the user ',
          mood: ' attentive '
        }
      }
    }
  };
}

function roleModelResultWithoutPatch(): Record<string, unknown> {
  const result = roleModelResultWithPatch();
  delete mutableRecord(result['decision'])['state_patch'];
  return result;
}

function committedSnapshot(): Record<string, unknown> {
  return {
    schema_version: '0.1',
    character_id: 'character-1',
    living_state: {
      current_activity: 'answering the user',
      mood: 'attentive',
      toward_user: 'warm'
    },
    updated_at: '2026-05-17T09:00:00+00:00',
    source_event_ids: ['event-state-1', 'event-1']
  };
}

function mutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected record');
  }
  return value as Record<string, unknown>;
}

function first<T>(items: readonly T[], name: string): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error(`expected ${name}`);
  }
  return item;
}

function expectCommitted(
  result: ReturnType<typeof commitLivingStatePatch>
): asserts result is LivingStatePatchCommittedResult {
  expect(result.status).toBe(LIVING_STATE_PATCH_COMMITTED_STATUS);
  if (result.status !== LIVING_STATE_PATCH_COMMITTED_STATUS) {
    throw new Error('expected committed result');
  }
}

function expectRejected(
  result: ReturnType<typeof commitLivingStatePatch>
): asserts result is LivingStatePatchRejectedResult {
  expect(result.status).toBe(LIVING_STATE_PATCH_REJECTED_STATUS);
  if (result.status !== LIVING_STATE_PATCH_REJECTED_STATUS) {
    throw new Error('expected rejected result');
  }
}

describe('living-state patch commit effects', () => {
  it('builds commit requests without model-authored store metadata', () => {
    const request = buildLivingStatePatchCommitRequest(
      normalizedUserMessage(),
      roleModelResultWithPatch()
    );

    expect(request).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'USER_MESSAGE',
      decision_action: 'visible_reply',
      patch: {
        living_state: {
          current_activity: 'answering the user',
          mood: 'attentive'
        }
      },
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    });
    expect(request?.patch.living_state).not.toHaveProperty('updated_at');
    expect(request?.patch.living_state).not.toHaveProperty('source_event_ids');
  });

  it('skips without logs or boundary calls when the decision has no patch', () => {
    const rawLog = new RecordingRawEventLog();
    const store = new RecordingLivingStatePatchStore();
    const finalizer = new RecordingLivingStatePatchFinalizer();

    const result = commitLivingStatePatch(normalizedUserMessage(), roleModelResultWithoutPatch(), {
      livingStatePatchStore: store,
      livingStatePatchFinalizer: finalizer,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    expect(result.status).toBe(LIVING_STATE_PATCH_SKIPPED_STATUS);
    expect(store.requests).toEqual([]);
    expect(finalizer.requests).toEqual([]);
    expect(rawLog.entries).toEqual([]);
  });

  it('commits through the atomic finalizer and uses defensive copies', () => {
    const rawLog = new RecordingRawEventLog();
    const store = new RecordingLivingStatePatchStore();
    const finalizer = new RecordingLivingStatePatchFinalizer();
    const event = normalizedUserMessage();
    const roleModelResult = roleModelResultWithPatch();

    const result = commitLivingStatePatch(event, roleModelResult, {
      livingStatePatchStore: store,
      livingStatePatchFinalizer: finalizer,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expectCommitted(result);
    const storeRequest = first(store.requests, 'store request');
    const finalizerRequest = first(finalizer.requests, 'finalizer request');
    const durableSuccessLog = first(finalizer.durableSuccessLogs, 'durable success log');
    const durableStateSnapshot = first(
      finalizer.durableStateSnapshots,
      'durable state snapshot'
    );

    mutableRecord(mutableRecord(event['payload']))['text'] = 'mutated event';
    mutableRecord(
      mutableRecord(mutableRecord(roleModelResult['decision'])['state_patch'])['living_state']
    )['mood'] = 'mutated';
    result.committed_snapshot.living_state.mood = 'mutated result';
    storeRequest.patch.living_state.mood = 'mutated request';
    finalizerRequest.committed_snapshot.living_state.mood = 'mutated finalizer request';
    mutableRecord(
      mutableRecord(
        mutableRecord(finalizerRequest.committed_log_entry.data['source_event'])['payload']
      )
    )['text'] = 'mutated finalizer request';

    expect(result.committed_log_entry_id).toBe(durableSuccessLog.log_id);
    expect(storeRequest.commit_time).toBe('2026-05-17T09:00:00+00:00');
    expect(storeRequest.patch.living_state.current_activity).toBe('answering the user');
    expect(store.requests).toHaveLength(1);
    expect(finalizer.requests).toHaveLength(1);
    expect(rawLog.entries).toEqual([]);
    expect(durableSuccessLog.kind).toBe('living_state_patch_committed');
    expect(mutableRecord(durableStateSnapshot)['living_state']).toEqual({
      current_activity: 'answering the user',
      mood: 'attentive',
      toward_user: 'warm'
    });
    expect(
      mutableRecord(
        mutableRecord(durableSuccessLog.data['source_event'])['payload']
      )['text']
    ).toBe('hello');
    expect(
      mutableRecord(
        mutableRecord(durableSuccessLog.data['patch'])['living_state']
      )['mood']
    ).toBe('attentive');
  });

  it('rejects finalizer failures without exposing durable success artifacts', () => {
    const rawLog = new RecordingRawEventLog();
    const store = new RecordingLivingStatePatchStore();
    const finalizer = new RecordingLivingStatePatchFinalizer({
      error: new LivingStatePatchFinalizerError('finalize rejected', {
        code: 'finalize_rejected'
      })
    });

    const result = commitLivingStatePatch(normalizedUserMessage(), roleModelResultWithPatch(), {
      livingStatePatchStore: store,
      livingStatePatchFinalizer: finalizer,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    expectRejected(result);
    expect(result.failure.stage).toBe(LIVING_STATE_PATCH_FINALIZE_STAGE);
    expect(result.failure.code).toBe('finalize_rejected');
    expect(store.requests).toHaveLength(1);
    expect(finalizer.requests).toHaveLength(1);
    expect(finalizer.durableStateSnapshots).toEqual([]);
    expect(finalizer.durableSuccessLogs).toEqual([]);
    const rejectedEntry = first(rawLog.entries, 'rejected log entry');
    expect(rejectedEntry.kind).toBe('living_state_patch_rejected');
    expect(rejectedEntry.data['failure']).toEqual(result.failure);
  });

  it('treats malformed finalizer results as no durable visibility', () => {
    const rawLog = new RecordingRawEventLog();
    const store = new RecordingLivingStatePatchStore();
    const finalizer = new RecordingLivingStatePatchFinalizer({
      resultOverride: {
        schema_version: '0.1',
        trace_id: 'trace-1',
        event_id: 'event-1',
        event_type: 'USER_MESSAGE',
        committed_log_entry_id: 'wrong-log-id'
      }
    });

    const result = commitLivingStatePatch(normalizedUserMessage(), roleModelResultWithPatch(), {
      livingStatePatchStore: store,
      livingStatePatchFinalizer: finalizer,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    expectRejected(result);
    expect(result.failure.stage).toBe(LIVING_STATE_PATCH_FINALIZE_STAGE);
    expect(result.failure.code).toBe('malformed_finalize_result');
    expect(finalizer.durableStateSnapshots).toEqual([]);
    expect(finalizer.durableSuccessLogs).toEqual([]);
    expect(first(rawLog.entries, 'rejected log entry').kind).toBe(
      'living_state_patch_rejected'
    );
  });

  it('discards staged success visibility when finalizer result validation fails', () => {
    const rawLog = new InMemoryRawEventLog();
    const store = new RecordingLivingStatePatchStore();
    const finalizer = new RecordingLivingStatePatchFinalizer({
      rawLogVisibility: rawLog,
      exposeBeforeResultOverride: true,
      resultOverride: {
        schema_version: '0.1',
        trace_id: 'trace-1',
        event_id: 'event-1',
        event_type: 'USER_MESSAGE',
        committed_log_entry_id: 'wrong-log-id'
      }
    });

    const result = commitLivingStatePatch(normalizedUserMessage(), roleModelResultWithPatch(), {
      livingStatePatchStore: store,
      livingStatePatchFinalizer: finalizer,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    expectRejected(result);
    expect(result.failure.stage).toBe(LIVING_STATE_PATCH_FINALIZE_STAGE);
    expect(result.failure.code).toBe('malformed_finalize_result');
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'living_state_patch_rejected'
    ]);
    expect(
      rawLog.query({ trace_id: 'trace-1', kinds: ['living_state_patch_committed'] }).entries
    ).toEqual([]);
  });

  it('rejects store failures and malformed snapshot candidates before finalization', () => {
    const rejectedStore = new RecordingLivingStatePatchStore({
      error: new LivingStatePatchStoreError('store rejected', { code: 'store_rejected' })
    });
    const rejectedRawLog = new RecordingRawEventLog();
    const rejectedFinalizer = new RecordingLivingStatePatchFinalizer();

    const rejected = commitLivingStatePatch(
      normalizedUserMessage(),
      roleModelResultWithPatch(),
      {
        livingStatePatchStore: rejectedStore,
        livingStatePatchFinalizer: rejectedFinalizer,
        rawEventLog: rejectedRawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      }
    );

    expectRejected(rejected);
    expect(rejected.failure.stage).toBe('living_state_patch_store');
    expect(rejected.failure.code).toBe('store_rejected');
    expect(rejectedFinalizer.requests).toEqual([]);
    expect(first(rejectedRawLog.entries, 'rejected log entry').kind).toBe(
      'living_state_patch_rejected'
    );

    for (const [snapshot, messagePattern] of [
      [{ ...committedSnapshot(), source_event_ids: ['event-state-1'] }, /source_event_ids/],
      [
        {
          ...committedSnapshot(),
          living_state: { ...mutableRecord(committedSnapshot()['living_state']), mood: 'focused' }
        },
        /living_state\.mood/
      ],
      [{ ...committedSnapshot(), updated_at: '2026-05-17T08:58:00+00:00' }, /updated_at/]
    ] as const) {
      const rawLog = new RecordingRawEventLog();
      const store = new RecordingLivingStatePatchStore({ snapshot });
      const finalizer = new RecordingLivingStatePatchFinalizer();
      const result = commitLivingStatePatch(normalizedUserMessage(), roleModelResultWithPatch(), {
        livingStatePatchStore: store,
        livingStatePatchFinalizer: finalizer,
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      });

      expectRejected(result);
      expect(result.failure.stage).toBe('living_state_patch_store');
      expect(result.failure.code).toBe('malformed_store_result');
      expect(result.failure.message).toMatch(messagePattern);
      expect(finalizer.requests).toEqual([]);
      expect(first(rawLog.entries, 'rejected log entry').kind).toBe(
        'living_state_patch_rejected'
      );
    }
  });

  it('logs commit validation failures before store calls', () => {
    const rawLog = new RecordingRawEventLog();
    const store = new RecordingLivingStatePatchStore();
    const finalizer = new RecordingLivingStatePatchFinalizer();
    const roleModelResult = roleModelResultWithPatch();
    mutableRecord(mutableRecord(roleModelResult['decision'])['state_patch'])['living_state'] = {};

    const result = commitLivingStatePatch(normalizedUserMessage(), roleModelResult, {
      livingStatePatchStore: store,
      livingStatePatchFinalizer: finalizer,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    expectRejected(result);
    expect(result.failure.stage).toBe('living_state_patch_commit_validation');
    expect(result.failure.code).toBe('malformed_commit_input');
    expect(store.requests).toEqual([]);
    expect(finalizer.requests).toEqual([]);
    const rejectedEntry = first(rawLog.entries, 'rejected log entry');
    expect(rejectedEntry.kind).toBe('living_state_patch_rejected');
    expect(rejectedEntry.data).not.toHaveProperty('patch_snapshot');
  });

  it('builds committed and rejected raw logs with copied snapshots', () => {
    const event = normalizedUserMessage();
    const roleModelResult = roleModelResultWithPatch();
    const request = buildLivingStatePatchCommitRequest(event, roleModelResult);
    if (request === undefined) {
      throw new Error('expected commit request');
    }
    const snapshot = committedSnapshot();

    const committed = buildLivingStatePatchCommittedLogEntry(
      event,
      roleModelResult,
      request.patch,
      snapshot,
      { idGenerator: new SequenceIdGenerator().generate, clock: fixedClock }
    );

    mutableRecord(mutableRecord(event['payload']))['text'] = 'mutated';
    mutableRecord(mutableRecord(mutableRecord(roleModelResult['decision'])['visible_reply']))[
      'text'
    ] = 'mutated';
    request.patch.living_state.mood = 'mutated';
    mutableRecord(mutableRecord(snapshot['living_state']))['mood'] = 'mutated';

    expect(committed.kind).toBe('living_state_patch_committed');
    expect(mutableRecord(mutableRecord(committed.data['source_event'])['payload'])['text']).toBe(
      'hello'
    );
    expect(
      mutableRecord(
        mutableRecord(mutableRecord(committed.data['role_model_result'])['decision'])[
          'visible_reply'
        ]
      )['text']
    ).toBe('hello back');
    expect(mutableRecord(mutableRecord(committed.data['patch'])['living_state'])['mood']).toBe(
      'attentive'
    );
    expect(
      mutableRecord(mutableRecord(committed.data['committed_snapshot'])['living_state'])['mood']
    ).toBe('attentive');

    const rejectedEvent = normalizedUserMessage();
    const rejectedRoleModelResult = roleModelResultWithPatch();
    const rejectedRequest = buildLivingStatePatchCommitRequest(
      rejectedEvent,
      rejectedRoleModelResult
    );
    if (rejectedRequest === undefined) {
      throw new Error('expected rejected commit request');
    }
    const failure = {
      stage: 'living_state_patch_store',
      code: 'store_rejected',
      message: 'store rejected'
    };
    const rejected = buildLivingStatePatchRejectedLogEntry(rejectedEvent, {
      roleModelResultSnapshot: rejectedRoleModelResult,
      patchSnapshot: rejectedRequest.patch,
      failure,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    mutableRecord(mutableRecord(rejectedEvent['payload']))['text'] = 'mutated rejected event';
    mutableRecord(
      mutableRecord(
        mutableRecord(rejectedRoleModelResult['decision'])['visible_reply']
      )
    )['text'] = 'mutated rejected result';
    rejectedRequest.patch.living_state.mood = 'mutated rejected patch';
    failure.message = 'mutated failure';
    expect(rejected.kind).toBe('living_state_patch_rejected');
    expect(mutableRecord(mutableRecord(rejected.data['source_event'])['payload'])['text']).toBe(
      'hello'
    );
    expect(
      mutableRecord(
        mutableRecord(mutableRecord(rejected.data['role_model_result_snapshot'])['decision'])[
          'visible_reply'
        ]
      )['text']
    ).toBe('hello back');
    expect(mutableRecord(mutableRecord(rejected.data['patch_snapshot'])['living_state'])['mood']).toBe(
      'attentive'
    );
    expect(mutableRecord(rejected.data['failure'])['message']).toBe('store rejected');
  });

  it('keeps atomic success logs queryable only after finalizer staging and confirmation', () => {
    const rawLog = new InMemoryRawEventLog();
    const store = new RecordingLivingStatePatchStore();
    const finalizer = new RecordingLivingStatePatchFinalizer({ rawLogVisibility: rawLog });

    const result = commitLivingStatePatch(normalizedUserMessage(), roleModelResultWithPatch(), {
      livingStatePatchStore: store,
      livingStatePatchFinalizer: finalizer,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    expectCommitted(result);
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      'living_state_patch_committed'
    ]);

    const unstagedRawLog = new InMemoryRawEventLog();
    const unstagedFinalizer = new RecordingLivingStatePatchFinalizer();
    const unstagedResult = commitLivingStatePatch(
      normalizedUserMessage(),
      roleModelResultWithPatch(),
      {
        livingStatePatchStore: new RecordingLivingStatePatchStore(),
        livingStatePatchFinalizer: unstagedFinalizer,
        rawEventLog: unstagedRawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      }
    );

    expectRejected(unstagedResult);
    expect(unstagedResult.failure.stage).toBe(LIVING_STATE_PATCH_FINALIZE_STAGE);
    expect(unstagedResult.failure.code).toBe('malformed_finalize_result');
    expect(unstagedResult.failure.message).toMatch(/not staged by finalizer visibility/);
    expect(
      unstagedRawLog.query({ trace_id: 'trace-1', kinds: ['living_state_patch_committed'] }).entries
    ).toEqual([]);

    const stagedThenMalformedRawLog = new InMemoryRawEventLog();
    const stagedThenMalformedResult = commitLivingStatePatch(
      normalizedUserMessage(),
      roleModelResultWithPatch(),
      {
        livingStatePatchStore: new RecordingLivingStatePatchStore(),
        livingStatePatchFinalizer: new RecordingLivingStatePatchFinalizer({
          rawLogVisibility: stagedThenMalformedRawLog,
          exposeBeforeResultOverride: true,
          resultOverride: {
            schema_version: '0.1',
            trace_id: 'trace-1',
            event_id: 'event-1',
            event_type: 'USER_MESSAGE',
            committed_log_entry_id: 'wrong-log-id'
          }
        }),
        rawEventLog: stagedThenMalformedRawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      }
    );

    expectRejected(stagedThenMalformedResult);
    expect(stagedThenMalformedResult.failure.stage).toBe(LIVING_STATE_PATCH_FINALIZE_STAGE);
    expect(stagedThenMalformedResult.failure.code).toBe('malformed_finalize_result');
    expect(
      stagedThenMalformedRawLog.query({
        trace_id: 'trace-1',
        kinds: ['living_state_patch_committed']
      }).entries
    ).toEqual([]);
    expect(
      stagedThenMalformedRawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)
    ).toEqual(['living_state_patch_rejected']);
  });
});
