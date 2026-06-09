import { describe, expect, it } from 'vitest';

import {
  CharacterReplyValidationError,
  localCharacterProfile,
  type CharacterAgent,
  type CharacterAgentReply,
  type VisibleMessage
} from '../src/conversation.ts';
import {
  createDecisionContext,
  createRoleModelInputEnvelope,
  roleModelMalformedOutputRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelVisibleReplyActionName
} from '../src/role-model-contracts.ts';
import {
  createDeterministicLocalRoleModelAdapter,
  createRoleModelAdapterFromCharacterAgent,
  parseRoleModelDecision,
  runRoleModelLoop,
  type RoleModelAdapter,
  type RoleModelAdapterRawOutput
} from '../src/role-model-loop.ts';
import { createUserMessageRuntimeEvent } from '../src/runtime-event.ts';

describe('role model loop', () => {
  it('runs a fresh local USER_MESSAGE turn through the deterministic adapter and captures snapshots', async () => {
    const event = createTestUserMessageEvent('hello', 'evt_role_fresh');
    const decisionContext = createDecisionContext({
      sessionId: 'local-session',
      characterSnapshot: localCharacterProfile
    });
    const expectedReply = "I'm here. Tell me what you need.";
    const expectedRawOutputText = JSON.stringify({
      action: {
        type: roleModelVisibleReplyActionName,
        text: expectedReply
      }
    });

    const result = await runRoleModelLoop({
      event,
      decisionContext
    });

    expect(result.status).toBe('accepted');

    if (result.status !== 'accepted') {
      throw new Error('Expected accepted role model result.');
    }

    expect(result.decision.action).toEqual({
      type: roleModelVisibleReplyActionName,
      text: expectedReply
    });
    expect(result.inputEnvelope.event).toEqual(event);
    expect(result.inputEnvelope.event.payload.currentUserMessage).toBe('hello');
    expect(result.inputEnvelope.decisionContext).toEqual(decisionContext);
    expect(
      'currentUserMessage' in
        result.inputEnvelope.decisionContext.characterSnapshot
    ).toBe(false);
    expect(result.ioSnapshot).toEqual({
      eventId: 'evt_role_fresh',
      traceId: 'trace_evt_role_fresh',
      createdAt: '2026-06-09T12:00:00.000Z',
      kind: 'role_model_io_snapshot',
      sessionId: 'local-session',
      inputEnvelope: result.inputEnvelope,
      rawOutputText: expectedRawOutputText
    });
    expect(result.parsedDecisionSnapshot).toEqual({
      eventId: 'evt_role_fresh',
      traceId: 'trace_evt_role_fresh',
      createdAt: '2026-06-09T12:00:00.000Z',
      kind: 'role_model_decision_snapshot',
      sessionId: 'local-session',
      result: result.decisionResult
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ioSnapshot)).toBe(true);
    expect(Object.isFrozen(result.parsedDecisionSnapshot)).toBe(true);
  });

  it('preserves current context-aware deterministic reply behavior through the local adapter', async () => {
    const previousUserMessage = createVisibleMessage({
      id: 'local-session:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'are you there?'
    });
    const previousCharacterMessage = createVisibleMessage({
      id: 'local-session:message-2',
      role: 'character',
      speakerId: 'mira',
      speakerName: 'Mira',
      text: "I'm here. Tell me what you need."
    });
    const event = createTestUserMessageEvent('I am tired', 'evt_role_context');
    const decisionContext = createDecisionContext({
      sessionId: 'local-session',
      characterSnapshot: localCharacterProfile,
      recentVisibleMessages: [previousUserMessage, previousCharacterMessage]
    });

    const result = await runRoleModelLoop({
      event,
      decisionContext,
      adapter: createDeterministicLocalRoleModelAdapter()
    });

    expect(result.status).toBe('accepted');

    if (result.status !== 'accepted') {
      throw new Error('Expected accepted role model result.');
    }

    expect(result.decision.action).toEqual({
      type: roleModelVisibleReplyActionName,
      text: 'I remember you said "are you there?" Stay with me for a minute.'
    });
    expect(JSON.parse(result.ioSnapshot.rawOutputText)).toEqual({
      action: result.decision.action
    });
  });

  it('rejects malformed custom character-agent replies before JSON wrapping', async () => {
    const malformedReplies: readonly unknown[] = [null, {}, { text: 42 }];

    for (const [index, malformedReply] of malformedReplies.entries()) {
      const agent: CharacterAgent = {
        reply() {
          // Bypass the static agent contract to exercise runtime boundary validation.
          return malformedReply as CharacterAgentReply;
        }
      };
      const adapter = createRoleModelAdapterFromCharacterAgent(agent);
      const inputEnvelope = createRoleModelInputEnvelope({
        event: createTestUserMessageEvent(
          'hello',
          `evt_role_malformed_agent_${String(index)}`
        ),
        decisionContext: createDecisionContext({
          sessionId: 'local-session',
          characterSnapshot: localCharacterProfile
        })
      });
      const invokePromise = adapter.invoke(inputEnvelope);

      await expect(invokePromise).rejects.toThrow(CharacterReplyValidationError);
      await expect(invokePromise).rejects.toThrow(
        'Character agent returned an invalid reply.'
      );
    }
  });

  it('rejects malformed raw output before commit while keeping model I/O evidence', async () => {
    const event = createTestUserMessageEvent('hello', 'evt_role_malformed');
    const result = await runRoleModelLoop({
      event,
      decisionContext: createDecisionContext({
        sessionId: 'local-session',
        characterSnapshot: localCharacterProfile
      }),
      adapter: createRawOutputAdapter('not json')
    });

    expect(result.status).toBe('rejected');

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected role model result.');
    }

    expect(result.rejection.reason).toBe(roleModelMalformedOutputRejectionReason);
    expect(result.ioSnapshot.rawOutputText).toBe('not json');
    expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
    expect(result.parsedDecisionSnapshot.result).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Adapter output must be valid JSON.'
      }
    });
  });

  it('rejects adapter raw outputs without string rawOutputText before snapshotting evidence', async () => {
    const malformedRawOutputs: readonly unknown[] = [
      {},
      {
        rawOutputText: undefined
      }
    ];

    for (const [index, rawOutput] of malformedRawOutputs.entries()) {
      const result = await runRoleModelLoop({
        event: createTestUserMessageEvent(
          'hello',
          `evt_role_malformed_adapter_${String(index)}`
        ),
        decisionContext: createDecisionContext({
          sessionId: 'local-session',
          characterSnapshot: localCharacterProfile
        }),
        adapter: createMalformedRawOutputAdapter(rawOutput)
      });

      expect(result.status).toBe('rejected');

      if (result.status !== 'rejected') {
        throw new Error('Expected rejected role model result.');
      }

      expect(result.rejection).toEqual({
        reason: roleModelMalformedOutputRejectionReason,
        details: 'Adapter raw output must include string rawOutputText.'
      });
      expect(result.ioSnapshot.rawOutputText).toBe('');
      expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
      expect(result.parsedDecisionSnapshot.result).toEqual({
        status: 'rejected',
        rejection: {
          reason: roleModelMalformedOutputRejectionReason,
          details: 'Adapter raw output must include string rawOutputText.'
        }
      });
    }
  });

  it('rejects unsupported action and effect shapes with the CT-01 unsupported reason', async () => {
    const unsupportedOutputs = [
      JSON.stringify({
        action: {
          type: 'tool_call',
          name: 'search'
        }
      }),
      JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: 'I can do that.'
        },
        effects: [
          {
            type: 'schedule_reminder'
          }
        ]
      })
    ];

    for (const rawOutputText of unsupportedOutputs) {
      const result = await runRoleModelLoop({
        event: createTestUserMessageEvent(
          'hello',
          `evt_${String(rawOutputText.length)}`
        ),
        decisionContext: createDecisionContext({
          sessionId: 'local-session',
          characterSnapshot: localCharacterProfile
        }),
        adapter: createRawOutputAdapter(rawOutputText)
      });

      expect(result.status).toBe('rejected');

      if (result.status !== 'rejected') {
        throw new Error('Expected rejected role model result.');
      }

      expect(result.rejection.reason).toBe(
        roleModelUnsupportedEffectRejectionReason
      );
      expect(result.parsedDecisionSnapshot.result).toEqual(result.decisionResult);
    }
  });

  it('parses empty and multiline visible_reply text as shape-valid for CT-04 validation', () => {
    const emptyReplyResult = parseRoleModelDecision(
      JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: ''
        }
      })
    );
    const multilineReplyResult = parseRoleModelDecision(
      JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: 'line one\nline two'
        }
      })
    );

    expect(emptyReplyResult).toEqual({
      status: 'accepted',
      decision: {
        action: {
          type: roleModelVisibleReplyActionName,
          text: ''
        }
      }
    });
    expect(multilineReplyResult).toEqual({
      status: 'accepted',
      decision: {
        action: {
          type: roleModelVisibleReplyActionName,
          text: 'line one\nline two'
        }
      }
    });
  });
});

function createTestUserMessageEvent(message: string, eventId: string) {
  return createUserMessageRuntimeEvent(message, {
    eventId,
    traceId: `trace_${eventId}`,
    createdAt: '2026-06-09T12:00:00.000Z'
  });
}

function createVisibleMessage(message: VisibleMessage): VisibleMessage {
  return Object.freeze(message);
}

function createRawOutputAdapter(rawOutputText: string): RoleModelAdapter {
  return {
    invoke() {
      return Object.freeze({
        rawOutputText
      });
    }
  };
}

function createMalformedRawOutputAdapter(rawOutput: unknown): RoleModelAdapter {
  return {
    invoke() {
      // Bypass the static adapter contract to exercise runtime boundary validation.
      return rawOutput as RoleModelAdapterRawOutput;
    }
  };
}
