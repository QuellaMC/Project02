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
  'before_role_model_call',
  'handle_tool_call',
  'after_turn_committed',
  'on_session_end',
  'on_shutdown',
  'health',
  'plugin_discovery',
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

/** Scheduling only: whether the runtime may overlap two calls of a tool. */
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

export const healthFailureBehaviorValues = ['degrade', 'reject_turn'] as const;
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
export type RuntimePluginBeforeRoleModelFailureBehavior =
  (typeof beforeRoleModelFailureBehaviorValues)[number];
export type RuntimePluginHandleToolCallFailureBehavior =
  (typeof handleToolCallFailureBehaviorValues)[number];
export type RuntimePluginHealthFailureBehavior =
  (typeof healthFailureBehaviorValues)[number];
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

// Contract vocabulary: the runtime's turn model and codecs match on it.
export const runtimePluginBeforeRoleModelCallRejectionReason =
  'plugin_before_role_model_call_rejected';

export type RuntimePluginBeforeRoleModelCallRejectionReason =
  typeof runtimePluginBeforeRoleModelCallRejectionReason;
