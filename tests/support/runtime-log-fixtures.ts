import {testCharacterProfile} from './character-fixtures.ts';
import type {RuntimeLogStore} from '../../src/runtime/evidence/contract.ts';
import type {ConversationLogRecord} from '../../src/runtime/evidence/records.ts';
import {createRoleModelCommitValidationSnapshot} from '../../src/runtime/evidence/records.ts';
import {
  createDecisionContext,
  createDefaultRoleModelPluginToolDefinitions,
  createParsedRoleModelDecisionSnapshot,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  parseRoleModelExecutionDecision,
} from '../../src/role-model/index.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  sessionIdFromMessageId,
  type CharacterProfile,
} from '../../src/core/index.ts';

// The model input inside the character evidence must match the turn's
// committed user message; callers whose turn committed something other than
// the default `hello` pass that text.
export function appendVisibleMessageWithCommitAnchor(
  store: RuntimeLogStore,
  message: ConversationLogRecord,
  expectedCharacter?: CharacterProfile,
  modelInputText = 'hello',
): void {
  const eventIdentity = {
    eventId: message.eventId,
    traceId: message.traceId,
    createdAt: message.createdAt,
  };
  const sessionId = sessionIdFromMessageId(message.id) ?? 'local-session';

  store.appendRawEvent(
    {
      ...eventIdentity,
      kind: 'visible_message_committed',
      eventType: 'USER_MESSAGE',
      visibleMessageIds: [message.id],
      visibleMessage: {
        id: message.id,
        role: message.role,
        speakerId: message.speakerId,
        speakerName: message.speakerName,
        text: message.text,
      },
      committedAt: message.committedAt,
      ...(message.role === 'user'
        ? {}
        : {
            roleModelIOSnapshot: createRoleModelIOSnapshot({
              ...eventIdentity,
              sessionId,
              inputEnvelope: createRoleModelInputEnvelope({
                event: createUserMessageRuntimeEvent(
                  modelInputText,
                  createRuntimeEventIdentity(eventIdentity),
                ),
                decisionContext: createDecisionContext({
                  sessionId,
                  characterSnapshot: expectedCharacter ?? testCharacterProfile,
                }),
                pluginToolDefinitions:
                  createDefaultRoleModelPluginToolDefinitions(),
              }),
              rawOutputText: JSON.stringify({
                toolCalls: [
                  {name: 'visible_reply', input: {text: message.text}},
                ],
              }),
            }),
            parsedRoleModelDecisionSnapshot:
              createParsedRoleModelDecisionSnapshot({
                ...eventIdentity,
                sessionId,
                result: parseRoleModelExecutionDecision(
                  JSON.stringify({
                    toolCalls: [
                      {name: 'visible_reply', input: {text: message.text}},
                    ],
                  }),
                ),
              }),
            commitValidation: createRoleModelCommitValidationSnapshot({
              ...eventIdentity,
              sessionId,
              result: {
                status: 'accepted',
                acceptedVisibleReplyText: message.text,
              },
            }),
            decisionRound: 1,
          }),
    },
    expectedCharacter,
  );
}
