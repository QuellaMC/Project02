import {
  selectRecentVisibleMessages,
  type ConversationSession,
} from '../../core/index.ts';
import {createDecisionContext} from './decision.ts';
import type {DecisionContext} from './contracts.ts';
import type {RuntimePluginContextItem} from '../../plugins/api/index.ts';

export type BuildUserTurnDecisionContextOptions = {
  readonly session: ConversationSession;
  readonly runtimeNotes?: readonly string[];
  readonly pluginContextItems?: readonly RuntimePluginContextItem[];
};

export function buildUserTurnDecisionContext(
  options: BuildUserTurnDecisionContextOptions,
): DecisionContext {
  return createDecisionContext({
    sessionId: options.session.id,
    characterSnapshot: options.session.character,
    recentVisibleMessages: selectRecentVisibleMessages(
      options.session.visibleTranscript,
    ),
    runtimeNotes: options.runtimeNotes ?? [],
    pluginContextItems: options.pluginContextItems ?? [],
  });
}
