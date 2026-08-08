import type {RuntimePluginSessionHistoryMessage} from '../../../api/session-history-contract.ts';

/**
 * One matching session, presented the way a reader reconstructs an old
 * conversation: how it started, what happened around the best match, and
 * how it ended. Bookends collapse into the window when they would overlap.
 */
export type SessionIndexSessionView = {
  readonly sessionId: string;
  readonly bookendStart: readonly RuntimePluginSessionHistoryMessage[];
  readonly window: readonly RuntimePluginSessionHistoryMessage[];
  readonly bookendEnd: readonly RuntimePluginSessionHistoryMessage[];
  readonly matchMessageId: string;
};

export type SessionIndexSearchResult = {
  /** Best-matching session first; one view per session. */
  readonly sessions: readonly SessionIndexSessionView[];
  readonly totalSessionsWithHits: number;
  readonly damagedRecordCount: number;
};

export type SessionIndexConversationWindow = {
  /** Oldest-first within the window. */
  readonly messages: readonly RuntimePluginSessionHistoryMessage[];
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
  readonly damagedRecordCount: number;
};

export type SessionIndexSearchOptions = {
  readonly query: string;
  readonly sessionId?: string;
  /** Ignored when `sessionId` targets a session explicitly. */
  readonly excludeSessionId?: string;
  readonly sessionLimit: number;
  /** Stops the catch-up between slices; use the hook context's signal. */
  readonly signal?: AbortSignal;
};

export type SessionIndexReadAroundOptions = {
  readonly sessionId: string;
  readonly anchorMessageId?: string;
  readonly window: number;
  /** Stops the catch-up between slices; use the hook context's signal. */
  readonly signal?: AbortSignal;
};

export type SessionIndexWarmUpOptions = {
  /** Catch up one session only; unknown sessions are a quiet no-op. */
  readonly sessionId?: string;
  /** Stops the catch-up between slices; use the hook context's signal. */
  readonly signal?: AbortSignal;
};

/**
 * The plugin-owned search index over the session-history feed, stored in
 * the plugin's own database. Every query first catches the index up to
 * the feed it is derived from, slice by slice with event-loop yields so
 * a cold index never blocks the process; warm-up only moves that cost
 * off the first search.
 */
export type SessionHistoryEngine = {
  readonly characterId: string;
  search(options: SessionIndexSearchOptions): Promise<SessionIndexSearchResult>;
  readAround(
    options: SessionIndexReadAroundOptions,
  ): Promise<SessionIndexConversationWindow>;
  warmUp(options?: SessionIndexWarmUpOptions): Promise<void>;
  close(): void;
};

export type SessionHistoryEngineErrorCode =
  'engine_closed' | 'aborted' | 'session_not_found' | 'message_not_found';

export class SessionHistoryEngineError extends Error {
  readonly code: SessionHistoryEngineErrorCode;

  constructor(code: SessionHistoryEngineErrorCode, message: string) {
    super(message);
    this.name = 'SessionHistoryEngineError';
    this.code = code;
  }
}
