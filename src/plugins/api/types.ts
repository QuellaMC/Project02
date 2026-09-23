import {
  type CharacterProfile,
  type RuntimeEventIdentity,
  type RuntimeEventType,
  type VisibleMessage,
} from '../../core/index.ts';
import type {ModelToolInputContract} from '../../role-model/api/index.ts';
import type {RuntimePluginDatabaseOpener} from './database-contract.ts';
import type {RuntimePluginSessionHistoryFeed} from './session-history-contract.ts';
import type {
  JsonBoundaryObject,
  JsonBoundaryValue,
} from '../../shared/json-boundary.ts';
import type {
  runtimePluginContractVersion,
  RuntimePluginAccessMap,
  RuntimePluginAccessSnapshot,
  RuntimePluginBeforeRoleModelFailureBehavior,
  RuntimePluginConfigScope,
  RuntimePluginConfigValueType,
  RuntimePluginToolConcurrency,
  RuntimePluginContextItemKind,
  RuntimePluginDeclaration,
  RuntimePluginEvidenceKind,
  RuntimePluginEvidenceStatus,
  RuntimePluginHandleToolCallFailureBehavior,
  RuntimePluginHealthFailureBehavior,
  RuntimePluginHealthStatus,
  RuntimePluginKind,
  RuntimePluginPolicyOutcome,
  RuntimePluginSourceKind,
  RuntimePluginToolValidationOwner,
} from './contract.ts';

export type RuntimePluginJsonValue = JsonBoundaryValue;

export type RuntimePluginJsonObject = JsonBoundaryObject;

export type RuntimePluginFileStore = {
  readJson(path: string): RuntimePluginJsonValue | undefined;
  readJsonl(path: string): readonly RuntimePluginJsonValue[];
  writeJsonAtomic(path: string, value: RuntimePluginJsonValue): void;
  appendJsonl(path: string, value: RuntimePluginJsonValue): void;
  revision(): number;
  /**
   * Runs the synchronous operation under the store's cross-process
   * mutation lease, so a read-modify-write derives only from state it
   * observed itself. Store calls inside the operation re-enter the lease.
   */
  withMutations<T>(operation: () => T): T;
};

export type RuntimePluginCompatibilityMetadata = {
  readonly hostContractVersions: readonly string[];
};

export type RuntimePluginConfigField = {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly valueType?: RuntimePluginConfigValueType;
  readonly defaultValueSummary?: string;
  readonly allowedValues?: readonly string[];
  readonly agentMutable?: boolean;
  readonly reloadRequired?: boolean;
  readonly redactionLabels: readonly string[];
};

export type RuntimePluginConfigMetadata = {
  readonly scope: RuntimePluginConfigScope;
  readonly fields: readonly RuntimePluginConfigField[];
  readonly fingerprint?: string;
};

export type RuntimePluginRuntimePolicy = {
  readonly timeoutMs: number;
  readonly redactionLabels: readonly string[];
  readonly failureBehavior: {
    readonly beforeRoleModelCall: RuntimePluginBeforeRoleModelFailureBehavior;
    readonly handleToolCall: RuntimePluginHandleToolCallFailureBehavior;
    readonly health: RuntimePluginHealthFailureBehavior;
  };
};

export type RuntimePluginActivationMetadata = {
  readonly defaultEnabled: boolean;
  readonly reasons: readonly string[];
};

export type RuntimePluginManifest = {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly kind: RuntimePluginKind;
  readonly description: string;
  readonly contractVersion: typeof runtimePluginContractVersion;
  readonly compatibility: RuntimePluginCompatibilityMetadata;
  readonly declaredPlugins: readonly RuntimePluginDeclaration[];
  readonly config: RuntimePluginConfigMetadata;
  readonly firstParty: boolean;
  readonly runtimePolicy: RuntimePluginRuntimePolicy;
  readonly activation: RuntimePluginActivationMetadata;
  readonly requestedAccess: RuntimePluginAccessMap;
};

export type RuntimePluginProvidedTool = {
  readonly name: string;
  readonly description: string;
  readonly inputContract: ModelToolInputContract;
  readonly validationOwner: RuntimePluginToolValidationOwner;
  /** Absent means exclusive: a tool overlaps only when it says so. */
  readonly concurrency?: RuntimePluginToolConcurrency;
  readonly requiresConfirmation: boolean;
};

export type RuntimePluginSourceReference = {
  readonly kind: RuntimePluginSourceKind;
  readonly id: string;
  readonly title?: string;
  readonly uri?: string;
};

