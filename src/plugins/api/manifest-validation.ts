import {
  createJsonBoundarySnapshot,
  jsonBoundaryUtf8ByteLength,
} from '../../shared/json-boundary.ts';
import {normalizeRuntimePluginAccessMap} from '../policy/access-control.ts';
import {
  afterTurnCommittedFailureBehaviorValues,
  beforeRoleModelFailureBehaviorValues,
  confirmationRequirementValues,
  handleToolCallFailureBehaviorValues,
  healthFailureBehaviorValues,
  runtimePluginConfigScopeValues,
  runtimePluginConfigValueTypeValues,
  runtimePluginContextItemKindValues,
  runtimePluginContractVersion,
  runtimePluginDeclarationValues,
  runtimePluginKindValues,
  runtimePluginToolConcurrencyValues,
  type RuntimePluginToolAnnotations,
  runtimePluginToolValidationOwnerValues,
  runtimePluginTrustLevelValues,
  type RuntimePluginAccessMap,
  type RuntimePluginConfigValueType,
  type RuntimePluginDeclaration,
} from './contract.ts';
import type {
  RuntimePluginActivationMetadata,
  RuntimePluginCompatibilityMetadata,
  RuntimePluginConfigField,
  RuntimePluginConfigMetadata,
  RuntimePluginContextItem,
  RuntimePluginManifest,
  RuntimePluginProvidedTool,
  RuntimePluginRuntimePolicy,
  RuntimePluginValidationResult,
} from './types.ts';
import {
  optionalModelToolCallLimit,
  requiredModelToolInputContract,
} from './tool-schema-validation.ts';
import {
  accept,
  acceptedOrThrow,
  firstRejected,
  freezeRedactedStrings,
  freezeSourceReferences,
  isOneOf,
  isRecord,
  optionalConfidence,
  optionalString,
  redactRuntimePluginText,
  reject,
  requiredBoolean,
  requiredContextBudget,
  requiredIdentifier,
  requiredNonEmptyString,
  requiredPositiveInteger,
  requiredSourceReferences,
  requiredStringArray,
} from './validation-primitives.ts';

export function createRuntimePluginManifest(
  value: unknown,
): RuntimePluginManifest {
  return acceptedOrThrow(validateRuntimePluginManifest(value));
}

export function validateRuntimePluginManifest(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginManifest> {
  if (!isRecord(value)) {
    return reject('malformed_manifest', 'Plugin manifest must be an object.');
  }

  const contractVersion = value['contractVersion'];

  if (contractVersion !== runtimePluginContractVersion) {
    return reject(
      'unsupported_contract_version',
      `Plugin contractVersion must be "${runtimePluginContractVersion}".`,
    );
  }

  const kind = value['kind'];

  if (!isOneOf(kind, runtimePluginKindValues)) {
    return reject(
      'unsupported_plugin_kind',
      'Plugin manifest kind is not supported.',
    );
  }

  const declaredPlugins = requiredDeclarationArray(value['declaredPlugins']);

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
      'Plugin manifest localTrustLevel is not supported.',
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

  if (
    config.value.scope === 'character_only' &&
    activation.value.defaultEnabled
  ) {
    return reject(
      'malformed_manifest',
      'Character-only plugins cannot be enabled by the manifest default; enable them in a character package or character config.',
    );
  }

  const requestedAccess = requiredAccess(
    value['requestedAccess'],
    'Plugin manifest requestedAccess',
  );

  if (requestedAccess.status === 'rejected') {
    return requestedAccess;
  }

  const id = requiredIdentifier(value['id'], 'id');
  const displayName = requiredNonEmptyString(
    value['displayName'],
    'displayName',
  );
  const version = requiredNonEmptyString(value['version'], 'version');
  const description = requiredNonEmptyString(
    value['description'],
    'description',
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
      displayName: redactRuntimePluginText(displayName.value),
      version: redactRuntimePluginText(version.value),
      kind,
      description: redactRuntimePluginText(description.value),
      contractVersion: runtimePluginContractVersion,
      compatibility: compatibility.value,
      declaredPlugins: declaredPlugins.value,
      config: config.value,
      localTrustLevel,
      runtimePolicy: runtimePolicy.value,
      activation: activation.value,
      requestedAccess: requestedAccess.value,
    } satisfies RuntimePluginManifest),
  );
}

