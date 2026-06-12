import type { CharacterProfile } from './conversation.ts';
import {
  builtInModelToolDefinitionsForUserTurn,
  type ModelToolInputContract,
  type ModelToolInputField
} from './model-tools.ts';
import type {
  RuntimeEventIdentity,
  RuntimeEventType
} from './runtime-event.ts';

export const agentCapabilityContractVersion =
  'mvp-007.agent_capability.v1';
export const firstPartyModelToolsCapabilityId = 'first_party.model_tools';

const agentCapabilityKindValues = [
  'first_party',
  'memory_provider',
  'tool_provider',
  'context_provider',
  'bridge_adapter'
] as const;

const agentCapabilityDeclarationValues = [
  'tool_provider',
  'context_provider',
  'before_role_model_call',
  'handle_tool_call',
  'after_turn_committed',
  'on_session_end',
  'health',
  'capability_discovery'
] as const;

const agentCapabilityTrustLevelValues = [
  'first_party',
  'trusted_adapter',
  'test_fixture'
] as const;

const agentCapabilitySideEffectLevelValues = [
  'none',
  'runtime_read',
  'local_memory_write',
  'external_read',
  'external_write'
] as const;

const beforeRoleModelFailureBehaviorValues = [
  'reject_turn',
  'degrade'
] as const;

const handleToolCallFailureBehaviorValues = [
  'reject_tool_call',
  'degrade'
] as const;

const afterTurnCommittedFailureBehaviorValues = ['log_failure'] as const;
const healthFailureBehaviorValues = ['degrade', 'reject_turn'] as const;
const confirmationRequirementValues = ['not_required', 'required'] as const;

const agentCapabilityContextItemKindValues = [
  'memory',
  'resource',
  'runtime_note',
  'tool_result',
  'discovery'
] as const;

const agentCapabilitySourceKindValues = [
  'memory',
  'conversation',
  'resource',
  'external_contract',
  'runtime'
] as const;

const agentCapabilityToolValidationOwnerValues = [
  'built_in_model_tools',
  'capability_host',
  'adapter'
] as const;

const agentCapabilityEvidenceKindValues = [
  'registration',
  'before_role_model_call',
  'tool_invocation',
  'after_turn_committed',
  'session_end',
  'health',
  'policy'
] as const;

const agentCapabilityEvidenceStatusValues = [
  'accepted',
  'rejected',
  'degraded',
  'failed'
] as const;

const agentCapabilityPolicyOutcomeValues = [
  'registration_accepted',
  'available_for_turn',
  'optional_degraded',
  'required_rejected',
  'disallowed_tool_call',
  'handler_rejected',
  'timeout',
  'health_degraded',
  'after_commit_failed'
] as const;

const agentCapabilityHealthStatusValues = [
  'ok',
  'degraded',
  'unavailable'
] as const;

export type AgentCapabilityKind =
  (typeof agentCapabilityKindValues)[number];
export type AgentCapabilityDeclaration =
  (typeof agentCapabilityDeclarationValues)[number];
export type AgentCapabilityTrustLevel =
  (typeof agentCapabilityTrustLevelValues)[number];
export type AgentCapabilitySideEffectLevel =
  (typeof agentCapabilitySideEffectLevelValues)[number];
export type AgentCapabilityBeforeRoleModelFailureBehavior =
  (typeof beforeRoleModelFailureBehaviorValues)[number];
export type AgentCapabilityHandleToolCallFailureBehavior =
  (typeof handleToolCallFailureBehaviorValues)[number];
export type AgentCapabilityAfterTurnCommittedFailureBehavior =
  (typeof afterTurnCommittedFailureBehaviorValues)[number];
export type AgentCapabilityHealthFailureBehavior =
  (typeof healthFailureBehaviorValues)[number];
export type AgentCapabilityConfirmationRequirement =
  (typeof confirmationRequirementValues)[number];
export type AgentCapabilityContextItemKind =
  (typeof agentCapabilityContextItemKindValues)[number];
export type AgentCapabilitySourceKind =
  (typeof agentCapabilitySourceKindValues)[number];
export type AgentCapabilityToolValidationOwner =
  (typeof agentCapabilityToolValidationOwnerValues)[number];
export type AgentCapabilityEvidenceKind =
  (typeof agentCapabilityEvidenceKindValues)[number];
export type AgentCapabilityEvidenceStatus =
  (typeof agentCapabilityEvidenceStatusValues)[number];
export type AgentCapabilityPolicyOutcome =
  (typeof agentCapabilityPolicyOutcomeValues)[number];
export type AgentCapabilityHealthStatus =
  (typeof agentCapabilityHealthStatusValues)[number];

export type AgentCapabilityJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly AgentCapabilityJsonValue[]
  | AgentCapabilityJsonObject;

export type AgentCapabilityJsonObject = {
  readonly [key: string]: AgentCapabilityJsonValue;
};

export type AgentCapabilityCompatibilityMetadata = {
  readonly hostContractVersions: readonly string[];
  readonly sourceSystem?: string;
  readonly sourceVersion?: string;
  readonly externalContract?: string;
  readonly notes?: readonly string[];
};

export type AgentCapabilityConfigField = {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly redactionLabels: readonly string[];
};

export type AgentCapabilityConfigMetadata = {
  readonly fields: readonly AgentCapabilityConfigField[];
  readonly fingerprint?: string;
};

export type AgentCapabilityRuntimePolicy = {
  readonly requiredForTurn: boolean;
  readonly sideEffectLevel: AgentCapabilitySideEffectLevel;
  readonly confirmation: AgentCapabilityConfirmationRequirement;
  readonly timeoutMs: number;
  readonly sourceReferencesRequired: boolean;
  readonly redactionLabels: readonly string[];
  readonly failureBehavior: {
    readonly beforeRoleModelCall: AgentCapabilityBeforeRoleModelFailureBehavior;
    readonly handleToolCall: AgentCapabilityHandleToolCallFailureBehavior;
    readonly afterTurnCommitted: AgentCapabilityAfterTurnCommittedFailureBehavior;
    readonly health: AgentCapabilityHealthFailureBehavior;
  };
};

export type AgentCapabilityActivationMetadata = {
  readonly defaultEnabled: boolean;
  readonly reasons: readonly string[];
};

export type AgentCapabilityManifest = {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly kind: AgentCapabilityKind;
  readonly description: string;
  readonly contractVersion: typeof agentCapabilityContractVersion;
  readonly compatibility: AgentCapabilityCompatibilityMetadata;
  readonly declaredCapabilities: readonly AgentCapabilityDeclaration[];
  readonly config: AgentCapabilityConfigMetadata;
  readonly localTrustLevel: AgentCapabilityTrustLevel;
  readonly runtimePolicy: AgentCapabilityRuntimePolicy;
  readonly activation: AgentCapabilityActivationMetadata;
};

export type AgentCapabilityProvidedTool = {
  readonly name: string;
  readonly description: string;
  readonly requiredForUserTurn: boolean;
  readonly maxCallsPerUserTurn: number;
  readonly inputContract: ModelToolInputContract;
  readonly validationOwner: AgentCapabilityToolValidationOwner;
  readonly sideEffectLevel: AgentCapabilitySideEffectLevel;
  readonly requiresConfirmation: boolean;
  readonly sourceReferencesRequired: boolean;
};

