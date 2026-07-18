import {
  assertCanonicalRuntimeTimestamp,
  type CharacterProfile,
  type RuntimeEventIdentity,
  type VisibleMessage,
} from '../../core/index.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
  jsonBoundaryUtf8ByteLength,
  ownJsonRecordValue,
} from '../../shared/json-boundary.ts';
import {normalizeRuntimePluginAccessMap} from '../policy/access-control.ts';
import {
  runtimePluginContractVersion,
  runtimePluginEvidenceKindValues,
  runtimePluginEvidenceStatusValues,
  runtimePluginHealthStatusValues,
  runtimePluginPolicyOutcomeValues,
  type RuntimePluginAccessMap,
  type RuntimePluginAccessSnapshot,
  type RuntimePluginDeclaration,
} from './contract.ts';
import {
  createRuntimePluginContextItem,
  createRuntimePluginManifest,
  createRuntimePluginProvidedTool,
  requiredDeclarationList,
} from './manifest-validation.ts';
import {assertUniqueRuntimePluginIds} from './identity.ts';
import type {
  CreateRuntimePluginAfterTurnCommittedContextOptions,
  CreateRuntimePluginContextOptions,
  RuntimePlugin,
  RuntimePluginAfterTurnCommittedContext,
  RuntimePluginCommittedTurnSnapshot,
  RuntimePluginContext,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginHealthSnapshot,
  RuntimePluginJsonObject,
  RuntimePluginJsonValue,
  RuntimePluginLifecycleHooks,
  RuntimePluginListingSnapshot,
  RuntimePluginManifest,
  PreparedRuntimePluginConfigEffect,
  RuntimePluginProvidedTool,
  RuntimePluginRegistrationSnapshot,
  RuntimePluginRegistrySnapshot,
  RuntimePluginToolCallResult,
  RuntimePluginToolInvocationSnapshot,
  RuntimePluginTurnEvidenceSnapshot,
  RuntimePluginValidationResult,
} from './types.ts';
import {validateRuntimePluginModelFacingToolAccess} from './tool-classification.ts';
import {
  accept,
  freezeRedactedStrings,
  freezeSourceReferences,
  isRecord,
  isRuntimePluginCredentialKey,
  optionalOneOf,
  optionalPlainString,
  redactRuntimePluginText,
  reject,
  requireBooleanRecordField,
  requirePlainNonEmptyRecordString,
  requirePlainNonEmptyString,
  requiredArrayOrThrow,
  requiredOneOf,
  requiredSourceReferences,
  requiredStringArrayOrThrow,
} from './validation-primitives.ts';

export function createRuntimePluginContext(
  options: CreateRuntimePluginContextOptions,
): RuntimePluginContext {
  const deadlineAt = options.deadlineAt ?? Number.MAX_SAFE_INTEGER;

  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) {
    throw new TypeError(
      'Plugin context deadlineAt must be a positive safe integer.',
    );
  }

  return Object.freeze({
    sessionId: requirePlainNonEmptyString(options.sessionId, 'sessionId'),
    turnId: options.eventId,
    eventId: requirePlainNonEmptyString(options.eventId, 'eventId'),
    traceId: requirePlainNonEmptyString(options.traceId, 'traceId'),
    eventType: options.eventType,
    timestamp: assertCanonicalRuntimeTimestamp(
      options.createdAt,
      'Plugin context createdAt',
    ),
    deadlineAt,
    signal: options.signal ?? new AbortController().signal,
    currentUserMessage: requirePlainNonEmptyString(
      options.currentUserMessage,
      'currentUserMessage',
    ),
    character: Object.freeze({
      id: requirePlainNonEmptyString(options.character.id, 'character.id'),
      displayName: requirePlainNonEmptyString(
        options.character.displayName,
        'character.displayName',
      ),
    } satisfies CharacterProfile),
    privacy: Object.freeze({
      redactionLabels: freezeRedactedStrings(options.redactionLabels ?? []),
      exposePrivateConfig: false,
    }),
  } satisfies RuntimePluginContext);
}