export function createRuntimePluginProvidedTool(
  value: unknown,
): RuntimePluginProvidedTool {
  return acceptedOrThrow(validateRuntimePluginProvidedTool(value));
}

export function validateRuntimePluginProvidedTool(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginProvidedTool> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool must be an object.',
    );
  }

  const name = requiredIdentifier(value['name'], 'name');
  const description = requiredNonEmptyString(
    value['description'],
    'description',
  );
  const requiredForUserTurn = requiredBoolean(
    value['requiredForUserTurn'],
    'requiredForUserTurn',
  );
  const callLimit = optionalModelToolCallLimit(value['callLimit']);
  const inputContract = requiredModelToolInputContract(value['inputContract']);
  const validationOwner = value['validationOwner'];
  const annotations = optionalToolAnnotations(value['annotations']);
  const concurrency = value['concurrency'];
  const requiresConfirmation = requiredBoolean(
    value['requiresConfirmation'],
    'requiresConfirmation',
  );
  const sourceReferencesRequired = requiredBoolean(
    value['sourceReferencesRequired'],
    'sourceReferencesRequired',
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
      sourceReferencesRequired,
    ]);
  }

  if (!isOneOf(validationOwner, runtimePluginToolValidationOwnerValues)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool validationOwner is not supported.',
    );
  }

  if (annotations.status === 'rejected') {
    return annotations;
  }

  if (
    concurrency !== undefined &&
    !isOneOf(concurrency, runtimePluginToolConcurrencyValues)
  ) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool concurrency is not supported.',
    );
  }

  return accept(
    Object.freeze({
      name: name.value,
      description: redactRuntimePluginText(description.value),
      requiredForUserTurn: requiredForUserTurn.value,
      ...(callLimit.value === undefined ? {} : {callLimit: callLimit.value}),
      inputContract: inputContract.value,
      validationOwner,
      ...(annotations.value === undefined
        ? {}
        : {annotations: annotations.value}),
      ...(concurrency === undefined ? {} : {concurrency}),
      requiresConfirmation: requiresConfirmation.value,
      sourceReferencesRequired: sourceReferencesRequired.value,
    } satisfies RuntimePluginProvidedTool),
  );
}

export function createRuntimePluginContextItem(
  value: unknown,
): RuntimePluginContextItem {
  return acceptedOrThrow(validateRuntimePluginContextItem(value));
}

export function validateRuntimePluginContextItem(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginContextItem> {
  try {
    value = createJsonBoundarySnapshot(value, {
      field: 'Plugin context item',
      redact: true,
    });
  } catch (error: unknown) {
    return reject(
      'malformed_context_item',
      error instanceof Error
        ? error.message
        : 'Plugin context item exceeds the JSON boundary.',
    );
  }

  if (!isRecord(value)) {
    return reject(
      'malformed_context_item',
      'Plugin context item must be an object.',
    );
  }

  const pluginId = requiredIdentifier(value['pluginId'], 'pluginId');
  const id = requiredIdentifier(value['id'], 'id');
  const kind = value['kind'];
  const text = requiredNonEmptyString(value['text'], 'text');
  const budget = requiredContextBudget(value['budget']);
  const sourceReferences = requiredSourceReferences(value['sourceReferences']);
  const confidence = optionalConfidence(value['confidence']);
  const redactionLabels = requiredStringArray(
    value['redactionLabels'],
    'redactionLabels',
  );

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
      redactionLabels,
    ]);
  }

  if (!isOneOf(kind, runtimePluginContextItemKindValues)) {
    return reject(
      'malformed_context_item',
      'Plugin context item kind is not supported.',
    );
  }

  if (jsonBoundaryUtf8ByteLength(text.value) > 16 * 1_024) {
    return reject(
      'malformed_context_item',
      'Plugin context item text exceeds the 16384-byte limit.',
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
      ...(confidence.value === undefined ? {} : {confidence: confidence.value}),
      redactionLabels: freezeRedactedStrings(redactionLabels.value),
    } satisfies RuntimePluginContextItem),
  );
}