export type AgentCapabilitySourceReference = {
  readonly kind: AgentCapabilitySourceKind;
  readonly id: string;
  readonly title?: string;
  readonly uri?: string;
};

export type AgentCapabilityContextBudget = {
  readonly estimatedTokens: number;
  readonly priority: number;
};

export type AgentCapabilityContextItem = {
  readonly capabilityId: string;
  readonly id: string;
  readonly kind: AgentCapabilityContextItemKind;
  readonly text: string;
  readonly budget: AgentCapabilityContextBudget;
  readonly sourceReferences: readonly AgentCapabilitySourceReference[];
  readonly confidence?: number;
  readonly redactionLabels: readonly string[];
};

export type AgentCapabilityEvidenceSnapshot = RuntimeEventIdentity & {
  readonly kind: 'agent_capability_evidence_snapshot';
  readonly capabilityId: string;
  readonly evidenceKind: AgentCapabilityEvidenceKind;
  readonly status: AgentCapabilityEvidenceStatus;
  readonly summary: string;
  readonly policyOutcome?: AgentCapabilityPolicyOutcome;
  readonly sourceReferences?: readonly AgentCapabilitySourceReference[];
  readonly redactionLabels: readonly string[];
  readonly configFingerprint?: string;
};

export type AgentCapabilityHealthSnapshot = {
  readonly capabilityId: string;
  readonly status: AgentCapabilityHealthStatus;
  readonly checkedAt: string;
  readonly summary: string;
  readonly redactionLabels: readonly string[];
};

export type AgentCapabilityListingSnapshot = {
  readonly capabilityId: string;
  readonly manifest: AgentCapabilityManifest;
  readonly providedTools: readonly AgentCapabilityProvidedTool[];
  readonly registeredLifecycleHooks: readonly AgentCapabilityDeclaration[];
  readonly installed: boolean;
  readonly registered: boolean;
  readonly enabled: boolean;
  readonly availableForTurn: boolean;
  readonly redactionLabels: readonly string[];
  readonly configFingerprint?: string;
  readonly healthStatus?: AgentCapabilityHealthStatus;
};

export type AgentCapabilityTurnEvidenceSnapshot = RuntimeEventIdentity & {
  readonly kind: 'agent_capability_turn_evidence_snapshot';
  readonly contractVersion: typeof agentCapabilityContractVersion;
  readonly capabilities: readonly AgentCapabilityListingSnapshot[];
  readonly contextItems: readonly AgentCapabilityContextItem[];
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
  readonly health: readonly AgentCapabilityHealthSnapshot[];
};

export type RuntimeCapabilityContext = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventId: string;
  readonly traceId: string;
  readonly eventType: RuntimeEventType;
  readonly timestamp: string;
  readonly currentUserMessage: string;
  readonly character: CharacterProfile;
  readonly privacy: {
    readonly redactionLabels: readonly string[];
    readonly exposePrivateConfig: false;
  };
};

export type CreateRuntimeCapabilityContextOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly eventType: RuntimeEventType;
  readonly currentUserMessage: string;
  readonly character: CharacterProfile;
  readonly redactionLabels?: readonly string[];
};

export type AgentCapabilityBeforeRoleModelCallResult = {
  readonly contextItems: readonly AgentCapabilityContextItem[];
  readonly runtimeNotes: readonly string[];
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
};

export type AgentCapabilityToolCall = RuntimeEventIdentity & {
  readonly capabilityId: string;
  readonly toolName: string;
  readonly input: AgentCapabilityJsonObject;
};

export type AgentCapabilityToolCallResult =
  | {
      readonly status: 'accepted';
      readonly output: AgentCapabilityJsonValue;
      readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      readonly message: string;
      readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
    };

export type AgentCapabilityHookResult = {
  readonly status: 'completed' | 'failed';
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
};

export type AgentCapabilityLifecycleHooks = {
  readonly beforeRoleModelCall?: (
    context: RuntimeCapabilityContext
  ) =>
    | AgentCapabilityBeforeRoleModelCallResult
    | Promise<AgentCapabilityBeforeRoleModelCallResult>;
  readonly handleToolCall?: (
    call: AgentCapabilityToolCall,
    context: RuntimeCapabilityContext
  ) => AgentCapabilityToolCallResult | Promise<AgentCapabilityToolCallResult>;
  readonly afterTurnCommitted?: (
    context: RuntimeCapabilityContext
  ) => AgentCapabilityHookResult | Promise<AgentCapabilityHookResult>;
  readonly onSessionEnd?: (
    context: RuntimeCapabilityContext
  ) => AgentCapabilityHookResult | Promise<AgentCapabilityHookResult>;
  readonly health?: (
    context: RuntimeCapabilityContext
  ) => AgentCapabilityHealthSnapshot | Promise<AgentCapabilityHealthSnapshot>;
};

export type AgentCapability = {
  readonly manifest: AgentCapabilityManifest;
  readonly providedTools: readonly AgentCapabilityProvidedTool[];
  readonly lifecycleHooks: AgentCapabilityLifecycleHooks;
};

export type AgentCapabilityRegistrationSnapshot = {
  readonly manifest: AgentCapabilityManifest;
  readonly providedTools: readonly AgentCapabilityProvidedTool[];
  readonly registeredLifecycleHooks: readonly AgentCapabilityDeclaration[];
};

export type AgentCapabilityRegistrySnapshot = {
  readonly contractVersion: typeof agentCapabilityContractVersion;
  readonly capabilities: readonly AgentCapabilityRegistrationSnapshot[];
};

export type AgentCapabilityValidationFailureReason =
  | 'malformed_manifest'
  | 'unsupported_contract_version'
  | 'unsupported_capability_kind'
  | 'duplicate_declaration'
  | 'missing_required_declaration'
  | 'malformed_tool_definition'
  | 'malformed_context_item'
  | 'duplicate_capability_id';

export type AgentCapabilityValidationResult<T> =
  | {
      readonly status: 'accepted';
      readonly value: T;
    }
  | {
      readonly status: 'rejected';
      readonly reason: AgentCapabilityValidationFailureReason;
      readonly details: string;
    };

export function createAgentCapabilityManifest(
  value: unknown
): AgentCapabilityManifest {
  return acceptedOrThrow(validateAgentCapabilityManifest(value));
}