export function createRuntimePluginAfterTurnCommittedContext(
  options: CreateRuntimePluginAfterTurnCommittedContextOptions,
): RuntimePluginAfterTurnCommittedContext {
  const runtimeContext = createRuntimePluginContext(options);
  const visibleMessages = freezeVisibleMessages(options.visibleMessages);

  return Object.freeze({
    ...runtimeContext,
    committedTurn: Object.freeze({
      committedAt: assertCanonicalRuntimeTimestamp(
        options.committedAt,
        'Plugin committedAt',
      ),
      visibleMessageIds: Object.freeze(
        visibleMessages.map(message => message.id),
      ),
      visibleMessages,
    } satisfies RuntimePluginCommittedTurnSnapshot),
  } satisfies RuntimePluginAfterTurnCommittedContext);
}

function freezeVisibleMessages(
  messages: readonly VisibleMessage[],
): readonly VisibleMessage[] {
  return Object.freeze(messages.map(freezeVisibleMessage));
}

function freezeVisibleMessage(message: VisibleMessage): VisibleMessage {
  return Object.freeze({
    id: requirePlainNonEmptyString(message.id, 'visibleMessage.id'),
    role: message.role,
    speakerId: requirePlainNonEmptyString(
      message.speakerId,
      'visibleMessage.speakerId',
    ),
    speakerName: requirePlainNonEmptyString(
      message.speakerName,
      'visibleMessage.speakerName',
    ),
    text: requirePlainNonEmptyString(message.text, 'visibleMessage.text'),
  } satisfies VisibleMessage);
}

