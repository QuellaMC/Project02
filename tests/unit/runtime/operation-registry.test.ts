import { describe, expect, it } from 'vitest';

import {
  RUNTIME_OPERATION_COMPLETED_KIND,
  RUNTIME_OPERATION_REJECTED_KIND,
  RUNTIME_OPERATION_STARTED_KIND,
  RUNTIME_OPERATION_SUCCEEDED_WITH_AUDIT_FAILURE_STATUS,
  RuntimeAccess,
  RuntimeOperationExecutionError,
  createRuntimeOperationRegistry,
  type RuntimeOperationDefinition,
  type RuntimeOperationRequest
} from '../../../src/runtime/operation-registry.ts';
import {
  InMemoryRawEventLog,
  type IdGenerator,
  type RawEventLogEntry
} from '../../../src/runtime/logging.ts';

class SequenceIdGenerator {
  readonly calls: string[] = [];

  next: IdGenerator = (kind: string): string => {
    this.calls.push(kind);
    return `${kind}-generated-${String(this.calls.length)}`;
  };
}

class FailOnAppendRawEventLog {
  readonly entries: RawEventLogEntry[] = [];
  readonly failOnAppend: number;

  constructor(failOnAppend: number) {
    this.failOnAppend = failOnAppend;
  }

  append(entry: RawEventLogEntry): void {
    if (this.entries.length + 1 === this.failOnAppend) {
      throw new Error(`raw log append ${String(this.failOnAppend)} failed`);
    }
    this.entries.push(structuredClone(entry));
  }
}

function fixedClock(): Date {
  return new Date('2026-06-01T10:00:00.000Z');
}

function request(overrides: Partial<RuntimeOperationRequest> = {}): RuntimeOperationRequest {
  return {
    schema_version: '0.1',
    trace_id: 'trace-1',
    event_id: 'event-1',
    event_type: 'USER_MESSAGE',
    caller: {
      component_id: 'runtime.user_turn',
      call_type: 'user_turn'
    },
    op: 'visible_conversation.commit_user_message',
    input: { text: 'hello' },
    ...overrides
  };
}

function operation(
  overrides: Partial<RuntimeOperationDefinition> = {}
): RuntimeOperationDefinition {
  return {
    op: 'visible_conversation.commit_user_message',
    owner_component_id: 'visible_conversation',
    input_contract_id: 'test.input',
    output_contract_id: 'test.output',
    validate_input: (operationRequest) => operationRequest.input,
    validate_output: (output) => output,
    policy: {
      category: 'visible_effect',
      permission_policy_id: 'internal_runtime_only',
      allowed_callers: ['runtime.user_turn'],
      allowed_call_types: ['user_turn'],
      allowed_event_types: ['USER_MESSAGE']
    },
    privacy: {
      input: 'full',
      output: 'redacted'
    },
    logging: {
      mode: 'required'
    },
    transaction: {
      mode: 'existing_commit_effect_atomic'
    },
    execution: {
      mode: 'sync_in_process'
    },
    handler: (_operationRequest, input) => ({
      status: 'domain_rejected_result',
      echoed_input: input
    }),
    ...overrides
  };
}