export function validateAgentCapabilityManifest(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilityManifest> {
  if (!isRecord(value)) {
    return reject('malformed_manifest', 'Capability manifest must be an object.');
  }

  const contractVersion = value['contractVersion'];

  if (contractVersion !== agentCapabilityContractVersion) {
    return reject(
      'unsupported_contract_version',
      `Capability contractVersion must be "${agentCapabilityContractVersion}".`
    );
  }

  const kind = value['kind'];

  if (!isOneOf(kind, agentCapabilityKindValues)) {
    return reject(
      'unsupported_capability_kind',
      'Capability manifest kind is not supported.'
    );
  }

  const declaredCapabilities = requiredDeclarationArray(
    value['declaredCapabilities']
  );

  if (declaredCapabilities.status === 'rejected') {
    return declaredCapabilities;
  }

  const compatibility = requiredCompatibilityMetadata(value['compatibility']);

  if (compatibility.status === 'rejected') {
    return compatibility;
  }

  const config = requiredConfigMetadata(value['config']);

  if (config.status === 'rejected') {
    return config;
  }

  const localTrustLevel = value['localTrustLevel'];

  if (!isOneOf(localTrustLevel, agentCapabilityTrustLevelValues)) {
    return reject(
      'malformed_manifest',
      'Capability manifest localTrustLevel is not supported.'
    );
  }

  const runtimePolicy = requiredRuntimePolicy(value['runtimePolicy']);

  if (runtimePolicy.status === 'rejected') {
    return runtimePolicy;
  }

  const activation = requiredActivationMetadata(value['activation']);

  if (activation.status === 'rejected') {
    return activation;
  }

  const id = requiredIdentifier(value['id'], 'id');
  const displayName = requiredNonEmptyString(value['displayName'], 'displayName');
  const version = requiredNonEmptyString(value['version'], 'version');
  const description = requiredNonEmptyString(
    value['description'],
    'description'
  );

  if (
    id.status === 'rejected' ||
    displayName.status === 'rejected' ||
    version.status === 'rejected' ||
    description.status === 'rejected'
  ) {
    return firstRejected([id, displayName, version, description]);
  }

  return accept(
    Object.freeze({
      id: id.value,
      displayName: displayName.value,
      version: version.value,
      kind,
      description: description.value,
      contractVersion: agentCapabilityContractVersion,
      compatibility: compatibility.value,
      declaredCapabilities: declaredCapabilities.value,
      config: config.value,
      localTrustLevel,
      runtimePolicy: runtimePolicy.value,
      activation: activation.value
    } satisfies AgentCapabilityManifest)
  );
}

export function createAgentCapabilityProvidedTool(
  value: unknown
): AgentCapabilityProvidedTool {
  return acceptedOrThrow(validateAgentCapabilityProvidedTool(value));
}

export function validateAgentCapabilityProvidedTool(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilityProvidedTool> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      'Capability provided tool must be an object.'
    );
  }

  const name = requiredIdentifier(value['name'], 'name');
  const description = requiredNonEmptyString(value['description'], 'description');
  const requiredForUserTurn = requiredBoolean(
    value['requiredForUserTurn'],
    'requiredForUserTurn'
  );
  const maxCallsPerUserTurn = requiredPositiveInteger(
    value['maxCallsPerUserTurn'],
    'maxCallsPerUserTurn'
  );
  const inputContract = requiredModelToolInputContract(value['inputContract']);
  const validationOwner = value['validationOwner'];
  const sideEffectLevel = value['sideEffectLevel'];
  const requiresConfirmation = requiredBoolean(
    value['requiresConfirmation'],
    'requiresConfirmation'
  );
  const sourceReferencesRequired = requiredBoolean(
    value['sourceReferencesRequired'],
    'sourceReferencesRequired'
  );

  if (
    name.status === 'rejected' ||
    description.status === 'rejected' ||
    requiredForUserTurn.status === 'rejected' ||
    maxCallsPerUserTurn.status === 'rejected' ||
    inputContract.status === 'rejected' ||
    requiresConfirmation.status === 'rejected' ||
    sourceReferencesRequired.status === 'rejected'
  ) {
    return firstRejected([
      name,
      description,
      requiredForUserTurn,
      maxCallsPerUserTurn,
      inputContract,
      requiresConfirmation,
      sourceReferencesRequired
    ]);
  }

  if (!isOneOf(validationOwner, agentCapabilityToolValidationOwnerValues)) {
    return reject(
      'malformed_tool_definition',
      'Capability provided tool validationOwner is not supported.'
    );
  }

  if (!isOneOf(sideEffectLevel, agentCapabilitySideEffectLevelValues)) {
    return reject(
      'malformed_tool_definition',
      'Capability provided tool sideEffectLevel is not supported.'
    );
  }

  return accept(
    Object.freeze({
      name: name.value,
      description: description.value,
      requiredForUserTurn: requiredForUserTurn.value,
      maxCallsPerUserTurn: maxCallsPerUserTurn.value,
      inputContract: inputContract.value,
      validationOwner,
      sideEffectLevel,
      requiresConfirmation: requiresConfirmation.value,
      sourceReferencesRequired: sourceReferencesRequired.value
    } satisfies AgentCapabilityProvidedTool)
  );
}

export function createAgentCapabilityContextItem(
  value: unknown
): AgentCapabilityContextItem {
  return acceptedOrThrow(validateAgentCapabilityContextItem(value));
}