export function createRuntimePlugin(options: {
  readonly manifest: unknown;
  readonly providedTools?: readonly unknown[];
  readonly lifecycleHooks?: RuntimePluginLifecycleHooks;
}): RuntimePlugin {
  const manifest = createRuntimePluginManifest(options.manifest);
  const providedTools = Object.freeze(
    (options.providedTools ?? []).map(createRuntimePluginProvidedTool),
  );
  const declarationValidation = validatePluginDeclarationsAgainstRuntime({
    manifest,
    providedTools,
    lifecycleHooks: options.lifecycleHooks ?? {},
  });

  if (declarationValidation.status === 'rejected') {
    throw new TypeError(declarationValidation.details);
  }

  validateRuntimePluginModelFacingToolAccess({
    manifest,
    providedTools,
  });

  return Object.freeze({
    manifest,
    providedTools,
    lifecycleHooks: freezeLifecycleHooks(options.lifecycleHooks ?? {}),
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
  } = {},
): RuntimePluginRegistrySnapshot {
  const registrations: RuntimePluginRegistrationSnapshot[] = [];

  assertUniqueRuntimePluginIds(plugins);

  for (const plugin of plugins) {
    const resolvedAccess = ownJsonRecordValue(
      options.accessByPluginId,
      plugin.manifest.id,
    );
    const access = pluginAccessSnapshot({
      manifest: plugin.manifest,
      ...(resolvedAccess?.grantedAccess === undefined
        ? {}
        : {grantedAccess: resolvedAccess.grantedAccess}),
    });
    registrations.push(
      Object.freeze({
        manifest: plugin.manifest,
        providedTools: plugin.providedTools,
        registeredLifecycleHooks: registeredLifecycleHooks(plugin),
        requestedAccess: access.requestedAccess,
        grantedAccess: access.grantedAccess,
      } satisfies RuntimePluginRegistrationSnapshot),
    );
  }

  return Object.freeze({
    contractVersion: runtimePluginContractVersion,
    plugins: Object.freeze(registrations),
  } satisfies RuntimePluginRegistrySnapshot);
}

function pluginAccessSnapshot(options: {
  readonly manifest: RuntimePluginManifest;
  readonly requestedAccess?: RuntimePluginAccessMap;
  readonly grantedAccess?: RuntimePluginAccessMap;
}): RuntimePluginAccessSnapshot {
  return Object.freeze({
    requestedAccess: normalizeRuntimePluginAccessMap(
      options.requestedAccess ?? options.manifest.requestedAccess,
      'requestedAccess',
    ),
    grantedAccess: normalizeRuntimePluginAccessMap(
      options.grantedAccess,
      'grantedAccess',
    ),
  } satisfies RuntimePluginAccessSnapshot);
}

export function createRuntimePluginEvidenceSnapshot(
  options: unknown,
): RuntimePluginEvidenceSnapshot {
  options = createJsonBoundarySnapshot(options, {
    field: 'Plugin evidence snapshot',
    redact: true,
  });

  if (!isRecord(options)) {
    throw new TypeError('Plugin evidence snapshot must be an object.');
  }
  if (options['kind'] !== 'runtime_plugin_evidence_snapshot') {
    throw new TypeError('Plugin evidence snapshot kind is not supported.');
  }

  const policyOutcome = optionalOneOf(
    options['policyOutcome'],
    runtimePluginPolicyOutcomeValues,
    'policyOutcome',
  );
  const sourceReferences =
    options['sourceReferences'] === undefined
      ? undefined
      : requiredSourceReferences(options['sourceReferences']);
  const redactionLabels = requiredStringArrayOrThrow(
    options['redactionLabels'],
    'redactionLabels',
  );
  const configFingerprint = optionalPlainString(
    options['configFingerprint'],
    'configFingerprint',
  );

  if (sourceReferences?.status === 'rejected') {
    throw new TypeError(sourceReferences.details);
  }
  const summary = requirePlainNonEmptyRecordString(options, 'summary');
  if (jsonBoundaryUtf8ByteLength(summary) > 16 * 1_024) {
    throw new TypeError(
      'Plugin evidence summary exceeds the 16384-byte limit.',
    );
  }

  return Object.freeze({
    eventId: requirePlainNonEmptyRecordString(options, 'eventId'),
    traceId: requirePlainNonEmptyRecordString(options, 'traceId'),
    createdAt: assertCanonicalRuntimeTimestamp(
      requirePlainNonEmptyRecordString(options, 'createdAt'),
      'Plugin evidence createdAt',
    ),
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: requirePlainNonEmptyString(
      requirePlainNonEmptyRecordString(options, 'pluginId'),
      'pluginId',
    ),
    evidenceKind: requiredOneOf(
      options['evidenceKind'],
      runtimePluginEvidenceKindValues,
      'evidenceKind',
    ),
    status: requiredOneOf(
      options['status'],
      runtimePluginEvidenceStatusValues,
      'status',
    ),
    summary: redactRuntimePluginText(summary),
    ...(policyOutcome === undefined ? {} : {policyOutcome}),
    ...(sourceReferences === undefined
      ? {}
      : {sourceReferences: freezeSourceReferences(sourceReferences.value)}),
    redactionLabels: freezeRedactedStrings(redactionLabels),
    ...(configFingerprint === undefined
      ? {}
      : {configFingerprint: redactRuntimePluginText(configFingerprint)}),
  } satisfies RuntimePluginEvidenceSnapshot);
}

export function createRuntimePluginHealthSnapshot(
  options: unknown,
): RuntimePluginHealthSnapshot {
  options = createJsonBoundarySnapshot(options, {
    field: 'Plugin health snapshot',
    redact: true,
  });

  if (!isRecord(options)) {
    throw new TypeError('Plugin health snapshot must be an object.');
  }

  const redactionLabels = requiredStringArrayOrThrow(
    options['redactionLabels'],
    'redactionLabels',
  );

  return Object.freeze({
    pluginId: requirePlainNonEmptyString(
      requirePlainNonEmptyRecordString(options, 'pluginId'),
      'pluginId',
    ),
    status: requiredOneOf(
      options['status'],
      runtimePluginHealthStatusValues,
      'status',
    ),
    checkedAt: assertCanonicalRuntimeTimestamp(
      requirePlainNonEmptyRecordString(options, 'checkedAt'),
      'Plugin health checkedAt',
    ),
    summary: redactRuntimePluginText(
      requirePlainNonEmptyRecordString(options, 'summary'),
    ),
    redactionLabels: freezeRedactedStrings(redactionLabels),
  } satisfies RuntimePluginHealthSnapshot);
}

export function createRuntimePluginToolInvocationSnapshot(
  options: unknown,
): RuntimePluginToolInvocationSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Plugin tool invocation snapshot must be an object.');
  }

  if (options['kind'] !== 'runtime_plugin_tool_invocation_snapshot') {
    throw new TypeError(
      'Plugin tool invocation snapshot kind is not supported.',
    );
  }

  return Object.freeze({
    eventId: requirePlainNonEmptyRecordString(options, 'eventId'),
    traceId: requirePlainNonEmptyRecordString(options, 'traceId'),
    createdAt: assertCanonicalRuntimeTimestamp(
      requirePlainNonEmptyRecordString(options, 'createdAt'),
      'Plugin tool invocation createdAt',
    ),
    kind: 'runtime_plugin_tool_invocation_snapshot',
    pluginId: requirePlainNonEmptyString(
      requirePlainNonEmptyRecordString(options, 'pluginId'),
      'pluginId',
    ),
    toolName: requirePlainNonEmptyString(
      requirePlainNonEmptyRecordString(options, 'toolName'),
      'toolName',
    ),
    input: createRuntimePluginJsonObject(options['input'], 'input'),
    result: createRuntimePluginToolCallResultSnapshot(options['result']),
  } satisfies RuntimePluginToolInvocationSnapshot);
}