function requiredDeclarationArray(
  value: unknown,
): RuntimePluginValidationResult<readonly RuntimePluginDeclaration[]> {
  return requiredDeclarationList({
    value,
    field: 'declaredPlugins',
    allowEmpty: false,
  });
}

function requiredAccess(
  value: unknown,
  field: string,
): RuntimePluginValidationResult<RuntimePluginAccessMap> {
  try {
    return accept(normalizeRuntimePluginAccessMap(value, field));
  } catch (error: unknown) {
    return reject(
      'malformed_manifest',
      error instanceof Error ? error.message : `${field} is malformed.`,
    );
  }
}

export function requiredDeclarationList(options: {
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
      `Plugin manifest ${options.field} must be a non-empty array.`,
    );
  }

  const declarations: RuntimePluginDeclaration[] = [];
  const seen = new Set<RuntimePluginDeclaration>();

  for (const item of options.value) {
    if (!isOneOf(item, runtimePluginDeclarationValues)) {
      return reject(
        'malformed_manifest',
        `Plugin manifest ${options.field} includes an unsupported value.`,
      );
    }

    if (seen.has(item)) {
      return reject(
        'duplicate_declaration',
        `Plugin manifest ${options.field} declares "${item}" more than once.`,
      );
    }

    seen.add(item);
    declarations.push(item);
  }

  return accept(Object.freeze(declarations));
}

function requiredCompatibilityMetadata(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginCompatibilityMetadata> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin compatibility metadata must be an object.',
    );
  }

  const hostContractVersions = requiredStringArray(
    value['hostContractVersions'],
    'hostContractVersions',
  );

  if (hostContractVersions.status === 'rejected') {
    return hostContractVersions;
  }

  if (!hostContractVersions.value.includes(runtimePluginContractVersion)) {
    return reject(
      'unsupported_contract_version',
      `Plugin compatibility must include "${runtimePluginContractVersion}".`,
    );
  }

  const sourceSystem = optionalString(value['sourceSystem'], 'sourceSystem');
  const sourceVersion = optionalString(value['sourceVersion'], 'sourceVersion');
  const externalContract = optionalString(
    value['externalContract'],
    'externalContract',
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
    return firstRejected([
      sourceSystem,
      sourceVersion,
      externalContract,
      notes,
    ]);
  }

  return accept(
    Object.freeze({
      hostContractVersions: hostContractVersions.value,
      ...(sourceSystem.value === undefined
        ? {}
        : {sourceSystem: redactRuntimePluginText(sourceSystem.value)}),
      ...(sourceVersion.value === undefined
        ? {}
        : {sourceVersion: redactRuntimePluginText(sourceVersion.value)}),
      ...(externalContract.value === undefined
        ? {}
        : {externalContract: redactRuntimePluginText(externalContract.value)}),
      ...(notes.value === undefined
        ? {}
        : {notes: Object.freeze(notes.value.map(redactRuntimePluginText))}),
    } satisfies RuntimePluginCompatibilityMetadata),
  );
}

function requiredConfigMetadata(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginConfigMetadata> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin config metadata must be an object.',
    );
  }

  const scope = value['scope'];

  if (!isOneOf(scope, runtimePluginConfigScopeValues)) {
    return reject(
      'malformed_manifest',
      'Plugin config scope must be "global_with_character_overrides" or "character_only".',
    );
  }

  const fieldsValue = value['fields'];

  if (!Array.isArray(fieldsValue)) {
    return reject(
      'malformed_manifest',
      'Plugin config fields must be an array.',
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
        `Plugin config field "${field.value.name}" is declared more than once.`,
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
      scope,
      fields: Object.freeze(fields),
      ...(fingerprint.value === undefined
        ? {}
        : {fingerprint: redactRuntimePluginText(fingerprint.value)}),
    } satisfies RuntimePluginConfigMetadata),
  );
}

