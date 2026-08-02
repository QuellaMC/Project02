export const runtimePluginContractVersion = 'mvp-008.runtime_plugin.v2';
export const firstPartyModelToolsPluginId = 'first_party.model_tools';
export const runtimePluginId = 'runtime.plugin';
export const characterStatePluginId = 'character-state';

export const characterStatePatchModelToolName = 'character_state.patch';
export const runtimePluginListToolName = 'runtime.plugin.list';
export const runtimePluginConfigReadToolName = 'runtime.plugin.config';
export const runtimePluginConfigUpdateToolName = 'runtime.plugin.config.update';

export const runtimePluginKindValues = [
  'first_party',
  'memory_provider',
  'tool_provider',
  'context_provider',
  'bridge_adapter',
] as const;

export const runtimePluginDeclarationValues = [
  'tool_provider',
  'context_provider',
  'before_role_model_call',
  'handle_tool_call',
  'after_turn_committed',
  'on_session_end',
  'on_shutdown',
  'health',
  'plugin_discovery',
] as const;

export const runtimePluginTrustLevelValues = [
  'first_party',
  'trusted_adapter',
  'test_fixture',
] as const;

export const runtimePluginAccessNameValues = [
  'file_store',
  'turn_context',
  'model_input',
] as const;

export const runtimePluginAccessLevelValues = [
  'none',
  'read',
  'write',
] as const;

/**
 * How a tool call may overlap other calls in the same model batch.
 *
 * Scheduling only — deliberately separate from the annotation hints,
 * which describe a tool so a person can judge it. A read-only tool can
 * still need exclusivity (a rate-limited endpoint), and a writing tool
 * against isolated state could be shared; one field answering both
 * questions is what made the retired sideEffectLevel enum confusing.
 */
export const runtimePluginToolConcurrencyValues = [
  'shared',
  'exclusive',
] as const;

export const beforeRoleModelFailureBehaviorValues = [
  'reject_turn',
  'degrade',
] as const;

export const handleToolCallFailureBehaviorValues = [
  'reject_tool_call',
  'degrade',
] as const;

export const afterTurnCommittedFailureBehaviorValues = ['log_failure'] as const;
export const healthFailureBehaviorValues = ['degrade', 'reject_turn'] as const;
export const confirmationRequirementValues = [
  'not_required',
  'required',
] as const;

export const runtimePluginContextItemKindValues = [
  'memory',
  'resource',
  'runtime_note',
  'tool_result',
  'discovery',
] as const;

export const runtimePluginSourceKindValues = [
  'memory',
  'conversation',
  'resource',
  'external_contract',
  'runtime',
] as const;

export const runtimePluginToolValidationOwnerValues = [
  'built_in_model_tools',
  'plugin_host',
  'adapter',
] as const;

export const runtimePluginEvidenceKindValues = [
  'registration',
  'before_role_model_call',
  'tool_invocation',
  'after_turn_committed',
  'session_end',
  'shutdown',
  'health',
  'policy',
] as const;

export const runtimePluginEvidenceStatusValues = [
  'accepted',
  'rejected',
  'degraded',
  'failed',
] as const;

export const runtimePluginPolicyOutcomeValues = [
  'registration_accepted',
  'available_for_turn',
  'optional_degraded',
  'required_rejected',
  'disallowed_tool_call',
  'handler_rejected',
  'user_approved',
  'timeout',
  'health_degraded',
  'after_commit_failed',
] as const;

export const runtimePluginHealthStatusValues = [
  'ok',
  'degraded',
  'unavailable',
] as const;

export const runtimePluginConfigValueTypeValues = [
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'secret',
  'path',
  'enum',
] as const;

export const runtimePluginConfigScopeValues = [
  'global_with_character_overrides',
  'character_only',
] as const;

export type RuntimePluginKind = (typeof runtimePluginKindValues)[number];
export type RuntimePluginDeclaration =
  (typeof runtimePluginDeclarationValues)[number];
export type RuntimePluginTrustLevel =
  (typeof runtimePluginTrustLevelValues)[number];
export type RuntimePluginAccessName =
  (typeof runtimePluginAccessNameValues)[number];
export type RuntimePluginAccessLevel =
  (typeof runtimePluginAccessLevelValues)[number];
export type RuntimePluginAccessMap = Partial<
  Record<RuntimePluginAccessName, RuntimePluginAccessLevel>
>;
export type RuntimePluginAccessSnapshot = {
  readonly requestedAccess: RuntimePluginAccessMap;
  readonly grantedAccess: RuntimePluginAccessMap;
};
export type RuntimePluginToolConcurrency =
  (typeof runtimePluginToolConcurrencyValues)[number];

/**
 * Advisory description of a tool, in the shape MCP clients already use,
 * so the person enabling a plugin can judge its tools and the runtime
 * knows when to ask before running one.
 *
 * The runtime does not police these: a plugin the user chose to run is
 * trusted the way a local MCP server is. Absent annotations mean
 * unknown, and unknown is treated conservatively (ask).
 */
export type RuntimePluginToolAnnotations = {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly openWorldHint?: boolean;
};
export type RuntimePluginBeforeRoleModelFailureBehavior =
  (typeof beforeRoleModelFailureBehaviorValues)[number];
export type RuntimePluginHandleToolCallFailureBehavior =
  (typeof handleToolCallFailureBehaviorValues)[number];
export type RuntimePluginAfterTurnCommittedFailureBehavior =
  (typeof afterTurnCommittedFailureBehaviorValues)[number];
export type RuntimePluginHealthFailureBehavior =
  (typeof healthFailureBehaviorValues)[number];
export type RuntimePluginConfirmationRequirement =
  (typeof confirmationRequirementValues)[number];
export type RuntimePluginContextItemKind =
  (typeof runtimePluginContextItemKindValues)[number];
export type RuntimePluginSourceKind =
  (typeof runtimePluginSourceKindValues)[number];
export type RuntimePluginToolValidationOwner =
  (typeof runtimePluginToolValidationOwnerValues)[number];
export type RuntimePluginEvidenceKind =
  (typeof runtimePluginEvidenceKindValues)[number];
export type RuntimePluginEvidenceStatus =
  (typeof runtimePluginEvidenceStatusValues)[number];
export type RuntimePluginPolicyOutcome =
  (typeof runtimePluginPolicyOutcomeValues)[number];
export type RuntimePluginHealthStatus =
  (typeof runtimePluginHealthStatusValues)[number];
export type RuntimePluginConfigValueType =
  (typeof runtimePluginConfigValueTypeValues)[number];
export type RuntimePluginConfigScope =
  (typeof runtimePluginConfigScopeValues)[number];

// Reason code recorded in raw-event evidence when a plugin's
// before-role-model hook rejects the turn. Contract vocabulary: the
// runtime's turn model and codecs match on it.
export const runtimePluginBeforeRoleModelCallRejectionReason =
  'plugin_before_role_model_call_rejected';

export type RuntimePluginBeforeRoleModelCallRejectionReason =
  typeof runtimePluginBeforeRoleModelCallRejectionReason;
