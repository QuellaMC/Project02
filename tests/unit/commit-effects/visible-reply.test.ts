import { describe, expect, it } from 'vitest';

import {
  CommitValidationError,
  buildUserVisibleMessage,
  buildUserVisibleMessageCommittedLogEntry,
  buildUserVisibleMessageRejectedLogEntry,
  buildVisibleConversationOutput,
  buildVisibleReplyCommittedLogEntry,
  buildVisibleReplyRejectedLogEntry
} from '../../../src/commit-effects/visible-reply.ts';
import type { IdGenerator } from '../../../src/runtime/logging.ts';

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

function normalizedUserMessage(): Record<string, unknown> {
  return {
    event_id: 'event-1',
    trace_id: 'trace-1',
    type: 'USER_MESSAGE',
    created_at: '2026-05-15T11:59:00+00:00',
    schema_version: '0.1',
    payload: {
      text: 'hello',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    }
  };
}

function roleModelResult(): Record<string, unknown> {
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
      visible_reply: { text: ' hello back ' }
    }
  };
}

function mutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected record');
  }
  return value as Record<string, unknown>;
}

function expectCommitError(callback: () => unknown, code?: string): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(CommitValidationError);
    if (code !== undefined) {
      expect((error as CommitValidationError).code).toBe(code);
    }
    return;
  }
  throw new Error('expected CommitValidationError');
}

