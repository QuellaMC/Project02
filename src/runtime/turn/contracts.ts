import type {
  CharacterAgent,
  CharacterTurnOptions,
  CharacterTurnResult,
  ConversationSession
} from '../../core/conversation.ts';
import type {
  PreparedRuntimePluginConfigEffect,
  RuntimePluginContext,
  RuntimePluginContextItem,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginToolCall,
  RuntimePluginToolInvocationSnapshot
} from '../../plugins/types.ts';
import type {
  RuntimePluginHealthHostResult,
  RuntimePluginFileStorePreparedTransaction,
  RuntimePluginHost
} from '../../plugins/index.ts';
import type {
  ParsedRoleModelDecisionSnapshot,
  RoleModelDecisionRejectionReason,
  RoleModelIOSnapshot
} from '../../role-model/contracts.ts';
import type {
  RoleModelAdapter,
  RoleModelPluginToolRoutingEvidence
} from '../../role-model/loop.ts';
import type {
  RuntimeEventIdentity,
  UserMessageRuntimeEvent
} from '../../core/index.ts';
import type {
  ConversationLogRecord,
  RawEventLogPayloadSummary,
  RawEventLogRecord,
  RawEventLogRecordInput,
  RoleModelCommitValidationSnapshot,
  RuntimeLogStore,
  RuntimeTraceEntry,
  RuntimeTraceStepName
} from '../log.ts';

export const runtimePluginHealthRejectionReason = 'plugin_health_rejected';

export type LocalRuntimeUserMessageRejectionReason =
  | 'input_validation_rejected'
  | 'character_reply_rejected'
  | typeof runtimePluginHealthRejectionReason
  | 'plugin_before_role_model_call_rejected'
  | RoleModelDecisionRejectionReason;

export type RunLocalUserMessageEventOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly rawInput?: string;
  readonly agent?: CharacterAgent;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly pluginHost: RuntimePluginHost;
  readonly characterTurnOptions?: CharacterTurnOptions;
  readonly committedAt?: string;
  readonly onProgress?: (
    event: LocalRuntimeTurnProgressEvent
  ) => Promise<void> | void;
};

export type LocalRuntimeTurnProgressEvent =
  | {
      readonly kind: 'visible_reply';
      readonly final: boolean;
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
  readonly turn?: CharacterTurnResult;
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly rawEvent: RawEventLogRecord;
  readonly rawEventLogRecords: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
  readonly pluginFileStoreRecoveryPending?: boolean;
  readonly postCommitFailures?: readonly string[];
};

export type LocalRuntimeUserMessageRejectedResult = {
  readonly status: 'rejected';
  readonly event: UserMessageRuntimeEvent;
  readonly reason: LocalRuntimeUserMessageRejectionReason;
  readonly message: string;
  readonly rawEvent: RawEventLogRecord;
  readonly rawEventLogRecords: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
};

export type LocalRuntimeUserMessageInputRejectedResult = {
  readonly status: 'rejected';
  readonly identity: RuntimeEventIdentity;
  readonly eventType: 'USER_MESSAGE';
  readonly reason: 'input_validation_rejected';
  readonly message: string;
  readonly rawEvent: RawEventLogRecord;
  readonly traceEntries: readonly RuntimeTraceEntry[];
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

export type RoleModelRawEvidence = {
  readonly roleModelIOSnapshot?: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot?: ParsedRoleModelDecisionSnapshot;
  readonly commitValidation?: RoleModelCommitValidationSnapshot;
};

export function roleModelIOSnapshotSessionId(
  snapshot: RoleModelIOSnapshot
): string {
  return snapshot.inputEnvelope.decisionContext.sessionId;
}

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
  readonly traceEntries: RuntimeTraceEntry[];
  readonly rawEventLogRecords: RawEventLogRecord[];
  readonly identity: RuntimeEventIdentity;
  readonly normalizedEventResult: NormalizeUserMessageRuntimeEventResult;
  readonly event: UserMessageRuntimeEvent;
  readonly payloadSummary: RawEventLogPayloadSummary;
  runtimePluginContextForTurn: RuntimePluginContext | undefined;
  runtimePluginHostForTurn: RuntimePluginHost | undefined;
  pluginFileStoreTransactionActive: boolean;
  preparedPluginFileStoreTransaction:
    | RuntimePluginFileStorePreparedTransaction
    | undefined;
  terminalRawEventMayBeDurable: boolean;
  readonly committedVisibleMessages: ConversationLogRecord[];
  readonly startedPluginToolCalls: Map<string, RuntimePluginToolCall>;
  readonly finishedToolCallIds: string[];
  readonly finishedPluginToolResults: RoleModelPluginToolRoutingEvidence[];
  readonly preparedConfigEffectsByToolCallId: Map<
    string,
    PreparedRuntimePluginConfigEffect
  >;
  userConversationMessage: ConversationLogRecord | undefined;
};

export type AppendVisibleReplyOptions = {
  readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[];
  readonly final: boolean;
  readonly roleModelIOSnapshot: RoleModelIOSnapshot;
  readonly parsedRoleModelDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly text: string;
};

export type RuntimeTurnRejectionOptions = {
  readonly runtimePluginEvidence?: readonly RuntimePluginEvidenceSnapshot[];
  readonly runtimePluginContextItems?: readonly RuntimePluginContextItem[];
  readonly runtimePluginToolInvocations?: readonly RuntimePluginToolInvocationSnapshot[];
  readonly evidence?: RoleModelRawEvidence;
  readonly healthResult?: RuntimePluginHealthHostResult;
  readonly message: string;
  readonly rawKind: RawEventLogRecordInput['kind'];
  readonly rawReason: string;
  readonly reason: LocalRuntimeUserMessageRejectionReason;
  readonly runtimePluginContext?: RuntimePluginContext;
  readonly traceStep: RuntimeTraceStepName;
  readonly toolCallIds?: readonly string[];
  readonly visibleMessageIds?: readonly string[];
};
