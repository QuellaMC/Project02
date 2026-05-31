import { describe, expect, it } from 'vitest';

import {
  buildCharacterDecisionContext,
  RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES,
  RECENT_VISIBLE_MESSAGES_MAX_MESSAGES,
  RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS,
  VisibleConversationRecentMessagesSource,
  approximateTextTokens,
  validateCharacterDecisionContextForEvent,
  type DecisionContextSectionRequest,
  type RecentVisibleMessage,
  type RecentVisibleMessagesRequest,
  type VisibleConversationRecord,
  type VisibleConversationRecordsRequest
} from '../../../../src/character/state/context.ts';
import {
  buildInterruptedIncidentBrief,
  type ActiveIncidentRequest,
  type CurrentCharacterStateRequest,
  type InterruptedIncidentRequest
} from '../../../../src/character/state/current.ts';
import { InMemoryLifeIncidentStore } from '../../../../src/character/state/incidents.ts';
import { ContractValidationError } from '../../../../src/runtime/contracts.ts';
import type { UserMessageRuntimeEvent } from '../../../../src/runtime/contracts.ts';
import { InMemoryRawEventLog } from '../../../../src/runtime/logging.ts';

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

function recentMessage(
  messageId: string,
  {
    role = 'assistant',
    createdAt = '2026-05-14T11:20:00+00:00',
    text = 'previous reply',
    conversationId = 'conversation-1',
    sourceEventId
  }: {
    role?: RecentVisibleMessage['role'];
    createdAt?: string;
    text?: string;
    conversationId?: string;
    sourceEventId?: string;
  } = {}
): RecentVisibleMessage {
  return {
    schema_version: '0.1',
    message_id: messageId,
    trace_id: `trace-${messageId}`,
    source_event_id: sourceEventId ?? `event-${messageId}`,
    conversation_id: conversationId,
    role,
    created_at: createdAt,
    text
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

function interruptedIncidentSnapshot() {
  return {
    ...activeIncidentSnapshot(),
    status: 'interrupted',
    interrupted_at: '2026-05-14T11:30:00+00:00',
    source_event_ids: ['event-incident-started', 'event-1']
  };
}

function userVisibleRecord(messageId: string): VisibleConversationRecord {
  return {
    schema_version: '0.1',
    message_id: messageId,
    trace_id: `trace-${messageId}`,
    source_event_id: `event-${messageId}`,
    kind: 'user_visible_message',
    role: 'user',
    conversation_id: 'conversation-1',
    created_at: '2026-05-14T11:20:00+00:00',
    text: 'previous user message',
    user_id: 'user-1',
    source: { runtime_event_type: 'USER_MESSAGE' }
  };
}

function assistantVisibleRecord(outputId: string): VisibleConversationRecord {
  return {
    schema_version: '0.1',
    output_id: outputId,
    trace_id: `trace-${outputId}`,
    source_event_id: `event-${outputId}`,
    kind: 'assistant_visible_reply',
    conversation_id: 'conversation-1',
    created_at: '2026-05-14T11:21:00+00:00',
    text: 'previous assistant reply',
    user_id: 'user-1',
    source: {
      decision_action: 'visible_reply',
      role_model_status: 'decision_ready_for_commit'
    }
  };
}

class RecordingRecentMessagesSource {
  readonly messages: unknown;
  readonly requests: RecentVisibleMessagesRequest[] = [];

  constructor(messages: unknown) {
    this.messages = messages;
  }

  readRecentVisibleMessages(request: RecentVisibleMessagesRequest): unknown {
    this.requests.push(structuredClone(request));
    return this.messages;
  }
}

class RecordingCurrentStateSource {
  readonly snapshot: unknown;
  readonly requests: CurrentCharacterStateRequest[] = [];

  constructor(snapshot: unknown) {
    this.snapshot = snapshot;
  }

  readCurrentState(request: CurrentCharacterStateRequest): unknown {
    this.requests.push(structuredClone(request));
    return this.snapshot;
  }
}

class RecordingActiveIncidentSource {
  readonly snapshot: unknown;
  readonly requests: ActiveIncidentRequest[] = [];

  constructor(snapshot: unknown) {
    this.snapshot = snapshot;
  }

  readActiveIncident(request: ActiveIncidentRequest): unknown {
    this.requests.push(structuredClone(request));
    return this.snapshot;
  }
}

class RecordingInterruptedIncidentSource {
  readonly snapshot: unknown;
  readonly requests: InterruptedIncidentRequest[] = [];

  constructor(snapshot: unknown) {
    this.snapshot = snapshot;
  }

  readInterruptedIncident(request: InterruptedIncidentRequest): unknown {
    this.requests.push(structuredClone(request));
    return this.snapshot;
  }
}

class MutatingRecentMessagesSource {
  readonly requests: RecentVisibleMessagesRequest[] = [];

  readRecentVisibleMessages(request: RecentVisibleMessagesRequest): RecentVisibleMessage[] {
    request.before_event_id = 'mutated-by-source';
    this.requests.push(request);
    return [recentMessage('message-1')];
  }
}

class RecordingVisibleConversationRecordSource {
  readonly records: unknown;
  readonly requests: VisibleConversationRecordsRequest[] = [];

  constructor(records: unknown) {
    this.records = records;
  }

  readVisibleConversationRecords(request: VisibleConversationRecordsRequest): unknown {
    this.requests.push(structuredClone(request));
    return this.records;
  }
}

class RecordingDecisionContextSectionProvider {
  readonly sections: unknown;
  readonly requests: DecisionContextSectionRequest[] = [];

  constructor(sections: unknown) {
    this.sections = sections;
  }

  buildDecisionContextSections(request: DecisionContextSectionRequest): unknown {
    this.requests.push(structuredClone(request));
    return this.sections;
  }
}

function runtimeNoteSection(sectionId = 'runtime-note-1') {
  return {
    schema_version: '0.1',
    section_id: sectionId,
    section_type: 'runtime_note',
    content: {
      summary: 'User is asking about prior work.',
      priority: 1
    },
    source_event_ids: ['event-1']
  };
}

describe('character decision context builder', () => {
  it('builds minimal user-message context without sources', () => {
    expect(buildCharacterDecisionContext(normalizedUserMessage())).toEqual({
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      character_snapshot: { recent_visible_messages: [] }
    });
  });

  it('builds combined context and preserves copy safety', () => {
    const messages = [recentMessage('message-1')];
    const stateSnapshot = currentStateSnapshot();
    const incidentSnapshot = activeIncidentSnapshot();

    const context = buildCharacterDecisionContext(normalizedUserMessage(), {
      recentVisibleMessagesSource: new RecordingRecentMessagesSource(messages),
      currentStateSource: new RecordingCurrentStateSource(stateSnapshot),
      activeIncidentSource: new RecordingActiveIncidentSource(incidentSnapshot)
    });

    expect(context.character_snapshot.recent_visible_messages).toEqual([
      recentMessage('message-1')
    ]);
    expect(context.character_snapshot.living_state_brief?.mood).toBe('focused');
    expect(context.character_snapshot.active_incident?.title).toBe('Eating lunch');
    expect(context.character_snapshot.user_message_interrupted_active_incident).toBe(true);

    const [firstMessage] = messages;
    if (firstMessage === undefined) {
      throw new Error('expected first message');
    }
    firstMessage.text = 'mutated after context';
    stateSnapshot.living_state.mood = 'mutated after context';
    incidentSnapshot.title = 'mutated after context';

    expect(context.character_snapshot.recent_visible_messages[0]?.text).toBe('previous reply');
    expect(context.character_snapshot.living_state_brief?.mood).toBe('focused');
    expect(context.character_snapshot.active_incident?.title).toBe('Eating lunch');
  });

  it('adds provider sections outside the character snapshot', () => {
    const sections = [runtimeNoteSection()];
    const sectionProvider = new RecordingDecisionContextSectionProvider(sections);

    const context = buildCharacterDecisionContext(normalizedUserMessage(), {
      contextSectionProviders: [sectionProvider]
    });

    expect(sectionProvider.requests).toEqual([
      {
        schema_version: '0.1',
        trace_id: 'trace-1',
        event_id: 'event-1',
        event_type: 'USER_MESSAGE',
        created_at: '2026-05-14T11:30:00+00:00',
        conversation_id: 'conversation-1'
      }
    ]);
    expect(context.character_snapshot).toEqual({ recent_visible_messages: [] });
    expect(context.context_sections).toEqual(sections);

    const [firstSection] = sections;
    if (firstSection === undefined) {
      throw new Error('expected context section');
    }
    firstSection.content.summary = 'mutated after context';
    expect(context.context_sections?.[0]?.content).toEqual({
      summary: 'User is asking about prior work.',
      priority: 1
    });
  });

  it('rejects malformed provider sections', () => {
    expect(() =>
      buildCharacterDecisionContext(normalizedUserMessage(), {
        contextSectionProviders: [new RecordingDecisionContextSectionProvider({})]
      })
    ).toThrow(/DecisionContextSectionProvider must return a list/);

    for (const sections of [
      [{ ...runtimeNoteSection(), future_field: 'nope' }],
      [{ ...runtimeNoteSection(), section_id: '' }],
      [{ ...runtimeNoteSection(), content: 'not an object' }],
      [{ ...runtimeNoteSection(), source_event_ids: ['event-1', 2] }],
      [runtimeNoteSection(), runtimeNoteSection()]
    ]) {
      expect(() =>
        buildCharacterDecisionContext(normalizedUserMessage(), {
          contextSectionProviders: [new RecordingDecisionContextSectionProvider(sections)]
        })
      ).toThrow(ContractValidationError);
    }
  });

  it('validates direct context sections and rejects malformed section envelopes', () => {
    const context = {
      schema_version: '0.1',
      trace_id: 'trace-1',
      event_id: 'event-1',
      character_snapshot: { recent_visible_messages: [] },
      context_sections: [runtimeNoteSection()]
    };

    const validatedContext = validateCharacterDecisionContextForEvent(context, {
      event: {
        trace_id: 'trace-1',
        event_id: 'event-1',
        created_at: '2026-05-14T11:30:00+00:00',
        conversation_id: 'conversation-1'
      }
    });

    expect(validatedContext.context_sections).toEqual([runtimeNoteSection()]);

    const [firstContextSection] = context.context_sections;
    if (firstContextSection === undefined) {
      throw new Error('expected context section');
    }
    firstContextSection.content.summary = 'mutated after validation';
    expect(validatedContext.context_sections?.[0]?.content).toEqual({
      summary: 'User is asking about prior work.',
      priority: 1
    });
    expect(() =>
      validateCharacterDecisionContextForEvent(
        {
          ...context,
          context_sections: [runtimeNoteSection(), runtimeNoteSection()]
        },
        {
          event: {
            trace_id: 'trace-1',
            event_id: 'event-1',
            created_at: '2026-05-14T11:30:00+00:00',
            conversation_id: 'conversation-1'
          }
        }
      )
    ).toThrow(/section_id/);
  });

  it('prefers active incident context and omits stale interrupted incidents', () => {
    const staleInterrupted = {
      ...interruptedIncidentSnapshot(),
      source_event_ids: ['event-incident-started', 'event-old']
    };
    const activeSource = new RecordingActiveIncidentSource(activeIncidentSnapshot());
    const interruptedSource = new RecordingInterruptedIncidentSource(staleInterrupted);

    const activeContext = buildCharacterDecisionContext(normalizedUserMessage(), {
      activeIncidentSource: activeSource,
      interruptedIncidentSource: interruptedSource
    });

    expect(activeSource.requests).toHaveLength(1);
    expect(interruptedSource.requests).toEqual([]);
    expect(activeContext.character_snapshot.active_incident?.incident_id).toBe('incident-1');
    expect(activeContext.character_snapshot).not.toHaveProperty('interrupted_incident');
    expect(activeContext.character_snapshot.user_message_interrupted_active_incident).toBe(true);

    const staleContext = buildCharacterDecisionContext(normalizedUserMessage(), {
      interruptedIncidentSource: new RecordingInterruptedIncidentSource(staleInterrupted)
    });
    expect(staleContext.character_snapshot).not.toHaveProperty('interrupted_incident');
  });

  it('uses interrupted incident context only when it belongs to the current event', () => {
    const activeSource = new RecordingActiveIncidentSource(null);
    const interruptedSource = new RecordingInterruptedIncidentSource(interruptedIncidentSnapshot());

    const context = buildCharacterDecisionContext(normalizedUserMessage(), {
      activeIncidentSource: activeSource,
      interruptedIncidentSource: interruptedSource
    });

    expect(activeSource.requests).toHaveLength(1);
    expect(interruptedSource.requests).toHaveLength(1);
    expect(context.character_snapshot.interrupted_incident).toEqual(
      buildInterruptedIncidentBrief(interruptedIncidentSnapshot())
    );
    expect(context.character_snapshot).not.toHaveProperty('active_incident');
    expect(context.character_snapshot).not.toHaveProperty(
      'user_message_interrupted_active_incident'
    );
  });

  it('omits absent incidents from the concrete TypeScript incident store', () => {
    const incidentStore = new InMemoryLifeIncidentStore({
      rawEventLog: new InMemoryRawEventLog()
    });

    const context = buildCharacterDecisionContext(normalizedUserMessage(), {
      activeIncidentSource: incidentStore,
      interruptedIncidentSource: incidentStore
    });

    expect(context.character_snapshot).not.toHaveProperty('active_incident');
    expect(context.character_snapshot).not.toHaveProperty('interrupted_incident');
    expect(context.character_snapshot).not.toHaveProperty(
      'user_message_interrupted_active_incident'
    );
  });

  it('sends copy-safe recent message requests', () => {
    const event = normalizedUserMessage();
    const source = new MutatingRecentMessagesSource();

    buildCharacterDecisionContext(event, { recentVisibleMessagesSource: source });

    expect(event.event_id).toBe('event-1');
    expect(source.requests[0]?.before_event_id).toBe('mutated-by-source');
    expect(source.requests[0]?.max_candidate_messages).toBe(
      RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES
    );
  });
});

describe('recent visible message selection', () => {
  it('normalizes, limits, and orders recent messages oldest-to-newest', () => {
    const messages = [
      recentMessage('message-7', { createdAt: '2026-05-14T11:27:00+00:00' }),
      recentMessage('message-2', { createdAt: '2026-05-14T11:22:00+00:00' }),
      recentMessage('message-5', { createdAt: '2026-05-14T11:25:00+00:00' }),
      recentMessage('message-1', {
        role: 'user',
        createdAt: '2026-05-14T11:21:00+00:00',
        text: ' prior user '
      }),
      recentMessage('message-6', { createdAt: '2026-05-14T11:26:00+00:00' }),
      recentMessage('message-3', { createdAt: '2026-05-14T11:23:00+00:00' }),
      recentMessage('message-4', { createdAt: '2026-05-14T11:24:00+00:00' })
    ];

    const context = buildCharacterDecisionContext(normalizedUserMessage(), {
      recentVisibleMessagesSource: new RecordingRecentMessagesSource(messages)
    });

    expect(context.character_snapshot.recent_visible_messages.map((message) => message.message_id))
      .toEqual(['message-2', 'message-3', 'message-4', 'message-5', 'message-6', 'message-7']);
    expect(context.character_snapshot.recent_visible_messages).toHaveLength(
      RECENT_VISIBLE_MESSAGES_MAX_MESSAGES
    );
  });

  it('uses Python-style code-point tie breaking for same-timestamp message IDs', () => {
    const messages = ['_', '-', '0', 'a', 'Z'].map((messageId) =>
      recentMessage(messageId, { createdAt: '2026-05-14T11:21:00+00:00' })
    );

    const context = buildCharacterDecisionContext(normalizedUserMessage(), {
      recentVisibleMessagesSource: new RecordingRecentMessagesSource(messages)
    });

    expect(context.character_snapshot.recent_visible_messages.map((message) => message.message_id))
      .toEqual(['-', '0', 'Z', '_', 'a']);
  });

  it('skips oversized messages without truncating and excludes current-event messages', () => {
    const oversizedText = 'x'.repeat(RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS * 4 + 1);
    const messages = [
      recentMessage('message-1', {
        createdAt: '2026-05-14T11:21:00+00:00',
        text: oversizedText
      }),
      recentMessage('event-1', { createdAt: '2026-05-14T11:22:00+00:00' }),
      recentMessage('message-3', {
        createdAt: '2026-05-14T11:23:00+00:00',
        sourceEventId: 'event-1'
      }),
      recentMessage('message-4', {
        createdAt: '2026-05-14T11:24:00+00:00',
        text: 'small'
      })
    ];

    const context = buildCharacterDecisionContext(normalizedUserMessage(), {
      recentVisibleMessagesSource: new RecordingRecentMessagesSource(messages)
    });

    expect(context.character_snapshot.recent_visible_messages.map((message) => message.message_id))
      .toEqual(['message-4']);
    expect(approximateTextTokens('x'.repeat(5))).toBe(2);
  });

  it('sorts Python-valid ISO forms and preserves sub-millisecond ordering', () => {
    const event = normalizedUserMessage();
    event.created_at = '2026-05-14T11:20:00.000003+00:00';
    const messages = [
      recentMessage('message-a', {
        createdAt: '2026-05-14T11:20:00.000002+00:00'
      }),
      recentMessage('message-z', {
        createdAt: '2026-05-14T11:20:00.000001+00:00'
      }),
      recentMessage('message-week', {
        createdAt: '2026-W20-4T11:19:59.999999+00:00'
      }),
      recentMessage('message-offset-seconds', {
        createdAt: '2026-05-14T11:20:00+00:00:30'
      }),
      recentMessage('message-basic-offset-fraction', {
        createdAt: '20260514T112000+000030,5'
      })
    ];

    const context = buildCharacterDecisionContext(event, {
      recentVisibleMessagesSource: new RecordingRecentMessagesSource(messages)
    });

    expect(context.character_snapshot.recent_visible_messages.map((message) => message.message_id))
      .toEqual([
        'message-basic-offset-fraction',
        'message-offset-seconds',
        'message-week',
        'message-z',
        'message-a'
      ]);
  });

  it('compares sub-millisecond timestamps before rejecting current-or-future messages', () => {
    const event = normalizedUserMessage();
    event.created_at = '2026-05-14T11:20:00.000950+00:00';

    expect(
      buildCharacterDecisionContext(event, {
        recentVisibleMessagesSource: new RecordingRecentMessagesSource([
          recentMessage('message-before', {
            createdAt: '2026-05-14T11:20:00.000900+00:00'
          })
        ])
      }).character_snapshot.recent_visible_messages.map((message) => message.message_id)
    ).toEqual(['message-before']);

    expect(() =>
      buildCharacterDecisionContext(event, {
        recentVisibleMessagesSource: new RecordingRecentMessagesSource([
          recentMessage('message-after', {
            createdAt: '2026-05-14T11:20:00.000951+00:00'
          })
        ])
      })
    ).toThrow(/before event.created_at/);
  });

  it('rejects malformed or duplicate recent messages', () => {
    for (const messages of [
      [recentMessage('message-1', { createdAt: '2026-05-14T11:30:00+00:00' })],
      [
        recentMessage('message-1', { createdAt: '2026-05-14T11:21:00+00:00' }),
        recentMessage('message-1', {
          createdAt: '2026-05-14T11:22:00+00:00',
          sourceEventId: 'event-message-2'
        })
      ],
      [
        recentMessage('message-1', { createdAt: '2026-05-14T11:21:00+00:00' }),
        recentMessage('message-2', {
          createdAt: '2026-05-14T11:22:00+00:00',
          sourceEventId: 'event-message-1'
        })
      ],
      [recentMessage('message-1', { conversationId: 'other-conversation' })],
      [{ ...recentMessage('message-1'), future_field: 'nope' }],
      [
        ...Array.from({ length: RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES + 1 }, (_, index) =>
          recentMessage(`message-${String(index)}`, {
            createdAt: '2026-05-14T11:21:00+00:00'
          })
        )
      ]
    ]) {
      expect(() =>
        buildCharacterDecisionContext(normalizedUserMessage(), {
          recentVisibleMessagesSource: new RecordingRecentMessagesSource(messages)
        })
      ).toThrow(ContractValidationError);
    }
  });
});

describe('visible conversation recent message source', () => {
  it('maps user and assistant visible records to recent message contracts', () => {
    const recordSource = new RecordingVisibleConversationRecordSource([
      userVisibleRecord('message-1'),
      assistantVisibleRecord('output-1')
    ]);
    const source = new VisibleConversationRecentMessagesSource(recordSource);

    const messages = source.readRecentVisibleMessages({
      schema_version: '0.1',
      conversation_id: 'conversation-1',
      before_event_id: 'event-1',
      before_created_at: '2026-05-14T11:30:00+00:00',
      max_candidate_messages: RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES
    });

    expect(recordSource.requests).toEqual([
      {
        schema_version: '0.1',
        conversation_id: 'conversation-1',
        before_event_id: 'event-1',
        before_created_at: '2026-05-14T11:30:00+00:00',
        max_candidate_records: RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES
      }
    ]);
    expect(messages).toEqual([
      {
        schema_version: '0.1',
        message_id: 'message-1',
        trace_id: 'trace-message-1',
        source_event_id: 'event-message-1',
        conversation_id: 'conversation-1',
        role: 'user',
        created_at: '2026-05-14T11:20:00+00:00',
        text: 'previous user message'
      },
      {
        schema_version: '0.1',
        message_id: 'output-1',
        trace_id: 'trace-output-1',
        source_event_id: 'event-output-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        created_at: '2026-05-14T11:21:00+00:00',
        text: 'previous assistant reply'
      }
    ]);
  });

  it('rejects malformed visible records before context mapping', () => {
    const source = new VisibleConversationRecentMessagesSource(
      new RecordingVisibleConversationRecordSource([
        { ...assistantVisibleRecord('output-1'), role: 'assistant' }
      ])
    );

    expect(() =>
      source.readRecentVisibleMessages({
        schema_version: '0.1',
        conversation_id: 'conversation-1',
        before_event_id: 'event-1',
        before_created_at: '2026-05-14T11:30:00+00:00',
        max_candidate_messages: RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES
      })
    ).toThrow(/role/);
  });
});