function requiredConfigField(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginConfigField> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin config field must be an object.',
    );
  }

  const name = requiredIdentifier(value['name'], 'name');
  const description = requiredNonEmptyString(
    value['description'],
    'description',
  );
  const required = requiredBoolean(value['required'], 'required');
  const secret = requiredBoolean(value['secret'], 'secret');
  const valueType = optionalRuntimePluginConfigValueType(value['valueType']);
  const defaultValueSummary = optionalString(
    value['defaultValueSummary'],
    'defaultValueSummary',
  );
  const envVar = optionalString(value['envVar'], 'envVar');
  const allowedValues =
    value['allowedValues'] === undefined
      ? accept(undefined)
      : requiredStringArray(value['allowedValues'], 'allowedValues');
  const agentMutable =
    value['agentMutable'] === undefined
      ? accept(undefined)
      : requiredBoolean(value['agentMutable'], 'agentMutable');
  const reloadRequired =
    value['reloadRequired'] === undefined
      ? accept(undefined)
      : requiredBoolean(value['reloadRequired'], 'reloadRequired');
  const redactionLabels = requiredStringArray(
    value['redactionLabels'],
    'redactionLabels',
  );
  const configFingerprint = optionalString(
    value['configFingerprint'],
    'configFingerprint',
  );

  if (name.status === 'rejected') return name;
  if (description.status === 'rejected') return description;
  if (required.status === 'rejected') return required;
  if (secret.status === 'rejected') return secret;
  if (valueType.status === 'rejected') return valueType;
  if (defaultValueSummary.status === 'rejected') return defaultValueSummary;
  if (envVar.status === 'rejected') return envVar;
  if (allowedValues.status === 'rejected') return allowedValues;
  if (agentMutable.status === 'rejected') return agentMutable;
  if (reloadRequired.status === 'rejected') return reloadRequired;
  if (redactionLabels.status === 'rejected') return redactionLabels;
  if (configFingerprint.status === 'rejected') return configFingerprint;

  if (secret.value && agentMutable.value === true) {
    return reject(
      'malformed_manifest',
      'Secret plugin config fields cannot allow agent mutation.',
    );
  }

  return acceptRuntimePluginConfigField({
    name: name.value,
    description: description.value,
    required: required.value,
    secret: secret.value,
    valueType: valueType.value,
    defaultValueSummary: defaultValueSummary.value,
    envVar: envVar.value,
    allowedValues: allowedValues.value,
    agentMutable: agentMutable.value,
    reloadRequired: reloadRequired.value,
    redactionLabels: redactionLabels.value,
    configFingerprint: configFingerprint.value,
  });
}

function acceptRuntimePluginConfigField(options: {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly valueType: RuntimePluginConfigValueType | undefined;
  readonly defaultValueSummary: string | undefined;
  readonly envVar: string | undefined;
  readonly allowedValues: readonly string[] | undefined;
  readonly agentMutable: boolean | undefined;
  readonly reloadRequired: boolean | undefined;
  readonly redactionLabels: readonly string[];
  readonly configFingerprint: string | undefined;
}): RuntimePluginValidationResult<RuntimePluginConfigField> {
  return accept(
    Object.freeze({
      name: options.name,
      description: redactRuntimePluginText(options.description),
      required: options.required,
      secret: options.secret,
      ...(options.valueType === undefined
        ? {}
        : {valueType: options.valueType}),
      ...(options.defaultValueSummary === undefined
        ? {}
        : {
            defaultValueSummary: redactRuntimePluginText(
              options.defaultValueSummary,
            ),
          }),
      ...(options.envVar === undefined
        ? {}
        : {envVar: redactRuntimePluginText(options.envVar)}),
      ...(options.allowedValues === undefined
        ? {}
        : {
            allowedValues: Object.freeze(
              options.allowedValues.map(redactRuntimePluginText),
            ),
          }),
      ...(options.agentMutable === undefined
        ? {}
        : {agentMutable: options.agentMutable}),
      ...(options.reloadRequired === undefined
        ? {}
        : {reloadRequired: options.reloadRequired}),
      redactionLabels: freezeRedactedStrings(options.redactionLabels),
      ...(options.configFingerprint === undefined
        ? {}
        : {
            configFingerprint: redactRuntimePluginText(
              options.configFingerprint,
            ),
          }),
    } satisfies RuntimePluginConfigField),
  );
}