export function validateAgentCapabilityContextItem(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilityContextItem> {
  if (!isRecord(value)) {
    return reject(
      'malformed_context_item',
      'Capability context item must be an object.'
    );
  }

  const capabilityId = requiredIdentifier(value['capabilityId'], 'capabilityId');
  const id = requiredIdentifier(value['id'], 'id');
  const kind = value['kind'];
  const text = requiredNonEmptyString(value['text'], 'text');
  const budget = requiredContextBudget(value['budget']);
  const sourceReferences = requiredSourceReferences(value['sourceReferences']);
  const confidence = optionalConfidence(value['confidence']);
  const redactionLabels = requiredStringArray(value['redactionLabels'], 'redactionLabels');

  if (
    capabilityId.status === 'rejected' ||
    id.status === 'rejected' ||
    text.status === 'rejected' ||
    budget.status === 'rejected' ||
    sourceReferences.status === 'rejected' ||
    confidence.status === 'rejected' ||
    redactionLabels.status === 'rejected'
  ) {
    return firstRejected([
      capabilityId,
      id,
      text,
      budget,
      sourceReferences,
      confidence,
      redactionLabels
    ]);
  }

  if (!isOneOf(kind, agentCapabilityContextItemKindValues)) {
    return reject(
      'malformed_context_item',
      'Capability context item kind is not supported.'
    );
  }

  return accept(
    Object.freeze({
      capabilityId: capabilityId.value,
      id: id.value,
      kind,
      text: redactAgentCapabilityText(text.value),
      budget: budget.value,
      sourceReferences: freezeSourceReferences(sourceReferences.value),
      ...(confidence.value === undefined ? {} : { confidence: confidence.value }),
      redactionLabels: redactionLabels.value
    } satisfies AgentCapabilityContextItem)
  );
}

export function createRuntimeCapabilityContext(
  options: CreateRuntimeCapabilityContextOptions
): RuntimeCapabilityContext {
  return Object.freeze({
    sessionId: requirePlainNonEmptyString(options.sessionId, 'sessionId'),
    turnId: options.eventId,
    eventId: requirePlainNonEmptyString(options.eventId, 'eventId'),
    traceId: requirePlainNonEmptyString(options.traceId, 'traceId'),
    eventType: options.eventType,
    timestamp: requirePlainNonEmptyString(options.createdAt, 'createdAt'),
    currentUserMessage: requirePlainNonEmptyString(
      options.currentUserMessage,
      'currentUserMessage'
    ),
    character: Object.freeze({
      id: requirePlainNonEmptyString(options.character.id, 'character.id'),
      displayName: requirePlainNonEmptyString(
        options.character.displayName,
        'character.displayName'
      )
    } satisfies CharacterProfile),
    privacy: Object.freeze({
      redactionLabels: Object.freeze([...(options.redactionLabels ?? [])]),
      exposePrivateConfig: false
    })
  } satisfies RuntimeCapabilityContext);
}

export function createAgentCapability(
  options: {
    readonly manifest: unknown;
    readonly providedTools?: readonly unknown[];
    readonly lifecycleHooks?: AgentCapabilityLifecycleHooks;
  }
): AgentCapability {
  const manifest = createAgentCapabilityManifest(options.manifest);
  const providedTools = Object.freeze(
    (options.providedTools ?? []).map(createAgentCapabilityProvidedTool)
  );
  const declarationValidation = validateCapabilityDeclarationsAgainstRuntime({
    manifest,
    providedTools,
    lifecycleHooks: options.lifecycleHooks ?? {}
  });

  if (declarationValidation.status === 'rejected') {
    throw new TypeError(declarationValidation.details);
  }

  return Object.freeze({
    manifest,
    providedTools,
    lifecycleHooks: freezeLifecycleHooks(options.lifecycleHooks ?? {})
  } satisfies AgentCapability);
}

export function createAgentCapabilityRegistrySnapshot(
  capabilities: readonly AgentCapability[]
): AgentCapabilityRegistrySnapshot {
  const seenIds = new Set<string>();
  const registrations: AgentCapabilityRegistrationSnapshot[] = [];

  for (const capability of capabilities) {
    if (seenIds.has(capability.manifest.id)) {
      throw new TypeError(
        `Duplicate capability id "${capability.manifest.id}" is not allowed.`
      );
    }

    seenIds.add(capability.manifest.id);
    registrations.push(
      Object.freeze({
        manifest: capability.manifest,
        providedTools: capability.providedTools,
        registeredLifecycleHooks: registeredLifecycleHooks(capability)
      } satisfies AgentCapabilityRegistrationSnapshot)
    );
  }

  return Object.freeze({
    contractVersion: agentCapabilityContractVersion,
    capabilities: Object.freeze(registrations)
  } satisfies AgentCapabilityRegistrySnapshot);
}

export function createFirstPartyModelToolsCapability(): AgentCapability {
  return createAgentCapability({
    manifest: {
      id: firstPartyModelToolsCapabilityId,
      displayName: 'First-party model tools',
      version: '1.0.0',
      kind: 'first_party',
      description:
        'Represents the built-in visible_reply and character_state.patch tools through the shared capability contract.',
      contractVersion: agentCapabilityContractVersion,
      compatibility: {
        hostContractVersions: [agentCapabilityContractVersion],
        sourceSystem: 'project02',
        externalContract: 'built_in_model_tools'
      },
      declaredCapabilities: ['tool_provider', 'handle_tool_call', 'health'],
      config: {
        fields: []
      },
      localTrustLevel: 'first_party',
      runtimePolicy: {
        requiredForTurn: true,
        sideEffectLevel: 'none',
        confirmation: 'not_required',
        timeoutMs: 1000,
        sourceReferencesRequired: false,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall: 'reject_turn',
          handleToolCall: 'reject_tool_call',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      },
      activation: {
        defaultEnabled: true,
        reasons: ['built_in_user_turn_tools']
      }
    },
    providedTools: builtInModelToolDefinitionsForUserTurn().map((definition) =>
      Object.freeze({
        name: definition.name,
        description: definition.description,
        requiredForUserTurn: definition.requiredForUserTurn,
        maxCallsPerUserTurn: definition.maxCallsPerUserTurn,
        inputContract: definition.inputContract,
        validationOwner: 'built_in_model_tools',
        sideEffectLevel: 'none',
        requiresConfirmation: false,
        sourceReferencesRequired: false
      } satisfies AgentCapabilityProvidedTool)
    ),
    lifecycleHooks: {}
  });
}

export function createAgentCapabilityEvidenceSnapshot(
  options: unknown
): AgentCapabilityEvidenceSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Capability evidence snapshot must be an object.');
  }

  const policyOutcome = optionalOneOf(
    options['policyOutcome'],
    agentCapabilityPolicyOutcomeValues,
    'policyOutcome'
  );
  const sourceReferences =
    options['sourceReferences'] === undefined
      ? undefined
      : requiredSourceReferences(options['sourceReferences']);
  const redactionLabels = requiredStringArrayOrThrow(
    options['redactionLabels'],
    'redactionLabels'
  );
  const configFingerprint = optionalPlainString(
    options['configFingerprint'],
    'configFingerprint'
  );

  if (sourceReferences?.status === 'rejected') {
    throw new TypeError(sourceReferences.details);
  }

  return Object.freeze({
    eventId: requirePlainNonEmptyRecordString(options, 'eventId'),
    traceId: requirePlainNonEmptyRecordString(options, 'traceId'),
    createdAt: requirePlainNonEmptyRecordString(options, 'createdAt'),
    kind: 'agent_capability_evidence_snapshot',
    capabilityId: requirePlainNonEmptyString(
      requirePlainNonEmptyRecordString(options, 'capabilityId'),
      'capabilityId'
    ),
    evidenceKind: requiredOneOf(
      options['evidenceKind'],
      agentCapabilityEvidenceKindValues,
      'evidenceKind'
    ),
    status: requiredOneOf(
      options['status'],
      agentCapabilityEvidenceStatusValues,
      'status'
    ),
    summary: redactAgentCapabilityText(
      requirePlainNonEmptyRecordString(options, 'summary')
    ),
    ...(policyOutcome === undefined
      ? {}
      : { policyOutcome }),
    ...(sourceReferences === undefined
      ? {}
      : { sourceReferences: freezeSourceReferences(sourceReferences.value) }),
    redactionLabels: Object.freeze([...redactionLabels]),
    ...(configFingerprint === undefined
      ? {}
      : { configFingerprint: redactAgentCapabilityText(configFingerprint) })
  } satisfies AgentCapabilityEvidenceSnapshot);
}

export function createAgentCapabilityHealthSnapshot(
  options: unknown
): AgentCapabilityHealthSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Capability health snapshot must be an object.');
  }

  const redactionLabels = requiredStringArrayOrThrow(
    options['redactionLabels'],
    'redactionLabels'
  );

  return Object.freeze({
    capabilityId: requirePlainNonEmptyString(
      requirePlainNonEmptyRecordString(options, 'capabilityId'),
      'capabilityId'
    ),
    status: requiredOneOf(
      options['status'],
      agentCapabilityHealthStatusValues,
      'status'
    ),
    checkedAt: requirePlainNonEmptyRecordString(options, 'checkedAt'),
    summary: redactAgentCapabilityText(
      requirePlainNonEmptyRecordString(options, 'summary')
    ),
    redactionLabels: Object.freeze([...redactionLabels])
  } satisfies AgentCapabilityHealthSnapshot);
}

