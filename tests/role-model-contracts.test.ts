import { describe, expect, it } from 'vitest';

import {
  createAcceptedRoleModelDecisionResult,
  createDecisionContext,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  createVisibleReplyCharacterDecision,
  roleModelAllowedActionNames,
  roleModelCommitValidationFailureRejectionReason,
  roleModelDecisionContractVersion,
  roleModelDecisionOutputContract,
  roleModelDecisionRejectionReasons,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelVisibleReplyActionName,
  type RoleModelDecisionRejectionReason,
  type VisibleMessage
} from '../src/index.ts';

describe('role model decision contracts', () => {
  it('creates immutable accepted user-turn snapshots that preserve event, session, and character identity', () => {
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
    const previousMessage: {
      id: string;
      role: VisibleMessage['role'];
      speakerId: string;
      speakerName: string;
      text: string;
    } = {
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
      rawOutputText:
        '{"action":{"type":"visible_reply","text":"I am here."}}'
    });
    const parsedSnapshot = createParsedRoleModelDecisionSnapshot({
      ...identity,
      sessionId: context.sessionId,
      result: accepted
    });

    character.displayName = 'Mutated Mira';
    previousMessage.text = 'mutated previous hello';
    runtimeNotes.push('mutated after snapshot');

    expect(envelope.event).toEqual(event);
    expect(envelope.event.eventId).toBe('evt_role_model_001');
    expect(envelope.event.traceId).toBe('trace_role_model_001');
    expect(envelope.event.payload.currentUserMessage).toBe('hello Mira');
    expect(envelope.decisionContext.sessionId).toBe('session-role-model');
    expect(envelope.decisionContext.characterSnapshot).toEqual({
      id: 'mira',
      displayName: 'Mira'
    });
    expect('currentUserMessage' in envelope.decisionContext.characterSnapshot).toBe(
      false
    );
    expect(envelope.decisionContext.recentVisibleMessages).toEqual([
      {
        id: 'session-role-model:message-1',
        role: 'user',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'previous hello'
      }
    ]);
    expect(envelope.decisionContext.runtimeNotes).toEqual([
      'recent visible messages only'
    ]);
    expect(envelope.allowedActions).toEqual([roleModelVisibleReplyActionName]);
    expect(envelope.outputContract).toEqual(roleModelDecisionOutputContract);
    expect(envelope.outputContract.version).toBe(roleModelDecisionContractVersion);
    expect(accepted).toEqual({
      status: 'accepted',
      decision: {
        action: {
          type: roleModelVisibleReplyActionName,
          text: 'I am here.'
        }
      }
    });
    expect(ioSnapshot).toEqual({
      eventId: 'evt_role_model_001',
      traceId: 'trace_role_model_001',
      createdAt: '2026-06-09T00:00:00.000Z',
      kind: 'role_model_io_snapshot',
      sessionId: 'session-role-model',
      inputEnvelope: envelope,
      rawOutputText:
        '{"action":{"type":"visible_reply","text":"I am here."}}'
    });
    expect(parsedSnapshot).toEqual({
      eventId: 'evt_role_model_001',
      traceId: 'trace_role_model_001',
      createdAt: '2026-06-09T00:00:00.000Z',
      kind: 'role_model_decision_snapshot',
      sessionId: 'session-role-model',
      result: accepted
    });

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.characterSnapshot)).toBe(true);
    expect(Object.isFrozen(context.recentVisibleMessages)).toBe(true);
    expect(Object.isFrozen(context.runtimeNotes)).toBe(true);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.event)).toBe(true);
    expect(Object.isFrozen(envelope.event.payload)).toBe(true);
    expect(Object.isFrozen(envelope.allowedActions)).toBe(true);
    expect(Object.isFrozen(envelope.outputContract)).toBe(true);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.action)).toBe(true);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.decision)).toBe(true);
    expect(Object.isFrozen(ioSnapshot)).toBe(true);
    expect(Object.isFrozen(ioSnapshot.inputEnvelope)).toBe(true);
    expect(Object.isFrozen(parsedSnapshot)).toBe(true);
    expect(Object.isFrozen(parsedSnapshot.result)).toBe(true);

    const firstRecentVisibleMessage = context.recentVisibleMessages[0];

    expect(firstRecentVisibleMessage).toBeDefined();

    if (firstRecentVisibleMessage === undefined) {
      throw new Error('Expected one recent visible message.');
    }

    expect(Object.isFrozen(firstRecentVisibleMessage)).toBe(true);
    expect(() => {
      Object.defineProperty(firstRecentVisibleMessage, 'text', {
        value: 'tampered'
      });
    }).toThrow(TypeError);
    expect(() => {
      Reflect.apply(Array.prototype.push, envelope.allowedActions, [
        roleModelVisibleReplyActionName
      ]);
    }).toThrow(TypeError);
  });

  it('keeps the MVP-005 action vocabulary scoped to visible_reply', () => {
    expect(roleModelAllowedActionNames).toEqual([
      roleModelVisibleReplyActionName
    ]);
    expect(roleModelAllowedActionNames).toEqual(['visible_reply']);

    const decision = createVisibleReplyCharacterDecision('Only one reply.');

    expect(decision.action.type).toBe('visible_reply');
  });

  it('rejects unsupported allowed actions at input-envelope construction', () => {
    const identity = createRuntimeEventIdentity({
      eventId: 'evt_unsupported_allowed_action',
      traceId: 'trace_unsupported_allowed_action',
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
          allowedActions: ['unsupported_action']
        }
      ]);
    }).toThrow(TypeError);
  });

  it('represents malformed and unsupported decisions with explicit rejection reasons', () => {
    const expectedReasons: readonly RoleModelDecisionRejectionReason[] = [
      roleModelMalformedOutputRejectionReason,
      roleModelUnsupportedEffectRejectionReason,
      roleModelInvalidVisibleReplyRejectionReason,
      roleModelCommitValidationFailureRejectionReason
    ];

    const rejectionResults = expectedReasons.map((reason) =>
      createRejectedRoleModelDecisionResult(reason, `${reason} detail`)
    );

    expect(roleModelDecisionRejectionReasons).toEqual(expectedReasons);
    expect(rejectionResults.map((result) => result.rejection.reason)).toEqual([
      'malformed_output',
      'unsupported_effect',
      'invalid_visible_reply',
      'commit_validation_failure'
    ]);

    rejectionResults.forEach((result, index) => {
      const expectedReason = expectedReasons[index];

      expect(expectedReason).toBeDefined();

      if (expectedReason === undefined) {
        throw new Error('Expected rejection reason.');
      }

      expect(result).toEqual({
        status: 'rejected',
        rejection: {
          reason: expectedReason,
          details: `${expectedReason} detail`
        }
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.rejection)).toBe(true);
    });
  });
});
