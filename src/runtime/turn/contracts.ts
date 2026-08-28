import {
  type Session,
  type RuntimeEventIdentity,
  type UserMessageRuntimeEvent,
} from '../../core/index.ts';
import type {
  RuntimePluginContext,
  RuntimePluginContextItem,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginToolInvocationSnapshot,
} from '../../plugins/api/index.ts';
import type {
  RuntimePluginHealthHostResult,
  RuntimePluginHost,
} from '../../plugins/index.ts';
import type {
  RoleModelCharacterRef,
  RoleModelDecisionRejectionReason,
} from '../../role-model/index.ts';
import type {RoleModelAdapter} from '../../role-model/index.ts';
import type {
  ConversationLogRecord,
  RawEventLogPayloadSummary,
  RawEventLogRecord,
  RoleModelCommitValidationSnapshot,
  RuntimeTurnRejectionReason,
} from '../evidence/records.ts';
import type {RuntimeLogStore} from '../evidence/contract.ts';

export const runtimePluginHealthRejectionReason = 'plugin_health_rejected';

export type LocalRuntimeUserMessageRejectionReason =
  | 'input_validation_rejected'
  | typeof runtimePluginHealthRejectionReason
  | 'plugin_before_role_model_call_rejected'
  | RoleModelDecisionRejectionReason;

export type RunLocalUserMessageEventOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly session: Session;
  readonly logStore: RuntimeLogStore;
  readonly rawInput?: string;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly maxToolRounds?: number;
  readonly pluginHost: RuntimePluginHost;
  readonly characterPersonaSections?: readonly string[];
  readonly characterRef?: RoleModelCharacterRef;
  /** IANA zone the day note is written in; defaults to the process zone. */
  readonly timeZone?: string;
  /** The model's context size; replayed history may use half of it. */
  readonly contextWindowTokens?: number;
  readonly onProgress?: (
    event: LocalRuntimeTurnProgressEvent,
  ) => Promise<void> | void;
};

export type LocalRuntimeTurnProgressEvent =
  | {
      readonly kind: 'visible_reply';
      readonly messageId: string;
      readonly speakerId: string;
      readonly speakerName: string;
      readonly text: string;
    }
  | {
      readonly kind: 'tool_calls_requested';
      readonly round: number;
      readonly toolNames: readonly string[];
    }
  | {
      readonly kind: 'tool_call_completed';
      readonly round: number;
      readonly status: 'accepted' | 'rejected';
      readonly toolName: string;
    };

export type LocalRuntimeUserMessageCompletedResult = {
  readonly status: 'completed';
  readonly event: UserMessageRuntimeEvent;
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly rawEvent: RawEventLogRecord;
  readonly rawEventLogRecords: readonly RawEventLogRecord[];
  readonly postCommitFailures?: readonly string[];
};

export type LocalRuntimeUserMessageRejectedResult = {
  readonly status: 'rejected';
  readonly event: UserMessageRuntimeEvent;
  readonly reason: LocalRuntimeUserMessageRejectionReason;
  readonly message: string;
  readonly rawEvent: RawEventLogRecord;
  readonly rawEventLogRecords: readonly RawEventLogRecord[];
};

export type LocalRuntimeUserMessageInputRejectedResult = {
  readonly status: 'rejected';
  readonly identity: RuntimeEventIdentity;
  readonly eventType: 'USER_MESSAGE';
  readonly reason: 'input_validation_rejected';
  readonly message: string;
  readonly rawEvent: RawEventLogRecord;
  readonly rawEventLogRecords: readonly RawEventLogRecord[];
};

export type LocalRuntimeUserMessageResult =
  | LocalRuntimeUserMessageCompletedResult
  | LocalRuntimeUserMessageRejectedResult;

export type RecordLocalUserMessageInputRejectionOptions = {
  readonly identity: RuntimeEventIdentity;
  readonly logStore: RuntimeLogStore;
  readonly message: string;
  readonly rawInput?: string;
};

export type NormalizeUserMessageRuntimeEventResult =
  | {
      readonly status: 'accepted';
      readonly event: UserMessageRuntimeEvent;
    }
  | {
      readonly status: 'rejected';
      readonly message: string;
    };

export type RuntimeTurnState = {
  readonly options: RunLocalUserMessageEventOptions;
  readonly rawEventLogRecords: RawEventLogRecord[];
  readonly identity: RuntimeEventIdentity;
  readonly normalizedEventResult: NormalizeUserMessageRuntimeEventResult;
  readonly event: UserMessageRuntimeEvent;
  readonly payloadSummary: RawEventLogPayloadSummary;
  runtimePluginContextForTurn: RuntimePluginContext | undefined;
  terminalRawEventMayBeDurable: boolean;
  readonly committedVisibleMessages: ConversationLogRecord[];
  readonly finishedToolCallIds: string[];
};

export type AppendVisibleReplyOptions = {
  readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[];
  readonly sessionId: string;
  /** The round whose decision said this; the commit references it. */
  readonly round: number;
  readonly text: string;
};

export type RuntimeTurnRejectionOptions = {
  readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[];
  readonly runtimePluginContextItems?: readonly RuntimePluginContextItem[];
  readonly runtimePluginToolInvocations?: readonly RuntimePluginToolInvocationSnapshot[];
  /** The model round the rejection judged, with the runtime's verdict on it. */
  readonly round?: number;
  readonly commitValidation?: RoleModelCommitValidationSnapshot;
  readonly healthResult?: RuntimePluginHealthHostResult;
  readonly message: string;
  readonly reason: LocalRuntimeUserMessageRejectionReason;
  /**
   * What the record says; the same as the result's reason except at the
   * health gate, where the record names the commit validation failure.
   */
  readonly recordReason: RuntimeTurnRejectionReason;
  readonly runtimePluginContext?: RuntimePluginContext;
  readonly toolCallIds?: readonly string[];
  readonly visibleMessageIds?: readonly string[];
};
