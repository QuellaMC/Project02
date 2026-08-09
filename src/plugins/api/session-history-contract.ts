import type {VisibleMessageRole} from '../../core/index.ts';

export type RuntimePluginSessionHistorySummary = {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RuntimePluginSessionHistoryListing = {
  readonly sessions: readonly RuntimePluginSessionHistorySummary[];
  readonly damagedEntryCount: number;
};

export type RuntimePluginSessionHistoryMessage = {
  readonly sessionId: string;
  readonly messageId: string;
  readonly role: VisibleMessageRole;
  readonly speakerName: string;
  readonly text: string;
  readonly committedAt: string;
};

export type ReadNewSessionHistoryMessagesOptions = {
  readonly sessionId: string;
  /** Opaque position from a prior batch; absent starts at the beginning. */
  readonly cursor?: string;
  /** Byte budget for one call; anything beyond it stays unconsumed. */
  readonly maxBytes?: number;
};

export type SessionHistoryMessageBatch = {
  readonly messages: readonly RuntimePluginSessionHistoryMessage[];
  readonly nextCursor: string;
  readonly damagedRecordCount: number;
  /**
   * The transcript no longer matches the cursor (shrunk, replaced, or the
   * cursor itself is unreadable): everything previously consumed for this
   * session is stale and must be discarded before applying this batch,
   * which restarts from the top.
   */
  readonly reset: boolean;
};

/**
 * Privacy-filtered incremental feed over one character's committed visible
 * messages — never raw events. Torn tails are invisible, damaged records
 * are counted and skipped, and every batch is prefix-consistent with the
 * canonical log. Requires the session_history access declaration.
 */
export type RuntimePluginSessionHistoryFeed = {
  readonly characterId: string;
  listSessions(): RuntimePluginSessionHistoryListing;
  readNewMessages(
    options: ReadNewSessionHistoryMessagesOptions,
  ): SessionHistoryMessageBatch;
};
