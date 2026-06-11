import { describe, expect, it } from 'vitest';

import {
  characterStatePatchModelToolName,
  createAcceptedRoleModelDecisionResult,
  createCharacterStatePatchModelToolCall,
  createDecisionContext,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  createVisibleReplyCharacterDecision,
  getCharacterStatePatchToolCall,
  getRequiredVisibleReplyText,
  parseRoleModelDecision,
  roleModelAllowedToolNames,
  roleModelDecisionContractVersion,
  roleModelDecisionOutputContract,
  roleModelDecisionRejectionReasons,
  roleModelDisallowedToolRejectionReason,
  roleModelDuplicateToolCallRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  roleModelMissingRequiredToolCallRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelUnknownToolRejectionReason,
  roleModelVisibleReplyActionName,
  type RoleModelDecisionRejectionReason,
  type VisibleMessage
} from '../src/index.ts';

describe('role model decision contracts', () => {
  it('creates immutable tool-call snapshots that preserve event, session, and character identity', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_role_model_001',
      traceId: 'trace_role_model_001',
      createdAt: '2026-06-09T00:00:00.000Z'
    });
    const event = createUserMessageRuntimeEvent('  hello Mira  ', identity);
    const character = {
      id: 'mira',
      displayName: 'Mira'
    };
    const previousMessage: VisibleMessage = {
      id: 'session-role-model:message-1',
      role: 'user',
      speakerId: 'local-user',
      speakerName: 'You',
      text: 'previous hello'
    };
    const runtimeNotes = ['recent visible messages only'];

    const context = createDecisionContext({
      sessionId: 'session-role-model',
      characterSnapshot: character,
      recentVisibleMessages: [previousMessage],
      runtimeNotes
    });
    const envelope = createRoleModelInputEnvelope({
      event,
      decisionContext: context
    });
    const decision = createVisibleReplyCharacterDecision('I am here.');
    const accepted = createAcceptedRoleModelDecisionResult(decision);
    const ioSnapshot = createRoleModelIOSnapshot({
      ...identity,
      sessionId: context.sessionId,
      inputEnvelope: envelope,
      rawOutputText: JSON.stringify(decision)
    });
    const parsedSnapshot = createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId: context.sessionId,
      result: accepted
    });

    character.displayName = 'Mutated Mira';
    runtimeNotes.push('mutated after snapshot');

    expect(envelope.event).toEqual(event);
    expect(envelope.event.payload.currentUserMessage).toBe('hello Mira');
    expect(envelope.decisionContext.characterSnapshot).toEqual({
      id: 'mira',
      displayName: 'Mira'
    });
    expect(envelope.decisionContext.recentVisibleMessages).toEqual([
      previousMessage
    ]);
    expect(envelope.decisionContext.runtimeNotes).toEqual([
      'recent visible messages only'
    ]);
    expect(envelope.allowedTools).toEqual([
      roleModelVisibleReplyActionName,
      characterStatePatchModelToolName
    ]);
    expect(envelope.outputContract).toEqual(roleModelDecisionOutputContract);
    expect(accepted).toEqual({
      status: 'accepted',
      decision: {
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'I am here.'
            }
          }
        ]
      }
    });
    expect(getRequiredVisibleReplyText(decision)).toBe('I am here.');
    expect(ioSnapshot).toEqual({
      eventId: 'evt_role_model_001',
      traceId: 'trace_role_model_001',
      createdAt: '2026-06-09T00:00:00.000Z',
      kind: 'role_model_io_snapshot',
      sessionId: 'session-role-model',
      inputEnvelope: envelope,
      rawOutputText: JSON.stringify(decision)
    });
    expect(parsedSnapshot.result).toEqual(accepted);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(envelope.allowedTools)).toBe(true);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.toolCalls)).toBe(true);
    expect(Object.isFrozen(decision.toolCalls[0])).toBe(true);
  });

  it('keeps the user-turn tool vocabulary scoped to visible_reply and character_state.patch', () => {
    expect(roleModelAllowedToolNames).toEqual([
      roleModelVisibleReplyActionName,
      characterStatePatchModelToolName
    ]);
    expect(roleModelDecisionOutputContract.text).toContain(
      '{"name":"visible_reply","input":{"text":"one visible reply line"}}'
    );
    expect(roleModelDecisionOutputContract.text).toContain('not "tool"');

    const decision = createVisibleReplyCharacterDecision('Only one reply.');

    expect(decision.toolCalls[0]?.name).toBe('visible_reply');
    expect(getRequiredVisibleReplyText(decision)).toBe('Only one reply.');
  });

  it('rejects unsupported allowed tools at input-envelope construction', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_unsupported_allowed_tool',
      traceId: 'trace_unsupported_allowed_tool',
      createdAt: '2026-06-09T00:00:00.000Z'
    });
    const event = createUserMessageRuntimeEvent('hello', identity);
    const decisionContext = createDecisionContext({
      sessionId: 'session-role-model',
      characterSnapshot: {
        id: 'mira',
        displayName: 'Mira'
      }
    });

    expect(() => {
      Reflect.apply(createRoleModelInputEnvelope, undefined, [
        {
          event,
          decisionContext,
          allowedTools: ['unsupported_tool']
        }
      ]);
    }).toThrow(TypeError);
  });

  it('honors legacy allowedActions when creating input envelopes', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_legacy_allowed_actions',
      traceId: 'trace_legacy_allowed_actions',
      createdAt: '2026-06-09T00:00:00.000Z'
    });
    const event = createUserMessageRuntimeEvent('hello', identity);
    const decisionContext = createDecisionContext({
      sessionId: 'session-role-model',
      characterSnapshot: {
        id: 'mira',
        displayName: 'Mira'
      }
    });
    const envelope = createRoleModelInputEnvelope({
      event,
      decisionContext,
      allowedActions: [roleModelVisibleReplyActionName]
    });

    expect(envelope.allowedTools).toEqual([roleModelVisibleReplyActionName]);
  });

  it('parses the new ordered toolCalls decision and the MVP-005 visible_reply action shape', () => {
    const patchCall = createCharacterStatePatchModelToolCall({
      mood: 'curious'
    });
    const toolCallResult = parseRoleModelDecision(
      JSON.stringify({
        version: roleModelDecisionContractVersion,
        toolCalls: [
          {
            name: roleModelVisibleReplyActionName,
            input: {
              text: 'I am here.'
            }
          },
          patchCall
        ]
      })
    );
    const legacyResult = parseRoleModelDecision(
      JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: 'legacy reply'
        }
      })
    );

    expect(toolCallResult.status).toBe('accepted');
    expect(legacyResult.status).toBe('accepted');

    if (toolCallResult.status !== 'accepted' || legacyResult.status !== 'accepted') {
      throw new Error('Expected accepted role-model decisions.');
    }

    expect(getRequiredVisibleReplyText(toolCallResult.decision)).toBe('I am here.');
    expect(getCharacterStatePatchToolCall(toolCallResult.decision)?.input).toEqual({
      mood: 'curious'
    });
    expect(getRequiredVisibleReplyText(legacyResult.decision)).toBe(
      'legacy reply'
    );
  });

  it('enforces allowed tools for legacy visible_reply action decisions', () => {
    const result = parseRoleModelDecision(
      JSON.stringify({
        action: {
          type: roleModelVisibleReplyActionName,
          text: 'legacy reply'
        }
      }),
      [characterStatePatchModelToolName]
    );

    expect(result).toEqual({
      status: 'rejected',
      rejection: {
        reason: roleModelDisallowedToolRejectionReason,
        details: `Decision requested disallowed tool "${roleModelVisibleReplyActionName}".`
      }
    });
  });

  it('represents malformed and unsupported decisions with explicit rejection reasons', () => {
    const expectedReasons: readonly RoleModelDecisionRejectionReason[] = [
      roleModelMalformedOutputRejectionReason,
      roleModelMalformedToolCallRejectionReason,
      roleModelUnknownToolRejectionReason,
      roleModelMissingRequiredToolCallRejectionReason,
      roleModelDuplicateToolCallRejectionReason,
      roleModelUnsupportedEffectRejectionReason,
      roleModelInvalidVisibleReplyRejectionReason
    ];
    const rejectedResults = expectedReasons.map((reason) =>
      createRejectedRoleModelDecisionResult(reason, `${reason} detail`)
    );

    expect(roleModelDecisionRejectionReasons).toEqual(
      expect.arrayContaining([...expectedReasons])
    );
    expect(rejectedResults.map((result) => result.rejection.reason)).toEqual(
      expectedReasons
    );
  });
});