export function createAgentCapabilityListingSnapshot(
  options: unknown
): AgentCapabilityListingSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Capability listing snapshot must be an object.');
  }

  const manifest = createAgentCapabilityManifest(options['manifest']);
  const capabilityId = requirePlainNonEmptyRecordString(
    options,
    'capabilityId'
  );
  const providedTools = requiredArrayOrThrow(
    options['providedTools'],
    'providedTools'
  ).map(createAgentCapabilityProvidedTool);
  const registeredLifecycleHooks = requiredRegisteredLifecycleHooks(
    options['registeredLifecycleHooks']
  );
  const redactionLabels = requiredStringArrayOrThrow(
    options['redactionLabels'],
    'redactionLabels'
  );
  const configFingerprint =
    optionalPlainString(options['configFingerprint'], 'configFingerprint') ??
    manifest.config.fingerprint;
  const healthStatus = optionalOneOf(
    options['healthStatus'],
    agentCapabilityHealthStatusValues,
    'healthStatus'
  );

  if (capabilityId !== manifest.id) {
    throw new TypeError(
      'Capability listing capabilityId must match manifest.id.'
    );
  }

  if (registeredLifecycleHooks.status === 'rejected') {
    throw new TypeError(registeredLifecycleHooks.details);
  }

  return Object.freeze({
    capabilityId,
    manifest,
    providedTools: Object.freeze(providedTools),
    registeredLifecycleHooks: registeredLifecycleHooks.value,
    installed: requireBooleanRecordField(options, 'installed'),
    registered: requireBooleanRecordField(options, 'registered'),
    enabled: requireBooleanRecordField(options, 'enabled'),
    availableForTurn: requireBooleanRecordField(options, 'availableForTurn'),
    redactionLabels: Object.freeze([...redactionLabels]),
    ...(configFingerprint === undefined
      ? {}
      : { configFingerprint: redactAgentCapabilityText(configFingerprint) }),
    ...(healthStatus === undefined ? {} : { healthStatus })
  } satisfies AgentCapabilityListingSnapshot);
}

export function createAgentCapabilityTurnEvidenceSnapshot(
  options: unknown
): AgentCapabilityTurnEvidenceSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Capability turn evidence snapshot must be an object.');
  }

  if (options['kind'] !== 'agent_capability_turn_evidence_snapshot') {
    throw new TypeError(
      'Capability turn evidence snapshot kind is not supported.'
    );
  }

  if (options['contractVersion'] !== agentCapabilityContractVersion) {
    throw new TypeError(
      `Capability turn evidence contractVersion must be "${agentCapabilityContractVersion}".`
    );
  }

  const identity = {
    eventId: requirePlainNonEmptyRecordString(options, 'eventId'),
    traceId: requirePlainNonEmptyRecordString(options, 'traceId'),
    createdAt: requirePlainNonEmptyRecordString(options, 'createdAt')
  } satisfies RuntimeEventIdentity;
  const capabilities = requiredArrayOrThrow(options['capabilities'], 'capabilities').map(
    createAgentCapabilityListingSnapshot
  );
  const contextItems = requiredArrayOrThrow(options['contextItems'], 'contextItems').map(
    createAgentCapabilityContextItem
  );
  const evidence = requiredArrayOrThrow(options['evidence'], 'evidence').map(
    createAgentCapabilityEvidenceSnapshot
  );
  const health = requiredArrayOrThrow(options['health'], 'health').map(
    createAgentCapabilityHealthSnapshot
  );

  assertUniqueCapabilityListingIds(capabilities);
  assertAgentCapabilityEvidenceIdentity({
    identity,
    evidence
  });

  return Object.freeze({
    ...identity,
    kind: 'agent_capability_turn_evidence_snapshot',
    contractVersion: agentCapabilityContractVersion,
    capabilities: Object.freeze(capabilities),
    contextItems: Object.freeze(contextItems),
    evidence: Object.freeze(evidence),
    health: Object.freeze(health)
  } satisfies AgentCapabilityTurnEvidenceSnapshot);
}

function validateCapabilityDeclarationsAgainstRuntime(options: {
  readonly manifest: AgentCapabilityManifest;
  readonly providedTools: readonly AgentCapabilityProvidedTool[];
  readonly lifecycleHooks: AgentCapabilityLifecycleHooks;
}): AgentCapabilityValidationResult<undefined> {
  if (
    options.providedTools.length > 0 &&
    !options.manifest.declaredCapabilities.includes('tool_provider')
  ) {
    return reject(
      'missing_required_declaration',
      'Capabilities with provided tools must declare tool_provider.'
    );
  }

  if (
    options.providedTools.length > 0 &&
    !options.manifest.declaredCapabilities.includes('handle_tool_call')
  ) {
    return reject(
      'missing_required_declaration',
      'Capabilities with provided tools must declare handle_tool_call.'
    );
  }

  if (
    options.lifecycleHooks.beforeRoleModelCall !== undefined &&
    !options.manifest.declaredCapabilities.includes('before_role_model_call')
  ) {
    return reject(
      'missing_required_declaration',
      'beforeRoleModelCall hooks must declare before_role_model_call.'
    );
  }

  if (
    options.lifecycleHooks.afterTurnCommitted !== undefined &&
    !options.manifest.declaredCapabilities.includes('after_turn_committed')
  ) {
    return reject(
      'missing_required_declaration',
      'afterTurnCommitted hooks must declare after_turn_committed.'
    );
  }

  if (
    options.lifecycleHooks.onSessionEnd !== undefined &&
    !options.manifest.declaredCapabilities.includes('on_session_end')
  ) {
    return reject(
      'missing_required_declaration',
      'onSessionEnd hooks must declare on_session_end.'
    );
  }

  if (
    options.lifecycleHooks.health !== undefined &&
    !options.manifest.declaredCapabilities.includes('health')
  ) {
    return reject(
      'missing_required_declaration',
      'health hooks must declare health.'
    );
  }

  return accept(undefined);
}

function registeredLifecycleHooks(
  capability: AgentCapability
): readonly AgentCapabilityDeclaration[] {
  const hooks: AgentCapabilityDeclaration[] = [];

  if (capability.providedTools.length > 0) {
    hooks.push('tool_provider', 'handle_tool_call');
  }

  if (capability.lifecycleHooks.beforeRoleModelCall !== undefined) {
    hooks.push('before_role_model_call');
  }

  if (capability.lifecycleHooks.afterTurnCommitted !== undefined) {
    hooks.push('after_turn_committed');
  }

  if (capability.lifecycleHooks.onSessionEnd !== undefined) {
    hooks.push('on_session_end');
  }

  if (capability.lifecycleHooks.health !== undefined) {
    hooks.push('health');
  }

  return Object.freeze(hooks);
}

function requiredDeclarationArray(
  value: unknown
): AgentCapabilityValidationResult<readonly AgentCapabilityDeclaration[]> {
  return requiredDeclarationList({
    value,
    field: 'declaredCapabilities',
    allowEmpty: false
  });
}

function requiredRegisteredLifecycleHooks(
  value: unknown
): AgentCapabilityValidationResult<readonly AgentCapabilityDeclaration[]> {
  return requiredDeclarationList({
    value,
    field: 'registeredLifecycleHooks',
    allowEmpty: true
  });
}

