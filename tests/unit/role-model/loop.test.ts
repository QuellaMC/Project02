import { describe, expect, it } from 'vitest';

import {
  INCIDENT_CANCEL_ROLE_MODEL_INSTRUCTIONS,
  INCIDENT_COMPLETE_ROLE_MODEL_INSTRUCTIONS,
  INCIDENT_START_ROLE_MODEL_INSTRUCTIONS,
  ROLE_MODEL_INSTRUCTIONS,
  RoleModelValidationError,
  INCIDENT_CANCEL_MODEL_ACTION_SPEC,
  INCIDENT_COMPLETE_MODEL_ACTION_SPEC,
  INCIDENT_START_MODEL_ACTION_SPEC,
  STATE_PATCH_MODEL_ACTION_SPEC,
  STATE_PATCH_ROLE_MODEL_INSTRUCTIONS,
  buildDecisionContext,
  buildRoleModelContextFailedLogEntry,
  buildRoleModelTurnCompletedLogEntry,
  buildRoleModelTurnFailedLogEntry,
  parseCharacterDecision,
  renderRoleModelInput
} from '../../../src/role-model/loop.ts';
import type {
  ActiveIncidentRequest,
  CurrentCharacterStateRequest
} from '../../../src/character/state/current.ts';
import type { DecisionContextSectionRequest } from '../../../src/character/state/context.ts';
import type { UserMessageRuntimeEvent } from '../../../src/runtime/contracts.ts';
import type { IdGenerator } from '../../../src/runtime/logging.ts';

function normalizedUserMessage(): UserMessageRuntimeEvent {
  return {
    event_id: 'event-1',
    trace_id: 'trace-1',
    type: 'USER_MESSAGE',
    created_at: '2026-05-14T11:30:00+00:00',
    schema_version: '0.1',
    payload: {
      text: 'hello',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    }
  };
}

function currentStateSnapshot() {
  return {
    schema_version: '0.1',
    character_id: 'character-1',
    living_state: {
      current_activity: 'writing notes',
      mood: 'focused',
      toward_user: 'warm'
    },
    updated_at: '2026-05-14T11:29:00+00:00',
    source_event_ids: ['event-state-1']
  };
}

function activeIncidentSnapshot() {
  return {
    schema_version: '0.1',
    incident_id: 'incident-1',
    type: 'eat',
    status: 'active',
    title: 'Eating lunch',
    remaining_seconds: 600,
    interrupt_policy: 'interruptible',
    resume_policy: 'resume',
    source_event_ids: ['event-incident-started']
  };
}

function livingStateBrief() {
  return {
    character_id: 'character-1',
    current_activity: 'writing notes',
    mood: 'focused',
    toward_user: 'warm',
    updated_at: '2026-05-14T11:29:00+00:00',
    source_event_ids: ['event-state-1']
  };
}

function activeIncidentBrief() {
  return {
    incident_id: 'incident-1',
    type: 'eat',
    title: 'Eating lunch',
    remaining_seconds: 600,
    interrupt_policy: 'interruptible',
    resume_policy: 'resume',
    source_event_ids: ['event-incident-started']
  };
}

function adapterOutput(rawText: string, extra: Record<string, unknown> = {}) {
  return {
    model_id: 'fake-role-model',
    created_at: '2026-05-14T11:31:00+00:00',
    raw_text: rawText,
    ...extra
  };
}

function visibleReplyRaw(text = ' Hi there. '): string {
  return JSON.stringify({
    schema_version: '0.1',
    action: 'visible_reply',
    visible_reply: { text }
  });
}

function fixedClock(): Date {
  return new Date('2026-05-14T11:32:00.000Z');
}

class SequenceIdGenerator {
  readonly calls: string[] = [];

  generate: IdGenerator = (kind: string): string => {
    this.calls.push(kind);
    return `${kind}-generated-${String(this.calls.length)}`;
  };
}

class RecordingCurrentStateSource {
  readonly requests: CurrentCharacterStateRequest[] = [];

  readCurrentState(request: CurrentCharacterStateRequest): unknown {
    this.requests.push(structuredClone(request));
    return currentStateSnapshot();
  }
}

class RecordingActiveIncidentSource {
  readonly requests: ActiveIncidentRequest[] = [];

  readActiveIncident(request: ActiveIncidentRequest): unknown {
    this.requests.push(structuredClone(request));
    return activeIncidentSnapshot();
  }
}