export type RuntimePluginContextItem = {
  readonly pluginId: string;
  readonly id: string;
  readonly kind: RuntimePluginContextItemKind;
  readonly text: string;
  readonly sourceReferences: readonly RuntimePluginSourceReference[];
  readonly confidence?: number;
  readonly redactionLabels: readonly string[];
};

export type RuntimePluginEvidenceSnapshot = RuntimeEventIdentity & {
  readonly kind: 'runtime_plugin_evidence_snapshot';
  readonly pluginId: string;
  readonly evidenceKind: RuntimePluginEvidenceKind;
  readonly status: RuntimePluginEvidenceStatus;
  readonly summary: string;
  readonly policyOutcome?: RuntimePluginPolicyOutcome;
  readonly sourceReferences?: readonly RuntimePluginSourceReference[];
  readonly redactionLabels: readonly string[];
  readonly configFingerprint?: string;
};

export type RuntimePluginHealthSnapshot = {
  readonly pluginId: string;
  readonly status: RuntimePluginHealthStatus;
  readonly checkedAt: string;
  readonly summary: string;
  readonly redactionLabels: readonly string[];
};

export type RuntimePluginListingSnapshot = RuntimePluginAccessSnapshot & {
  readonly pluginId: string;
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
  readonly registeredLifecycleHooks: readonly RuntimePluginDeclaration[];
  readonly enabled: boolean;
  readonly redactionLabels: readonly string[];
  readonly configFingerprint?: string;
  readonly healthStatus?: RuntimePluginHealthStatus;
};

export type RuntimePluginTurnEvidenceSnapshot = RuntimeEventIdentity & {
  readonly kind: 'runtime_plugin_turn_evidence_snapshot';
  readonly contractVersion: typeof runtimePluginContractVersion;
  readonly plugins: readonly RuntimePluginListingSnapshot[];
  readonly contextItems: readonly RuntimePluginContextItem[];
  readonly toolInvocations: readonly RuntimePluginToolInvocationSnapshot[];
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly health: readonly RuntimePluginHealthSnapshot[];
};

export type RuntimePluginContext = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventId: string;
  readonly traceId: string;
  readonly eventType: RuntimeEventType;
  readonly timestamp: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly currentUserMessage: string;
  /** Ids of the visible messages currently in the model's context window. */
  readonly recentVisibleMessageIds: readonly string[];
  readonly character: CharacterProfile;
  readonly privacy: {
    readonly redactionLabels: readonly string[];
    readonly exposePrivateConfig: false;
  };
  readonly pluginId?: string;
  readonly fileStore?: RuntimePluginFileStore;
  /** Character-scoped cross-session store; needs character_file_store. */
  readonly characterFileStore?: RuntimePluginFileStore;
  /** Visible-message history feed; needs session_history read. */
  readonly sessionHistory?: RuntimePluginSessionHistoryFeed;
  /** Opener for this plugin's own databases; needs plugin_database write. */
  readonly pluginDatabase?: RuntimePluginDatabaseOpener;
};

export type RuntimePluginCommittedTurnSnapshot = {
  readonly committedAt: string;
  readonly visibleMessageIds: readonly string[];
  readonly visibleMessages: readonly VisibleMessage[];
};

export type RuntimePluginAfterTurnCommittedContext = RuntimePluginContext & {
  readonly committedTurn: RuntimePluginCommittedTurnSnapshot;
};

export type CreateRuntimePluginContextOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly eventType: RuntimeEventType;
  readonly currentUserMessage: string;
  /**
   * What the model sees can grow mid-turn (interim replies commit before
   * executable tools route), so a live turn passes a thunk the context
   * re-reads; a plain array stays fixed.
   */
  readonly recentVisibleMessageIds?:
    readonly string[] | (() => readonly string[]);
  readonly character: CharacterProfile;
  readonly redactionLabels?: readonly string[];
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
};

export type CreateRuntimePluginAfterTurnCommittedContextOptions =
  CreateRuntimePluginContextOptions & {
    readonly committedAt: string;
    readonly visibleMessages: readonly VisibleMessage[];
  };

/**
 * A structured entry for the trusted curated-context prompt frame. Plugins
 * never contribute raw prompt text; the host renders sections it validated.
 */
export type RuntimePluginCuratedContextSection = {
  readonly pluginId: string;
  readonly id: string;
  /** Single-line section heading rendered by the host. */
  readonly title: string;
  readonly text: string;
  /** Capacity display only; enforcement belongs to the owning plugin. */
  readonly capChars?: number;
  readonly usedChars?: number;
};