export function createPreparedRuntimePluginConfigEffect(
  options: unknown,
): PreparedRuntimePluginConfigEffect {
  if (!isRecord(options)) {
    throw new TypeError('Prepared plugin config effect must be an object.');
  }

  if (options['kind'] !== 'runtime_plugin_config_effect') {
    throw new TypeError('Prepared plugin config effect kind is not supported.');
  }

  const operation = options['operation'];

  if (!isRecord(operation)) {
    throw new TypeError(
      'Prepared plugin config effect operation must be an object.',
    );
  }

  const normalizedOperation =
    operation['kind'] === 'set'
      ? Object.freeze({
          kind: 'set' as const,
          value: createJsonBoundarySnapshot(operation['value'], {
            field: 'Prepared plugin config effect value',
          }),
        })
      : operation['kind'] === 'unset'
        ? Object.freeze({kind: 'unset' as const})
        : undefined;

  if (normalizedOperation === undefined) {
    throw new TypeError(
      'Prepared plugin config effect operation is not supported.',
    );
  }

  return Object.freeze({
    eventId: requirePlainNonEmptyRecordString(options, 'eventId'),
    traceId: requirePlainNonEmptyRecordString(options, 'traceId'),
    createdAt: assertCanonicalRuntimeTimestamp(
      requirePlainNonEmptyRecordString(options, 'createdAt'),
      'Prepared plugin config effect createdAt',
    ),
    kind: 'runtime_plugin_config_effect',
    effectId: requirePlainNonEmptyRecordString(options, 'effectId'),
    targetPluginId: requirePlainNonEmptyRecordString(options, 'targetPluginId'),
    targetConfigPath: requirePlainNonEmptyRecordString(
      options,
      'targetConfigPath',
    ),
    fieldName: requirePlainNonEmptyRecordString(options, 'fieldName'),
    expectedFingerprint: requirePlainNonEmptyRecordString(
      options,
      'expectedFingerprint',
    ),
    resultFingerprint: requirePlainNonEmptyRecordString(
      options,
      'resultFingerprint',
    ),
    operation: normalizedOperation,
  } satisfies PreparedRuntimePluginConfigEffect);
}

