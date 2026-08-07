import {
  createJsonBoundarySnapshot,
  jsonBoundaryUtf8ByteLength,
} from '../../shared/json-boundary.ts';
import {normalizeRuntimePluginAccessMap} from '../policy/access-control.ts';
import {
  beforeRoleModelFailureBehaviorValues,
  handleToolCallFailureBehaviorValues,
  healthFailureBehaviorValues,
  runtimePluginConfigScopeValues,
  runtimePluginConfigValueTypeValues,
  runtimePluginContextItemKindValues,
  runtimePluginContractVersion,
  runtimePluginDeclarationValues,
  runtimePluginKindValues,
  runtimePluginToolConcurrencyValues,
  runtimePluginToolValidationOwnerValues,
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
import {requiredModelToolInputContract} from './tool-schema-validation.ts';
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

  const firstParty = requiredBoolean(value['firstParty'], 'firstParty');

  if (firstParty.status === 'rejected') {
    return firstParty;
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
      displayName: displayName.value,
      version: version.value,
      kind,
      description: description.value,
      contractVersion: runtimePluginContractVersion,
      compatibility: compatibility.value,
      declaredPlugins: declaredPlugins.value,
      config: config.value,
      firstParty: firstParty.value,
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

  const retired = retiredToolDeclaration(value);

  if (retired !== undefined) {
    return retired;
  }

  const name = requiredIdentifier(value['name'], 'name');
  const description = requiredNonEmptyString(
    value['description'],
    'description',
  );
  const inputContract = requiredModelToolInputContract(value['inputContract']);
  const validationOwner = value['validationOwner'];
  const concurrency = value['concurrency'];
  const requiresConfirmation = requiredBoolean(
    value['requiresConfirmation'],
    'requiresConfirmation',
  );

  if (
    name.status === 'rejected' ||
    description.status === 'rejected' ||
    inputContract.status === 'rejected' ||
    requiresConfirmation.status === 'rejected'
  ) {
    return firstRejected([
      name,
      description,
      inputContract,
      requiresConfirmation,
    ]);
  }

  if (!isOneOf(validationOwner, runtimePluginToolValidationOwnerValues)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool validationOwner is not supported.',
    );
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
      description: description.value,
      inputContract: inputContract.value,
      validationOwner,
      ...(concurrency === undefined ? {} : {concurrency}),
      requiresConfirmation: requiresConfirmation.value,
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
      text: text.value,
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

  return accept(
    Object.freeze({
      hostContractVersions: hostContractVersions.value,
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
        : {fingerprint: fingerprint.value}),
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
}): RuntimePluginValidationResult<RuntimePluginConfigField> {
  return accept(
    Object.freeze({
      name: options.name,
      description: options.description,
      required: options.required,
      secret: options.secret,
      ...(options.valueType === undefined
        ? {}
        : {valueType: options.valueType}),
      ...(options.defaultValueSummary === undefined
        ? {}
        : {defaultValueSummary: options.defaultValueSummary}),
      ...(options.envVar === undefined ? {} : {envVar: options.envVar}),
      ...(options.allowedValues === undefined
        ? {}
        : {
            allowedValues: Object.freeze([...options.allowedValues]),
          }),
      ...(options.agentMutable === undefined
        ? {}
        : {agentMutable: options.agentMutable}),
      ...(options.reloadRequired === undefined
        ? {}
        : {reloadRequired: options.reloadRequired}),
      redactionLabels: freezeRedactedStrings(options.redactionLabels),
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

  const timeoutMs = requiredPositiveInteger(value['timeoutMs'], 'timeoutMs');
  const redactionLabels = requiredStringArray(
    value['redactionLabels'],
    'redactionLabels',
  );
  const failureBehavior = requiredFailureBehavior(value['failureBehavior']);

  if (
    timeoutMs.status === 'rejected' ||
    redactionLabels.status === 'rejected' ||
    failureBehavior.status === 'rejected'
  ) {
    return firstRejected([timeoutMs, redactionLabels, failureBehavior]);
  }

  return accept(
    Object.freeze({
      timeoutMs: timeoutMs.value,
      redactionLabels: freezeRedactedStrings(redactionLabels.value),
      failureBehavior: failureBehavior.value,
    } satisfies RuntimePluginRuntimePolicy),
  );
}

/** Ignoring a retired field would silently reverse its author's intent. */
const retiredProvidedToolFields = Object.freeze({
  sideEffectLevel: 'no longer supported; remove it',
  requiredForUserTurn: 'no longer supported; remove it',
  callLimit: 'no longer supported; remove it',
});

function retiredToolDeclaration(
  value: Readonly<Record<string, unknown>>,
): RuntimePluginValidationResult<RuntimePluginProvidedTool> | undefined {
  for (const [field, guidance] of Object.entries(retiredProvidedToolFields)) {
    if (value[field] !== undefined) {
      return reject(
        'malformed_tool_definition',
        `Plugin provided tool declares retired field "${field}": ${guidance}.`,
      );
    }
  }

  return undefined;
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
  const health = value['health'];

  if (
    !isOneOf(beforeRoleModelCall, beforeRoleModelFailureBehaviorValues) ||
    !isOneOf(handleToolCall, handleToolCallFailureBehaviorValues) ||
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
