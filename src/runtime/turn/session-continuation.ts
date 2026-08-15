import {
  summarizerInstructions,
  type ConversationTurn,
  type RoleModelAdapter,
} from '../../role-model/index.ts';
import type {RuntimeLogStore} from '../evidence/contract.ts';
import {conversationHistoryFromRawEvents} from '../evidence/conversation-history.ts';
import {
  maxContextSummaryChars,
  type ContextSummarizer,
  type SessionContinuationPlan,
} from '../evidence/records.ts';
import {defaultProject02ContextWindowTokens} from '../config/types.ts';
import {
  capSummaryText,
  mechanicalSummary,
  selectSessionContinuation,
  serializeTurnsForSummarizer,
} from './compaction-policy.ts';

export type {SessionContinuationPlan} from '../evidence/records.ts';

/**
 * Called after a completed turn. Returns a plan when the session's history has
 * outgrown its window, condensing the older turns through the provider's
 * plain completion when it has one and mechanically when it has not; a
 * summariser failure still yields a plan, so the next prompt never overflows.
 * Never throws.
 */
export async function planSessionContinuation(options: {
  readonly sessionId: string;
  readonly logStore: RuntimeLogStore;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly contextWindowTokens?: number;
  readonly characterName: string;
  readonly userDisplayName?: string;
}): Promise<SessionContinuationPlan | undefined> {
  const contextWindowTokens =
    options.contextWindowTokens ?? defaultProject02ContextWindowTokens;
  const history = conversationHistoryFromRawEvents(
    options.logStore.rawEvents(),
  );
  const selection = selectSessionContinuation(history.turns, {
    contextWindowTokens,
  });
  const lastTurn = history.turns[history.turns.length - 1];

  if (selection === undefined || lastTurn === undefined) {
    return undefined;
  }

  const summarized = await summarize({
    adapter: options.roleModelAdapter,
    turns: selection.summarized,
    ...(history.summary === undefined
      ? {}
      : {previousSummary: history.summary}),
    characterName: options.characterName,
    ...(options.userDisplayName === undefined
      ? {}
      : {userDisplayName: options.userDisplayName}),
    contextWindowTokens,
  });

  return Object.freeze({
    continuedFrom: Object.freeze({
      sessionId: options.sessionId,
      lastEventId: lastTurn.eventId,
    }),
    summary: summarized.summary,
    summarizedTurnCount: selection.summarized.length,
    carriedTurns: selection.carried,
    summarizer: summarized.summarizer,
  });
}

async function summarize(options: {
  readonly adapter: RoleModelAdapter | undefined;
  readonly turns: readonly ConversationTurn[];
  readonly previousSummary?: string;
  readonly characterName: string;
  readonly userDisplayName?: string;
  readonly contextWindowTokens: number;
}): Promise<{
  readonly summary: string;
  readonly summarizer: ContextSummarizer;
}> {
  const fallback = (reason: string) => ({
    summary: mechanicalSummary({
      summarized: options.turns,
      ...(options.previousSummary === undefined
        ? {}
        : {previousSummary: options.previousSummary}),
      ...(options.userDisplayName === undefined
        ? {}
        : {userDisplayName: options.userDisplayName}),
    }),
    summarizer: {status: 'fallback', reason} as const,
  });
  const adapter = options.adapter;

  if (adapter?.completeText === undefined) {
    return fallback('The selected provider has no summariser model.');
  }

  try {
    const result = await adapter.completeText({
      instructions: summarizerInstructions({
        characterName: options.characterName,
        ...(options.userDisplayName === undefined
          ? {}
          : {userDisplayName: options.userDisplayName}),
        maxOutputChars: maxContextSummaryChars,
        hasPreviousSummary: options.previousSummary !== undefined,
      }),
      input: serializeTurnsForSummarizer({
        turns: options.turns,
        ...(options.previousSummary === undefined
          ? {}
          : {previousSummary: options.previousSummary}),
        ...(options.userDisplayName === undefined
          ? {}
          : {userDisplayName: options.userDisplayName}),
        contextWindowTokens: options.contextWindowTokens,
      }),
      maxOutputChars: maxContextSummaryChars,
    });

    if (result.status === 'failed') {
      return fallback(result.reason);
    }

    const summary = capSummaryText(result.text);

    return summary === undefined
      ? fallback('The summariser returned no text.')
      : {
          summary,
          summarizer: {status: 'model', provider: result.provider} as const,
        };
  } catch (error: unknown) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}
