import type { CharacterProfile, VisibleMessage } from '../core/conversation.ts';
import {
  modelToolCallLimitScopes,
  modelToolInputFieldValueTypes,
  type ModelToolCallLimit,
  type ModelToolInputContract,
  type ModelToolInputField,
  type ModelToolInputFieldValueType,
  type ModelToolJsonSchema,
  type ModelToolJsonSchemaType,
  type ModelToolObjectJsonSchema
} from '../role-model/model-tools.ts';
import type {
  RuntimeEventIdentity,
  RuntimeEventType
} from '../runtime/event.ts';
import {
  afterTurnCommittedFailureBehaviorValues,
  beforeRoleModelFailureBehaviorValues,
  confirmationRequirementValues,
  handleToolCallFailureBehaviorValues,
  healthFailureBehaviorValues,
  runtimePluginConfigValueTypeValues,
  runtimePluginContextItemKindValues,
  runtimePluginContractVersion,
  runtimePluginDeclarationValues,
  runtimePluginEvidenceKindValues,
  runtimePluginEvidenceStatusValues,
  runtimePluginHealthStatusValues,
  runtimePluginKindValues,
  runtimePluginPolicyOutcomeValues,
  runtimePluginSideEffectLevelValues,
  runtimePluginSourceKindValues,
  runtimePluginToolValidationOwnerValues,
  runtimePluginTrustLevelValues,
  type RuntimePluginAccessMap,
  type RuntimePluginAccessSnapshot,
  type RuntimePluginAfterTurnCommittedFailureBehavior,
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
  type RuntimePluginTrustLevel
} from './contract.ts';
import { normalizeRuntimePluginAccessMap } from './access-control.ts';
import { validateRuntimePluginModelFacingToolAccess } from './tool-policy.ts';

export type RuntimePluginJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimePluginJsonValue[]
  | RuntimePluginJsonObject;

export type RuntimePluginJsonObject = {
  readonly [key: string]: RuntimePluginJsonValue;
};

export type RuntimePluginFileStore = {
  readJson(path: string): RuntimePluginJsonValue | undefined;
  readJsonl(path: string): readonly RuntimePluginJsonValue[];
  writeJsonAtomic(path: string, value: RuntimePluginJsonValue): void;
  appendJsonl(path: string, value: RuntimePluginJsonValue): void;
  revision(): number;
};

export type RuntimePluginCompatibilityMetadata = {
  readonly hostContractVersions: readonly string[];
  readonly sourceSystem?: string;
  readonly sourceVersion?: string;
  readonly externalContract?: string;
  readonly notes?: readonly string[];
};

export type RuntimePluginConfigField = {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly valueType?: RuntimePluginConfigValueType;
  readonly defaultValueSummary?: string;
  readonly envVar?: string;
  readonly allowedValues?: readonly string[];
  readonly redactionLabels: readonly string[];
  readonly configFingerprint?: string;
};

export type RuntimePluginConfigMetadata = {
  readonly fields: readonly RuntimePluginConfigField[];
  readonly fingerprint?: string;
};

export type RuntimePluginRuntimePolicy = {
  readonly requiredForTurn: boolean;
  readonly sideEffectLevel: RuntimePluginSideEffectLevel;
  readonly confirmation: RuntimePluginConfirmationRequirement;
  readonly timeoutMs: number;
  readonly sourceReferencesRequired: boolean;
  readonly redactionLabels: readonly string[];
  readonly failureBehavior: {
    readonly beforeRoleModelCall: RuntimePluginBeforeRoleModelFailureBehavior;
    readonly handleToolCall: RuntimePluginHandleToolCallFailureBehavior;
    readonly afterTurnCommitted: RuntimePluginAfterTurnCommittedFailureBehavior;
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
  readonly localTrustLevel: RuntimePluginTrustLevel;
  readonly runtimePolicy: RuntimePluginRuntimePolicy;
  readonly activation: RuntimePluginActivationMetadata;
  readonly requestedAccess: RuntimePluginAccessMap;
};

export type RuntimePluginProvidedTool = {
  readonly name: string;
  readonly description: string;
  readonly requiredForUserTurn: boolean;
  readonly callLimit: ModelToolCallLimit;
  readonly inputContract: ModelToolInputContract;
  readonly validationOwner: RuntimePluginToolValidationOwner;
  readonly sideEffectLevel: RuntimePluginSideEffectLevel;
  readonly requiresConfirmation: boolean;
  readonly sourceReferencesRequired: boolean;
};

export type RuntimePluginSourceReference = {
  readonly kind: RuntimePluginSourceKind;
  readonly id: string;
  readonly title?: string;
  readonly uri?: string;
};

export type RuntimePluginContextBudget = {
  readonly estimatedTokens: number;
  readonly priority: number;
};

export type RuntimePluginContextItem = {
  readonly pluginId: string;
  readonly id: string;
  readonly kind: RuntimePluginContextItemKind;
  readonly text: string;
  readonly budget: RuntimePluginContextBudget;
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
  readonly installed: boolean;
  readonly registered: boolean;
  readonly enabled: boolean;
  readonly availableForTurn: boolean;
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
  readonly currentUserMessage: string;
  readonly character: CharacterProfile;
  readonly privacy: {
    readonly redactionLabels: readonly string[];
    readonly exposePrivateConfig: false;
  };
  readonly pluginId?: string;
  readonly fileStore?: RuntimePluginFileStore;
};

export type RuntimePluginCommittedTurnSnapshot = {
  readonly committedAt: string;
  readonly visibleMessageIds: readonly string[];
  readonly visibleMessages: readonly VisibleMessage[];
};

export type RuntimePluginAfterTurnCommittedContext =
  RuntimePluginContext & {
    readonly committedTurn: RuntimePluginCommittedTurnSnapshot;
  };

export type CreateRuntimePluginContextOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly eventType: RuntimeEventType;
  readonly currentUserMessage: string;
  readonly character: CharacterProfile;
  readonly redactionLabels?: readonly string[];
};

export type CreateRuntimePluginAfterTurnCommittedContextOptions =
  CreateRuntimePluginContextOptions & {
    readonly committedAt: string;
    readonly visibleMessages: readonly VisibleMessage[];
  };

export type RuntimePluginBeforeRoleModelCallResult = {
  readonly contextItems: readonly RuntimePluginContextItem[];
  readonly runtimeNotes: readonly string[];
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
    context: RuntimePluginContext
  ) =>
    | RuntimePluginBeforeRoleModelCallResult
    | Promise<RuntimePluginBeforeRoleModelCallResult>;
  readonly handleToolCall?: (
    call: RuntimePluginToolCall,
    context: RuntimePluginContext
  ) => RuntimePluginToolCallResult | Promise<RuntimePluginToolCallResult>;
  readonly afterTurnCommitted?: (
    context: RuntimePluginAfterTurnCommittedContext
  ) => RuntimePluginHookResult | Promise<RuntimePluginHookResult>;
  readonly onSessionEnd?: (
    context: RuntimePluginContext
  ) => RuntimePluginHookResult | Promise<RuntimePluginHookResult>;
  readonly health?: (
    context: RuntimePluginContext
  ) => RuntimePluginHealthSnapshot | Promise<RuntimePluginHealthSnapshot>;
};

