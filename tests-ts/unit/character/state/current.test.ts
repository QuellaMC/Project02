import { describe, expect, it } from 'vitest';

import {
  buildActiveIncidentBrief,
  buildActiveIncidentRequest,
  buildCurrentCharacterStateRequest,
  buildInterruptedIncidentBrief,
  buildLivingStateBrief,
  validateActiveIncidentBriefForEvent,
  validateActiveIncidentRequest,
  validateActiveIncidentSnapshot,
  validateCurrentCharacterStateRequest,
  validateCurrentCharacterStateSnapshot,
  validateInterruptedIncidentBriefForEvent,
  validateInterruptedIncidentSnapshot,
  validateLivingStateBriefForEvent
} from '../../../../src-ts/character/state/current.ts';
import {
  ContractValidationError,
  type IncidentCompletionRuntimeEvent,
  type UserMessageRuntimeEvent
} from '../../../../src-ts/runtime/contracts.ts';

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

function normalizedIncidentCompletion(): IncidentCompletionRuntimeEvent {
  return {
    event_id: 'event-complete',
    trace_id: 'trace-complete',
    type: 'INCIDENT_COMPLETION',
    created_at: '2026-05-14T11:40:00+00:00',
    schema_version: '0.1',
    payload: {
      incident_id: 'incident-1',
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
    source_event_ids: ['event-prior-state']
  };
}

function activeIncidentSnapshot() {
  return {
    schema_version: '0.1',
    incident_id: 'incident-1',
    type: 'eat',
    status: 'active',
    title: 'Eating lunch',
    started_at: '2026-05-14T11:00:00+00:00',
    expected_end_at: '2026-05-14T11:40:00+00:00',
    remaining_seconds: 600,
    interrupt_policy: 'interruptible',
    resume_policy: 'resume',
    source_event_ids: ['event-incident-started']
  };
}

function interruptedIncidentSnapshot() {
  return {
    ...activeIncidentSnapshot(),
    status: 'interrupted',
    interrupted_at: '2026-05-14T11:30:00+00:00',
    source_event_ids: ['event-incident-started', 'event-1']
  };
}

describe('character state read-side requests', () => {
  it('builds current-state and active-incident requests from normalized events', () => {
    expect(buildCurrentCharacterStateRequest(normalizedUserMessage())).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      event_type: 'USER_MESSAGE',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    });

    expect(buildActiveIncidentRequest(normalizedIncidentCompletion())).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-complete',
      event_id: 'event-complete',
      event_type: 'INCIDENT_COMPLETION',
      user_id: 'user-1',
      conversation_id: 'conversation-1'
    });
  });

  it('preserves empty optional identity strings and rejects unsupported request fields', () => {
    const event = normalizedUserMessage();
    event.payload.user_id = '';
    event.payload.conversation_id = '';

    expect(buildCurrentCharacterStateRequest(event)).toMatchObject({
      user_id: '',
      conversation_id: ''
    });
    expect(buildActiveIncidentRequest(event)).toMatchObject({
      user_id: '',
      conversation_id: ''
    });

    expect(() =>
      validateCurrentCharacterStateRequest({
        schema_version: '0.1',
        trace_id: 'trace-1',
        event_id: 'event-1',
        event_type: 'USER_MESSAGE',
        character_id: 'character-1'
      })
    ).toThrow(/character_id/);

    expect(() =>
      validateActiveIncidentRequest({
        schema_version: '0.1',
        trace_id: 'trace-1',
        event_id: 'event-1',
        event_type: 'TIMER'
      })
    ).toThrow(/USER_MESSAGE/);
  });
});

describe('current character state snapshots', () => {
  it('maps current state snapshots to living-state briefs with copy safety', () => {
    const snapshot = currentStateSnapshot();
    const brief = buildLivingStateBrief(snapshot);
    const validated = validateCurrentCharacterStateSnapshot(snapshot);
    validated.source_event_ids.push('mutated');

    expect(brief).toEqual({
      character_id: 'character-1',
      current_activity: 'writing notes',
      mood: 'focused',
      toward_user: 'warm',
      updated_at: '2026-05-14T11:29:00+00:00',
      source_event_ids: ['event-prior-state']
    });
    expect(snapshot.source_event_ids).toEqual(['event-prior-state']);
  });

  it('rejects malformed current state snapshots and current-event source IDs', () => {
    const brief = buildLivingStateBrief({
      ...currentStateSnapshot(),
      source_event_ids: ['event-1']
    });

    expect(() => validateLivingStateBriefForEvent(brief, { eventId: 'event-1' })).toThrow(
      /current event_id/
    );

    for (const snapshot of [
      { ...currentStateSnapshot(), schema_version: '0.2' },
      { ...currentStateSnapshot(), character_id: '' },
      {
        ...currentStateSnapshot(),
        living_state: { current_activity: '', mood: 'focused', toward_user: 'warm' }
      },
      {
        ...currentStateSnapshot(),
        living_state: {
          current_activity: 'writing notes',
          mood: 'focused',
          toward_user: 'warm',
          future_field: 'nope'
        }
      },
      { ...currentStateSnapshot(), updated_at: '2026-05-14' },
      { ...currentStateSnapshot(), source_event_ids: 'event-1' },
      { ...currentStateSnapshot(), source_event_ids: [''] },
      { ...currentStateSnapshot(), future_field: 'nope' },
      'not a mapping'
    ]) {
      expect(() => validateCurrentCharacterStateSnapshot(snapshot)).toThrow(
        ContractValidationError
      );
    }
  });
});

