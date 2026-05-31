import { describe, expect, it } from 'vitest';

import {
  STATE_PATCH_MODEL_ACTION_SPEC,
  RoleModelValidationError,
  buildDecisionContext,
  renderRoleModelInput,
  runRoleModelTurn,
  type ModelActionSpec,
  type RoleModelAdapter,
  type RoleModelInputEnvelope
} from '../../src/role-model/loop.ts';
import type { UserMessageRuntimeEvent } from '../../src/runtime/contracts.ts';
import type { IdGenerator, RawEventLogEntry } from '../../src/runtime/logging.ts';

function normalizedUserMessage(): UserMessageRuntimeEvent {
  return {
    event_id: 'event-1',
    trace_id: 'trace-1',
    type: 'USER_MESSAGE',
    created_at: '2026-05-14T11:30:00+00:00',
    schema_version: '0.1',
    payload: { text: 'hello' }
  };
}

function fixedClock(): Date {
  return new Date('2026-05-14T11:31:00.000Z');
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
    this.entries.push(entry);
  }
}

class FakeRoleModelAdapter implements RoleModelAdapter {
  readonly inputs: RoleModelInputEnvelope[] = [];
  readonly rawText: string;

  constructor(rawText: string) {
    this.rawText = rawText;
  }

  generate(modelInput: RoleModelInputEnvelope): unknown {
    this.inputs.push(modelInput);
    return {
      model_id: 'fake-role-model',
      created_at: '2026-05-14T11:31:00+00:00',
      raw_text: this.rawText
    };
  }
}

class FailingRoleModelAdapter implements RoleModelAdapter {
  readonly inputs: RoleModelInputEnvelope[] = [];

  generate(modelInput: RoleModelInputEnvelope): unknown {
    this.inputs.push(modelInput);
    throw new Error('adapter failed');
  }
}

class BadShapeRoleModelAdapter implements RoleModelAdapter {
  readonly inputs: RoleModelInputEnvelope[] = [];

  generate(modelInput: RoleModelInputEnvelope): unknown {
    this.inputs.push(modelInput);
    return {
      model_id: 'fake-role-model',
      created_at: '2026-05-14T11:31:00+00:00'
    };
  }
}

class NullRoleModelAdapter implements RoleModelAdapter {
  readonly inputs: RoleModelInputEnvelope[] = [];

  generate(modelInput: RoleModelInputEnvelope): unknown {
    this.inputs.push(modelInput);
    return null;
  }
}

class ArrayRoleModelAdapter implements RoleModelAdapter {
  readonly inputs: RoleModelInputEnvelope[] = [];

  generate(modelInput: RoleModelInputEnvelope): unknown {
    this.inputs.push(modelInput);
    return ['bad', null, true, { model_id: 'fake', ok: false }];
  }
}

class MutatingRoleModelAdapter implements RoleModelAdapter {
  readonly inputs: RoleModelInputEnvelope[] = [];

  generate(modelInput: RoleModelInputEnvelope): unknown {
    this.inputs.push(modelInput);
    modelInput.event.text = 'mutated by adapter';
    return {
      model_id: 'fake-role-model',
      created_at: '2026-05-14T11:31:00+00:00',
      raw_text: JSON.stringify({
        schema_version: '0.1',
        action: 'visible_reply',
        visible_reply: { text: 'reply after mutation' }
      })
    };
  }
}

class MalformedCurrentStateSource {
  readCurrentState(): unknown {
    return {
      schema_version: '0.1',
      character_id: 'character-1',
      living_state: {
        current_activity: 'writing notes',
        mood: 'focused',
        toward_user: 'warm'
      },
      updated_at: '2026-05-14T11:29:00+00:00',
      source_event_ids: ['event-1']
    };
  }
}

function visibleReplyRaw(text = 'hello back'): string {
  return JSON.stringify({
    schema_version: '0.1',
    action: 'visible_reply',
    visible_reply: { text }
  });
}

