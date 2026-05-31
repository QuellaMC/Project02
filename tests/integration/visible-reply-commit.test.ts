import { describe, expect, it } from 'vitest';

import {
  CommitValidationError,
  commitUserVisibleMessage,
  commitVisibleReply,
  type VisibleConversationRecord
} from '../../src/commit-effects/visible-reply.ts';
import type { IdGenerator, RawEventLogEntry } from '../../src/runtime/logging.ts';

function fixedClock(): Date {
  return new Date('2026-05-15T12:00:00.000Z');
}

class SequenceIdGenerator {
  readonly calls: string[] = [];

  generate: IdGenerator = (kind: string): string => {
    this.calls.push(kind);
    return `${kind}-generated-${String(this.calls.length)}`;
  };
}

class RecordingVisibleLog {
  readonly entries: VisibleConversationRecord[] = [];
  readonly operations: string[];

  constructor(operations: string[] = []) {
    this.operations = operations;
  }

  append(entry: VisibleConversationRecord): void {
    this.operations.push('visible');
    this.entries.push(entry);
  }
}

class RecordingRawLog {
  readonly entries: RawEventLogEntry[] = [];
  readonly operations: string[];

  constructor(operations: string[] = []) {
    this.operations = operations;
  }

  append(entry: RawEventLogEntry): void {
    this.operations.push('raw');
    this.entries.push(entry);
  }
}

class FailingAppendLog {
  append(): void {
    throw new Error('append failed');
  }
}

class FailingCommitValidationAppendLog {
  append(): void {
    throw new CommitValidationError('append failed');
  }
}

function normalizedUserMessage(): Record<string, unknown> {
  return {
    event_id: 'event-1',
    trace_id: 'trace-1',
    type: 'USER_MESSAGE',
    created_at: '2026-05-15T11:59:00+00:00',
    schema_version: '0.1',
    payload: { text: 'hello', conversation_id: 'conversation-1' }
  };
}

function roleModelResult(replyText = 'hello back'): Record<string, unknown> {
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
      visible_reply: { text: replyText }
    }
  };
}

function mutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected record');
  }
  return value as Record<string, unknown>;
}