describe('active and interrupted incident briefs', () => {
  it('maps active incident snapshots to briefs without leaking status', () => {
    const snapshot = activeIncidentSnapshot();
    const brief = buildActiveIncidentBrief(snapshot);
    const validated = validateActiveIncidentSnapshot(snapshot);
    validated.source_event_ids.push('mutated');

    expect(brief).toEqual({
      incident_id: 'incident-1',
      type: 'eat',
      title: 'Eating lunch',
      started_at: '2026-05-14T11:00:00+00:00',
      expected_end_at: '2026-05-14T11:40:00+00:00',
      remaining_seconds: 600,
      interrupt_policy: 'interruptible',
      resume_policy: 'resume',
      source_event_ids: ['event-incident-started']
    });
    expect(brief).not.toHaveProperty('status');
    expect(snapshot.source_event_ids).toEqual(['event-incident-started']);
  });

  it('rejects malformed active incident snapshots and current-event source IDs', () => {
    expect(() =>
      validateActiveIncidentBriefForEvent(
        buildActiveIncidentBrief({
          ...activeIncidentSnapshot(),
          source_event_ids: ['event-1']
        }),
        { eventId: 'event-1' }
      )
    ).toThrow(/current event_id/);

    for (const snapshot of [
      { ...activeIncidentSnapshot(), schema_version: '0.2' },
      { ...activeIncidentSnapshot(), incident_id: '' },
      { ...activeIncidentSnapshot(), type: 'dance' },
      { ...activeIncidentSnapshot(), status: 'completed' },
      { ...activeIncidentSnapshot(), title: '' },
      { ...activeIncidentSnapshot(), started_at: '2026-05-14' },
      { ...activeIncidentSnapshot(), expected_end_at: 'bad' },
      { ...activeIncidentSnapshot(), remaining_seconds: -1 },
      { ...activeIncidentSnapshot(), remaining_seconds: true },
      { ...activeIncidentSnapshot(), interrupt_policy: 'force' },
      { ...activeIncidentSnapshot(), resume_policy: 'ignore' },
      { ...activeIncidentSnapshot(), source_event_ids: [] },
      { ...activeIncidentSnapshot(), source_event_ids: [''] },
      { ...activeIncidentSnapshot(), future_field: 'nope' },
      'not a mapping'
    ]) {
      expect(() => validateActiveIncidentSnapshot(snapshot)).toThrow(ContractValidationError);
    }
  });

  it('maps interrupted incident snapshots and requires the current event source ID', () => {
    const snapshot = interruptedIncidentSnapshot();
    const brief = buildInterruptedIncidentBrief(snapshot);
    const validated = validateInterruptedIncidentSnapshot(snapshot);
    validated.source_event_ids.push('mutated');

    expect(brief).toEqual({
      incident_id: 'incident-1',
      type: 'eat',
      title: 'Eating lunch',
      started_at: '2026-05-14T11:00:00+00:00',
      expected_end_at: '2026-05-14T11:40:00+00:00',
      remaining_seconds: 600,
      interrupt_policy: 'interruptible',
      resume_policy: 'resume',
      interrupted_at: '2026-05-14T11:30:00+00:00',
      source_event_ids: ['event-incident-started', 'event-1']
    });
    expect(brief).not.toHaveProperty('status');
    expect(snapshot.source_event_ids).toEqual(['event-incident-started', 'event-1']);
    expect(validateInterruptedIncidentBriefForEvent(brief, { eventId: 'event-1' })).toEqual(
      brief
    );
  });

  it('rejects malformed interrupted incident snapshots and stale briefs', () => {
    expect(() =>
      validateInterruptedIncidentBriefForEvent(
        buildInterruptedIncidentBrief({
          ...interruptedIncidentSnapshot(),
          source_event_ids: ['event-incident-started']
        }),
        { eventId: 'event-1' }
      )
    ).toThrow(/current event_id/);

    for (const snapshot of [
      { ...interruptedIncidentSnapshot(), schema_version: '0.2' },
      { ...interruptedIncidentSnapshot(), incident_id: '' },
      { ...interruptedIncidentSnapshot(), type: 'dance' },
      { ...interruptedIncidentSnapshot(), status: 'active' },
      { ...interruptedIncidentSnapshot(), title: '' },
      { ...interruptedIncidentSnapshot(), interrupted_at: 'bad' },
      { ...interruptedIncidentSnapshot(), interrupt_policy: 'background' },
      { ...interruptedIncidentSnapshot(), resume_policy: 'ignore' },
      { ...interruptedIncidentSnapshot(), source_event_ids: [] },
      { ...interruptedIncidentSnapshot(), source_event_ids: [''] },
      { ...interruptedIncidentSnapshot(), future_field: 'nope' },
      'not a mapping'
    ]) {
      expect(() => validateInterruptedIncidentSnapshot(snapshot)).toThrow(
        ContractValidationError
      );
    }
  });
});