export type RuntimePlugin = {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
  readonly lifecycleHooks: RuntimePluginLifecycleHooks;
};

export type RuntimePluginRegistrationSnapshot =
  RuntimePluginAccessSnapshot & {
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

export function createRuntimePluginManifest(
  value: unknown
): RuntimePluginManifest {
  return acceptedOrThrow(validateRuntimePluginManifest(value));
}

export function validateRuntimePluginManifest(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginManifest> {
  if (!isRecord(value)) {
    return reject('malformed_manifest', 'Plugin manifest must be an object.');
  }

  const contractVersion = value['contractVersion'];

  if (contractVersion !== runtimePluginContractVersion) {
    return reject(
      'unsupported_contract_version',
      `Plugin contractVersion must be "${runtimePluginContractVersion}".`
    );
  }

  const kind = value['kind'];

  if (!isOneOf(kind, runtimePluginKindValues)) {
    return reject(
      'unsupported_plugin_kind',
      'Plugin manifest kind is not supported.'
    );
  }

  const declaredPlugins = requiredDeclarationArray(
    value['declaredPlugins']
  );

  if (declaredPlugins.status === 'rejected') {
    return declaredPlugins;
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

  if (!isOneOf(localTrustLevel, runtimePluginTrustLevelValues)) {
    return reject(
      'malformed_manifest',
      'Plugin manifest localTrustLevel is not supported.'
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

  const requestedAccess = requiredAccess(
    value['requestedAccess'],
    'Plugin manifest requestedAccess'
  );

  if (requestedAccess.status === 'rejected') {
    return requestedAccess;
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
      description: redactRuntimePluginText(description.value),
      contractVersion: runtimePluginContractVersion,
      compatibility: compatibility.value,
      declaredPlugins: declaredPlugins.value,
      config: config.value,
      localTrustLevel,
      runtimePolicy: runtimePolicy.value,
      activation: activation.value,
      requestedAccess: requestedAccess.value
    } satisfies RuntimePluginManifest)
  );
}

export function createRuntimePluginProvidedTool(
  value: unknown
): RuntimePluginProvidedTool {
  return acceptedOrThrow(validateRuntimePluginProvidedTool(value));
}

export function validateRuntimePluginProvidedTool(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginProvidedTool> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool must be an object.'
    );
  }

  const name = requiredIdentifier(value['name'], 'name');
  const description = requiredNonEmptyString(value['description'], 'description');
  const requiredForUserTurn = requiredBoolean(
    value['requiredForUserTurn'],
    'requiredForUserTurn'
  );
  const callLimit = requiredModelToolCallLimit(value['callLimit']);
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
    callLimit.status === 'rejected' ||
    inputContract.status === 'rejected' ||
    requiresConfirmation.status === 'rejected' ||
    sourceReferencesRequired.status === 'rejected'
  ) {
    return firstRejected([
      name,
      description,
      requiredForUserTurn,
      callLimit,
      inputContract,
      requiresConfirmation,
      sourceReferencesRequired
    ]);
  }

  if (!isOneOf(validationOwner, runtimePluginToolValidationOwnerValues)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool validationOwner is not supported.'
    );
  }

  if (!isOneOf(sideEffectLevel, runtimePluginSideEffectLevelValues)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool sideEffectLevel is not supported.'
    );
  }

  return accept(
    Object.freeze({
      name: name.value,
      description: redactRuntimePluginText(description.value),
      requiredForUserTurn: requiredForUserTurn.value,
      callLimit: callLimit.value,
      inputContract: inputContract.value,
      validationOwner,
      sideEffectLevel,
      requiresConfirmation: requiresConfirmation.value,
      sourceReferencesRequired: sourceReferencesRequired.value
    } satisfies RuntimePluginProvidedTool)
  );
}

function requiredModelToolCallLimit(
  value: unknown
): RuntimePluginValidationResult<ModelToolCallLimit> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool callLimit must be an object.'
    );
  }

  const scope = value['scope'];
  const maxCalls = requiredPositiveInteger(
    value['maxCalls'],
    'callLimit.maxCalls'
  );

  if (!isOneOf(scope, modelToolCallLimitScopes)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool callLimit.scope is not supported.'
    );
  }

  if (maxCalls.status === 'rejected') {
    return maxCalls;
  }

  return accept(
    Object.freeze({
      scope,
      maxCalls: maxCalls.value
    } satisfies ModelToolCallLimit)
  );
}

export function createRuntimePluginContextItem(
  value: unknown
): RuntimePluginContextItem {
  return acceptedOrThrow(validateRuntimePluginContextItem(value));
}

export function validateRuntimePluginContextItem(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginContextItem> {
  if (!isRecord(value)) {
    return reject(
      'malformed_context_item',
      'Plugin context item must be an object.'
    );
  }

  const pluginId = requiredIdentifier(value['pluginId'], 'pluginId');
  const id = requiredIdentifier(value['id'], 'id');
  const kind = value['kind'];
  const text = requiredNonEmptyString(value['text'], 'text');
  const budget = requiredContextBudget(value['budget']);
  const sourceReferences = requiredSourceReferences(value['sourceReferences']);
  const confidence = optionalConfidence(value['confidence']);
  const redactionLabels = requiredStringArray(value['redactionLabels'], 'redactionLabels');

  if (
    pluginId.status === 'rejected' ||
    id.status === 'rejected' ||
    text.status === 'rejected' ||
    budget.status === 'rejected' ||
    sourceReferences.status === 'rejected' ||
    confidence.status === 'rejected' ||
    redactionLabels.status === 'rejected'
  ) {
    return firstRejected([
      pluginId,
      id,
      text,
      budget,
      sourceReferences,
      confidence,
      redactionLabels
    ]);
  }

  if (!isOneOf(kind, runtimePluginContextItemKindValues)) {
    return reject(
      'malformed_context_item',
      'Plugin context item kind is not supported.'
    );
  }

  return accept(
    Object.freeze({
      pluginId: pluginId.value,
      id: id.value,
      kind,
      text: redactRuntimePluginText(text.value),
      budget: budget.value,
      sourceReferences: freezeSourceReferences(sourceReferences.value),
      ...(confidence.value === undefined ? {} : { confidence: confidence.value }),
      redactionLabels: redactionLabels.value
    } satisfies RuntimePluginContextItem)
  );
}

export function createRuntimePluginContext(
  options: CreateRuntimePluginContextOptions
): RuntimePluginContext {
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
  } satisfies RuntimePluginContext);
}