export function preparedRuntimePluginConfigEffectHasApprovalEvidence(options: {
  readonly effect: PreparedRuntimePluginConfigEffect;
  readonly eventIdentity: RuntimeEventIdentity;
  readonly inputIdentity: RuntimeEventIdentity;
  readonly inputPluginId: string | undefined;
  readonly inputToolName: string | undefined;
  readonly toolCallId: string | undefined;
  readonly dispatchedToHost: boolean | undefined;
  readonly pluginId: string | undefined;
  readonly toolName: string | undefined;
  readonly result: RuntimePluginToolCallResult | undefined;
}): boolean {
  const {effect, result} = options;

  if (
    options.toolCallId !== effect.effectId ||
    options.dispatchedToHost !== true ||
    options.inputPluginId === undefined ||
    options.inputPluginId !== options.pluginId ||
    options.inputToolName === undefined ||
    options.inputToolName !== options.toolName ||
    options.eventIdentity.eventId !== effect.eventId ||
    options.eventIdentity.traceId !== effect.traceId ||
    options.eventIdentity.createdAt !== effect.createdAt ||
    options.inputIdentity.eventId !== effect.eventId ||
    options.inputIdentity.traceId !== effect.traceId ||
    options.inputIdentity.createdAt !== effect.createdAt ||
    result?.status !== 'accepted'
  ) {
    return false;
  }

  return result.evidence.some(
    evidence =>
      evidence.eventId === effect.eventId &&
      evidence.traceId === effect.traceId &&
      evidence.createdAt === effect.createdAt &&
      evidence.pluginId === options.pluginId &&
      evidence.evidenceKind === 'policy' &&
      evidence.status === 'accepted' &&
      evidence.policyOutcome === 'user_approved' &&
      evidence.sourceReferences?.some(
        reference =>
          reference.kind === 'runtime' && reference.id === effect.effectId,
      ) === true &&
      evidence.configFingerprint === effect.resultFingerprint,
  );
}

export function createRuntimePluginToolCallResultSnapshot(
  value: unknown,
): RuntimePluginToolCallResult {
  const boundedValue = createJsonBoundarySnapshot(value, {
    field: 'Plugin tool result',
    redact: true,
  });

  if (!isRecord(boundedValue)) {
    throw new TypeError('Plugin tool result must be an object.');
  }
  const evidenceValues = requiredArrayOrThrow(
    boundedValue['evidence'],
    'result.evidence',
  );

  if (evidenceValues.length > 64) {
    throw new TypeError(
      'Plugin tool result evidence exceeds the 64-record limit.',
    );
  }

  if (boundedValue['status'] === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: createRuntimePluginJsonValue(boundedValue['output'], 'output'),
      evidence: Object.freeze(
        evidenceValues.map(createRuntimePluginEvidenceSnapshot),
      ),
    } satisfies RuntimePluginToolCallResult);
  }

  if (boundedValue['status'] === 'rejected') {
    return Object.freeze({
      status: 'rejected',
      reason: redactRuntimePluginText(
        requirePlainNonEmptyRecordString(boundedValue, 'reason'),
      ),
      message: redactRuntimePluginText(
        requirePlainNonEmptyRecordString(boundedValue, 'message'),
      ),
      evidence: Object.freeze(
        evidenceValues.map(createRuntimePluginEvidenceSnapshot),
      ),
    } satisfies RuntimePluginToolCallResult);
  }

  throw new TypeError('Plugin tool result status is not supported.');
}

function createRuntimePluginJsonObject(
  value: unknown,
  field: string,
): RuntimePluginJsonObject {
  return createJsonBoundaryObjectSnapshot(value, {
    field: `Plugin field "${field}"`,
    redact: true,
  });
}

function createRuntimePluginJsonValue(
  value: unknown,
  field: string,
  key?: string,
): RuntimePluginJsonValue {
  if (key !== undefined && isRuntimePluginCredentialKey(key)) {
    return '[redacted]';
  }

  return createJsonBoundarySnapshot(value, {
    field: `Plugin field "${field}"`,
    redact: true,
  });
}