describe('visible conversation output builders', () => {
  it('builds assistant output from visible reply decisions', () => {
    const ids = new SequenceIdGenerator();

    const output = buildVisibleConversationOutput(normalizedUserMessage(), roleModelResult(), {
      idGenerator: ids.generate,
      clock: fixedClock
    });

    expect(ids.calls).toEqual(['output']);
    expect(output).toEqual({
      output_id: 'output-generated-1',
      trace_id: 'trace-1',
      source_event_id: 'event-1',
      kind: 'assistant_visible_reply',
      created_at: '2026-05-15T12:00:00+00:00',
      schema_version: '0.1',
      text: 'hello back',
      user_id: 'user-1',
      conversation_id: 'conversation-1',
      source: {
        decision_action: 'visible_reply',
        role_model_status: 'decision_ready_for_commit'
      }
    });
  });

  it('omits absent optional conversation fields', () => {
    const event = normalizedUserMessage();
    const payload = mutableRecord(event['payload']);
    delete payload['user_id'];
    delete payload['conversation_id'];

    const output = buildVisibleConversationOutput(event, roleModelResult(), {
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    expect(output).not.toHaveProperty('user_id');
    expect(output).not.toHaveProperty('conversation_id');
  });

  it('rejects invalid visible reply commit inputs with Python-compatible codes', () => {
    const unsupportedEvent = normalizedUserMessage();
    unsupportedEvent['type'] = 'TIMER';
    expectCommitError(
      () =>
        buildVisibleConversationOutput(unsupportedEvent, roleModelResult(), {
          idGenerator: new SequenceIdGenerator().generate,
          clock: fixedClock
        }),
      'malformed_commit_input'
    );

    const unsupportedStatus = roleModelResult();
    unsupportedStatus['status'] = 'already_committed';
    expectCommitError(
      () =>
        buildVisibleConversationOutput(normalizedUserMessage(), unsupportedStatus, {
          idGenerator: new SequenceIdGenerator().generate,
          clock: fixedClock
        }),
      'unsupported_result_status'
    );

    const unsupportedAction = roleModelResult();
    mutableRecord(unsupportedAction['decision'])['action'] = 'state_patch';
    expectCommitError(
      () =>
        buildVisibleConversationOutput(normalizedUserMessage(), unsupportedAction, {
          idGenerator: new SequenceIdGenerator().generate,
          clock: fixedClock
        }),
      'unsupported_action'
    );

    const emptyReply = roleModelResult();
    mutableRecord(mutableRecord(emptyReply['decision'])['visible_reply'])['text'] = '   ';
    expectCommitError(
      () =>
        buildVisibleConversationOutput(normalizedUserMessage(), emptyReply, {
          idGenerator: new SequenceIdGenerator().generate,
          clock: fixedClock
        }),
      'empty_reply_text'
    );

    const mismatchedResult = roleModelResult();
    mismatchedResult['event_id'] = 'event-2';
    expectCommitError(
      () =>
        buildVisibleConversationOutput(normalizedUserMessage(), mismatchedResult, {
          idGenerator: new SequenceIdGenerator().generate,
          clock: fixedClock
        }),
      'identity_mismatch'
    );

    const unsupportedSchema = normalizedUserMessage();
    unsupportedSchema['schema_version'] = '0.2';
    expectCommitError(
      () =>
        buildVisibleConversationOutput(unsupportedSchema, roleModelResult(), {
          idGenerator: new SequenceIdGenerator().generate,
          clock: fixedClock
        }),
      'malformed_commit_input'
    );

    const malformedCreatedAt = normalizedUserMessage();
    malformedCreatedAt['created_at'] = '2026-05-15';
    expectCommitError(
      () =>
        buildVisibleConversationOutput(malformedCreatedAt, roleModelResult(), {
          idGenerator: new SequenceIdGenerator().generate,
          clock: fixedClock
        }),
      'malformed_commit_input'
    );

    const mismatchedDecision = roleModelResult();
    mutableRecord(mismatchedDecision['decision'])['trace_id'] = 'trace-2';
    expectCommitError(
      () =>
        buildVisibleConversationOutput(normalizedUserMessage(), mismatchedDecision, {
          idGenerator: new SequenceIdGenerator().generate,
          clock: fixedClock
        }),
      'identity_mismatch'
    );
  });

  it('builds committed and rejected visible-reply logs with copied snapshots', () => {
    const event = normalizedUserMessage();
    const result = roleModelResult();
    const output = buildVisibleConversationOutput(event, result, {
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    const committed = buildVisibleReplyCommittedLogEntry(event, result, output, {
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    mutableRecord(mutableRecord(event['payload']))['text'] = 'mutated event';
    mutableRecord(mutableRecord(mutableRecord(result['decision'])['visible_reply']))['text'] =
      'mutated decision';
    output.text = 'mutated output';

    expect(committed.kind).toBe('visible_reply_committed');
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
    expect(mutableRecord(committed.data['output'])['text']).toBe('hello back');

    const failure = {
      stage: 'commit_validation',
      code: 'unsupported_action',
      message: "action must be 'visible_reply'."
    };
    const rejected = buildVisibleReplyRejectedLogEntry(normalizedUserMessage(), {
      roleModelResultSnapshot: roleModelResult(),
      failure,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    failure.message = 'mutated failure';
    expect(rejected.kind).toBe('visible_reply_rejected');
    expect(mutableRecord(rejected.data['decision_snapshot'])['action']).toBe('visible_reply');
    expect(mutableRecord(rejected.data['failure'])['message']).toBe(
      "action must be 'visible_reply'."
    );

    const primitiveSnapshot = buildVisibleReplyRejectedLogEntry(normalizedUserMessage(), {
      roleModelResultSnapshot: 'line\nbreak\t\x00',
      failure: {
        stage: 'commit_validation',
        code: 'malformed_commit_input',
        message: 'bad snapshot'
      },
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expect(primitiveSnapshot.data['role_model_result_snapshot']).toEqual({
      raw_value: "'line\\nbreak\\t\\x00'"
    });

    const uncloneableSource = normalizedUserMessage();
    uncloneableSource['callback'] = () => undefined;
    uncloneableSource['self'] = uncloneableSource;
    const uncloneableRoleModelSnapshot: Record<string, unknown> = {
      trace_id: 'trace-1',
      event_id: 'event-1',
      callback: () => undefined
    };
    uncloneableRoleModelSnapshot['self'] = uncloneableRoleModelSnapshot;
    const uncloneableSnapshot = buildVisibleReplyRejectedLogEntry(uncloneableSource, {
      roleModelResultSnapshot: uncloneableRoleModelSnapshot,
      failure: {
        stage: 'commit_validation',
        code: 'malformed_commit_input',
        message: 'bad snapshot'
      },
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expect(mutableRecord(uncloneableSnapshot.data['source_event'])['callback']).toEqual({
      raw_value: '[Function]'
    });
    expect(mutableRecord(uncloneableSnapshot.data['source_event'])['self']).toEqual({
      raw_value: '{...}'
    });
    expect(uncloneableSnapshot.data['role_model_result_snapshot']).toEqual({
      trace_id: 'trace-1',
      event_id: 'event-1',
      callback: { raw_value: '[Function]' },
      self: { raw_value: '{...}' }
    });
  });

  it('rejects unsupported visible-reply output and log fields', () => {
    const event = normalizedUserMessage();
    const result = roleModelResult();
    const output = {
      ...buildVisibleConversationOutput(event, result, {
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      }),
      future: 'not allowed'
    };
    expectCommitError(() =>
      buildVisibleReplyCommittedLogEntry(event, result, output, {
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    );

    const outputWithSourceExtra = buildVisibleConversationOutput(event, result, {
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    mutableRecord(outputWithSourceExtra.source)['future'] = 'not allowed';
    expectCommitError(() =>
      buildVisibleReplyCommittedLogEntry(event, result, outputWithSourceExtra, {
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    );

    expectCommitError(() =>
      buildVisibleReplyRejectedLogEntry(event, {
        roleModelResultSnapshot: result,
        failure: {
          stage: 'commit_validation',
          code: 'unsupported_action',
          message: 'bad',
          future: 'not allowed'
        },
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    );
  });

  it('rejects invalid visible-reply rejection failure codes', () => {
    expectCommitError(() =>
      buildVisibleReplyRejectedLogEntry(normalizedUserMessage(), {
        roleModelResultSnapshot: roleModelResult(),
        failure: {
          stage: 'commit_validation',
          code: 'adapter_exception',
          message: 'wrong boundary'
        },
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    );
  });
});

describe('user visible message builders', () => {
  it('builds user visible messages from normalized user messages', () => {
    const ids = new SequenceIdGenerator();

    const message = buildUserVisibleMessage(normalizedUserMessage(), {
      idGenerator: ids.generate
    });

    expect(ids.calls).toEqual(['message']);
    expect(message).toEqual({
      message_id: 'message-generated-1',
      trace_id: 'trace-1',
      source_event_id: 'event-1',
      kind: 'user_visible_message',
      role: 'user',
      created_at: '2026-05-15T11:59:00+00:00',
      schema_version: '0.1',
      text: 'hello',
      user_id: 'user-1',
      conversation_id: 'conversation-1',
      source: { runtime_event_type: 'USER_MESSAGE' }
    });
  });

  it('omits absent optional user-message fields', () => {
    const event = normalizedUserMessage();
    const payload = mutableRecord(event['payload']);
    delete payload['user_id'];
    delete payload['conversation_id'];

    const message = buildUserVisibleMessage(event, {
      idGenerator: new SequenceIdGenerator().generate
    });

    expect(message).not.toHaveProperty('user_id');
    expect(message).not.toHaveProperty('conversation_id');
  });

  it('rejects invalid user visible message source events', () => {
    const unsupportedEvent = normalizedUserMessage();
    unsupportedEvent['type'] = 'TIMER';
    expectCommitError(() =>
      buildUserVisibleMessage(unsupportedEvent, {
        idGenerator: new SequenceIdGenerator().generate
      })
    );

    const malformedCreatedAt = normalizedUserMessage();
    malformedCreatedAt['created_at'] = '2026-05-15';
    expectCommitError(() =>
      buildUserVisibleMessage(malformedCreatedAt, {
        idGenerator: new SequenceIdGenerator().generate
      })
    );

    const unsupportedSchema = normalizedUserMessage();
    unsupportedSchema['schema_version'] = '0.2';
    expectCommitError(() =>
      buildUserVisibleMessage(unsupportedSchema, {
        idGenerator: new SequenceIdGenerator().generate
      })
    );

    const missingPayload = normalizedUserMessage();
    delete missingPayload['payload'];
    expectCommitError(() =>
      buildUserVisibleMessage(missingPayload, {
        idGenerator: new SequenceIdGenerator().generate
      })
    );

    const emptyText = normalizedUserMessage();
    mutableRecord(emptyText['payload'])['text'] = '   ';
    expectCommitError(() =>
      buildUserVisibleMessage(emptyText, {
        idGenerator: new SequenceIdGenerator().generate
      })
    );
  });

  it('builds committed and rejected user-visible-message logs with copied snapshots', () => {
    const event = normalizedUserMessage();
    const message = buildUserVisibleMessage(event, {
      idGenerator: new SequenceIdGenerator().generate
    });

    const committed = buildUserVisibleMessageCommittedLogEntry(event, message, {
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    mutableRecord(mutableRecord(event['payload']))['text'] = 'mutated event';
    message.text = 'mutated message';

    expect(committed.kind).toBe('user_visible_message_committed');
    expect(mutableRecord(mutableRecord(committed.data['source_event'])['payload'])['text']).toBe(
      'hello'
    );
    expect(mutableRecord(committed.data['message'])['text']).toBe('hello');

    const failure = {
      stage: 'user_visible_message_validation',
      code: 'malformed_commit_input',
      message: "source_event.type must be 'USER_MESSAGE'."
    };
    const rejected = buildUserVisibleMessageRejectedLogEntry(normalizedUserMessage(), {
      failure,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    failure.message = 'mutated failure';
    expect(rejected.kind).toBe('user_visible_message_rejected');
    expect(mutableRecord(rejected.data['failure'])['message']).toBe(
      "source_event.type must be 'USER_MESSAGE'."
    );
  });

  it('rejects unsupported user-visible-message and log fields', () => {
    const event = normalizedUserMessage();
    const message = {
      ...buildUserVisibleMessage(event, {
        idGenerator: new SequenceIdGenerator().generate
      }),
      future: 'not allowed'
    };
    expectCommitError(() =>
      buildUserVisibleMessageCommittedLogEntry(event, message, {
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    );

    const messageWithSourceExtra = buildUserVisibleMessage(event, {
      idGenerator: new SequenceIdGenerator().generate
    });
    mutableRecord(messageWithSourceExtra.source)['future'] = 'not allowed';
    expectCommitError(() =>
      buildUserVisibleMessageCommittedLogEntry(event, messageWithSourceExtra, {
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    );

    expectCommitError(() =>
      buildUserVisibleMessageRejectedLogEntry(event, {
        failure: {
          stage: 'user_visible_message_validation',
          code: 'malformed_commit_input',
          message: 'bad',
          future: 'not allowed'
        },
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    );
  });

  it('rejects invalid user-visible-message rejection failure codes', () => {
    expectCommitError(() =>
      buildUserVisibleMessageRejectedLogEntry(normalizedUserMessage(), {
        failure: {
          stage: 'user_visible_message_validation',
          code: 'unsupported_action',
          message: 'wrong boundary'
        },
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    );
  });
});