export type RuntimePluginBeforeRoleModelCallResult = {
  readonly contextItems: readonly RuntimePluginContextItem[];
  /** Trusted-frame sections; granted only via trusted_context write access. */
  readonly curatedContext?: readonly RuntimePluginCuratedContextSection[];
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

export type RuntimePluginToolCall = RuntimeEventIdentity & {
  readonly toolCallId?: string;
  readonly pluginId: string;
  readonly toolName: string;
  readonly input: RuntimePluginJsonObject;
};

export type RuntimePluginToolCallResult =
  | {
      readonly status: 'accepted';
      readonly output: RuntimePluginJsonValue;
      readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      readonly message: string;
      readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
    };

export type PreparedRuntimePluginConfigEffect = RuntimeEventIdentity & {
  readonly kind: 'runtime_plugin_config_effect';
  readonly effectId: string;
  readonly targetPluginId: string;
  readonly targetConfigPath: string;
  readonly fieldName: string;
  readonly expectedFingerprint: string;
  readonly resultFingerprint: string;
  readonly operation:
    | {
        readonly kind: 'set';
        readonly value: RuntimePluginJsonValue;
      }
    | {
        readonly kind: 'unset';
      };
};

/**
 * What a handleToolCall hook returns. An approval-gated tool hands the host
 * the change it prepared; the host asks the person, applies it on approval,
 * and answers the model with a plain result — the effect never travels on.
 */
export type RuntimePluginToolCallExecutionResult =
  | (Extract<RuntimePluginToolCallResult, {readonly status: 'accepted'}> & {
      readonly preparedConfigEffect?: PreparedRuntimePluginConfigEffect;
    })
  | Extract<RuntimePluginToolCallResult, {readonly status: 'rejected'}>;

export type RuntimePluginToolInvocationSnapshot = RuntimeEventIdentity & {
  readonly kind: 'runtime_plugin_tool_invocation_snapshot';
  readonly pluginId: string;
  readonly toolName: string;
  readonly input: RuntimePluginJsonObject;
  readonly result: RuntimePluginToolCallResult;
};

export type RuntimePluginHookResult = {
  readonly status: 'completed' | 'failed';
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
};

export type RuntimePluginLifecycleHooks = {
  readonly beforeRoleModelCall?: (
    context: RuntimePluginContext,
  ) =>
    | RuntimePluginBeforeRoleModelCallResult
    | Promise<RuntimePluginBeforeRoleModelCallResult>;
  readonly handleToolCall?: (
    call: RuntimePluginToolCall,
    context: RuntimePluginContext,
  ) =>
    | RuntimePluginToolCallExecutionResult
    | Promise<RuntimePluginToolCallExecutionResult>;
  readonly afterTurnCommitted?: (
    context: RuntimePluginAfterTurnCommittedContext,
  ) => RuntimePluginHookResult | Promise<RuntimePluginHookResult>;
  readonly onSessionEnd?: (
    context: RuntimePluginContext,
  ) => RuntimePluginHookResult | Promise<RuntimePluginHookResult>;
  readonly onShutdown?: (
    context: RuntimePluginContext,
  ) => RuntimePluginHookResult | Promise<RuntimePluginHookResult>;
  readonly health?: (
    context: RuntimePluginContext,
  ) => RuntimePluginHealthSnapshot | Promise<RuntimePluginHealthSnapshot>;
};

export type RuntimePlugin = {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
  readonly lifecycleHooks: RuntimePluginLifecycleHooks;
};

export type RuntimePluginRegistrationSnapshot = RuntimePluginAccessSnapshot & {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
  readonly registeredLifecycleHooks: readonly RuntimePluginDeclaration[];
};

export type RuntimePluginRegistrySnapshot = {
  readonly contractVersion: typeof runtimePluginContractVersion;
  readonly plugins: readonly RuntimePluginRegistrationSnapshot[];
};

export type RuntimePluginValidationFailureReason =
  | 'malformed_manifest'
  | 'unsupported_contract_version'
  | 'unsupported_plugin_kind'
  | 'duplicate_declaration'
  | 'missing_required_declaration'
  | 'malformed_tool_definition'
  | 'malformed_context_item'
  | 'malformed_curated_context_section'
  | 'duplicate_plugin_id';

export type RuntimePluginValidationResult<T> =
  | {
      readonly status: 'accepted';
      readonly value: T;
    }
  | {
      readonly status: 'rejected';
      readonly reason: RuntimePluginValidationFailureReason;
      readonly details: string;
    };