export function createRuntimePluginAfterTurnCommittedContext(
  options: CreateRuntimePluginAfterTurnCommittedContextOptions
): RuntimePluginAfterTurnCommittedContext {
  const runtimeContext = createRuntimePluginContext(options);
  const visibleMessages = freezeVisibleMessages(options.visibleMessages);

  return Object.freeze({
    ...runtimeContext,
    committedTurn: Object.freeze({
      committedAt: requirePlainNonEmptyString(options.committedAt, 'committedAt'),
      visibleMessageIds: Object.freeze(
        visibleMessages.map((message) => message.id)
      ),
      visibleMessages
    } satisfies RuntimePluginCommittedTurnSnapshot)
  } satisfies RuntimePluginAfterTurnCommittedContext);
}

function freezeVisibleMessages(
  messages: readonly VisibleMessage[]
): readonly VisibleMessage[] {
  return Object.freeze(messages.map(freezeVisibleMessage));
}

function freezeVisibleMessage(message: VisibleMessage): VisibleMessage {
  return Object.freeze({
    id: requirePlainNonEmptyString(message.id, 'visibleMessage.id'),
    role: message.role,
    speakerId: requirePlainNonEmptyString(
      message.speakerId,
      'visibleMessage.speakerId'
    ),
    speakerName: requirePlainNonEmptyString(
      message.speakerName,
      'visibleMessage.speakerName'
    ),
    text: requirePlainNonEmptyString(message.text, 'visibleMessage.text')
  } satisfies VisibleMessage);
}

export function createRuntimePlugin(
  options: {
    readonly manifest: unknown;
    readonly providedTools?: readonly unknown[];
    readonly lifecycleHooks?: RuntimePluginLifecycleHooks;
  }
): RuntimePlugin {
  const manifest = createRuntimePluginManifest(options.manifest);
  const providedTools = Object.freeze(
    (options.providedTools ?? []).map(createRuntimePluginProvidedTool)
  );
  const declarationValidation = validatePluginDeclarationsAgainstRuntime({
    manifest,
    providedTools,
    lifecycleHooks: options.lifecycleHooks ?? {}
  });

  if (declarationValidation.status === 'rejected') {
    throw new TypeError(declarationValidation.details);
  }

  validateRuntimePluginModelFacingToolAccess({
    manifest,
    providedTools
  });

  return Object.freeze({
    manifest,
    providedTools,
    lifecycleHooks: freezeLifecycleHooks(options.lifecycleHooks ?? {})
  } satisfies RuntimePlugin);
}

export function createRuntimePluginRegistrySnapshot(
  plugins: readonly RuntimePlugin[],
  options: {
    readonly accessByPluginId?: Readonly<
      Record<
        string,
        {
          readonly grantedAccess?: RuntimePluginAccessMap;
        }
      >
    >;
  } = {}
): RuntimePluginRegistrySnapshot {
  const registrations: RuntimePluginRegistrationSnapshot[] = [];

  assertUniqueRuntimePluginIds(plugins);

  for (const plugin of plugins) {
    const resolvedAccess =
      options.accessByPluginId?.[plugin.manifest.id];
    const access = pluginAccessSnapshot({
      manifest: plugin.manifest,
      ...(resolvedAccess?.grantedAccess === undefined
        ? {}
        : { grantedAccess: resolvedAccess.grantedAccess })
    });
    registrations.push(
      Object.freeze({
        manifest: plugin.manifest,
        providedTools: plugin.providedTools,
        registeredLifecycleHooks: registeredLifecycleHooks(plugin),
        requestedAccess: access.requestedAccess,
        grantedAccess: access.grantedAccess
      } satisfies RuntimePluginRegistrationSnapshot)
    );
  }

  return Object.freeze({
    contractVersion: runtimePluginContractVersion,
    plugins: Object.freeze(registrations)
  } satisfies RuntimePluginRegistrySnapshot);
}

export function assertUniqueRuntimePluginIds(
  plugins: readonly RuntimePlugin[]
): void {
  const seenIds = new Set<string>();

  for (const plugin of plugins) {
    if (seenIds.has(plugin.manifest.id)) {
      throw new TypeError(
        `Duplicate plugin id "${plugin.manifest.id}" is not allowed.`
      );
    }

    seenIds.add(plugin.manifest.id);
  }
}

function pluginAccessSnapshot(options: {
  readonly manifest: RuntimePluginManifest;
  readonly requestedAccess?: RuntimePluginAccessMap;
  readonly grantedAccess?: RuntimePluginAccessMap;
}): RuntimePluginAccessSnapshot {
  return Object.freeze({
    requestedAccess: normalizeRuntimePluginAccessMap(
      options.requestedAccess ?? options.manifest.requestedAccess,
      'requestedAccess'
    ),
    grantedAccess: normalizeRuntimePluginAccessMap(
      options.grantedAccess,
      'grantedAccess'
    )
  } satisfies RuntimePluginAccessSnapshot);
}

export function createRuntimePluginEvidenceSnapshot(
  options: unknown
): RuntimePluginEvidenceSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Plugin evidence snapshot must be an object.');
  }

  const policyOutcome = optionalOneOf(
    options['policyOutcome'],
    runtimePluginPolicyOutcomeValues,
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
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: requirePlainNonEmptyString(
      requirePlainNonEmptyRecordString(options, 'pluginId'),
      'pluginId'
    ),
    evidenceKind: requiredOneOf(
      options['evidenceKind'],
      runtimePluginEvidenceKindValues,
      'evidenceKind'
    ),
    status: requiredOneOf(
      options['status'],
      runtimePluginEvidenceStatusValues,
      'status'
    ),
    summary: redactRuntimePluginText(
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
      : { configFingerprint: redactRuntimePluginText(configFingerprint) })
  } satisfies RuntimePluginEvidenceSnapshot);
}

export function createRuntimePluginHealthSnapshot(
  options: unknown
): RuntimePluginHealthSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Plugin health snapshot must be an object.');
  }

  const redactionLabels = requiredStringArrayOrThrow(
    options['redactionLabels'],
    'redactionLabels'
  );

  return Object.freeze({
    pluginId: requirePlainNonEmptyString(
      requirePlainNonEmptyRecordString(options, 'pluginId'),
      'pluginId'
    ),
    status: requiredOneOf(
      options['status'],
      runtimePluginHealthStatusValues,
      'status'
    ),
    checkedAt: requirePlainNonEmptyRecordString(options, 'checkedAt'),
    summary: redactRuntimePluginText(
      requirePlainNonEmptyRecordString(options, 'summary')
    ),
    redactionLabels: Object.freeze([...redactionLabels])
  } satisfies RuntimePluginHealthSnapshot);
}

