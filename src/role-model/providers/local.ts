import {
  validateCharacterAgentReply,
  type CharacterAgent,
} from '../../core/index.ts';
import {createDeterministicCharacterAgent} from './deterministic.ts';
import {
  createVisibleReplyModelToolCall,
  visibleReplyModelToolName,
} from '../api/model-tools.ts';
import type {RoleModelAdapter} from '../api/adapter.ts';
import {conversationTurnVisibleMessages} from '../api/conversation-history.ts';
import {createRoleModelAdapterRawOutput} from '../api/adapter.ts';

export function createDeterministicLocalRoleModelAdapter(): RoleModelAdapter {
  return createRoleModelAdapterFromCharacterAgent(
    createDeterministicCharacterAgent(),
  );
}

export function createRoleModelAdapterFromCharacterAgent(
  agent: CharacterAgent,
): RoleModelAdapter {
  return Object.freeze({
    async invoke(inputEnvelope, invocation) {
      const reply = await agent.reply({
        character: inputEnvelope.decisionContext.characterSnapshot,
        message: inputEnvelope.event.payload.currentUserMessage,
        recentVisibleMessages: invocation.conversationHistory.flatMap(
          conversationTurnVisibleMessages,
        ),
      });
      const characterReply = validateCharacterAgentReply(reply);

      return createRoleModelAdapterRawOutput(
        JSON.stringify(
          inputEnvelope.allowedTools.includes(visibleReplyModelToolName)
            ? {
                toolCalls: [
                  createVisibleReplyModelToolCall(characterReply.text),
                ],
              }
            : {
                toolCalls: [],
                text: characterReply.text,
              },
        ),
      );
    },
  } satisfies RoleModelAdapter);
}
