import {
  selectRecentVisibleMessages,
  type ConversationSession
} from './conversation.ts';
import {
  createDecisionContext,
  type DecisionContext
} from './role-model-contracts.ts';
import type { RuntimePluginContextItem } from './plugins/types.ts';

export type BuildUserTurnDecisionContextOptions = {
  readonly session: ConversationSession;
  readonly runtimeNotes?: readonly string[];
  readonly pluginContextItems?: readonly RuntimePluginContextItem[];
  readonly recentMessageLimit?: number;
};

export function buildUserTurnDecisionContext(
  options: BuildUserTurnDecisionContextOptions
): DecisionContext {
  return createDecisionContext({
    sessionId: options.session.id,
    characterSnapshot: options.session.character,
    recentVisibleMessages: selectRecentVisibleMessages(
      options.session.visibleTranscript,
      options.recentMessageLimit
    ),
    runtimeNotes: options.runtimeNotes ?? [],
    pluginContextItems: options.pluginContextItems ?? []
  });
}