export function createRuntimePluginToolInvocationSnapshot(
  options: unknown
): RuntimePluginToolInvocationSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Plugin tool invocation snapshot must be an object.');
  }

  if (options['kind'] !== 'runtime_plugin_tool_invocation_snapshot') {
    throw new TypeError(
      'Plugin tool invocation snapshot kind is not supported.'
    );
  }

  return Object.freeze({
    eventId: requirePlainNonEmptyRecordString(options, 'eventId'),
    traceId: requirePlainNonEmptyRecordString(options, 'traceId'),
    createdAt: requirePlainNonEmptyRecordString(options, 'createdAt'),
    kind: 'runtime_plugin_tool_invocation_snapshot',
    pluginId: requirePlainNonEmptyString(
      requirePlainNonEmptyRecordString(options, 'pluginId'),
      'pluginId'
    ),
    toolName: requirePlainNonEmptyString(
      requirePlainNonEmptyRecordString(options, 'toolName'),
      'toolName'
    ),
    input: createRuntimePluginJsonObject(options['input'], 'input'),
    result: createRuntimePluginToolCallResult(options['result'])
  } satisfies RuntimePluginToolInvocationSnapshot);
}

function createRuntimePluginToolCallResult(
  value: unknown
): RuntimePluginToolCallResult {
  if (!isRecord(value)) {
    throw new TypeError('Plugin tool result must be an object.');
  }

  if (value['status'] === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: createRuntimePluginJsonValue(value['output'], 'output'),
      evidence: Object.freeze(
        requiredArrayOrThrow(value['evidence'], 'result.evidence').map(
          createRuntimePluginEvidenceSnapshot
        )
      )
    } satisfies RuntimePluginToolCallResult);
  }

  if (value['status'] === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      reason: requirePlainNonEmptyRecordString(value, 'reason'),
      message: redactRuntimePluginText(
        requirePlainNonEmptyRecordString(value, 'message')
      ),
      evidence: Object.freeze(
        requiredArrayOrThrow(value['evidence'], 'result.evidence').map(
          createRuntimePluginEvidenceSnapshot
        )
      )
    } satisfies RuntimePluginToolCallResult);
  }

  throw new TypeError('Plugin tool result status is not supported.');
}

function createRuntimePluginJsonObject(
  value: unknown,
  field: string
): RuntimePluginJsonObject {
  const normalized = createRuntimePluginJsonValue(value, field);

  if (!isRecord(normalized)) {
    throw new TypeError(`Plugin field "${field}" must be an object.`);
  }

  return normalized;
}

