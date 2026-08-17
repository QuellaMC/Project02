import type {ConversationLogRecord, RuntimeTurnStatus} from './records.ts';
import type {RuntimePluginAccessMap} from '../../plugins/api/index.ts';
import type {RoleModelPromptFrameSize} from '../../role-model/index.ts';

export type InspectTurnEvidence = {
  readonly eventId: string;
  readonly traceId: string;
  readonly status: RuntimeTurnStatus;
  readonly steps: readonly string[];
  readonly visibleMessages: readonly InspectVisibleMessage[];
  readonly modelRounds: readonly InspectRoleModelRoundEvidence[];
  readonly toolEvents: readonly InspectToolCallEvent[];
  readonly roleModelEvidence?: InspectRoleModelEvidence;
  readonly pluginEvidence?: InspectPluginEvidence;
  readonly reason?: string;
};

export type InspectVisibleMessage = {
  readonly id: string;
  readonly role: ConversationLogRecord['role'];
  readonly speakerName: string;
  readonly text: string;
};

export type InspectToolCallEvent = {
  readonly callId: string;
  readonly round: number;
  readonly toolName: string;
  readonly pluginId: string;
  readonly input?: unknown;
  readonly result?: InspectPluginToolInvocationResult;
  readonly pluginStoreRevision?: number;
};

export type InspectCuratedContextSection = {
  readonly pluginId: string;
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly capChars?: number;
  readonly usedChars?: number;
};

export type InspectPromptSizeMeasure = {
  readonly chars: number;
  readonly estimatedTokens: number;
};

/** The recorded characters with the runtime's estimate applied, per frame and in all. */
export type InspectPromptSize = {
  readonly frames: readonly (RoleModelPromptFrameSize &
    InspectPromptSizeMeasure)[];
  readonly tools: InspectPromptSizeMeasure;
  readonly total: InspectPromptSizeMeasure;
};

export type InspectRuntimeNote = {
  readonly id: string;
  readonly text: string;
  readonly pluginId?: string;
};

export type InspectRoleModelEvidence = {
  readonly input?: {
    readonly sessionId: string;
    readonly allowedTools: readonly string[];
    readonly outputContractVersion: string;
    readonly currentUserMessage: string;
    readonly historyWindow: {readonly turnEventIds: readonly string[]};
    readonly contextSummary?: string;
    readonly runtimeNotes: readonly InspectRuntimeNote[];
    readonly curatedContextSections: readonly InspectCuratedContextSection[];
    readonly pluginContextItems: readonly InspectPluginContextItem[];
  };
  /** How big the rendered prompt was, per frame kind and in all, beside the reported usage. */
  readonly promptSize?: InspectPromptSize;
  readonly output?: {
    readonly rawOutputText: string;
    readonly providerMetadata?: unknown;
    readonly providerExchange?: unknown;
  };
  readonly parsedDecision?: InspectParsedRoleModelDecision;
  readonly commitValidation?: InspectRoleModelCommitValidation;
};

export type InspectRoleModelRoundEvidence = {
  readonly rawEventKind: string;
  readonly roleModelEvidence: InspectRoleModelEvidence;
};

export type InspectParsedRoleModelDecision =
  | {
      readonly status: 'accepted';
      readonly toolCalls: readonly InspectModelToolCall[];
      readonly nonCommittedTopLevelText?: InspectNonCommittedTopLevelText;
    }
  | {
      readonly status: 'rejected';
      readonly rejectionReason: string;
      readonly rejectionDetails?: string;
    };

export type InspectModelToolCall = {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
};

export type InspectNonCommittedTopLevelText = {
  readonly source: 'model_top_level_text';
  readonly committed: false;
  readonly text: string;
};

export type InspectRoleModelCommitValidation =
  | {
      readonly status: 'accepted';
      readonly acceptedVisibleReplyText?: string;
    }
  | {
      readonly status: 'rejected';
      readonly rejectionReason: string;
      readonly rejectionDetails?: string;
    };

export type InspectPluginEvidence = {
  readonly contractVersion?: string;
  readonly plugins: readonly InspectPluginListing[];
  readonly contextItems: readonly InspectPluginContextItem[];
  readonly toolInvocations: readonly InspectPluginToolInvocation[];
  readonly evidence: readonly InspectPluginEvidenceSnapshot[];
  readonly policyOutcomes: readonly string[];
  readonly health: readonly InspectPluginHealthSnapshot[];
};

export type InspectPluginListing = {
  readonly pluginId: string;
  readonly displayName: string;
  readonly version: string;
  readonly kind: string;
  readonly firstParty: boolean;
  readonly enabled: boolean;
  readonly requestedAccess: RuntimePluginAccessMap;
  readonly grantedAccess: RuntimePluginAccessMap;
  readonly providedTools: readonly InspectPluginToolListing[];
  readonly registeredLifecycleHooks: readonly string[];
  readonly redactionLabels: readonly string[];
  readonly configFingerprint?: string;
  readonly healthStatus?: string;
};

export type InspectPluginToolListing = {
  readonly name: string;
  readonly validationOwner: string;
  readonly requiresConfirmation: boolean;
  readonly concurrency?: string;
};

export type InspectPluginContextItem = {
  readonly pluginId: string;
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly sourceReferences: readonly InspectPluginSourceReference[];
  readonly redactionLabels: readonly string[];
  readonly confidence?: number;
};

export type InspectPluginToolInvocation = {
  readonly pluginId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly result: InspectPluginToolInvocationResult;
};

export type InspectPluginToolInvocationResult =
  | {
      readonly status: 'accepted';
      readonly output: unknown;
      readonly evidence: readonly InspectPluginEvidenceSnapshot[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      readonly message: string;
      readonly evidence: readonly InspectPluginEvidenceSnapshot[];
    };

export type InspectPluginEvidenceSnapshot = {
  readonly pluginId: string;
  readonly evidenceKind: string;
  readonly status: string;
  readonly summary: string;
  readonly redactionLabels: readonly string[];
  readonly policyOutcome?: string;
  readonly sourceReferences?: readonly InspectPluginSourceReference[];
  readonly configFingerprint?: string;
};

export type InspectPluginHealthSnapshot = {
  readonly pluginId: string;
  readonly status: string;
  readonly checkedAt: string;
  readonly summary: string;
  readonly redactionLabels: readonly string[];
};

export type InspectPluginSourceReference = {
  readonly kind: string;
  readonly id: string;
  readonly title?: string;
  readonly uri?: string;
};