function requiredDeclarationList(options: {
  readonly value: unknown;
  readonly field: string;
  readonly allowEmpty: boolean;
}): AgentCapabilityValidationResult<readonly AgentCapabilityDeclaration[]> {
  if (
    !Array.isArray(options.value) ||
    (!options.allowEmpty && options.value.length === 0)
  ) {
    return reject(
      'malformed_manifest',
      `Capability manifest ${options.field} must be a non-empty array.`
    );
  }

  const declarations: AgentCapabilityDeclaration[] = [];
  const seen = new Set<AgentCapabilityDeclaration>();

  for (const item of options.value) {
    if (!isOneOf(item, agentCapabilityDeclarationValues)) {
      return reject(
        'malformed_manifest',
        `Capability manifest ${options.field} includes an unsupported value.`
      );
    }

    if (seen.has(item)) {
      return reject(
        'duplicate_declaration',
        `Capability manifest ${options.field} declares "${item}" more than once.`
      );
    }

    seen.add(item);
    declarations.push(item);
  }

  return accept(Object.freeze(declarations));
}

function requiredCompatibilityMetadata(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilityCompatibilityMetadata> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Capability compatibility metadata must be an object.'
    );
  }

  const hostContractVersions = requiredStringArray(
    value['hostContractVersions'],
    'hostContractVersions'
  );

  if (hostContractVersions.status === 'rejected') {
    return hostContractVersions;
  }

  if (!hostContractVersions.value.includes(agentCapabilityContractVersion)) {
    return reject(
      'unsupported_contract_version',
      `Capability compatibility must include "${agentCapabilityContractVersion}".`
    );
  }

  const sourceSystem = optionalString(value['sourceSystem'], 'sourceSystem');
  const sourceVersion = optionalString(value['sourceVersion'], 'sourceVersion');
  const externalContract = optionalString(
    value['externalContract'],
    'externalContract'
  );
  const notes =
    value['notes'] === undefined
      ? accept(undefined)
      : requiredStringArray(value['notes'], 'notes');

  if (
    sourceSystem.status === 'rejected' ||
    sourceVersion.status === 'rejected' ||
    externalContract.status === 'rejected' ||
    notes.status === 'rejected'
  ) {
    return firstRejected([sourceSystem, sourceVersion, externalContract, notes]);
  }

  return accept(
    Object.freeze({
      hostContractVersions: hostContractVersions.value,
      ...(sourceSystem.value === undefined
        ? {}
        : { sourceSystem: redactAgentCapabilityText(sourceSystem.value) }),
      ...(sourceVersion.value === undefined
        ? {}
        : { sourceVersion: redactAgentCapabilityText(sourceVersion.value) }),
      ...(externalContract.value === undefined
        ? {}
        : { externalContract: redactAgentCapabilityText(externalContract.value) }),
      ...(notes.value === undefined
        ? {}
        : { notes: Object.freeze(notes.value.map(redactAgentCapabilityText)) })
    } satisfies AgentCapabilityCompatibilityMetadata)
  );
}

function requiredConfigMetadata(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilityConfigMetadata> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Capability config metadata must be an object.'
    );
  }

  const fieldsValue = value['fields'];

  if (!Array.isArray(fieldsValue)) {
    return reject(
      'malformed_manifest',
      'Capability config fields must be an array.'
    );
  }

  const fields: AgentCapabilityConfigField[] = [];
  const seenNames = new Set<string>();

  for (const fieldValue of fieldsValue) {
    const field = requiredConfigField(fieldValue);

    if (field.status === 'rejected') {
      return field;
    }

    if (seenNames.has(field.value.name)) {
      return reject(
        'duplicate_declaration',
        `Capability config field "${field.value.name}" is declared more than once.`
      );
    }

    seenNames.add(field.value.name);
    fields.push(field.value);
  }

  const fingerprint = optionalString(value['fingerprint'], 'fingerprint');

  if (fingerprint.status === 'rejected') {
    return fingerprint;
  }

  return accept(
    Object.freeze({
      fields: Object.freeze(fields),
      ...(fingerprint.value === undefined
        ? {}
        : { fingerprint: redactAgentCapabilityText(fingerprint.value) })
    } satisfies AgentCapabilityConfigMetadata)
  );
}

function requiredConfigField(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilityConfigField> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Capability config field must be an object.'
    );
  }

  const name = requiredIdentifier(value['name'], 'name');
  const description = requiredNonEmptyString(value['description'], 'description');
  const required = requiredBoolean(value['required'], 'required');
  const secret = requiredBoolean(value['secret'], 'secret');
  const redactionLabels = requiredStringArray(
    value['redactionLabels'],
    'redactionLabels'
  );

  if (
    name.status === 'rejected' ||
    description.status === 'rejected' ||
    required.status === 'rejected' ||
    secret.status === 'rejected' ||
    redactionLabels.status === 'rejected'
  ) {
    return firstRejected([
      name,
      description,
      required,
      secret,
      redactionLabels
    ]);
  }

  return accept(
    Object.freeze({
      name: name.value,
      description: redactAgentCapabilityText(description.value),
      required: required.value,
      secret: secret.value,
      redactionLabels: redactionLabels.value
    } satisfies AgentCapabilityConfigField)
  );
}

function requiredRuntimePolicy(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilityRuntimePolicy> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Capability runtimePolicy must be an object.'
    );
  }

  const requiredForTurn = requiredBoolean(
    value['requiredForTurn'],
    'requiredForTurn'
  );
  const sideEffectLevel = value['sideEffectLevel'];
  const confirmation = value['confirmation'];
  const timeoutMs = requiredPositiveInteger(value['timeoutMs'], 'timeoutMs');
  const sourceReferencesRequired = requiredBoolean(
    value['sourceReferencesRequired'],
    'sourceReferencesRequired'
  );
  const redactionLabels = requiredStringArray(
    value['redactionLabels'],
    'redactionLabels'
  );
  const failureBehavior = requiredFailureBehavior(value['failureBehavior']);

  if (
    requiredForTurn.status === 'rejected' ||
    timeoutMs.status === 'rejected' ||
    sourceReferencesRequired.status === 'rejected' ||
    redactionLabels.status === 'rejected' ||
    failureBehavior.status === 'rejected'
  ) {
    return firstRejected([
      requiredForTurn,
      timeoutMs,
      sourceReferencesRequired,
      redactionLabels,
      failureBehavior
    ]);
  }

  if (!isOneOf(sideEffectLevel, agentCapabilitySideEffectLevelValues)) {
    return reject(
      'malformed_manifest',
      'Capability runtimePolicy.sideEffectLevel is not supported.'
    );
  }

  if (!isOneOf(confirmation, confirmationRequirementValues)) {
    return reject(
      'malformed_manifest',
      'Capability runtimePolicy.confirmation is not supported.'
    );
  }

  return accept(
    Object.freeze({
      requiredForTurn: requiredForTurn.value,
      sideEffectLevel,
      confirmation,
      timeoutMs: timeoutMs.value,
      sourceReferencesRequired: sourceReferencesRequired.value,
      redactionLabels: redactionLabels.value,
      failureBehavior: failureBehavior.value
    } satisfies AgentCapabilityRuntimePolicy)
  );
}