describe('visible reply commit integration', () => {
  it('appends committed raw log before assistant visible output', () => {
    const operations: string[] = [];
    const visibleLog = new RecordingVisibleLog(operations);
    const rawLog = new RecordingRawLog(operations);
    const ids = new SequenceIdGenerator();

    const result = commitVisibleReply(normalizedUserMessage(), roleModelResult(), {
      visibleConversationLog: visibleLog,
      rawEventLog: rawLog,
      idGenerator: ids.generate,
      clock: fixedClock
    });

    expect(ids.calls).toEqual(['output', 'log']);
    expect(operations).toEqual(['raw', 'visible']);
    expect(result).toEqual({
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'USER_MESSAGE',
      status: 'visible_reply_committed',
      output: visibleLog.entries[0]
    });
    expect(visibleLog.entries[0]?.output_id).toBe('output-generated-1');
    expect(visibleLog.entries[0]?.kind).toBe('assistant_visible_reply');
    expect(visibleLog.entries[0]?.text).toBe('hello back');
    expect(visibleLog.entries[0]?.conversation_id).toBe('conversation-1');
    expect(rawLog.entries[0]?.log_id).toBe('log-generated-2');
    expect(rawLog.entries[0]?.kind).toBe('visible_reply_committed');
    expect(rawLog.entries[0]?.data['output']).toEqual(visibleLog.entries[0]);
  });

  it('appends rejection log without visible output for invalid decisions', () => {
    const visibleLog = new RecordingVisibleLog();
    const rawLog = new RecordingRawLog();
    const ids = new SequenceIdGenerator();
    const invalidResult = roleModelResult();
    mutableRecord(invalidResult['decision'])['action'] = 'state_patch';

    const result = commitVisibleReply(normalizedUserMessage(), invalidResult, {
      visibleConversationLog: visibleLog,
      rawEventLog: rawLog,
      idGenerator: ids.generate,
      clock: fixedClock
    });

    expect(ids.calls).toEqual(['log']);
    expect(visibleLog.entries).toEqual([]);
    expect(rawLog.entries).toHaveLength(1);
    expect(rawLog.entries[0]?.kind).toBe('visible_reply_rejected');
    expect(mutableRecord(rawLog.entries[0]?.data['failure'])['stage']).toBe('commit_validation');
    expect(mutableRecord(rawLog.entries[0]?.data['failure'])['code']).toBe(
      'unsupported_action'
    );
    expect(result).toEqual({
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'USER_MESSAGE',
      status: 'visible_reply_rejected',
      failure: rawLog.entries[0]?.data['failure']
    });
  });

  it('does not append visible output when raw log append fails', () => {
    const visibleLog = new RecordingVisibleLog();

    expect(() =>
      commitVisibleReply(normalizedUserMessage(), roleModelResult(), {
        visibleConversationLog: visibleLog,
        rawEventLog: new FailingAppendLog(),
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/append failed/);

    expect(visibleLog.entries).toEqual([]);
  });

  it('propagates raw CommitValidationError append failures without rejection logs', () => {
    const visibleLog = new RecordingVisibleLog();

    expect(() =>
      commitVisibleReply(normalizedUserMessage(), roleModelResult(), {
        visibleConversationLog: visibleLog,
        rawEventLog: new FailingCommitValidationAppendLog(),
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/append failed/);

    expect(visibleLog.entries).toEqual([]);
  });

  it('keeps committed raw log when visible output append fails', () => {
    const rawLog = new RecordingRawLog();

    expect(() =>
      commitVisibleReply(normalizedUserMessage(), roleModelResult(), {
        visibleConversationLog: new FailingAppendLog(),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/append failed/);

    expect(rawLog.entries).toHaveLength(1);
    expect(rawLog.entries[0]?.kind).toBe('visible_reply_committed');
    expect(mutableRecord(rawLog.entries[0]?.data['output'])['text']).toBe('hello back');
  });

  it('propagates visible CommitValidationError append failures after committed raw log', () => {
    const rawLog = new RecordingRawLog();

    expect(() =>
      commitVisibleReply(normalizedUserMessage(), roleModelResult(), {
        visibleConversationLog: new FailingCommitValidationAppendLog(),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/append failed/);

    expect(rawLog.entries).toHaveLength(1);
    expect(rawLog.entries[0]?.kind).toBe('visible_reply_committed');
  });

  it('raises malformed trusted identity without rejection log', () => {
    const visibleLog = new RecordingVisibleLog();
    const rawLog = new RecordingRawLog();
    const event = normalizedUserMessage();
    delete event['trace_id'];

    expect(() =>
      commitVisibleReply(event, roleModelResult(), {
        visibleConversationLog: visibleLog,
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(CommitValidationError);

    expect(visibleLog.entries).toEqual([]);
    expect(rawLog.entries).toEqual([]);
  });

  it('logs unsupported source type rejection with trusted identity', () => {
    const visibleLog = new RecordingVisibleLog();
    const rawLog = new RecordingRawLog();
    const event = normalizedUserMessage();
    event['type'] = 'TIMER';

    const result = commitVisibleReply(event, roleModelResult(), {
      visibleConversationLog: visibleLog,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    expect(visibleLog.entries).toEqual([]);
    expect(rawLog.entries).toHaveLength(1);
    expect(rawLog.entries[0]?.kind).toBe('visible_reply_rejected');
    expect(mutableRecord(rawLog.entries[0]?.data['source_event'])['type']).toBe('TIMER');
    expect(mutableRecord(rawLog.entries[0]?.data['failure'])['code']).toBe(
      'malformed_commit_input'
    );
    expect(result.status).toBe('visible_reply_rejected');
  });
});

describe('user visible message commit integration', () => {
  it('appends committed raw log before user visible message', () => {
    const operations: string[] = [];
    const visibleLog = new RecordingVisibleLog(operations);
    const rawLog = new RecordingRawLog(operations);
    const ids = new SequenceIdGenerator();

    const result = commitUserVisibleMessage(normalizedUserMessage(), {
      visibleConversationLog: visibleLog,
      rawEventLog: rawLog,
      idGenerator: ids.generate,
      clock: fixedClock
    });

    expect(ids.calls).toEqual(['message', 'log']);
    expect(operations).toEqual(['raw', 'visible']);
    expect(result).toEqual({
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'USER_MESSAGE',
      status: 'user_visible_message_committed',
      message: visibleLog.entries[0]
    });
    expect(visibleLog.entries[0]?.message_id).toBe('message-generated-1');
    expect(visibleLog.entries[0]?.kind).toBe('user_visible_message');
    expect(visibleLog.entries[0]?.role).toBe('user');
    expect(visibleLog.entries[0]?.created_at).toBe('2026-05-15T11:59:00+00:00');
    expect(visibleLog.entries[0]?.text).toBe('hello');
    expect(rawLog.entries[0]?.log_id).toBe('log-generated-2');
    expect(rawLog.entries[0]?.kind).toBe('user_visible_message_committed');
    expect(rawLog.entries[0]?.data['message']).toEqual(visibleLog.entries[0]);
  });

  it('logs rejection for invalid trusted source events', () => {
    const visibleLog = new RecordingVisibleLog();
    const rawLog = new RecordingRawLog();
    const ids = new SequenceIdGenerator();
    const event = normalizedUserMessage();
    event['created_at'] = '2026-05-15';

    const result = commitUserVisibleMessage(event, {
      visibleConversationLog: visibleLog,
      rawEventLog: rawLog,
      idGenerator: ids.generate,
      clock: fixedClock
    });

    expect(ids.calls).toEqual(['log']);
    expect(visibleLog.entries).toEqual([]);
    expect(rawLog.entries).toHaveLength(1);
    expect(rawLog.entries[0]?.kind).toBe('user_visible_message_rejected');
    expect(mutableRecord(rawLog.entries[0]?.data['failure'])['stage']).toBe(
      'user_visible_message_validation'
    );
    expect(mutableRecord(rawLog.entries[0]?.data['failure'])['code']).toBe(
      'malformed_commit_input'
    );
    expect(result.status).toBe('user_visible_message_rejected');
  });

  it('logs unsupported source type rejection with Python-compatible failure text', () => {
    const visibleLog = new RecordingVisibleLog();
    const rawLog = new RecordingRawLog();
    const event = normalizedUserMessage();
    event['type'] = 'TIMER';

    const result = commitUserVisibleMessage(event, {
      visibleConversationLog: visibleLog,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    expect(visibleLog.entries).toEqual([]);
    expect(rawLog.entries[0]?.kind).toBe('user_visible_message_rejected');
    expect(rawLog.entries[0]?.data['failure']).toEqual({
      stage: 'user_visible_message_validation',
      code: 'malformed_commit_input',
      message: "source_event.type must be 'USER_MESSAGE'."
    });
    expect(result.status).toBe('user_visible_message_rejected');
  });

  it('raises missing trusted type without rejection log', () => {
    const visibleLog = new RecordingVisibleLog();
    const rawLog = new RecordingRawLog();
    const event = normalizedUserMessage();
    delete event['type'];

    expect(() =>
      commitUserVisibleMessage(event, {
        visibleConversationLog: visibleLog,
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(CommitValidationError);

    expect(visibleLog.entries).toEqual([]);
    expect(rawLog.entries).toEqual([]);
  });

  it('does not append user visible message when raw log append fails', () => {
    const visibleLog = new RecordingVisibleLog();

    expect(() =>
      commitUserVisibleMessage(normalizedUserMessage(), {
        visibleConversationLog: visibleLog,
        rawEventLog: new FailingAppendLog(),
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/append failed/);

    expect(visibleLog.entries).toEqual([]);
  });

  it('propagates raw CommitValidationError failures before user visible append', () => {
    const visibleLog = new RecordingVisibleLog();

    expect(() =>
      commitUserVisibleMessage(normalizedUserMessage(), {
        visibleConversationLog: visibleLog,
        rawEventLog: new FailingCommitValidationAppendLog(),
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/append failed/);

    expect(visibleLog.entries).toEqual([]);
  });

  it('keeps committed raw log when user visible message append fails', () => {
    const rawLog = new RecordingRawLog();

    expect(() =>
      commitUserVisibleMessage(normalizedUserMessage(), {
        visibleConversationLog: new FailingAppendLog(),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/append failed/);

    expect(rawLog.entries).toHaveLength(1);
    expect(rawLog.entries[0]?.kind).toBe('user_visible_message_committed');
    expect(mutableRecord(rawLog.entries[0]?.data['message'])['text']).toBe('hello');
  });

  it('propagates visible CommitValidationError failures after user committed raw log', () => {
    const rawLog = new RecordingRawLog();

    expect(() =>
      commitUserVisibleMessage(normalizedUserMessage(), {
        visibleConversationLog: new FailingCommitValidationAppendLog(),
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/append failed/);

    expect(rawLog.entries).toHaveLength(1);
    expect(rawLog.entries[0]?.kind).toBe('user_visible_message_committed');
  });
});