describe('role model turn integration', () => {
  it('calls the fake adapter and appends one completed role-model log', () => {
    const rawLog = new RecordingRawEventLog();
    const ids = new SequenceIdGenerator();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());

    const result = runRoleModelTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      idGenerator: ids.generate,
      clock: fixedClock
    });

    const event = normalizedUserMessage();
    const expectedInput = renderRoleModelInput(event, buildDecisionContext(event));
    expect(adapter.inputs).toEqual([expectedInput]);
    expect(result).toEqual({
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
        visible_reply: { text: 'hello back' }
      }
    });
    expect(ids.calls).toEqual(['log']);
    expect(rawLog.entries).toHaveLength(1);
    expect(rawLog.entries[0]).toMatchObject({
      log_id: 'log-generated-1',
      kind: 'role_model_turn_completed',
      created_at: '2026-05-14T11:31:00+00:00',
      data: {
        model_input: expectedInput,
        decision: result.decision
      }
    });

    result.decision.visible_reply.text = 'mutated after return';
    expect(
      rawLog.entries[0]?.data['decision']
    ).toMatchObject({ visible_reply: { text: 'hello back' } });
  });

  it('logs context failures before adapter invocation', () => {
    const rawLog = new RecordingRawEventLog();
    const adapter = new BadShapeRoleModelAdapter();

    expect(() =>
      runRoleModelTurn(normalizedUserMessage(), {
        adapter,
        rawEventLog: rawLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock,
        currentStateSource: new MalformedCurrentStateSource()
      })
    ).toThrow(/current event_id/);

    expect(adapter.inputs).toEqual([]);
    expect(rawLog.entries).toHaveLength(1);
    expect(rawLog.entries[0]?.kind).toBe('role_model_turn_failed');
    expect(rawLog.entries[0]?.data).toMatchObject({
      event: normalizedUserMessage(),
      failure: {
        stage: 'context_build',
        code: 'malformed_context'
      }
    });
    expect(rawLog.entries[0]?.data).not.toHaveProperty('model_input');
  });

  it.each([
    {
      actionSpec: {
        ...STATE_PATCH_MODEL_ACTION_SPEC,
        instructions: 'typo in prompt contract'
      },
      message: 'model action spec instructions must match the supported contract.'
    },
    {
      actionSpec: {
        ...STATE_PATCH_MODEL_ACTION_SPEC,
        allowed_actions: ['visible_reply', 'memory_write']
      } as unknown as ModelActionSpec,
      message: 'model action spec allowed_actions must match the supported contract.'
    }
  ])('rejects malformed model action specs before adapter invocation', ({ actionSpec, message }) => {
    const rawLog = new RecordingRawEventLog();
    const ids = new SequenceIdGenerator();
    const adapter = new FakeRoleModelAdapter(visibleReplyRaw());

    expect(() =>
      runRoleModelTurn(normalizedUserMessage(), {
        adapter,
        rawEventLog: rawLog,
        idGenerator: ids.generate,
        clock: fixedClock,
        modelActionSpec: actionSpec
      })
    ).toThrow(message);

    expect(adapter.inputs).toEqual([]);
    expect(ids.calls).toEqual(['log']);
    expect(rawLog.entries).toHaveLength(1);
    expect(rawLog.entries[0]?.kind).toBe('role_model_turn_failed');
    expect(rawLog.entries[0]?.data).toMatchObject({
      event: normalizedUserMessage(),
      failure: {
        stage: 'context_build',
        code: 'malformed_context',
        message
      }
    });
    expect(rawLog.entries[0]?.data).not.toHaveProperty('model_input');
  });

  it('logs adapter exceptions without model output', () => {
    const rawLog = new RecordingRawEventLog();
    const ids = new SequenceIdGenerator();
    const adapter = new FailingRoleModelAdapter();

    expect(() =>
      runRoleModelTurn(normalizedUserMessage(), {
        adapter,
        rawEventLog: rawLog,
        idGenerator: ids.generate,
        clock: fixedClock
      })
    ).toThrow(/adapter failed/);

    expect(adapter.inputs).toEqual([
      renderRoleModelInput(normalizedUserMessage(), buildDecisionContext(normalizedUserMessage()))
    ]);
    expect(ids.calls).toEqual(['log']);
    expect(rawLog.entries[0]?.data).toMatchObject({
      failure: {
        stage: 'adapter_call',
        code: 'adapter_exception',
        message: 'adapter failed'
      }
    });
    expect(rawLog.entries[0]?.data).not.toHaveProperty('model_output');
  });

  it('logs parse failures with model output or raw adapter snapshots', () => {
    const malformedOutputLog = new RecordingRawEventLog();
    expect(() =>
      runRoleModelTurn(normalizedUserMessage(), {
        adapter: new FakeRoleModelAdapter(visibleReplyRaw('   ')),
        rawEventLog: malformedOutputLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(RoleModelValidationError);

    expect(malformedOutputLog.entries[0]?.data).toMatchObject({
      model_output: {
        model_id: 'fake-role-model',
        created_at: '2026-05-14T11:31:00+00:00',
        raw_text: visibleReplyRaw('   ')
      },
      failure: {
        stage: 'parse_output',
        code: 'malformed_model_output'
      }
    });

    const badShapeLog = new RecordingRawEventLog();
    expect(() =>
      runRoleModelTurn(normalizedUserMessage(), {
        adapter: new BadShapeRoleModelAdapter(),
        rawEventLog: badShapeLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/raw_text/);

    expect(badShapeLog.entries[0]?.data['raw_model_output_snapshot']).toEqual({
      model_id: 'fake-role-model',
      created_at: '2026-05-14T11:31:00+00:00'
    });
    expect(badShapeLog.entries[0]?.data).not.toHaveProperty('model_output');

    const nullOutputLog = new RecordingRawEventLog();
    expect(() =>
      runRoleModelTurn(normalizedUserMessage(), {
        adapter: new NullRoleModelAdapter(),
        rawEventLog: nullOutputLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/RoleModelAdapterOutput must be a mapping/);
    expect(nullOutputLog.entries[0]?.data).not.toHaveProperty('model_output');
    expect(nullOutputLog.entries[0]?.data).not.toHaveProperty('raw_model_output_snapshot');

    const arrayOutputLog = new RecordingRawEventLog();
    expect(() =>
      runRoleModelTurn(normalizedUserMessage(), {
        adapter: new ArrayRoleModelAdapter(),
        rawEventLog: arrayOutputLog,
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/RoleModelAdapterOutput must be a mapping/);
    expect(arrayOutputLog.entries[0]?.data['raw_model_output_snapshot']).toEqual({
      raw_value: "['bad', None, True, {'model_id': 'fake', 'ok': False}]"
    });
    expect(arrayOutputLog.entries[0]?.data).not.toHaveProperty('model_output');
  });

  it('passes a clone to the adapter and logs the pre-mutation input snapshot', () => {
    const rawLog = new RecordingRawEventLog();
    const adapter = new MutatingRoleModelAdapter();

    runRoleModelTurn(normalizedUserMessage(), {
      adapter,
      rawEventLog: rawLog,
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    expect(adapter.inputs[0]?.event.text).toBe('mutated by adapter');
    expect(rawLog.entries[0]?.data['model_input']).toMatchObject({
      event: { text: 'hello' }
    });
  });
});
