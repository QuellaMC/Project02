/**
 * Public API of the plugin contract layer (src/plugins/api).
 *
 * This is the only plugins surface the runtime may depend on
 * (arch:check rule `runtime-plugins-value-via-api`): data shapes,
 * contract constants, validating constructors, and pure predicates.
 * Host, policy, and package behavior live outside api and must never
 * be imported from runtime.
 */
export {
  afterTurnCommittedFailureBehaviorValues,
  beforeRoleModelFailureBehaviorValues,
  characterStatePatchModelToolName,
  characterStatePluginId,
  confirmationRequirementValues,
  firstPartyModelToolsPluginId,
  handleToolCallFailureBehaviorValues,
  healthFailureBehaviorValues,
  runtimePluginAccessLevelValues,
  runtimePluginAccessNameValues,
  runtimePluginBeforeRoleModelCallRejectionReason,
  runtimePluginConfigReadToolName,
  runtimePluginConfigUpdateToolName,
  runtimePluginConfigValueTypeValues,
  runtimePluginContextItemKindValues,
  runtimePluginContractVersion,
  runtimePluginDeclarationValues,
  runtimePluginEvidenceKindValues,
  runtimePluginEvidenceStatusValues,
  runtimePluginHealthStatusValues,
  runtimePluginId,
  runtimePluginKindValues,
  runtimePluginListToolName,
  runtimePluginPolicyOutcomeValues,
  runtimePluginSideEffectLevelValues,
  runtimePluginSourceKindValues,
  runtimePluginToolValidationOwnerValues,
  runtimePluginTrustLevelValues,
  type RuntimePluginAccessLevel,
  type RuntimePluginAccessMap,
  type RuntimePluginAccessName,
  type RuntimePluginAccessSnapshot,
  type RuntimePluginAfterTurnCommittedFailureBehavior,
  type RuntimePluginBeforeRoleModelCallRejectionReason,
  type RuntimePluginBeforeRoleModelFailureBehavior,
  type RuntimePluginConfigValueType,
  type RuntimePluginConfirmationRequirement,
  type RuntimePluginContextItemKind,
  type RuntimePluginDeclaration,
  type RuntimePluginEvidenceKind,
  type RuntimePluginEvidenceStatus,
  type RuntimePluginHandleToolCallFailureBehavior,
  type RuntimePluginHealthFailureBehavior,
  type RuntimePluginHealthStatus,
  type RuntimePluginKind,
  type RuntimePluginPolicyOutcome,
  type RuntimePluginSideEffectLevel,
  type RuntimePluginSourceKind,
  type RuntimePluginToolValidationOwner,
  type RuntimePluginTrustLevel,
} from './contract.ts';
export {
  type CreateRuntimePluginAfterTurnCommittedContextOptions,
  type CreateRuntimePluginContextOptions,
  type PreparedRuntimePluginConfigEffect,
  type RuntimePlugin,
  type RuntimePluginActivationMetadata,
  type RuntimePluginAfterTurnCommittedContext,
  type RuntimePluginBeforeRoleModelCallResult,
  type RuntimePluginCommittedTurnSnapshot,
  type RuntimePluginCompatibilityMetadata,
  type RuntimePluginConfigField,
  type RuntimePluginConfigMetadata,
  type RuntimePluginContext,
  type RuntimePluginContextBudget,
  type RuntimePluginContextItem,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginFileStore,
  type RuntimePluginHealthSnapshot,
  type RuntimePluginHookResult,
  type RuntimePluginJsonObject,
  type RuntimePluginJsonValue,
  type RuntimePluginLifecycleHooks,
  type RuntimePluginListingSnapshot,
  type RuntimePluginManifest,
  type RuntimePluginProvidedTool,
  type RuntimePluginRegistrationSnapshot,
  type RuntimePluginRegistrySnapshot,
  type RuntimePluginRuntimePolicy,
  type RuntimePluginSourceReference,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallExecutionResult,
  type RuntimePluginToolCallResult,
  type RuntimePluginToolInvocationSnapshot,
  type RuntimePluginTurnEvidenceSnapshot,
  type RuntimePluginValidationFailureReason,
  type RuntimePluginValidationResult,
} from './types.ts';
export {
  createPreparedRuntimePluginConfigEffect,
  createRuntimePlugin,
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  createRuntimePluginListingSnapshot,
  createRuntimePluginRegistrySnapshot,
  createRuntimePluginToolCallResultSnapshot,
  createRuntimePluginToolInvocationSnapshot,
  createRuntimePluginTurnEvidenceSnapshot,
  preparedRuntimePluginConfigEffectHasApprovalEvidence,
  registeredRuntimePluginLifecycleHooks,
} from './constructors.ts';
export {
  createRuntimePluginContextItem,
  createRuntimePluginManifest,
  createRuntimePluginProvidedTool,
  validateRuntimePluginContextItem,
  validateRuntimePluginManifest,
  validateRuntimePluginProvidedTool,
} from './manifest-validation.ts';
export {
  isRuntimePluginCredentialKey,
  redactRuntimePluginText,
} from './validation-primitives.ts';
export {
  isApprovalGatedRuntimePluginTool,
  isModelFacingRuntimePluginTool,
  validateRuntimePluginModelFacingToolAccess,
} from './tool-classification.ts';
export {
  beforeRoleModelFailureRejectsTurn,
  mergedRedactionLabels,
  runtimePluginEvidenceBlocksToolInvocation,
  runtimePluginToolResultHasBlockingEvidence,
} from './evidence-policy.ts';
export {
  requiredModelToolCallLimit,
  requiredModelToolInputContract,
} from './tool-schema-validation.ts';
export {
  assertUniqueRuntimePluginIds,
  runtimeIdentityMatchesContext,
} from './identity.ts';
export {
  parseRuntimePluginPackageDescriptor,
  readRuntimePluginPackageDescriptor,
  runtimePluginPackageDescriptorFormat,
  runtimePluginPackageEntryExtensions,
  type ParsedRuntimePluginPackageDescriptor,
  type RuntimePluginPackageDescriptorIssue,
  type RuntimePluginPackageDescriptorParseResult,
} from './package-descriptor.ts';
// factory.ts is deliberately NOT re-exported here: it type-imports
// runtime/config (resolved plugin config shapes), so exposing it through
// this barrel would put the barrel on a runtime->api->runtime cycle.
// Its consumers (package-loader, the composition root) reach it via
// plugins/index.ts or intra-module paths.
export {
  createPluginContextEvidence,
  createPluginToolEvidence,
} from './evidence-helpers.ts';
export {
  type CreateRuntimePluginFileStoreOptions,
  type DurableRuntimePluginFileStoreOptions,
  type InMemoryRuntimePluginFileStoreOptions,
  type RuntimePluginFileStorePathMode,
  type RuntimePluginFileStorePreparedTransaction,
  type RuntimePluginFileStoreProvider,
  type RuntimePluginFileStoreTransaction,
} from './file-store-contract.ts';