class RecordingDecisionContextSectionProvider {
  readonly requests: DecisionContextSectionRequest[] = [];

  buildDecisionContextSections(request: DecisionContextSectionRequest): unknown {
    this.requests.push(structuredClone(request));
    return [
      {
        schema_version: '0.1',
        section_id: 'runtime-note-1',
        section_type: 'runtime_note',
        content: { summary: 'User is asking about prior work.' },
        source_event_ids: ['event-1']
      }
    ];
  }
}

function mutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected mutable record');
  }
  return value as Record<string, unknown>;
}

describe('role model input envelope', () => {
  it('renders a stable default envelope outside DecisionContext', () => {
    const event = normalizedUserMessage();
    const context = buildDecisionContext(event);

    const modelInput = renderRoleModelInput(event, context);

    expect(modelInput).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      call_type: 'user_message_visible_reply',
      event: {
        type: 'USER_MESSAGE',
        text: 'hello',
        created_at: '2026-05-14T11:30:00+00:00',
        user_id: 'user-1',
        conversation_id: 'conversation-1'
      },
      allowed_actions: ['visible_reply'],
      instructions: ROLE_MODEL_INSTRUCTIONS,
      decision_context: context
    });
    expect(modelInput.decision_context).not.toHaveProperty('call_type');
    expect(modelInput.decision_context).not.toHaveProperty('event');
    expect(modelInput.decision_context).not.toHaveProperty('allowed_actions');

    context.character_snapshot.recent_visible_messages.push({
      schema_version: '0.1',
      message_id: 'message-1',
      trace_id: 'trace-message-1',
      source_event_id: 'event-message-1',
      conversation_id: 'conversation-1',
      role: 'assistant',
      created_at: '2026-05-14T11:20:00+00:00',
      text: 'previous reply'
    });
    expect(modelInput.decision_context.character_snapshot.recent_visible_messages).toEqual([]);
  });

  it('renders provider sections through the role-model context boundary', () => {
    const event = normalizedUserMessage();
    const sectionProvider = new RecordingDecisionContextSectionProvider();
    const context = buildDecisionContext(event, {
      contextSectionProviders: [sectionProvider]
    });

    const modelInput = renderRoleModelInput(event, context);

    expect(sectionProvider.requests).toHaveLength(1);
    expect(modelInput.decision_context.character_snapshot).toEqual({
      recent_visible_messages: []
    });
    expect(modelInput.decision_context.context_sections).toEqual([
      {
        schema_version: '0.1',
        section_id: 'runtime-note-1',
        section_type: 'runtime_note',
        content: { summary: 'User is asking about prior work.' },
        source_event_ids: ['event-1']
      }
    ]);

    const [section] = context.context_sections ?? [];
    if (section === undefined) {
      throw new Error('expected context section');
    }
    section.content['summary'] = 'mutated after render';
    expect(modelInput.decision_context.context_sections?.[0]?.content).toEqual({
      summary: 'User is asking about prior work.'
    });
  });

  it('renders state patch and life action opt-in envelopes with exact instructions', () => {
    const event = normalizedUserMessage();
    const currentStateSource = new RecordingCurrentStateSource();
    const stateContext = buildDecisionContext(event, {
      currentStateSource,
      modelActionSpec: STATE_PATCH_MODEL_ACTION_SPEC
    });
    const stateModelInput = renderRoleModelInput(event, stateContext, {
      modelActionSpec: STATE_PATCH_MODEL_ACTION_SPEC
    });

    expect(stateModelInput.allowed_actions).toEqual(['visible_reply', 'state_patch']);
    expect(stateModelInput.instructions).toBe(STATE_PATCH_ROLE_MODEL_INSTRUCTIONS);
    expect(stateModelInput.decision_context.character_snapshot.living_state_brief).toEqual(
      livingStateBrief()
    );
    expect(stateModelInput).not.toHaveProperty('allowed_life_action_type');

    const startContext = buildDecisionContext(event, {
      modelActionSpec: INCIDENT_START_MODEL_ACTION_SPEC
    });
    const startModelInput = renderRoleModelInput(event, startContext, {
      modelActionSpec: INCIDENT_START_MODEL_ACTION_SPEC
    });
    expect(startModelInput.allowed_actions).toEqual(['visible_reply', 'life_action']);
    expect(startModelInput.allowed_life_action_type).toBe('start_incident');
    expect(startModelInput.instructions).toBe(INCIDENT_START_ROLE_MODEL_INSTRUCTIONS);

    const activeIncidentSource = new RecordingActiveIncidentSource();
    const cancelContext = buildDecisionContext(event, {
      activeIncidentSource,
      modelActionSpec: INCIDENT_CANCEL_MODEL_ACTION_SPEC
    });
    const cancelModelInput = renderRoleModelInput(event, cancelContext, {
      modelActionSpec: INCIDENT_CANCEL_MODEL_ACTION_SPEC
    });
    expect(cancelModelInput.allowed_life_action_type).toBe('cancel_incident');
    expect(cancelModelInput.instructions).toBe(INCIDENT_CANCEL_ROLE_MODEL_INSTRUCTIONS);
    expect(cancelModelInput.decision_context.character_snapshot.active_incident).toEqual(
      activeIncidentBrief()
    );

    const completeContext = buildDecisionContext(event, {
      activeIncidentSource,
      modelActionSpec: INCIDENT_COMPLETE_MODEL_ACTION_SPEC
    });
    const completeModelInput = renderRoleModelInput(event, completeContext, {
      modelActionSpec: INCIDENT_COMPLETE_MODEL_ACTION_SPEC
    });
    expect(completeModelInput.allowed_life_action_type).toBe('complete_incident');
    expect(completeModelInput.instructions).toBe(INCIDENT_COMPLETE_ROLE_MODEL_INSTRUCTIONS);
  });

  it('rejects invalid write-action opt-ins and malformed context envelopes', () => {
    const event = normalizedUserMessage();
    expect(() =>
      buildDecisionContext(event, { modelActionSpec: STATE_PATCH_MODEL_ACTION_SPEC })
    ).toThrow(
      /current_state_source/
    );
    expect(() =>
      buildDecisionContext(event, { modelActionSpec: INCIDENT_CANCEL_MODEL_ACTION_SPEC })
    ).toThrow(/active_incident_source/);

    const context = mutableRecord(buildDecisionContext(event));
    context['call_type'] = 'user_message_visible_reply';
    expect(() => renderRoleModelInput(event, context)).toThrow(/call_type/);

    const activeContext = buildDecisionContext(event, {
      activeIncidentSource: new RecordingActiveIncidentSource()
    });
    const activeSnapshot = mutableRecord(activeContext.character_snapshot);
    activeSnapshot['interrupted_incident'] = {
      ...activeIncidentBrief(),
      interrupted_at: '2026-05-14T11:30:00+00:00',
      source_event_ids: ['event-incident-started', 'event-1']
    };
    expect(() => renderRoleModelInput(event, activeContext)).toThrow(/active_incident/);

    const flagContext = buildDecisionContext(event);
    mutableRecord(flagContext.character_snapshot)['user_message_interrupted_active_incident'] =
      false;
    expect(() => renderRoleModelInput(event, flagContext)).toThrow(/must be true/);
  });
});