function createRuntimePluginJsonValue(
  value: unknown,
  field: string,
  key?: string
): RuntimePluginJsonValue {
  if (key !== undefined && isRuntimePluginCredentialKey(key)) {
    return '[redacted]';
  }

  if (value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return redactRuntimePluginText(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Plugin field "${field}" must be finite JSON.`);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item) => createRuntimePluginJsonValue(item, field))
    );
  }

  if (isRecord(value)) {
    const snapshotEntries: Array<readonly [string, RuntimePluginJsonValue]> = [];

    for (const [key, item] of Object.entries(value)) {
      snapshotEntries.push([
        key,
        createRuntimePluginJsonValue(item, `${field}.${key}`, key)
      ]);
    }

    return Object.freeze(Object.fromEntries(snapshotEntries));
  }

  throw new TypeError(`Plugin field "${field}" must be JSON serializable.`);
}

export function createRuntimePluginListingSnapshot(
  options: unknown
): RuntimePluginListingSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Plugin listing snapshot must be an object.');
  }

  const manifest = createRuntimePluginManifest(options['manifest']);
  const pluginId = requirePlainNonEmptyRecordString(
    options,
    'pluginId'
  );
  const providedTools = requiredArrayOrThrow(
    options['providedTools'],
    'providedTools'
  ).map(createRuntimePluginProvidedTool);
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
    runtimePluginHealthStatusValues,
    'healthStatus'
  );
  const access = pluginAccessSnapshot({
    manifest,
    requestedAccess: normalizeRuntimePluginAccessMap(
      options['requestedAccess'] ?? manifest.requestedAccess,
      'requestedAccess'
    ),
    grantedAccess: normalizeRuntimePluginAccessMap(
      options['grantedAccess'],
      'grantedAccess'
    )
  });

  if (pluginId !== manifest.id) {
    throw new TypeError(
      'Plugin listing pluginId must match manifest.id.'
    );
  }

  if (registeredLifecycleHooks.status === 'rejected') {
    throw new TypeError(registeredLifecycleHooks.details);
  }

  return Object.freeze({
    pluginId,
    manifest,
    providedTools: Object.freeze(providedTools),
    registeredLifecycleHooks: registeredLifecycleHooks.value,
    installed: requireBooleanRecordField(options, 'installed'),
    registered: requireBooleanRecordField(options, 'registered'),
    enabled: requireBooleanRecordField(options, 'enabled'),
    availableForTurn: requireBooleanRecordField(options, 'availableForTurn'),
    redactionLabels: Object.freeze([...redactionLabels]),
    requestedAccess: access.requestedAccess,
    grantedAccess: access.grantedAccess,
    ...(configFingerprint === undefined
      ? {}
      : { configFingerprint: redactRuntimePluginText(configFingerprint) }),
    ...(healthStatus === undefined ? {} : { healthStatus })
  } satisfies RuntimePluginListingSnapshot);
}

export function createRuntimePluginTurnEvidenceSnapshot(
  options: unknown
): RuntimePluginTurnEvidenceSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Plugin turn evidence snapshot must be an object.');
  }

  if (options['kind'] !== 'runtime_plugin_turn_evidence_snapshot') {
    throw new TypeError(
      'Plugin turn evidence snapshot kind is not supported.'
    );
  }

  if (options['contractVersion'] !== runtimePluginContractVersion) {
    throw new TypeError(
      `Plugin turn evidence contractVersion must be "${runtimePluginContractVersion}".`
    );
  }

  const identity = {
    eventId: requirePlainNonEmptyRecordString(options, 'eventId'),
    traceId: requirePlainNonEmptyRecordString(options, 'traceId'),
    createdAt: requirePlainNonEmptyRecordString(options, 'createdAt')
  } satisfies RuntimeEventIdentity;
  const plugins = requiredArrayOrThrow(options['plugins'], 'plugins').map(
    createRuntimePluginListingSnapshot
  );
  const contextItems = requiredArrayOrThrow(options['contextItems'], 'contextItems').map(
    createRuntimePluginContextItem
  );
  const toolInvocations = requiredArrayOrThrow(
    options['toolInvocations'] ?? [],
    'toolInvocations'
  ).map(createRuntimePluginToolInvocationSnapshot);
  const evidence = requiredArrayOrThrow(options['evidence'], 'evidence').map(
    createRuntimePluginEvidenceSnapshot
  );
  const health = requiredArrayOrThrow(options['health'], 'health').map(
    createRuntimePluginHealthSnapshot
  );

  assertUniquePluginListingIds(plugins);
  assertRuntimePluginEvidenceIdentity({
    identity,
    evidence
  });
  assertRuntimePluginToolInvocationIdentity({
    identity,
    toolInvocations
  });

  return Object.freeze({
    ...identity,
    kind: 'runtime_plugin_turn_evidence_snapshot',
    contractVersion: runtimePluginContractVersion,
    plugins: Object.freeze(plugins),
    contextItems: Object.freeze(contextItems),
    toolInvocations: Object.freeze(toolInvocations),
    evidence: Object.freeze(evidence),
    health: Object.freeze(health)
  } satisfies RuntimePluginTurnEvidenceSnapshot);
}

function validatePluginDeclarationsAgainstRuntime(options: {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
  readonly lifecycleHooks: RuntimePluginLifecycleHooks;
}): RuntimePluginValidationResult<undefined> {
  if (
    options.providedTools.length > 0 &&
    !options.manifest.declaredPlugins.includes('tool_provider')
  ) {
    return reject(
      'missing_required_declaration',
      'Plugins with provided tools must declare tool_provider.'
    );
  }

  const seenToolNames = new Set<string>();

  for (const tool of options.providedTools) {
    if (seenToolNames.has(tool.name)) {
      return reject(
        'duplicate_declaration',
        `Plugin provided tool "${tool.name}" is declared more than once.`
      );
    }

    seenToolNames.add(tool.name);
  }

  if (
    options.lifecycleHooks.handleToolCall !== undefined &&
    !options.manifest.declaredPlugins.includes('handle_tool_call')
  ) {
    return reject(
      'missing_required_declaration',
      'handleToolCall hooks must declare handle_tool_call.'
    );
  }

  if (
    options.lifecycleHooks.beforeRoleModelCall !== undefined &&
    !options.manifest.declaredPlugins.includes('before_role_model_call')
  ) {
    return reject(
      'missing_required_declaration',
      'beforeRoleModelCall hooks must declare before_role_model_call.'
    );
  }

  if (
    options.lifecycleHooks.afterTurnCommitted !== undefined &&
    !options.manifest.declaredPlugins.includes('after_turn_committed')
  ) {
    return reject(
      'missing_required_declaration',
      'afterTurnCommitted hooks must declare after_turn_committed.'
    );
  }

  if (
    options.lifecycleHooks.onSessionEnd !== undefined &&
    !options.manifest.declaredPlugins.includes('on_session_end')
  ) {
    return reject(
      'missing_required_declaration',
      'onSessionEnd hooks must declare on_session_end.'
    );
  }

  if (
    options.lifecycleHooks.health !== undefined &&
    !options.manifest.declaredPlugins.includes('health')
  ) {
    return reject(
      'missing_required_declaration',
      'health hooks must declare health.'
    );
  }

  return accept(undefined);
}

function registeredLifecycleHooks(
  plugin: RuntimePlugin
): readonly RuntimePluginDeclaration[] {
  const hooks: RuntimePluginDeclaration[] = [];

  if (plugin.providedTools.length > 0) {
    hooks.push('tool_provider');
  }

  if (plugin.lifecycleHooks.handleToolCall !== undefined) {
    hooks.push('handle_tool_call');
  }

  if (plugin.lifecycleHooks.beforeRoleModelCall !== undefined) {
    hooks.push('before_role_model_call');
  }

  if (plugin.lifecycleHooks.afterTurnCommitted !== undefined) {
    hooks.push('after_turn_committed');
  }

  if (plugin.lifecycleHooks.onSessionEnd !== undefined) {
    hooks.push('on_session_end');
  }

  if (plugin.lifecycleHooks.health !== undefined) {
    hooks.push('health');
  }

  return Object.freeze(hooks);
}

function requiredDeclarationArray(
  value: unknown
): RuntimePluginValidationResult<readonly RuntimePluginDeclaration[]> {
  return requiredDeclarationList({
    value,
    field: 'declaredPlugins',
    allowEmpty: false
  });
}

function requiredAccess(
  value: unknown,
  field: string
): RuntimePluginValidationResult<RuntimePluginAccessMap> {
  try {
    return accept(normalizeRuntimePluginAccessMap(value, field));
  } catch (error: unknown) {
    return reject(
      'malformed_manifest',
      error instanceof Error ? error.message : `${field} is malformed.`
    );
  }
}

function requiredRegisteredLifecycleHooks(
  value: unknown
): RuntimePluginValidationResult<readonly RuntimePluginDeclaration[]> {
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
}): RuntimePluginValidationResult<readonly RuntimePluginDeclaration[]> {
  if (
    !Array.isArray(options.value) ||
    (!options.allowEmpty && options.value.length === 0)
  ) {
    return reject(
      'malformed_manifest',
      `Plugin manifest ${options.field} must be a non-empty array.`
    );
  }

  const declarations: RuntimePluginDeclaration[] = [];
  const seen = new Set<RuntimePluginDeclaration>();

  for (const item of options.value) {
    if (!isOneOf(item, runtimePluginDeclarationValues)) {
      return reject(
        'malformed_manifest',
        `Plugin manifest ${options.field} includes an unsupported value.`
      );
    }

    if (seen.has(item)) {
      return reject(
        'duplicate_declaration',
        `Plugin manifest ${options.field} declares "${item}" more than once.`
      );
    }

    seen.add(item);
    declarations.push(item);
  }

  return accept(Object.freeze(declarations));
}

function requiredCompatibilityMetadata(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginCompatibilityMetadata> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin compatibility metadata must be an object.'
    );
  }

  const hostContractVersions = requiredStringArray(
    value['hostContractVersions'],
    'hostContractVersions'
  );

  if (hostContractVersions.status === 'rejected') {
    return hostContractVersions;
  }

  if (!hostContractVersions.value.includes(runtimePluginContractVersion)) {
    return reject(
      'unsupported_contract_version',
      `Plugin compatibility must include "${runtimePluginContractVersion}".`
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
        : { sourceSystem: redactRuntimePluginText(sourceSystem.value) }),
      ...(sourceVersion.value === undefined
        ? {}
        : { sourceVersion: redactRuntimePluginText(sourceVersion.value) }),
      ...(externalContract.value === undefined
        ? {}
        : { externalContract: redactRuntimePluginText(externalContract.value) }),
      ...(notes.value === undefined
        ? {}
        : { notes: Object.freeze(notes.value.map(redactRuntimePluginText)) })
    } satisfies RuntimePluginCompatibilityMetadata)
  );
}

function requiredConfigMetadata(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginConfigMetadata> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin config metadata must be an object.'
    );
  }

  const fieldsValue = value['fields'];

  if (!Array.isArray(fieldsValue)) {
    return reject(
      'malformed_manifest',
      'Plugin config fields must be an array.'
    );
  }

  const fields: RuntimePluginConfigField[] = [];
  const seenNames = new Set<string>();

  for (const fieldValue of fieldsValue) {
    const field = requiredConfigField(fieldValue);

    if (field.status === 'rejected') {
      return field;
    }

    if (seenNames.has(field.value.name)) {
      return reject(
        'duplicate_declaration',
        `Plugin config field "${field.value.name}" is declared more than once.`
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
        : { fingerprint: redactRuntimePluginText(fingerprint.value) })
    } satisfies RuntimePluginConfigMetadata)
  );
}

function requiredConfigField(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginConfigField> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin config field must be an object.'
    );
  }

  const name = requiredIdentifier(value['name'], 'name');
  const description = requiredNonEmptyString(value['description'], 'description');
  const required = requiredBoolean(value['required'], 'required');
  const secret = requiredBoolean(value['secret'], 'secret');
  const valueType = optionalRuntimePluginConfigValueType(value['valueType']);
  const defaultValueSummary = optionalString(
    value['defaultValueSummary'],
    'defaultValueSummary'
  );
  const envVar = optionalString(value['envVar'], 'envVar');
  const allowedValues =
    value['allowedValues'] === undefined
      ? accept(undefined)
      : requiredStringArray(value['allowedValues'], 'allowedValues');
  const redactionLabels = requiredStringArray(
    value['redactionLabels'],
    'redactionLabels'
  );
  const configFingerprint = optionalString(
    value['configFingerprint'],
    'configFingerprint'
  );

  if (
    name.status === 'rejected' ||
    description.status === 'rejected' ||
    required.status === 'rejected' ||
    secret.status === 'rejected' ||
    valueType.status === 'rejected' ||
    defaultValueSummary.status === 'rejected' ||
    envVar.status === 'rejected' ||
    allowedValues.status === 'rejected' ||
    redactionLabels.status === 'rejected' ||
    configFingerprint.status === 'rejected'
  ) {
    return firstRejected([
      name,
      description,
      required,
      secret,
      valueType,
      defaultValueSummary,
      envVar,
      allowedValues,
      redactionLabels,
      configFingerprint
    ]);
  }

  return accept(
    Object.freeze({
      name: name.value,
      description: redactRuntimePluginText(description.value),
      required: required.value,
      secret: secret.value,
      ...(valueType.value === undefined ? {} : { valueType: valueType.value }),
      ...(defaultValueSummary.value === undefined
        ? {}
        : { defaultValueSummary: redactRuntimePluginText(defaultValueSummary.value) }),
      ...(envVar.value === undefined
        ? {}
        : { envVar: redactRuntimePluginText(envVar.value) }),
      ...(allowedValues.value === undefined
        ? {}
        : {
            allowedValues: Object.freeze(
              allowedValues.value.map(redactRuntimePluginText)
            )
          }),
      redactionLabels: redactionLabels.value,
      ...(configFingerprint.value === undefined
        ? {}
        : { configFingerprint: redactRuntimePluginText(configFingerprint.value) })
    } satisfies RuntimePluginConfigField)
  );
}

function optionalRuntimePluginConfigValueType(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginConfigValueType | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (!isOneOf(value, runtimePluginConfigValueTypeValues)) {
    return reject(
      'malformed_manifest',
      'Plugin config field valueType is not supported.'
    );
  }

  return accept(value);
}

function requiredRuntimePolicy(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginRuntimePolicy> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin runtimePolicy must be an object.'
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

  if (!isOneOf(sideEffectLevel, runtimePluginSideEffectLevelValues)) {
    return reject(
      'malformed_manifest',
      'Plugin runtimePolicy.sideEffectLevel is not supported.'
    );
  }

  if (!isOneOf(confirmation, confirmationRequirementValues)) {
    return reject(
      'malformed_manifest',
      'Plugin runtimePolicy.confirmation is not supported.'
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
    } satisfies RuntimePluginRuntimePolicy)
  );
}

function requiredFailureBehavior(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginRuntimePolicy['failureBehavior']> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin failureBehavior must be an object.'
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
      'Plugin failureBehavior includes an unsupported value.'
    );
  }

  return accept(
    Object.freeze({
      beforeRoleModelCall,
      handleToolCall,
      afterTurnCommitted,
      health
    } satisfies RuntimePluginRuntimePolicy['failureBehavior'])
  );
}

function requiredActivationMetadata(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginActivationMetadata> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin activation metadata must be an object.'
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
    } satisfies RuntimePluginActivationMetadata)
  );
}

function requiredModelToolInputContract(
  value: unknown
): RuntimePluginValidationResult<ModelToolInputContract> {
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

  const jsonSchema =
    value['jsonSchema'] === undefined
      ? accept(undefined)
      : requiredModelToolObjectJsonSchema(value['jsonSchema'], 'jsonSchema');

  if (jsonSchema.status === 'rejected') {
    return jsonSchema;
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
      additionalFields: additionalFields.value,
      ...(jsonSchema.value === undefined
        ? {}
        : { jsonSchema: jsonSchema.value })
    } satisfies ModelToolInputContract)
  );
}

function requiredModelToolObjectJsonSchema(
  value: unknown,
  fieldPath: string
): RuntimePluginValidationResult<ModelToolObjectJsonSchema> {
  const schema = requiredModelToolJsonSchema(value, fieldPath);

  if (schema.status === 'rejected') {
    return schema;
  }

  if (
    schema.value.type !== 'object' ||
    schema.value.properties === undefined ||
    schema.value.required === undefined ||
    schema.value.additionalProperties === undefined
  ) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath} must be a complete object JSON Schema.`
    );
  }

  return accept(schema.value as ModelToolObjectJsonSchema);
}