describe('runtime operation registry and access', () => {
  it('executes allowed operations with started and completed audit logs', () => {
    const rawLog = new InMemoryRawEventLog();
    const registry = createRuntimeOperationRegistry([operation()]);
    const access = new RuntimeAccess(registry, {
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    const result = access.execute(request());

    expect(result).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      op: 'visible_conversation.commit_user_message',
      owner_component_id: 'visible_conversation',
      status: 'succeeded',
      output: {
        status: 'domain_rejected_result',
        echoed_input: { text: 'hello' }
      }
    });
    const entries = rawLog.query({ trace_id: 'trace-1' }).entries;
    expect(entries.map((entry) => entry.kind)).toEqual([
      RUNTIME_OPERATION_STARTED_KIND,
      RUNTIME_OPERATION_COMPLETED_KIND
    ]);
    expect(entries[0]?.data).toMatchObject({
      op: 'visible_conversation.commit_user_message',
      owner_component_id: 'visible_conversation',
      caller: {
        component_id: 'runtime.user_turn',
        call_type: 'user_turn'
      },
      permission_policy_id: 'internal_runtime_only',
      operation_category: 'visible_effect',
      logging_policy: 'required',
      transaction_policy: 'existing_commit_effect_atomic',
      execution_policy: 'sync_in_process',
      input_snapshot: { text: 'hello' }
    });
    expect(entries[1]?.data).toMatchObject({
      op: 'visible_conversation.commit_user_message',
      output_snapshot: { redacted: true }
    });
  });

  it('rejects duplicate operations and disabled owner lookups', () => {
    expect(() =>
      createRuntimeOperationRegistry([operation(), operation()])
    ).toThrow(/duplicate operation/);

    const access = new RuntimeAccess(
      createRuntimeOperationRegistry([operation()], {
        disabledOwnerComponentIds: ['visible_conversation']
      }),
      {
        rawEventLog: new InMemoryRawEventLog(),
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    const result = access.execute(request());

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected' || result.failure === undefined) {
      throw new Error('expected operation rejection');
    }
    expect(result.failure.code).toBe('disabled_owner_component');
  });

  it('enforces permission logging transaction and execution policy contracts', () => {
    expect(() =>
      createRuntimeOperationRegistry([
        operation({
          policy: {
            category: 'read',
            permission_policy_id: 'internal_runtime_only',
            allowed_callers: ['runtime.user_turn'],
            allowed_call_types: ['user_turn'],
            allowed_event_types: ['USER_MESSAGE']
          }
        })
      ])
    ).toThrow(/read operations must use read_only transaction/);

    expect(() =>
      createRuntimeOperationRegistry([
        operation({
          logging: {
            mode: 'disabled_for_tests'
          }
        })
      ])
    ).toThrow(/disabled_for_tests requires test_only permission/);

    const access = new RuntimeAccess(
      createRuntimeOperationRegistry([
        operation({
          policy: {
            category: 'visible_effect',
            permission_policy_id: 'internal_runtime_only',
            allowed_callers: ['component.memory'],
            allowed_call_types: ['user_turn'],
            allowed_event_types: ['USER_MESSAGE']
          }
        })
      ]),
      {
        rawEventLog: new InMemoryRawEventLog(),
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(
      access.execute(
        request({
          caller: {
            component_id: 'component.memory',
            call_type: 'user_turn'
          }
        })
      ).failure?.code
    ).toBe('permission_denied');
  });

  it('rejects async handler results until a background executor is specified', () => {
    const rawLog = new InMemoryRawEventLog();
    const access = new RuntimeAccess(
      createRuntimeOperationRegistry([
        operation({
          handler: () => Promise.resolve({ status: 'queued' })
        })
      ]),
      {
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    const result = access.execute(request());

    expect(result.status).toBe('rejected');
    expect(result.failure).toEqual({
      stage: 'handler',
      code: 'async_operation_not_supported',
      message:
        'operation visible_conversation.commit_user_message returned a Promise, but only ' +
        'sync_in_process execution is supported in MVP-022.'
    });
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      RUNTIME_OPERATION_STARTED_KIND,
      RUNTIME_OPERATION_REJECTED_KIND
    ]);
  });

  it('rejects unknown operations caller event and contract failures before handlers run', () => {
    let handlerCalls = 0;
    const access = new RuntimeAccess(
      createRuntimeOperationRegistry([
        operation({
          validate_input: () => {
            throw new RuntimeOperationExecutionError('malformed input', {
              stage: 'input_validation',
              code: 'malformed_input'
            });
          },
          handler: () => {
            handlerCalls += 1;
            return {};
          }
        })
      ]),
      {
        rawEventLog: new InMemoryRawEventLog(),
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    expect(access.execute(request({ op: 'unknown.operation' })).failure?.code).toBe(
      'unknown_operation'
    );
    expect(
      access.execute(
        request({ caller: { component_id: 'runtime.kernel', call_type: 'user_turn' } })
      ).failure?.code
    ).toBe('unsupported_caller');
    expect(
      access.execute(
        request({ caller: { component_id: 'runtime.user_turn', call_type: 'test' } })
      ).failure?.code
    ).toBe('unsupported_call_type');
    expect(access.execute(request({ event_type: 'INCIDENT_COMPLETION' })).failure?.code).toBe(
      'unsupported_event_type'
    );
    expect(access.execute(request()).failure?.code).toBe('malformed_input');
    expect(handlerCalls).toBe(0);
  });

  it('logs handler exceptions as rejected operation results', () => {
    const rawLog = new InMemoryRawEventLog();
    const access = new RuntimeAccess(
      createRuntimeOperationRegistry([
        operation({
          handler: () => {
            throw new Error('storage unavailable');
          }
        })
      ]),
      {
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    const result = access.execute(request());

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') {
      throw new Error('expected operation rejection');
    }
    expect(result.failure).toEqual({
      stage: 'handler',
      code: 'handler_exception',
      message: 'storage unavailable'
    });
    expect(rawLog.query({ trace_id: 'trace-1' }).entries.map((entry) => entry.kind)).toEqual([
      RUNTIME_OPERATION_STARTED_KIND,
      RUNTIME_OPERATION_REJECTED_KIND
    ]);
  });

  it('keeps post-handler audit failures distinct from rejected operations', () => {
    let handlerCalls = 0;
    const startLogFails = new RuntimeAccess(
      createRuntimeOperationRegistry([
        operation({
          handler: () => {
            handlerCalls += 1;
            return { status: 'must_not_run' };
          }
        })
      ]),
      {
        rawEventLog: new FailOnAppendRawEventLog(1),
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    ).execute(request());

    expect(startLogFails.status).toBe('rejected');
    expect(startLogFails.failure).toEqual({
      stage: 'logging',
      code: 'audit_log_append_failed',
      message: 'failed to append runtime_operation_started: raw log append 1 failed'
    });
    expect(handlerCalls).toBe(0);

    let completedHandlerCalls = 0;
    const completedLogFails = new RuntimeAccess(
      createRuntimeOperationRegistry([
        operation({
          handler: (_operationRequest, input) => {
            completedHandlerCalls += 1;
            return {
              status: 'domain_committed_result',
              echoed_input: input
            };
          }
        })
      ]),
      {
        rawEventLog: new FailOnAppendRawEventLog(2),
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    ).execute(request());
    expect(completedLogFails.status).toBe(
      RUNTIME_OPERATION_SUCCEEDED_WITH_AUDIT_FAILURE_STATUS
    );
    expect(completedLogFails.output).toEqual({
      status: 'domain_committed_result',
      echoed_input: { text: 'hello' }
    });
    expect(completedLogFails.failure).toMatchObject({
      stage: 'logging',
      code: 'audit_log_append_failed',
      message: 'failed to append runtime_operation_completed: raw log append 2 failed'
    });
    expect(completedHandlerCalls).toBe(1);

    const rejectedLogFails = new RuntimeAccess(
      createRuntimeOperationRegistry([
        operation({
          handler: () => {
            throw new Error('storage unavailable');
          }
        })
      ]),
      {
        rawEventLog: new FailOnAppendRawEventLog(2),
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    ).execute(request());
    expect(rejectedLogFails.status).toBe('rejected');
    expect(rejectedLogFails.failure).toMatchObject({
      stage: 'logging',
      code: 'audit_log_append_failed',
      message: 'failed to append runtime_operation_rejected: raw log append 2 failed'
    });
  });

  it('returns structured rejected results for malformed envelopes with event identity', () => {
    const rawLog = new InMemoryRawEventLog();
    const access = new RuntimeAccess(createRuntimeOperationRegistry([operation()]), {
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().next,
      clock: fixedClock
    });

    const result = access.execute({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'USER_MESSAGE',
      caller: {
        component_id: 'runtime.user_turn'
      },
      op: 'visible_conversation.commit_user_message',
      input: { text: 'hello' }
    } as RuntimeOperationRequest);

    expect(result).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      op: 'visible_conversation.commit_user_message',
      owner_component_id: 'runtime',
      status: 'rejected',
      failure: {
        stage: 'request_validation',
        code: 'malformed_operation_request',
        message: 'RuntimeOperationRequest.caller.call_type must be a non-empty string.'
      }
    });
    expect(rawLog.query({ trace_id: 'trace-1' }).entries).toHaveLength(1);
    expect(rawLog.query({ trace_id: 'trace-1' }).entries[0]?.data).toMatchObject({
      op: 'visible_conversation.commit_user_message',
      owner_component_id: 'runtime',
      event_type: 'USER_MESSAGE',
      failure: {
        stage: 'request_validation',
        code: 'malformed_operation_request'
      }
    });
    expect(() => access.execute({} as RuntimeOperationRequest)).toThrow(
      /RuntimeOperationRequest.caller must be a mapping/
    );
  });

  it('omits read snapshots and avoids duplicating model input and output', () => {
    const rawLog = new InMemoryRawEventLog();
    const access = new RuntimeAccess(
      createRuntimeOperationRegistry([
        operation({
          op: 'role_model.run_turn',
          owner_component_id: 'role_model',
          policy: {
            category: 'model_call',
            permission_policy_id: 'internal_runtime_only',
            allowed_callers: ['runtime.user_turn'],
            allowed_call_types: ['user_turn'],
            allowed_event_types: ['USER_MESSAGE']
          },
          privacy: {
            input: 'omitted',
            output: 'omitted'
          },
          transaction: {
            mode: 'none'
          },
          handler: () => ({
            role_model_result: {
              raw_model_input: 'must not be duplicated',
              raw_model_output: 'must not be duplicated'
            }
          })
        })
      ]),
      {
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().next,
        clock: fixedClock
      }
    );

    access.execute(request({ op: 'role_model.run_turn' }));

    const entries = rawLog.query({ trace_id: 'trace-1' }).entries;
    expect(entries[0]?.data).toMatchObject({ input_snapshot: { omitted: true } });
    expect(entries[1]?.data).toMatchObject({ output_snapshot: { omitted: true } });
    expect(JSON.stringify(entries)).not.toContain('must not be duplicated');
  });
});
