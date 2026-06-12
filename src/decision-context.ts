import {
  selectRecentVisibleMessages,
  type ConversationSession
} from './conversation.ts';
import {
  createDecisionContext,
  type DecisionContext
} from './role-model-contracts.ts';
import type { LivingStateBrief } from './character-state.ts';

export type BuildUserTurnDecisionContextOptions = {
  readonly session: ConversationSession;
  readonly livingStateBrief?: LivingStateBrief;
  readonly runtimeNotes?: readonly string[];
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
    ...(options.livingStateBrief === undefined
      ? {}
      : { livingStateBrief: options.livingStateBrief })
  });
}