export function createRuntimePluginListingSnapshot(
  options: unknown,
): RuntimePluginListingSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Plugin listing snapshot must be an object.');
  }

  const manifest = createRuntimePluginManifest(options['manifest']);
  const pluginId = requirePlainNonEmptyRecordString(options, 'pluginId');
  const providedTools = requiredArrayOrThrow(
    options['providedTools'],
    'providedTools',
  ).map(createRuntimePluginProvidedTool);
  const registeredLifecycleHooks = requiredRegisteredLifecycleHooks(
    options['registeredLifecycleHooks'],
  );
  const redactionLabels = requiredStringArrayOrThrow(
    options['redactionLabels'],
    'redactionLabels',
  );
  const configFingerprint =
    optionalPlainString(options['configFingerprint'], 'configFingerprint') ??
    manifest.config.fingerprint;
  const healthStatus = optionalOneOf(
    options['healthStatus'],
    runtimePluginHealthStatusValues,
    'healthStatus',
  );
  const access = pluginAccessSnapshot({
    manifest,
    requestedAccess: normalizeRuntimePluginAccessMap(
      options['requestedAccess'] ?? manifest.requestedAccess,
      'requestedAccess',
    ),
    grantedAccess: normalizeRuntimePluginAccessMap(
      options['grantedAccess'],
      'grantedAccess',
    ),
  });

  if (pluginId !== manifest.id) {
    throw new TypeError('Plugin listing pluginId must match manifest.id.');
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
    redactionLabels: freezeRedactedStrings(redactionLabels),
    requestedAccess: access.requestedAccess,
    grantedAccess: access.grantedAccess,
    ...(configFingerprint === undefined
      ? {}
      : {configFingerprint: redactRuntimePluginText(configFingerprint)}),
    ...(healthStatus === undefined ? {} : {healthStatus}),
  } satisfies RuntimePluginListingSnapshot);
}