describe('character decision parser', () => {
  it('parses visible replies and optional write actions from JSON model output', () => {
    const event = normalizedUserMessage();
    expect(
      parseCharacterDecision(
        renderRoleModelInput(event, buildDecisionContext(event)),
        adapterOutput(visibleReplyRaw())
      )
    ).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      action: 'visible_reply',
      visible_reply: { text: 'Hi there.' }
    });

    const stateModelInput = renderRoleModelInput(
      event,
      buildDecisionContext(event, {
        currentStateSource: new RecordingCurrentStateSource(),
        modelActionSpec: STATE_PATCH_MODEL_ACTION_SPEC
      }),
      { modelActionSpec: STATE_PATCH_MODEL_ACTION_SPEC }
    );
    expect(
      parseCharacterDecision(
        stateModelInput,
        adapterOutput(
          JSON.stringify({
            schema_version: '0.1',
            action: 'visible_reply',
            visible_reply: { text: 'ok' },
            state_patch: {
              living_state: {
                current_activity: ' answering ',
                mood: ' attentive '
              }
            }
          })
        )
      ).state_patch
    ).toEqual({
      living_state: {
        current_activity: 'answering',
        mood: 'attentive'
      }
    });

    const startModelInput = renderRoleModelInput(
      event,
      buildDecisionContext(event, { modelActionSpec: INCIDENT_START_MODEL_ACTION_SPEC }),
      { modelActionSpec: INCIDENT_START_MODEL_ACTION_SPEC }
    );
    expect(
      parseCharacterDecision(
        startModelInput,
        adapterOutput(
          JSON.stringify({
            schema_version: '0.1',
            action: 'visible_reply',
            visible_reply: { text: 'ok' },
            life_action: {
              type: 'start_incident',
              incident: {
                type: 'think',
                title: ' Thinking ',
                remaining_seconds: 120,
                interrupt_policy: 'interruptible',
                resume_policy: 'ask_model'
              }
            }
          })
        )
      ).life_action
    ).toEqual({
      type: 'start_incident',
      incident: {
        type: 'think',
        title: 'Thinking',
        remaining_seconds: 120,
        interrupt_policy: 'interruptible',
        resume_policy: 'ask_model'
      }
    });

    const cancelModelInput = renderRoleModelInput(
      event,
      buildDecisionContext(event, {
        activeIncidentSource: new RecordingActiveIncidentSource(),
        modelActionSpec: INCIDENT_CANCEL_MODEL_ACTION_SPEC
      }),
      { modelActionSpec: INCIDENT_CANCEL_MODEL_ACTION_SPEC }
    );
    expect(
      parseCharacterDecision(
        cancelModelInput,
        adapterOutput(
          JSON.stringify({
            schema_version: '0.1',
            action: 'visible_reply',
            visible_reply: { text: 'ok' },
            life_action: {
              type: 'cancel_incident',
              incident_id: ' incident-1 ',
              reason: ' user needs attention '
            }
          })
        )
      ).life_action
    ).toEqual({
      type: 'cancel_incident',
      incident_id: 'incident-1',
      reason: 'user needs attention'
    });

    const completeModelInput = renderRoleModelInput(
      event,
      buildDecisionContext(event, {
        activeIncidentSource: new RecordingActiveIncidentSource(),
        modelActionSpec: INCIDENT_COMPLETE_MODEL_ACTION_SPEC
      }),
      { modelActionSpec: INCIDENT_COMPLETE_MODEL_ACTION_SPEC }
    );
    expect(
      parseCharacterDecision(
        completeModelInput,
        adapterOutput(
          JSON.stringify({
            schema_version: '0.1',
            action: 'visible_reply',
            visible_reply: { text: 'ok' },
            life_action: {
              type: 'complete_incident',
              incident_id: ' incident-1 '
            }
          })
        )
      ).life_action
    ).toEqual({
      type: 'complete_incident',
      incident_id: 'incident-1'
    });
  });

  it('rejects malformed model input and model output contracts', () => {
    const event = normalizedUserMessage();
    const modelInput = renderRoleModelInput(event, buildDecisionContext(event));

    expect(() =>
      parseCharacterDecision(modelInput, adapterOutput('{not json'))
    ).toThrow(/raw_text/);
    expect(() =>
      parseCharacterDecision(modelInput, adapterOutput(JSON.stringify([])))
    ).toThrow(/raw_text must contain a JSON object/);
    expect(() =>
      parseCharacterDecision(modelInput, adapterOutput(JSON.stringify(null)))
    ).toThrow(/raw_text must contain a JSON object/);
    expect(() =>
      parseCharacterDecision(modelInput, adapterOutput(JSON.stringify('text')))
    ).toThrow(/raw_text must contain a JSON object/);
    expect(() =>
      parseCharacterDecision(
        modelInput,
        adapterOutput(
          JSON.stringify({
            schema_version: '0.1',
            action: 'visible_reply',
            visible_reply: { text: 'ok' },
            state_patch: { living_state: { mood: 'focused' } }
          })
        )
      )
    ).toThrow(/state_patch/);
    expect(() =>
      parseCharacterDecision(
        modelInput,
        adapterOutput(
          JSON.stringify({
            schema_version: '0.1',
            action: 'visible_reply',
            visible_reply: { text: 'ok' },
            life_action: {
              type: 'start_incident',
              incident: {
                type: 'think',
                title: 'Think',
                interrupt_policy: 'interruptible',
                resume_policy: 'resume'
              }
            }
          })
        )
      )
    ).toThrow(/life_action/);

    const startModelInput = mutableRecord(
      renderRoleModelInput(
        event,
        buildDecisionContext(event, { modelActionSpec: INCIDENT_START_MODEL_ACTION_SPEC }),
        { modelActionSpec: INCIDENT_START_MODEL_ACTION_SPEC }
      )
    );
    startModelInput['instructions'] = INCIDENT_CANCEL_ROLE_MODEL_INSTRUCTIONS;
    expect(() => parseCharacterDecision(startModelInput, adapterOutput('{}'))).toThrow(
      /instructions/
    );

    const missingSubtypeInput = mutableRecord(
      renderRoleModelInput(
        event,
        buildDecisionContext(event, { modelActionSpec: INCIDENT_START_MODEL_ACTION_SPEC }),
        { modelActionSpec: INCIDENT_START_MODEL_ACTION_SPEC }
      )
    );
    delete missingSubtypeInput['allowed_life_action_type'];
    expect(() => parseCharacterDecision(missingSubtypeInput, adapterOutput('{}'))).toThrow(
      /allowed_life_action_type/
    );

    const extraFieldInput = mutableRecord(
      renderRoleModelInput(event, buildDecisionContext(event))
    );
    extraFieldInput['future_field'] = 'not allowed';
    expect(() => parseCharacterDecision(extraFieldInput, adapterOutput('{}'))).toThrow(
      RoleModelValidationError
    );

    const extraEventFieldInput = renderRoleModelInput(event, buildDecisionContext(event));
    mutableRecord(extraEventFieldInput.event)['future_field'] = 'not allowed';
    expect(() => parseCharacterDecision(extraEventFieldInput, adapterOutput('{}'))).toThrow(
      RoleModelValidationError
    );

    const cancelModelInput = renderRoleModelInput(
      event,
      buildDecisionContext(event, {
        activeIncidentSource: new RecordingActiveIncidentSource(),
        modelActionSpec: INCIDENT_CANCEL_MODEL_ACTION_SPEC
      }),
      { modelActionSpec: INCIDENT_CANCEL_MODEL_ACTION_SPEC }
    );
    expect(() =>
      parseCharacterDecision(
        cancelModelInput,
        adapterOutput(
          JSON.stringify({
            schema_version: '0.1',
            action: 'visible_reply',
            visible_reply: { text: 'ok' },
            life_action: {
              type: 'start_incident',
              incident: {
                type: 'think',
                title: 'Think',
                interrupt_policy: 'interruptible',
                resume_policy: 'resume'
              }
            }
          })
        )
      )
    ).toThrow(/cancel_incident/);
  });
});

