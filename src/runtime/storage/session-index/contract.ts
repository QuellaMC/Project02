import type {VisibleMessageRole} from '../../../core/index.ts';

export type SessionIndexMessage = {
  readonly sessionId: string;
  readonly messageId: string;
  readonly role: VisibleMessageRole;
  readonly speakerName: string;
  readonly text: string;
  readonly committedAt: string;
};

/**
 * One matching session, presented the way a reader reconstructs an old
 * conversation: how it started, what happened around the best match, and
 * how it ended. Bookends collapse into the window when they would overlap.
 */
export type SessionIndexSessionView = {
  readonly sessionId: string;
  readonly bookendStart: readonly SessionIndexMessage[];
  readonly window: readonly SessionIndexMessage[];
  readonly bookendEnd: readonly SessionIndexMessage[];
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
  readonly messages: readonly SessionIndexMessage[];
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
  readonly damagedRecordCount: number;
};

export type SessionIndexSearchOptions = {
  readonly query: string;
  readonly sessionId?: string;
  readonly sessionLimit: number;
};

export type SessionIndexReadAroundOptions = {
  readonly sessionId: string;
  readonly anchorMessageId?: string;
  readonly window: number;
};

export type LocalRuntimeSessionIndex = {
  readonly characterId: string;
  search(options: SessionIndexSearchOptions): SessionIndexSearchResult;
  readAround(
    options: SessionIndexReadAroundOptions,
  ): SessionIndexConversationWindow;
  close(): void;
};
