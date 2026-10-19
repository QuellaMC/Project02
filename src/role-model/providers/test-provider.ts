import {
  validateCharacterAgentReply,
  type CharacterAgent,
} from '../../core/index.ts';
import {createDeterministicCharacterAgent} from './deterministic.ts';
import {createVisibleReplyModelToolCall} from '../api/model-tools.ts';
import type {RoleModelAdapter} from '../api/adapter.ts';
import {conversationTurnVisibleMessages} from '../api/conversation-history.ts';
import {scrubReasoningBlocks} from '../api/reasoning.ts';
import {createRoleModelAdapterRawOutput} from '../api/adapter.ts';

/** Fixed replies, with no model or network behind them: a test's, never a setting. */
export function createDeterministicTestRoleModelAdapter(): RoleModelAdapter {
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

      // Spoken in word-sized pieces first, so the reply streams the way a
      // model's does — after the scrub the parser applies to the whole, so a
      // draft never shows what the commit will not; the whole of it still
      // arrives as the decision.
      const scrubbed = scrubReasoningBlocks(characterReply.text);

      if (scrubbed.status === 'accepted') {
        for (const piece of scrubbed.text.split(/(?<=\s)/u)) {
          invocation.onReplyDelta?.({reply: 0, text: piece});
        }
      }

      return createRoleModelAdapterRawOutput(
        JSON.stringify({
          toolCalls: [createVisibleReplyModelToolCall(characterReply.text)],
        }),
      );
    },
  } satisfies RoleModelAdapter);
}