describe('role model log entries', () => {
  it('builds context failure logs without model input', () => {
    const ids = new SequenceIdGenerator();
    const entry = buildRoleModelContextFailedLogEntry(normalizedUserMessage(), {
      stage: 'context_build',
      code: 'malformed_context',
      message: 'active_incident.status must be active',
      idGenerator: ids.generate,
      clock: fixedClock
    });

    expect(entry.kind).toBe('role_model_turn_failed');
    expect(entry.trace_id).toBe('trace-1');
    expect(entry.event_id).toBe('event-1');
    expect(entry.data).toEqual({
      event: normalizedUserMessage(),
      failure: {
        stage: 'context_build',
        code: 'malformed_context',
        message: 'active_incident.status must be active'
      }
    });
    expect(entry.data).not.toHaveProperty('model_input');
  });

  it('builds completed logs with cloned snapshots and projected adapter output', () => {
    const event = normalizedUserMessage();
    const modelInput = renderRoleModelInput(event, buildDecisionContext(event));
    const modelOutput = adapterOutput(visibleReplyRaw(' hello '), { ignored: true });
    const decision = {
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      action: 'visible_reply',
      visible_reply: { text: ' hello ' }
    };

    const entry = buildRoleModelTurnCompletedLogEntry(modelInput, modelOutput, decision, {
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });

    modelInput.event.text = 'mutated input';
    modelOutput.raw_text = 'mutated output';
    decision.visible_reply.text = 'mutated decision';

    expect(entry.data['model_input']).toMatchObject({
      event: { text: 'hello' }
    });
    expect(entry.data['model_output']).toEqual({
      model_id: 'fake-role-model',
      created_at: '2026-05-14T11:31:00+00:00',
      raw_text: visibleReplyRaw(' hello ')
    });
    expect(entry.data['decision']).toMatchObject({
      visible_reply: { text: 'hello' }
    });
  });

  it('builds failed logs with valid model output or raw snapshots', () => {
    const modelInput = renderRoleModelInput(
      normalizedUserMessage(),
      buildDecisionContext(normalizedUserMessage())
    );
    const validFailure = buildRoleModelTurnFailedLogEntry(modelInput, {
      modelOutput: adapterOutput(visibleReplyRaw(), { ignored: true }),
      stage: 'parse_output',
      code: 'malformed_model_output',
      message: 'bad output',
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expect(validFailure.data).toMatchObject({
      model_output: {
        model_id: 'fake-role-model',
        created_at: '2026-05-14T11:31:00+00:00',
        raw_text: visibleReplyRaw()
      },
      failure: {
        stage: 'parse_output',
        code: 'malformed_model_output',
        message: 'bad output'
      }
    });
    expect(mutableRecord(validFailure.data['model_output'])).not.toHaveProperty('ignored');

    const badShape = {
      model_id: 'fake-role-model',
      created_at: '2026-05-14T11:31:00+00:00'
    };
    const invalidFailure = buildRoleModelTurnFailedLogEntry(modelInput, {
      modelOutput: badShape,
      stage: 'parse_output',
      code: 'malformed_model_output',
      message: 'bad output',
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expect(invalidFailure.data['raw_model_output_snapshot']).toEqual(badShape);
    expect(invalidFailure.data).not.toHaveProperty('model_output');

    const uncloneableShape: Record<string, unknown> = {
      model_id: 'fake-role-model',
      created_at: '2026-05-14T11:31:00+00:00',
      callback: () => undefined
    };
    uncloneableShape['self'] = uncloneableShape;
    const uncloneableFailure = buildRoleModelTurnFailedLogEntry(modelInput, {
      modelOutput: uncloneableShape,
      stage: 'parse_output',
      code: 'malformed_model_output',
      message: 'bad output',
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expect(uncloneableFailure.data['raw_model_output_snapshot']).toEqual({
      model_id: 'fake-role-model',
      created_at: '2026-05-14T11:31:00+00:00',
      callback: { raw_value: '[Function]' },
      self: { raw_value: '{...}' }
    });
    expect(uncloneableFailure.data).not.toHaveProperty('model_output');

    const primitiveFailure = buildRoleModelTurnFailedLogEntry(modelInput, {
      modelOutput: 'bad',
      stage: 'parse_output',
      code: 'malformed_model_output',
      message: 'bad output',
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expect(primitiveFailure.data['raw_model_output_snapshot']).toEqual({
      raw_value: "'bad'"
    });

    const quotedPrimitiveFailure = buildRoleModelTurnFailedLogEntry(modelInput, {
      modelOutput: 'has \' quote',
      stage: 'parse_output',
      code: 'malformed_model_output',
      message: 'bad output',
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expect(quotedPrimitiveFailure.data['raw_model_output_snapshot']).toEqual({
      raw_value: '"has \' quote"'
    });

    const controlPrimitiveFailure = buildRoleModelTurnFailedLogEntry(modelInput, {
      modelOutput: 'line\nbreak\t\x00',
      stage: 'parse_output',
      code: 'malformed_model_output',
      message: 'bad output',
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expect(controlPrimitiveFailure.data['raw_model_output_snapshot']).toEqual({
      raw_value: "'line\\nbreak\\t\\x00'"
    });

    const arrayPrimitiveFailure = buildRoleModelTurnFailedLogEntry(modelInput, {
      modelOutput: ['bad', null, true, { model_id: 'fake', ok: false }],
      stage: 'parse_output',
      code: 'malformed_model_output',
      message: 'bad output',
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expect(arrayPrimitiveFailure.data['raw_model_output_snapshot']).toEqual({
      raw_value: "['bad', None, True, {'model_id': 'fake', 'ok': False}]"
    });

    const nullFailure = buildRoleModelTurnFailedLogEntry(modelInput, {
      modelOutput: null,
      stage: 'parse_output',
      code: 'malformed_model_output',
      message: 'bad output',
      idGenerator: new SequenceIdGenerator().generate,
      clock: fixedClock
    });
    expect(nullFailure.data).not.toHaveProperty('raw_model_output_snapshot');
    expect(nullFailure.data).not.toHaveProperty('model_output');

    expect(() =>
      buildRoleModelTurnFailedLogEntry(modelInput, {
        stage: 'adapter_call',
        code: 'malformed_model_output',
        message: 'bad output',
        idGenerator: new SequenceIdGenerator().generate,
        clock: fixedClock
      })
    ).toThrow(/failure.code/);
  });
});