function requiredModelToolJsonSchema(
  value: unknown,
  fieldPath: string
): RuntimePluginValidationResult<ModelToolJsonSchema> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath} must be a JSON Schema object.`
    );
  }

  const unsupportedKeyword = Object.keys(value).find(
    (keyword) => !supportedModelToolJsonSchemaKeywords.has(keyword)
  );

  if (unsupportedKeyword !== undefined) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.${unsupportedKeyword} is not supported.`
    );
  }

  const type = optionalModelToolJsonSchemaType(value['type'], fieldPath);
  const description =
    value['description'] === undefined
      ? accept(undefined)
      : requiredNonEmptyString(value['description'], `${fieldPath}.description`);
  const enumValues =
    value['enum'] === undefined
      ? accept(undefined)
      : requiredStringArray(value['enum'], `${fieldPath}.enum`);
  const required =
    value['required'] === undefined
      ? accept(undefined)
      : requiredStringArray(value['required'], `${fieldPath}.required`);
  const additionalProperties =
    value['additionalProperties'] === undefined
      ? accept(undefined)
      : requiredBoolean(
          value['additionalProperties'],
          `${fieldPath}.additionalProperties`
        );
  const properties = requiredModelToolJsonSchemaProperties(
    value['properties'],
    fieldPath
  );
  const items =
    value['items'] === undefined
      ? accept(undefined)
      : requiredModelToolJsonSchema(value['items'], `${fieldPath}.items`);

  if (
    type.status === 'rejected' ||
    description.status === 'rejected' ||
    enumValues.status === 'rejected' ||
    required.status === 'rejected' ||
    additionalProperties.status === 'rejected' ||
    properties.status === 'rejected' ||
    items.status === 'rejected'
  ) {
    return firstRejected([
      type,
      description,
      enumValues,
      required,
      additionalProperties,
      properties,
      items
    ]);
  }

  return accept(
    Object.freeze({
      ...(type.value === undefined ? {} : { type: type.value }),
      ...(description.value === undefined
        ? {}
        : { description: redactRuntimePluginText(description.value) }),
      ...(enumValues.value === undefined
        ? {}
        : { enum: enumValues.value }),
      ...(properties.value === undefined
        ? {}
        : { properties: properties.value }),
      ...(required.value === undefined ? {} : { required: required.value }),
      ...(additionalProperties.value === undefined
        ? {}
        : { additionalProperties: additionalProperties.value }),
      ...(items.value === undefined ? {} : { items: items.value })
    } satisfies ModelToolJsonSchema)
  );
}

