import { describe, expect, it } from 'vitest';

import {
  CANCEL_INCIDENT_ACTION,
  COMPLETE_INCIDENT_ACTION,
  ContractValidationError,
  DECISION_READY_FOR_COMMIT_STATUS,
  START_INCIDENT_ACTION,
  USER_MESSAGE,
  VISIBLE_REPLY_ACTION,
  normalizeCancelIncidentLifeAction,
  normalizeCompleteIncidentLifeAction,
  normalizeLifeAction,
  normalizeLivingStatePatch,
  normalizeRoleModelTurnResult,
  normalizeStartIncidentLifeAction,
  normalizeVisibleReplyDecision,
  normalizeVisibleReplyDecisionWithOptionalLifeAction,
  normalizeVisibleReplyDecisionWithOptionalLivingStatePatch,
  validateNormalizedIncidentCompletionEvent,
  validateNormalizedUserMessageEvent
} from '../../../src/runtime/contracts.ts';

function normalizedUserMessage() {
  return {
    event_id: 'event-1',
    trace_id: 'trace-1',
    type: 'USER_MESSAGE',
    created_at: '2026-05-15T11:59:00+00:00',
    schema_version: '0.1',
    payload: { text: 'hello', conversation_id: 'conversation-1' }
  };
}

function roleModelResult(decision?: unknown) {
  return {
    trace_id: 'trace-1',
    event_id: 'event-1',
    event_type: USER_MESSAGE,
    model_called: true,
    status: DECISION_READY_FOR_COMMIT_STATUS,
    decision:
      decision ??
      {
        schema_version: '0.1',
        trace_id: 'trace-1',
        event_id: 'event-1',
        action: VISIBLE_REPLY_ACTION,
        visible_reply: { text: 'hello back' }
      }
  };
}

function objectWithPrototypeFields(
  prototypeFields: Record<string, unknown>
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  Object.setPrototypeOf(target, prototypeFields);
  return target;
}