function requiredFailureBehavior(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilityRuntimePolicy['failureBehavior']> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Capability failureBehavior must be an object.'
    );
  }

  const beforeRoleModelCall = value['beforeRoleModelCall'];
  const handleToolCall = value['handleToolCall'];
  const afterTurnCommitted = value['afterTurnCommitted'];
  const health = value['health'];

  if (
    !isOneOf(beforeRoleModelCall, beforeRoleModelFailureBehaviorValues) ||
    !isOneOf(handleToolCall, handleToolCallFailureBehaviorValues) ||
    !isOneOf(afterTurnCommitted, afterTurnCommittedFailureBehaviorValues) ||
    !isOneOf(health, healthFailureBehaviorValues)
  ) {
    return reject(
      'malformed_manifest',
      'Capability failureBehavior includes an unsupported value.'
    );
  }

  return accept(
    Object.freeze({
      beforeRoleModelCall,
      handleToolCall,
      afterTurnCommitted,
      health
    } satisfies AgentCapabilityRuntimePolicy['failureBehavior'])
  );
}

function requiredActivationMetadata(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilityActivationMetadata> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Capability activation metadata must be an object.'
    );
  }

  const defaultEnabled = requiredBoolean(value['defaultEnabled'], 'defaultEnabled');
  const reasons = requiredStringArray(value['reasons'], 'reasons');

  if (defaultEnabled.status === 'rejected' || reasons.status === 'rejected') {
    return firstRejected([defaultEnabled, reasons]);
  }

  return accept(
    Object.freeze({
      defaultEnabled: defaultEnabled.value,
      reasons: reasons.value
    } satisfies AgentCapabilityActivationMetadata)
  );
}

function requiredModelToolInputContract(
  value: unknown
): AgentCapabilityValidationResult<ModelToolInputContract> {
  if (!isRecord(value) || value['type'] !== 'object') {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract must be an object contract.'
    );
  }

  const additionalFields = requiredBoolean(
    value['additionalFields'],
    'additionalFields'
  );
  const fieldsValue = value['fields'];

  if (additionalFields.status === 'rejected') {
    return additionalFields;
  }

  if (!Array.isArray(fieldsValue)) {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract.fields must be an array.'
    );
  }

  const fields: ModelToolInputField[] = [];
  const seenNames = new Set<string>();

  for (const fieldValue of fieldsValue) {
    const field = requiredModelToolInputField(fieldValue);

    if (field.status === 'rejected') {
      return field;
    }

    if (seenNames.has(field.value.name)) {
      return reject(
        'duplicate_declaration',
        `Model tool input field "${field.value.name}" is declared more than once.`
      );
    }

    seenNames.add(field.value.name);
    fields.push(field.value);
  }

  return accept(
    Object.freeze({
      type: 'object',
      fields: Object.freeze(fields),
      additionalFields: additionalFields.value
    } satisfies ModelToolInputContract)
  );
}

function requiredModelToolInputField(
  value: unknown
): AgentCapabilityValidationResult<ModelToolInputField> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract field must be an object.'
    );
  }

  const name = requiredIdentifier(value['name'], 'name');
  const description = requiredNonEmptyString(value['description'], 'description');
  const required = requiredBoolean(value['required'], 'required');
  const allowedValues =
    value['allowedValues'] === undefined
      ? accept(undefined)
      : requiredStringArray(value['allowedValues'], 'allowedValues');

  if (
    name.status === 'rejected' ||
    description.status === 'rejected' ||
    required.status === 'rejected' ||
    allowedValues.status === 'rejected'
  ) {
    return firstRejected([name, description, required, allowedValues]);
  }

  return accept(
    Object.freeze({
      name: name.value,
      description: redactAgentCapabilityText(description.value),
      required: required.value,
      ...(allowedValues.value === undefined
        ? {}
        : { allowedValues: allowedValues.value })
    } satisfies ModelToolInputField)
  );
}

function requiredContextBudget(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilityContextBudget> {
  if (!isRecord(value)) {
    return reject(
      'malformed_context_item',
      'Capability context budget must be an object.'
    );
  }

  const estimatedTokens = requiredPositiveInteger(
    value['estimatedTokens'],
    'estimatedTokens'
  );
  const priority = requiredPositiveInteger(value['priority'], 'priority');

  if (estimatedTokens.status === 'rejected' || priority.status === 'rejected') {
    return firstRejected([estimatedTokens, priority]);
  }

  return accept(
    Object.freeze({
      estimatedTokens: estimatedTokens.value,
      priority: priority.value
    } satisfies AgentCapabilityContextBudget)
  );
}

function requiredSourceReferences(
  value: unknown
): AgentCapabilityValidationResult<readonly AgentCapabilitySourceReference[]> {
  if (!Array.isArray(value)) {
    return reject(
      'malformed_context_item',
      'Capability sourceReferences must be an array.'
    );
  }

  const references: AgentCapabilitySourceReference[] = [];

  for (const item of value) {
    const reference = requiredSourceReference(item);

    if (reference.status === 'rejected') {
      return reference;
    }

    references.push(reference.value);
  }

  return accept(Object.freeze(references));
}

function requiredSourceReference(
  value: unknown
): AgentCapabilityValidationResult<AgentCapabilitySourceReference> {
  if (!isRecord(value)) {
    return reject(
      'malformed_context_item',
      'Capability source reference must be an object.'
    );
  }

  const kind = value['kind'];
  const id = requiredIdentifier(value['id'], 'id');
  const title = optionalString(value['title'], 'title');
  const uri = optionalString(value['uri'], 'uri');

  if (
    id.status === 'rejected' ||
    title.status === 'rejected' ||
    uri.status === 'rejected'
  ) {
    return firstRejected([id, title, uri]);
  }

  if (!isOneOf(kind, agentCapabilitySourceKindValues)) {
    return reject(
      'malformed_context_item',
      'Capability source reference kind is not supported.'
    );
  }

  return accept(
    Object.freeze({
      kind,
      id: id.value,
      ...(title.value === undefined ? {} : { title: title.value }),
      ...(uri.value === undefined ? {} : { uri: uri.value })
    } satisfies AgentCapabilitySourceReference)
  );
}

function freezeSourceReferences(
  value: readonly AgentCapabilitySourceReference[]
): readonly AgentCapabilitySourceReference[] {
  return Object.freeze(
    value.map((sourceReference) =>
      Object.freeze({
        kind: sourceReference.kind,
        id: sourceReference.id,
        ...(sourceReference.title === undefined
          ? {}
          : { title: redactAgentCapabilityText(sourceReference.title) }),
        ...(sourceReference.uri === undefined
          ? {}
          : { uri: redactAgentCapabilityText(sourceReference.uri) })
      } satisfies AgentCapabilitySourceReference)
    )
  );
}

function optionalConfidence(
  value: unknown
): AgentCapabilityValidationResult<number | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (typeof value !== 'number' || value < 0 || value > 1) {
    return reject(
      'malformed_context_item',
      'Capability context item confidence must be between 0 and 1.'
    );
  }

  return accept(value);
}

function requiredIdentifier(
  value: unknown,
  field: string
): AgentCapabilityValidationResult<string> {
  const stringValue = requiredNonEmptyString(value, field);

  if (stringValue.status === 'rejected') {
    return stringValue;
  }

  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(stringValue.value)) {
    return reject(
      'malformed_manifest',
      `Capability field "${field}" must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`
    );
  }

  return stringValue;
}