export function createRuntimePluginTurnEvidenceSnapshot(
  options: unknown,
): RuntimePluginTurnEvidenceSnapshot {
  if (!isRecord(options)) {
    throw new TypeError('Plugin turn evidence snapshot must be an object.');
  }

  if (options['kind'] !== 'runtime_plugin_turn_evidence_snapshot') {
    throw new TypeError('Plugin turn evidence snapshot kind is not supported.');
  }

  if (options['contractVersion'] !== runtimePluginContractVersion) {
    throw new TypeError(
      `Plugin turn evidence contractVersion must be "${runtimePluginContractVersion}".`,
    );
  }

  const identity = {
    eventId: requirePlainNonEmptyRecordString(options, 'eventId'),
    traceId: requirePlainNonEmptyRecordString(options, 'traceId'),
    createdAt: assertCanonicalRuntimeTimestamp(
      requirePlainNonEmptyRecordString(options, 'createdAt'),
      'Plugin turn evidence createdAt',
    ),
  } satisfies RuntimeEventIdentity;
  const plugins = requiredArrayOrThrow(options['plugins'], 'plugins').map(
    createRuntimePluginListingSnapshot,
  );
  const contextItems = requiredArrayOrThrow(
    options['contextItems'],
    'contextItems',
  ).map(createRuntimePluginContextItem);
  const toolInvocations = requiredArrayOrThrow(
    options['toolInvocations'] ?? [],
    'toolInvocations',
  ).map(createRuntimePluginToolInvocationSnapshot);
  const evidence = requiredArrayOrThrow(options['evidence'], 'evidence').map(
    createRuntimePluginEvidenceSnapshot,
  );
  const health = requiredArrayOrThrow(options['health'], 'health').map(
    createRuntimePluginHealthSnapshot,
  );

  assertUniquePluginListingIds(plugins);
  assertRuntimePluginEvidenceIdentity({
    identity,
    evidence,
  });
  assertRuntimePluginToolInvocationIdentity({
    identity,
    toolInvocations,
  });

  return Object.freeze({
    ...identity,
    kind: 'runtime_plugin_turn_evidence_snapshot',
    contractVersion: runtimePluginContractVersion,
    plugins: Object.freeze(plugins),
    contextItems: Object.freeze(contextItems),
    toolInvocations: Object.freeze(toolInvocations),
    evidence: Object.freeze(evidence),
    health: Object.freeze(health),
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
      'Plugins with provided tools must declare tool_provider.',
    );
  }

  const seenToolNames = new Set<string>();

  for (const tool of options.providedTools) {
    if (seenToolNames.has(tool.name)) {
      return reject(
        'duplicate_declaration',
        `Plugin provided tool "${tool.name}" is declared more than once.`,
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
      'handleToolCall hooks must declare handle_tool_call.',
    );
  }

  if (
    options.lifecycleHooks.beforeRoleModelCall !== undefined &&
    !options.manifest.declaredPlugins.includes('before_role_model_call')
  ) {
    return reject(
      'missing_required_declaration',
      'beforeRoleModelCall hooks must declare before_role_model_call.',
    );
  }

  if (
    options.lifecycleHooks.afterTurnCommitted !== undefined &&
    !options.manifest.declaredPlugins.includes('after_turn_committed')
  ) {
    return reject(
      'missing_required_declaration',
      'afterTurnCommitted hooks must declare after_turn_committed.',
    );
  }

  if (
    options.lifecycleHooks.onSessionEnd !== undefined &&
    !options.manifest.declaredPlugins.includes('on_session_end')
  ) {
    return reject(
      'missing_required_declaration',
      'onSessionEnd hooks must declare on_session_end.',
    );
  }

  if (
    options.lifecycleHooks.onShutdown !== undefined &&
    !options.manifest.declaredPlugins.includes('on_shutdown')
  ) {
    return reject(
      'missing_required_declaration',
      'onShutdown hooks must declare on_shutdown.',
    );
  }

  if (
    options.lifecycleHooks.health !== undefined &&
    !options.manifest.declaredPlugins.includes('health')
  ) {
    return reject(
      'missing_required_declaration',
      'health hooks must declare health.',
    );
  }

  return accept(undefined);
}

function registeredLifecycleHooks(
  plugin: RuntimePlugin,
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

  if (plugin.lifecycleHooks.onShutdown !== undefined) {
    hooks.push('on_shutdown');
  }

  if (plugin.lifecycleHooks.health !== undefined) {
    hooks.push('health');
  }

  return Object.freeze(hooks);
}

function requiredRegisteredLifecycleHooks(
  value: unknown,
): RuntimePluginValidationResult<readonly RuntimePluginDeclaration[]> {
  return requiredDeclarationList({
    value,
    field: 'registeredLifecycleHooks',
    allowEmpty: true,
  });
}

function assertUniquePluginListingIds(
  plugins: readonly RuntimePluginListingSnapshot[],
): void {
  const seen = new Set<string>();

  for (const plugin of plugins) {
    if (seen.has(plugin.pluginId)) {
      throw new TypeError(
        `Duplicate plugin listing id "${plugin.pluginId}" is not allowed.`,
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
      'Plugin evidence snapshot identity must match turn evidence identity.',
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
        'Plugin tool invocation identity must match turn evidence identity.',
      );
    }

    assertRuntimePluginEvidenceIdentity({
      identity: options.identity,
      evidence: invocation.result.evidence,
    });
  }
}

function freezeLifecycleHooks(
  hooks: RuntimePluginLifecycleHooks,
): RuntimePluginLifecycleHooks {
  const beforeRoleModelCall = hooks.beforeRoleModelCall;
  const handleToolCall = hooks.handleToolCall;
  const afterTurnCommitted = hooks.afterTurnCommitted;
  const onSessionEnd = hooks.onSessionEnd;
  const onShutdown = hooks.onShutdown;
  const health = hooks.health;

  return Object.freeze({
    ...(beforeRoleModelCall === undefined
      ? {}
      : {
          beforeRoleModelCall: context => beforeRoleModelCall(context),
        }),
    ...(handleToolCall === undefined
      ? {}
      : {
          handleToolCall: (call, context) => handleToolCall(call, context),
        }),
    ...(afterTurnCommitted === undefined
      ? {}
      : {
          afterTurnCommitted: context => afterTurnCommitted(context),
        }),
    ...(onSessionEnd === undefined
      ? {}
      : {
          onSessionEnd: context => onSessionEnd(context),
        }),
    ...(onShutdown === undefined
      ? {}
      : {
          onShutdown: context => onShutdown(context),
        }),
    ...(health === undefined
      ? {}
      : {
          health: context => health(context),
        }),
  } satisfies RuntimePluginLifecycleHooks);
}