describe('runtime contract validators', () => {
  it('validates normalized user message events and rejects date-only timestamps', () => {
    const event = validateNormalizedUserMessageEvent(normalizedUserMessage());

    expect(event.created_at).toBe('2026-05-15T11:59:00+00:00');
    expect(event.payload.conversation_id).toBe('conversation-1');

    expect(() =>
      validateNormalizedUserMessageEvent({
        ...normalizedUserMessage(),
        created_at: '2026-05-15'
      })
    ).toThrow(ContractValidationError);

    for (const createdAt of [
      '2026-02-30T00:00:00+00:00',
      '2026/05/15T11:59:00+00:00',
      ' 2026-05-15T11:59:00+00:00 ',
      '2026-05-15    11:59:00+00:00'
    ]) {
      expect(() =>
        validateNormalizedUserMessageEvent({
          ...normalizedUserMessage(),
          created_at: createdAt
        })
      ).toThrow(ContractValidationError);
    }

    for (const createdAt of [
      '2026-05-15T11:59:00,123456+00:00',
      '2026-W20-5T11:59:00+00:00',
      '0004-W53-1T00:00:00',
      '9999-W52-5T00:00:00',
      '20260515T115900+0000',
      '2026-05-15T11.5',
      '2026-05-15T1159.5',
      '2026-05-15T11:59.5',
      '2026-05-15T11:59:00+00:00:30',
      '2026-05-15T11:59:00+00:00:30.5',
      '2026-05-15T11:59:00+000030,5',
      '2026-05-15T11:59:00+00:60:00',
      '2026-05-15 11.5'
    ]) {
      expect(
        validateNormalizedUserMessageEvent({
          ...normalizedUserMessage(),
          created_at: createdAt
        }).created_at
      ).toBe(createdAt);
    }

    for (const createdAt of [
      '0000-01-01T00:00:00',
      '0000-W01-1T00:00:00',
      '0003-W53-1T00:00:00',
      '9999-W52-6T00:00:00',
      '9999-W52-7T00:00:00',
      '2026-0515T11:59:00',
      '202605-15T11:59:00',
      '2026-W205T11:59:00',
      '2026W20-5T11:59:00',
      '2026-05-15X11:59:00+00:00',
      '2026-05-15_11:59:00+00:00',
      '2026-05-15/11:59:00+00:00'
    ]) {
      expect(() =>
        validateNormalizedUserMessageEvent({
          ...normalizedUserMessage(),
          created_at: createdAt
        })
      ).toThrow(ContractValidationError);
    }
  });

  it('validates incident completion events with strict payload keys', () => {
    const event = validateNormalizedIncidentCompletionEvent({
      event_id: 'event-1',
      trace_id: 'trace-1',
      type: 'INCIDENT_COMPLETION',
      created_at: '2026-05-15T11:59:00+00:00',
      schema_version: '0.1',
      payload: {
        incident_id: ' incident-1 ',
        user_id: 'u-1',
        conversation_id: 'c-1'
      }
    });

    expect(event.payload).toEqual({
      incident_id: 'incident-1',
      user_id: 'u-1',
      conversation_id: 'c-1'
    });

    expect(() =>
      validateNormalizedIncidentCompletionEvent({
        ...event,
        payload: { incident_id: 'incident-1', future: 'nope' }
      })
    ).toThrow(/future/);
  });

  it('rejects inherited event and payload fields in runtime events', () => {
    const inheritedEvent = objectWithPrototypeFields(normalizedUserMessage());
    const inheritedUserPayload = objectWithPrototypeFields({ text: 'hello' });
    const inheritedIncidentPayload = objectWithPrototypeFields({
      incident_id: 'incident-1'
    });

    expect(() => validateNormalizedUserMessageEvent(inheritedEvent)).toThrow(/RuntimeEvent/);
    expect(() =>
      validateNormalizedUserMessageEvent({
        ...normalizedUserMessage(),
        payload: inheritedUserPayload
      })
    ).toThrow(/payload/);
    expect(() =>
      validateNormalizedIncidentCompletionEvent({
        event_id: 'event-1',
        trace_id: 'trace-1',
        type: 'INCIDENT_COMPLETION',
        created_at: '2026-05-15T11:59:00+00:00',
        schema_version: '0.1',
        payload: inheritedIncidentPayload
      })
    ).toThrow(/payload/);
  });

  it('normalizes visible replies and preserves identity mismatch error code', () => {
    const decision = normalizeVisibleReplyDecision(
      {
        schema_version: '0.1',
        trace_id: 'trace-1',
        event_id: 'event-1',
        action: 'visible_reply',
        visible_reply: { text: ' hello back ' }
      },
      { traceId: 'trace-1', eventId: 'event-1', requireAttachedIds: true }
    );

    expect(decision.visible_reply.text).toBe('hello back');

    try {
      normalizeVisibleReplyDecision(
        {
          schema_version: '0.1',
          trace_id: 'trace-1',
          event_id: 'event-1',
          action: 'visible_reply',
          visible_reply: { text: '   ' }
        },
        { traceId: 'trace-1', eventId: 'event-1', requireAttachedIds: true }
      );
      throw new Error('expected blank reply to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError);
      expect((error as ContractValidationError).code).toBe('empty_reply_text');
    }

    try {
      normalizeVisibleReplyDecision(
        {
          schema_version: '0.1',
          trace_id: 'trace-2',
          event_id: 'event-1',
          action: 'visible_reply',
          visible_reply: { text: 'hello' }
        },
        { traceId: 'trace-1', eventId: 'event-1', requireAttachedIds: true }
      );
      throw new Error('expected mismatch to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError);
      expect((error as ContractValidationError).code).toBe('identity_mismatch');
    }
  });

  it('rejects inherited decision and nested visible reply fields', () => {
    const inheritedDecision = objectWithPrototypeFields({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      action: 'visible_reply',
      visible_reply: { text: 'hello' }
    });
    const inheritedVisibleReply = objectWithPrototypeFields({ text: 'hello' });

    expect(() =>
      normalizeVisibleReplyDecision(inheritedDecision, {
        traceId: 'trace-1',
        eventId: 'event-1',
        requireAttachedIds: true
      })
    ).toThrow(/CharacterDecision/);
    expect(() =>
      normalizeVisibleReplyDecision(
        {
          schema_version: '0.1',
          trace_id: 'trace-1',
          event_id: 'event-1',
          action: 'visible_reply',
          visible_reply: inheritedVisibleReply
        },
        { traceId: 'trace-1', eventId: 'event-1', requireAttachedIds: true }
      )
    ).toThrow(/visible_reply/);
  });

  it('normalizes optional living-state patches and rejects future fields', () => {
    const patch = normalizeLivingStatePatch({
      living_state: {
        current_activity: ' writing notes ',
        mood: ' focused '
      }
    });

    expect(patch).toEqual({
      living_state: {
        current_activity: 'writing notes',
        mood: 'focused'
      }
    });

    expect(() =>
      normalizeLivingStatePatch({ living_state: { body_state: 'awake' } })
    ).toThrow(/body_state/);

    const decision = normalizeVisibleReplyDecisionWithOptionalLivingStatePatch(
      {
        schema_version: '0.1',
        trace_id: 'trace-1',
        event_id: 'event-1',
        action: 'visible_reply',
        visible_reply: { text: ' hello back ' },
        state_patch: {
          living_state: {
            current_activity: ' answering Mike ',
            toward_user: ' attentive '
          }
        }
      },
      {
        traceId: 'trace-1',
        eventId: 'event-1',
        requireAttachedIds: true,
        allowStatePatch: true
      }
    );

    expect(decision.state_patch).toEqual({
      living_state: {
        current_activity: 'answering Mike',
        toward_user: 'attentive'
      }
    });
  });

  it('rejects inherited state patch and life action fields', () => {
    const inheritedStatePatch = objectWithPrototypeFields({
      living_state: { mood: 'focused' }
    });
    const inheritedLivingState = objectWithPrototypeFields({ mood: 'focused' });
    const inheritedLifeAction = objectWithPrototypeFields({
      type: 'start_incident',
      incident: {
        type: 'think',
        title: 'Think',
        interrupt_policy: 'interruptible',
        resume_policy: 'resume'
      }
    });
    const inheritedIncident = objectWithPrototypeFields({
      type: 'think',
      title: 'Think',
      interrupt_policy: 'interruptible',
      resume_policy: 'resume'
    });

    expect(() => normalizeLivingStatePatch(inheritedStatePatch)).toThrow(/state_patch/);
    expect(() =>
      normalizeLivingStatePatch({ living_state: inheritedLivingState })
    ).toThrow(/living_state/);
    expect(() => normalizeStartIncidentLifeAction(inheritedLifeAction)).toThrow(/life_action/);
    expect(() =>
      normalizeStartIncidentLifeAction({
        type: 'start_incident',
        incident: inheritedIncident
      })
    ).toThrow(/incident/);
  });

  it('normalizes start cancel and complete incident life actions', () => {
    expect(
      normalizeStartIncidentLifeAction({
        type: 'start_incident',
        incident: {
          type: 'think',
          title: ' Thinking through the plan ',
          remaining_seconds: 300,
          interrupt_policy: 'interruptible',
          resume_policy: 'ask_model'
        }
      })
    ).toEqual({
      type: 'start_incident',
      incident: {
        type: 'think',
        title: 'Thinking through the plan',
        remaining_seconds: 300,
        interrupt_policy: 'interruptible',
        resume_policy: 'ask_model'
      }
    });

    expect(
      normalizeCancelIncidentLifeAction({
        type: 'cancel_incident',
        incident_id: ' incident-1 ',
        reason: ' User needs me now. '
      })
    ).toEqual({
      type: 'cancel_incident',
      incident_id: 'incident-1',
      reason: 'User needs me now.'
    });

    expect(
      normalizeCompleteIncidentLifeAction({
        type: 'complete_incident',
        incident_id: ' incident-1 '
      })
    ).toEqual({ type: 'complete_incident', incident_id: 'incident-1' });
  });

  it('rejects life action subtype drift and state-patch/life-action composition', () => {
    expect(() =>
      normalizeVisibleReplyDecisionWithOptionalLifeAction(
        {
          schema_version: '0.1',
          action: 'visible_reply',
          visible_reply: { text: 'hello' },
          life_action: {
            type: 'cancel_incident',
            incident_id: 'incident-1',
            reason: 'stop'
          }
        },
        {
          traceId: 'trace-1',
          eventId: 'event-1',
          requireAttachedIds: false,
          allowLifeAction: true,
          allowedLifeActionType: START_INCIDENT_ACTION
        }
      )
    ).toThrow(/start_incident/);

    expect(() =>
      normalizeVisibleReplyDecisionWithOptionalLivingStatePatch(
        {
          schema_version: '0.1',
          action: 'visible_reply',
          visible_reply: { text: 'hello' }
        },
        {
          traceId: 'trace-1',
          eventId: 'event-1',
          requireAttachedIds: false,
          allowStatePatch: true,
          allowLifeAction: true
        }
      )
    ).toThrow(/state_patch and life_action/);

    expect(() =>
      normalizeVisibleReplyDecisionWithOptionalLifeAction(
        {
          schema_version: '0.1',
          action: 'visible_reply',
          visible_reply: { text: 'hello' },
          state_patch: { living_state: { mood: 'focused' } }
        },
        {
          traceId: 'trace-1',
          eventId: 'event-1',
          requireAttachedIds: false,
          allowStatePatch: true,
          allowLifeAction: false
        }
      )
    ).toThrow(/state_patch/);

    expect(() =>
      normalizeLifeAction(
        { type: 'unsupported' },
        { allowedLifeActionType: 'unsupported' }
      )
    ).toThrow(/allowed_life_action_type/);
  });

  it('normalizes role-model turn results with supplied decision normalizer', () => {
    const result = normalizeRoleModelTurnResult(roleModelResult(), {
      sourceEvent: normalizedUserMessage(),
      decisionNormalizer: (decision) =>
        normalizeVisibleReplyDecision(decision, {
          traceId: 'trace-1',
          eventId: 'event-1',
          requireAttachedIds: true
        })
    });

    expect(result.status).toBe(DECISION_READY_FOR_COMMIT_STATUS);
    expect(result.decision.visible_reply.text).toBe('hello back');

    const unsupported = roleModelResult();
    unsupported.status = 'already_committed';

    try {
      normalizeRoleModelTurnResult(unsupported, {
        sourceEvent: normalizedUserMessage(),
        decisionNormalizer: (decision) =>
          normalizeVisibleReplyDecision(decision, {
            traceId: 'trace-1',
            eventId: 'event-1',
            requireAttachedIds: true
          })
      });
      throw new Error('expected unsupported status to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError);
      expect((error as ContractValidationError).code).toBe('unsupported_result_status');
    }
  });

  it('rejects inherited role-model turn result fields', () => {
    const inheritedResult = objectWithPrototypeFields(roleModelResult());

    expect(() =>
      normalizeRoleModelTurnResult(inheritedResult, {
        sourceEvent: normalizedUserMessage(),
        decisionNormalizer: (decision) =>
          normalizeVisibleReplyDecision(decision, {
            traceId: 'trace-1',
            eventId: 'event-1',
            requireAttachedIds: true
          })
      })
    ).toThrow(/RoleModelTurnResult/);
  });

  it('rejects malformed life actions with future committed fields', () => {
    expect(() =>
      normalizeStartIncidentLifeAction({
        type: 'start_incident',
        incident: {
          type: 'think',
          title: 'Think',
          status: 'active',
          interrupt_policy: 'interruptible',
          resume_policy: 'resume'
        }
      })
    ).toThrow(/status/);

    expect(() =>
      normalizeCancelIncidentLifeAction({
        type: CANCEL_INCIDENT_ACTION,
        incident_id: 'incident-1',
        reason: 'stop',
        status: 'cancelled'
      })
    ).toThrow(/status/);

    expect(() =>
      normalizeCompleteIncidentLifeAction({
        type: COMPLETE_INCIDENT_ACTION,
        incident_id: 'incident-1',
        reason: 'done'
      })
    ).toThrow(/reason/);
  });
});