function optionalRuntimePluginConfigValueType(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginConfigValueType | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (!isOneOf(value, runtimePluginConfigValueTypeValues)) {
    return reject(
      'malformed_manifest',
      'Plugin config field valueType is not supported.',
    );
  }

  return accept(value);
}

function requiredRuntimePolicy(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginRuntimePolicy> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin runtimePolicy must be an object.',
    );
  }

  const requiredForTurn = requiredBoolean(
    value['requiredForTurn'],
    'requiredForTurn',
  );
  const confirmation = value['confirmation'];
  const timeoutMs = requiredPositiveInteger(value['timeoutMs'], 'timeoutMs');
  const sourceReferencesRequired = requiredBoolean(
    value['sourceReferencesRequired'],
    'sourceReferencesRequired',
  );
  const redactionLabels = requiredStringArray(
    value['redactionLabels'],
    'redactionLabels',
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
      failureBehavior,
    ]);
  }

  if (!isOneOf(confirmation, confirmationRequirementValues)) {
    return reject(
      'malformed_manifest',
      'Plugin runtimePolicy.confirmation is not supported.',
    );
  }

  return accept(
    Object.freeze({
      requiredForTurn: requiredForTurn.value,
      confirmation,
      timeoutMs: timeoutMs.value,
      sourceReferencesRequired: sourceReferencesRequired.value,
      redactionLabels: freezeRedactedStrings(redactionLabels.value),
      failureBehavior: failureBehavior.value,
    } satisfies RuntimePluginRuntimePolicy),
  );
}

/**
 * Tool annotations are advisory and every field is optional, so an
 * absent block is valid; a present one must still be well formed, since
 * a malformed hint would silently read as "unknown" and change whether
 * the user is asked.
 */
function optionalToolAnnotations(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginToolAnnotations | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool annotations must be an object.',
    );
  }

  const record = value;
  const hints: Record<string, boolean> = {};

  for (const hint of [
    'readOnlyHint',
    'destructiveHint',
    'openWorldHint',
  ] as const) {
    const hintValue = record[hint];

    if (hintValue === undefined) {
      continue;
    }

    if (typeof hintValue !== 'boolean') {
      return reject(
        'malformed_tool_definition',
        `Plugin provided tool annotation "${hint}" must be a boolean.`,
      );
    }

    hints[hint] = hintValue;
  }

  return accept(Object.freeze(hints) as RuntimePluginToolAnnotations);
}

function requiredFailureBehavior(
  value: unknown,
): RuntimePluginValidationResult<
  RuntimePluginRuntimePolicy['failureBehavior']
> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin failureBehavior must be an object.',
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
      'Plugin failureBehavior includes an unsupported value.',
    );
  }

  return accept(
    Object.freeze({
      beforeRoleModelCall,
      handleToolCall,
      afterTurnCommitted,
      health,
    } satisfies RuntimePluginRuntimePolicy['failureBehavior']),
  );
}

function requiredActivationMetadata(
  value: unknown,
): RuntimePluginValidationResult<RuntimePluginActivationMetadata> {
  if (!isRecord(value)) {
    return reject(
      'malformed_manifest',
      'Plugin activation metadata must be an object.',
    );
  }

  const defaultEnabled = requiredBoolean(
    value['defaultEnabled'],
    'defaultEnabled',
  );
  const reasons = requiredStringArray(value['reasons'], 'reasons');

  if (defaultEnabled.status === 'rejected' || reasons.status === 'rejected') {
    return firstRejected([defaultEnabled, reasons]);
  }

  return accept(
    Object.freeze({
      defaultEnabled: defaultEnabled.value,
      reasons: freezeRedactedStrings(reasons.value),
    } satisfies RuntimePluginActivationMetadata),
  );
}
