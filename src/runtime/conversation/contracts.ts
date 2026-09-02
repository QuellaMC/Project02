import type {
  CharacterProfile,
  Conversation,
  RuntimeEventIdentity,
  Session,
} from '../../core/index.ts';
import type {RuntimeLogStore} from '../evidence/contract.ts';
import type {
  ContextSummarizer,
  RawEventLogRecord,
  RuntimeTraceEntry,
} from '../evidence/records.ts';
import type {
  LocalRuntimeTurnProgressEvent,
  LocalRuntimeUserMessageCompletedResult,
  LocalRuntimeUserMessageInputRejectedResult,
  LocalRuntimeUserMessageRejectedResult,
} from '../turn/contracts.ts';
import type {RoleModelAdapter} from '../../role-model/index.ts';
import type {RoleModelCharacterRef} from '../../role-model/index.ts';
import type {RuntimePluginHost} from '../../plugins/index.ts';

export type OpenConversationOptions = {
  readonly homeRoot?: string;
  readonly character: CharacterProfile;
  readonly userDisplayName?: string;
};

/**
 * An open thread between the local user and one character. `session` and
 * `logStore` are the character's current segment; a delivery may rotate
 * them. `close` waits for an in-flight delivery, then releases the segment
 * and the conversation; it is idempotent.
 */
export type ActiveConversation = {
  readonly conversation: Conversation;
  readonly session: Session;
  readonly logStore: RuntimeLogStore;
  close(): Promise<void>;
};

export type DeliverUserMessageOptions = {
  readonly conversation: ActiveConversation;
  readonly line: string;
  /** Session-agnostic: a host constructed with its own session binding would
   * pin plugin file-store scoping to that session across rotations. */
  readonly pluginHost: RuntimePluginHost;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly characterPersonaSections?: readonly string[];
  readonly characterRef?: RoleModelCharacterRef;
  readonly contextWindowTokens?: number;
  /** The client's stamps on the message; see RunLocalUserMessageEventOptions. */
  readonly source?: string;
  readonly clientMessageId?: string;
  readonly onProgress?: (
    event: LocalRuntimeTurnProgressEvent,
  ) => Promise<void> | void;
};

/** What happened to the character's memory after a completed delivery. */
export type SegmentRotation =
  | {
      readonly status: 'rotated';
      readonly from: string;
      readonly to: string;
      readonly summarizedTurnCount: number;
      readonly summarizer: ContextSummarizer;
      /** The closed segment's session-end failure, when it had one. */
      readonly endFailure?: string;
    }
  | {
      readonly status: 'failed';
      readonly from: string;
      readonly message: string;
    };

export type UserMessageDelivery =
  | {
      readonly status: 'completed';
      readonly turn: LocalRuntimeUserMessageCompletedResult;
      readonly rotation?: SegmentRotation;
    }
  | {
      readonly status: 'rejected';
      readonly turn: LocalRuntimeUserMessageRejectedResult;
    }
  | {
      readonly status: 'input_rejected';
      readonly turn: LocalRuntimeUserMessageInputRejectedResult;
    }
  | {
      readonly status: 'failed';
      readonly identity: RuntimeEventIdentity;
      readonly error: unknown;
      readonly traceEntries: readonly RuntimeTraceEntry[];
      readonly rawEvents: readonly RawEventLogRecord[];
    };