function requiredNonEmptyString(
  value: unknown,
  field: string
): AgentCapabilityValidationResult<string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return reject(
      'malformed_manifest',
      `Capability field "${field}" must be a non-empty string.`
    );
  }

  return accept(value);
}

function optionalString(
  value: unknown,
  field: string
): AgentCapabilityValidationResult<string | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  return requiredNonEmptyString(value, field);
}

function requiredBoolean(
  value: unknown,
  field: string
): AgentCapabilityValidationResult<boolean> {
  if (typeof value !== 'boolean') {
    return reject(
      'malformed_manifest',
      `Capability field "${field}" must be a boolean.`
    );
  }

  return accept(value);
}

function requiredPositiveInteger(
  value: unknown,
  field: string
): AgentCapabilityValidationResult<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return reject(
      'malformed_manifest',
      `Capability field "${field}" must be a positive integer.`
    );
  }

  return accept(value);
}

function requiredStringArray(
  value: unknown,
  field: string
): AgentCapabilityValidationResult<readonly string[]> {
  if (!Array.isArray(value)) {
    return reject(
      'malformed_manifest',
      `Capability field "${field}" must be an array.`
    );
  }

  const strings: string[] = [];

  for (const item of value) {
    const stringValue = requiredNonEmptyString(item, field);

    if (stringValue.status === 'rejected') {
      return stringValue;
    }

    strings.push(stringValue.value);
  }

  return accept(Object.freeze(strings));
}

function firstRejected(
  results: readonly AgentCapabilityValidationResult<unknown>[]
): AgentCapabilityValidationResult<never> {
  const rejected = results.find((result) => result.status === 'rejected');

  if (rejected !== undefined) {
    return reject(rejected.reason, rejected.details);
  }

  throw new Error('Expected at least one rejected validation result.');
}

function acceptedOrThrow<T>(result: AgentCapabilityValidationResult<T>): T {
  if (result.status === 'accepted') {
    return result.value;
  }

  throw new TypeError(result.details);
}

function accept<T>(value: T): AgentCapabilityValidationResult<T> {
  return Object.freeze({
    status: 'accepted',
    value
  } satisfies AgentCapabilityValidationResult<T>);
}

function reject(
  reason: AgentCapabilityValidationFailureReason,
  details: string
): AgentCapabilityValidationResult<never> {
  return Object.freeze({
    status: 'rejected',
    reason,
    details
  } satisfies AgentCapabilityValidationResult<never>);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(
  value: unknown,
  allowedValues: readonly T[]
): value is T {
  return (
    typeof value === 'string' &&
    allowedValues.some((allowedValue) => allowedValue === value)
  );
}

function requiredOneOf<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  field: string
): T {
  if (!isOneOf(value, allowedValues)) {
    throw new TypeError(`Unsupported ${field}: ${String(value)}.`);
  }

  return value;
}

function optionalOneOf<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  field: string
): T | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredOneOf(value, allowedValues, field);
}

function optionalPlainString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requirePlainNonEmptyStringFromUnknown(value, field);
}

function requiredArrayOrThrow(
  value: unknown,
  field: string
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Capability field "${field}" must be an array.`);
  }

  return value;
}

function requiredStringArrayOrThrow(
  value: unknown,
  field: string
): readonly string[] {
  const result = requiredStringArray(value, field);

  if (result.status === 'accepted') {
    return result.value;
  }

  throw new TypeError(result.details);
}

function requireBooleanRecordField(
  record: Readonly<Record<string, unknown>>,
  field: string
): boolean {
  const value = record[field];

  if (typeof value !== 'boolean') {
    throw new TypeError(`Capability field "${field}" must be a boolean.`);
  }

  return value;
}

function requirePlainNonEmptyString(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`Capability field "${field}" must be non-empty.`);
  }

  return value;
}

function requirePlainNonEmptyRecordString(
  record: Readonly<Record<string, unknown>>,
  field: string
): string {
  return requirePlainNonEmptyStringFromUnknown(record[field], field);
}

function requirePlainNonEmptyStringFromUnknown(
  value: unknown,
  field: string
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Capability field "${field}" must be a string.`);
  }

  return requirePlainNonEmptyString(value, field);
}

function assertUniqueCapabilityListingIds(
  capabilities: readonly AgentCapabilityListingSnapshot[]
): void {
  const seen = new Set<string>();

  for (const capability of capabilities) {
    if (seen.has(capability.capabilityId)) {
      throw new TypeError(
        `Duplicate capability listing id "${capability.capabilityId}" is not allowed.`
      );
    }

    seen.add(capability.capabilityId);
  }
}

function assertAgentCapabilityEvidenceIdentity(options: {
  readonly identity: RuntimeEventIdentity;
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
}): void {
  for (const snapshot of options.evidence) {
    if (
      snapshot.eventId === options.identity.eventId &&
      snapshot.traceId === options.identity.traceId &&
      snapshot.createdAt === options.identity.createdAt
    ) {
      continue;
    }

    throw new TypeError(
      'Capability evidence snapshot identity must match turn evidence identity.'
    );
  }
}

function redactAgentCapabilityText(value: string): string {
  return redactUriCredentials(
    redactUriSecretQueryValues(
      redactSecretKeyValues(redactBearerTokens(value))
    )
  );
}

function redactBearerTokens(value: string): string {
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]');
}

function redactSecretKeyValues(value: string): string {
  return value.replace(
    /\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|credential)[A-Za-z0-9_.-]*)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/giu,
    (
      _match: string,
      key: string,
      separatorAndSpacing: string,
      rawValue: string
    ): string => {
      const quote =
        rawValue.startsWith('"') ? '"' : rawValue.startsWith("'") ? "'" : '';

      return `${key}${separatorAndSpacing}${quote}[redacted]${quote}`;
    }
  );
}

function redactUriCredentials(value: string): string {
  return value.replace(/(https?:\/\/)([^/@\s]+)@/giu, '$1[redacted]@');
}

function redactUriSecretQueryValues(value: string): string {
  return value.replace(
    /([?&][A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|credential)[A-Za-z0-9_.-]*=)[^&#\s]+/giu,
    '$1[redacted]'
  );
}

function freezeLifecycleHooks(
  hooks: AgentCapabilityLifecycleHooks
): AgentCapabilityLifecycleHooks {
  const beforeRoleModelCall = hooks.beforeRoleModelCall;
  const handleToolCall = hooks.handleToolCall;
  const afterTurnCommitted = hooks.afterTurnCommitted;
  const onSessionEnd = hooks.onSessionEnd;
  const health = hooks.health;

  return Object.freeze({
    ...(beforeRoleModelCall === undefined
      ? {}
      : {
          beforeRoleModelCall: (context) => beforeRoleModelCall(context)
        }),
    ...(handleToolCall === undefined
      ? {}
      : {
          handleToolCall: (call, context) => handleToolCall(call, context)
        }),
    ...(afterTurnCommitted === undefined
      ? {}
      : {
          afterTurnCommitted: (context) => afterTurnCommitted(context)
        }),
    ...(onSessionEnd === undefined
      ? {}
      : {
          onSessionEnd: (context) => onSessionEnd(context)
        }),
    ...(health === undefined
      ? {}
      : {
          health: (context) => health(context)
        })
  } satisfies AgentCapabilityLifecycleHooks);
}