const supportedModelToolJsonSchemaKeywords = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items'
]);

function requiredModelToolJsonSchemaProperties(
  value: unknown,
  fieldPath: string
): RuntimePluginValidationResult<
  Readonly<Record<string, ModelToolJsonSchema>> | undefined
> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.properties must be an object.`
    );
  }

  const properties: Record<string, ModelToolJsonSchema> = {};

  for (const [key, item] of Object.entries(value)) {
    if (key.trim().length === 0) {
      return reject(
        'malformed_tool_definition',
        `Model tool inputContract.${fieldPath}.properties key must be non-empty.`
      );
    }

    const property = requiredModelToolJsonSchema(
      item,
      `${fieldPath}.properties.${key}`
    );

    if (property.status === 'rejected') {
      return property;
    }

    properties[key] = property.value;
  }

  return accept(Object.freeze(properties));
}

function optionalModelToolJsonSchemaType(
  value: unknown,
  fieldPath: string
): RuntimePluginValidationResult<
  ModelToolJsonSchemaType | readonly ModelToolJsonSchemaType[] | undefined
> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (isModelToolJsonSchemaType(value)) {
    return accept(value);
  }

  if (Array.isArray(value)) {
    const types: ModelToolJsonSchemaType[] = [];

    for (const item of value) {
      if (!isModelToolJsonSchemaType(item)) {
        return reject(
          'malformed_tool_definition',
          `Model tool inputContract.${fieldPath}.type is not supported.`
        );
      }

      types.push(item);
    }

    return accept(Object.freeze(types));
  }

  return reject(
    'malformed_tool_definition',
    `Model tool inputContract.${fieldPath}.type is not supported.`
  );
}

function isModelToolJsonSchemaType(
  value: unknown
): value is ModelToolJsonSchemaType {
  return (
    value === 'string' ||
    value === 'number' ||
    value === 'boolean' ||
    value === 'object' ||
    value === 'array' ||
    value === 'null'
  );
}

function requiredModelToolInputField(
  value: unknown
): RuntimePluginValidationResult<ModelToolInputField> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract field must be an object.'
    );
  }

  const name = requiredIdentifier(value['name'], 'name');
  const description = requiredNonEmptyString(value['description'], 'description');
  const required = requiredBoolean(value['required'], 'required');
  const valueType = optionalModelToolInputFieldValueType(value['valueType']);
  const allowedValues =
    value['allowedValues'] === undefined
      ? accept(undefined)
      : requiredStringArray(value['allowedValues'], 'allowedValues');

  if (
    name.status === 'rejected' ||
    description.status === 'rejected' ||
    required.status === 'rejected' ||
    valueType.status === 'rejected' ||
    allowedValues.status === 'rejected'
  ) {
    return firstRejected([name, description, required, valueType, allowedValues]);
  }

  return accept(
    Object.freeze({
      name: name.value,
      description: redactRuntimePluginText(description.value),
      required: required.value,
      ...(valueType.value === undefined ? {} : { valueType: valueType.value }),
      ...(allowedValues.value === undefined
        ? {}
        : { allowedValues: allowedValues.value })
    } satisfies ModelToolInputField)
  );
}

function optionalModelToolInputFieldValueType(
  value: unknown
): RuntimePluginValidationResult<ModelToolInputFieldValueType | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (isOneOf(value, modelToolInputFieldValueTypes)) {
    return accept(value);
  }

  return reject(
    'malformed_tool_definition',
    'Model tool inputContract field valueType is not supported.'
  );
}

function requiredContextBudget(
  value: unknown
): RuntimePluginValidationResult<RuntimePluginContextBudget> {
  if (!isRecord(value)) {
    return reject(
      'malformed_context_item',
      'Plugin context budget must be an object.'
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
    } satisfies RuntimePluginContextBudget)
  );
}

function requiredSourceReferences(
  value: unknown
): RuntimePluginValidationResult<readonly RuntimePluginSourceReference[]> {
  if (!Array.isArray(value)) {
    return reject(
      'malformed_context_item',
      'Plugin sourceReferences must be an array.'
    );
  }

  const references: RuntimePluginSourceReference[] = [];

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
): RuntimePluginValidationResult<RuntimePluginSourceReference> {
  if (!isRecord(value)) {
    return reject(
      'malformed_context_item',
      'Plugin source reference must be an object.'
    );
  }

  const kind = value['kind'];
  const id = requiredNonEmptyString(value['id'], 'id');
  const title = optionalString(value['title'], 'title');
  const uri = optionalString(value['uri'], 'uri');

  if (
    id.status === 'rejected' ||
    title.status === 'rejected' ||
    uri.status === 'rejected'
  ) {
    return firstRejected([id, title, uri]);
  }

  if (!isOneOf(kind, runtimePluginSourceKindValues)) {
    return reject(
      'malformed_context_item',
      'Plugin source reference kind is not supported.'
    );
  }

  return accept(
    Object.freeze({
      kind,
      id: id.value,
      ...(title.value === undefined ? {} : { title: title.value }),
      ...(uri.value === undefined ? {} : { uri: uri.value })
    } satisfies RuntimePluginSourceReference)
  );
}

function freezeSourceReferences(
  value: readonly RuntimePluginSourceReference[]
): readonly RuntimePluginSourceReference[] {
  return Object.freeze(
    value.map((sourceReference) =>
      Object.freeze({
        kind: sourceReference.kind,
        id: sourceReference.id,
        ...(sourceReference.title === undefined
          ? {}
          : { title: redactRuntimePluginText(sourceReference.title) }),
        ...(sourceReference.uri === undefined
          ? {}
          : { uri: redactRuntimePluginText(sourceReference.uri) })
      } satisfies RuntimePluginSourceReference)
    )
  );
}

function optionalConfidence(
  value: unknown
): RuntimePluginValidationResult<number | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    return reject(
      'malformed_context_item',
      'Plugin context item confidence must be a finite number between 0 and 1.'
    );
  }

  return accept(value);
}

function requiredIdentifier(
  value: unknown,
  field: string
): RuntimePluginValidationResult<string> {
  const stringValue = requiredNonEmptyString(value, field);

  if (stringValue.status === 'rejected') {
    return stringValue;
  }

  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(stringValue.value)) {
    return reject(
      'malformed_manifest',
      `Plugin field "${field}" must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`
    );
  }

  return stringValue;
}

function requiredNonEmptyString(
  value: unknown,
  field: string
): RuntimePluginValidationResult<string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return reject(
      'malformed_manifest',
      `Plugin field "${field}" must be a non-empty string.`
    );
  }

  return accept(value);
}

function optionalString(
  value: unknown,
  field: string
): RuntimePluginValidationResult<string | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  return requiredNonEmptyString(value, field);
}

function requiredBoolean(
  value: unknown,
  field: string
): RuntimePluginValidationResult<boolean> {
  if (typeof value !== 'boolean') {
    return reject(
      'malformed_manifest',
      `Plugin field "${field}" must be a boolean.`
    );
  }

  return accept(value);
}

function requiredPositiveInteger(
  value: unknown,
  field: string
): RuntimePluginValidationResult<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return reject(
      'malformed_manifest',
      `Plugin field "${field}" must be a positive integer.`
    );
  }

  return accept(value);
}

function requiredStringArray(
  value: unknown,
  field: string
): RuntimePluginValidationResult<readonly string[]> {
  if (!Array.isArray(value)) {
    return reject(
      'malformed_manifest',
      `Plugin field "${field}" must be an array.`
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
  results: readonly RuntimePluginValidationResult<unknown>[]
): RuntimePluginValidationResult<never> {
  const rejected = results.find((result) => result.status === 'rejected');

  if (rejected !== undefined) {
    return reject(rejected.reason, rejected.details);
  }

  throw new Error('Expected at least one rejected validation result.');
}

function acceptedOrThrow<T>(result: RuntimePluginValidationResult<T>): T {
  if (result.status === 'accepted') {
    return result.value;
  }

  throw new TypeError(result.details);
}

function accept<T>(value: T): RuntimePluginValidationResult<T> {
  return Object.freeze({
    status: 'accepted',
    value
  } satisfies RuntimePluginValidationResult<T>);
}

function reject(
  reason: RuntimePluginValidationFailureReason,
  details: string
): RuntimePluginValidationResult<never> {
  return Object.freeze({
    status: 'rejected',
    reason,
    details
  } satisfies RuntimePluginValidationResult<never>);
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
    throw new TypeError(`Plugin field "${field}" must be an array.`);
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
    throw new TypeError(`Plugin field "${field}" must be a boolean.`);
  }

  return value;
}

function requirePlainNonEmptyString(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`Plugin field "${field}" must be non-empty.`);
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
    throw new TypeError(`Plugin field "${field}" must be a string.`);
  }

  return requirePlainNonEmptyString(value, field);
}

function assertUniquePluginListingIds(
  plugins: readonly RuntimePluginListingSnapshot[]
): void {
  const seen = new Set<string>();

  for (const plugin of plugins) {
    if (seen.has(plugin.pluginId)) {
      throw new TypeError(
        `Duplicate plugin listing id "${plugin.pluginId}" is not allowed.`
      );
    }

    seen.add(plugin.pluginId);
  }
}

function assertRuntimePluginEvidenceIdentity(options: {
  readonly identity: RuntimeEventIdentity;
  readonly evidence: readonly RuntimePluginEvidenceSnapshot[];
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
      'Plugin evidence snapshot identity must match turn evidence identity.'
    );
  }
}

function assertRuntimePluginToolInvocationIdentity(options: {
  readonly identity: RuntimeEventIdentity;
  readonly toolInvocations: readonly RuntimePluginToolInvocationSnapshot[];
}): void {
  for (const invocation of options.toolInvocations) {
    if (
      invocation.eventId !== options.identity.eventId ||
      invocation.traceId !== options.identity.traceId ||
      invocation.createdAt !== options.identity.createdAt
    ) {
      throw new TypeError(
        'Plugin tool invocation identity must match turn evidence identity.'
      );
    }

    assertRuntimePluginEvidenceIdentity({
      identity: options.identity,
      evidence: invocation.result.evidence
    });
  }
}

export function redactRuntimePluginText(value: string): string {
  return redactUriCredentials(
    redactUriSecretQueryValues(
      redactSecretKeyValues(redactBearerTokens(value))
    )
  );
}

const runtimePluginCredentialKeySource =
  String.raw`\b[A-Za-z0-9_.-]*(?:api[_.-]?key|token|secret|password|credential)[A-Za-z0-9_.-]*\b`;
const runtimePluginCredentialKeyPattern = new RegExp(
  runtimePluginCredentialKeySource,
  'iu'
);
const runtimePluginSecretKeyValuePattern = new RegExp(
  String.raw`(["']?)(${runtimePluginCredentialKeySource})\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^&#\s,;}]+)`,
  'giu'
);
const runtimePluginSecretQueryValuePattern = new RegExp(
  String.raw`([?&]${runtimePluginCredentialKeySource}=)[^&#\s]+`,
  'giu'
);

export function isRuntimePluginCredentialKey(value: string): boolean {
  return runtimePluginCredentialKeyPattern.test(value);
}

function redactBearerTokens(value: string): string {
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]');
}

function redactSecretKeyValues(value: string): string {
  return value.replace(
    runtimePluginSecretKeyValuePattern,
    (
      _match: string,
      keyQuote: string,
      key: string,
      separatorAndSpacing: string,
      rawValue: string
    ): string => {
      const quote =
        rawValue.startsWith('"') ? '"' : rawValue.startsWith("'") ? "'" : '';

      return `${keyQuote}${key}${keyQuote}${separatorAndSpacing}${quote}[redacted]${quote}`;
    }
  );
}

function redactUriCredentials(value: string): string {
  return value.replace(/(https?:\/\/)([^/@\s]+)@/giu, '$1[redacted]@');
}

function redactUriSecretQueryValues(value: string): string {
  return value.replace(
    runtimePluginSecretQueryValuePattern,
    '$1[redacted]'
  );
}

function freezeLifecycleHooks(
  hooks: RuntimePluginLifecycleHooks
): RuntimePluginLifecycleHooks {
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
  } satisfies RuntimePluginLifecycleHooks);
}
