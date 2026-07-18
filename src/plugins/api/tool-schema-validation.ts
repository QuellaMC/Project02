import {
  isModelToolJsonSchemaType,
  modelToolCallLimitScopes,
  modelToolInputFieldValueTypes,
  type ModelToolCallLimit,
  type ModelToolInputContract,
  type ModelToolInputField,
  type ModelToolInputFieldValueType,
  type ModelToolJsonSchema,
  type ModelToolJsonSchemaType,
  type ModelToolObjectJsonSchema,
} from '../../role-model/api/index.ts';
import type {RuntimePluginValidationResult} from './types.ts';
import {
  accept,
  firstRejected,
  isOneOf,
  isRecord,
  redactRuntimePluginText,
  reject,
  requiredBoolean,
  requiredIdentifier,
  requiredNonEmptyString,
  requiredPositiveInteger,
  requiredStringArray,
} from './validation-primitives.ts';

export function requiredModelToolCallLimit(
  value: unknown,
): RuntimePluginValidationResult<ModelToolCallLimit> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool callLimit must be an object.',
    );
  }

  const scope = value['scope'];
  const maxCalls = requiredPositiveInteger(
    value['maxCalls'],
    'callLimit.maxCalls',
  );

  if (!isOneOf(scope, modelToolCallLimitScopes)) {
    return reject(
      'malformed_tool_definition',
      'Plugin provided tool callLimit.scope is not supported.',
    );
  }

  if (maxCalls.status === 'rejected') {
    return maxCalls;
  }

  return accept(
    Object.freeze({
      scope,
      maxCalls: maxCalls.value,
    } satisfies ModelToolCallLimit),
  );
}

export function optionalModelToolCallLimit(
  value: unknown,
): RuntimePluginValidationResult<ModelToolCallLimit | undefined> {
  return value === undefined
    ? accept(undefined)
    : requiredModelToolCallLimit(value);
}

export function requiredModelToolInputContract(
  value: unknown,
): RuntimePluginValidationResult<ModelToolInputContract> {
  if (!isRecord(value) || value['type'] !== 'object') {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract must be an object contract.',
    );
  }

  const additionalFields = requiredBoolean(
    value['additionalFields'],
    'additionalFields',
  );
  const fieldsValue = value['fields'];

  if (additionalFields.status === 'rejected') {
    return additionalFields;
  }

  if (!Array.isArray(fieldsValue)) {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract.fields must be an array.',
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
        `Model tool input field "${field.value.name}" is declared more than once.`,
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
      ...(jsonSchema.value === undefined ? {} : {jsonSchema: jsonSchema.value}),
    } satisfies ModelToolInputContract),
  );
}

function requiredModelToolObjectJsonSchema(
  value: unknown,
  fieldPath: string,
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
      `Model tool inputContract.${fieldPath} must be a complete object JSON Schema.`,
    );
  }

  return accept(schema.value as ModelToolObjectJsonSchema);
}

function requiredModelToolJsonSchema(
  value: unknown,
  fieldPath: string,
): RuntimePluginValidationResult<ModelToolJsonSchema> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath} must be a JSON Schema object.`,
    );
  }

  const unsupportedKeyword = Object.keys(value).find(
    keyword => !supportedModelToolJsonSchemaKeywords.has(keyword),
  );

  if (unsupportedKeyword !== undefined) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.${unsupportedKeyword} is not supported.`,
    );
  }

  const type = optionalModelToolJsonSchemaType(value['type'], fieldPath);
  const description =
    value['description'] === undefined
      ? accept(undefined)
      : requiredNonEmptyString(
          value['description'],
          `${fieldPath}.description`,
        );
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
          `${fieldPath}.additionalProperties`,
        );
  const properties = requiredModelToolJsonSchemaProperties(
    value['properties'],
    fieldPath,
  );
  const items =
    value['items'] === undefined
      ? accept(undefined)
      : requiredModelToolJsonSchema(value['items'], `${fieldPath}.items`);

  if (type.status === 'rejected') return type;
  if (description.status === 'rejected') return description;
  if (enumValues.status === 'rejected') return enumValues;
  if (required.status === 'rejected') return required;
  if (additionalProperties.status === 'rejected') return additionalProperties;
  if (properties.status === 'rejected') return properties;
  if (items.status === 'rejected') return items;

  if (
    enumValues.value?.some(
      enumValue => redactRuntimePluginText(enumValue) !== enumValue,
    ) === true
  ) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.enum must not contain credential-bearing values.`,
    );
  }

  const parts = {
    type: type.value,
    description: description.value,
    enumValues: enumValues.value,
    required: required.value,
    additionalProperties: additionalProperties.value,
    properties: properties.value,
    items: items.value,
  } satisfies ModelToolJsonSchemaParts;
  const semanticValidation = validateModelToolJsonSchemaSemantics(
    parts,
    fieldPath,
  );

  if (semanticValidation !== undefined) {
    return semanticValidation;
  }

  return acceptModelToolJsonSchema(parts);
}

type ModelToolJsonSchemaParts = {
  readonly type:
    ModelToolJsonSchemaType | readonly ModelToolJsonSchemaType[] | undefined;
  readonly description: string | undefined;
  readonly enumValues: readonly string[] | undefined;
  readonly required: readonly string[] | undefined;
  readonly additionalProperties: boolean | undefined;
  readonly properties:
    Readonly<Record<string, ModelToolJsonSchema>> | undefined;
  readonly items: ModelToolJsonSchema | undefined;
};

function validateModelToolJsonSchemaSemantics(
  parts: ModelToolJsonSchemaParts,
  fieldPath: string,
): RuntimePluginValidationResult<ModelToolJsonSchema> | undefined {
  const schemaTypes =
    parts.type === undefined
      ? []
      : Array.isArray(parts.type)
        ? parts.type
        : [parts.type];
  if (Array.isArray(parts.type) && parts.type.length === 0) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.type must be non-empty.`,
    );
  }
  if (
    Array.isArray(parts.type) &&
    new Set(parts.type).size !== parts.type.length
  ) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.type must not contain duplicates.`,
    );
  }

  const usesObjectKeywords =
    parts.properties !== undefined ||
    parts.required !== undefined ||
    parts.additionalProperties !== undefined;
  if (usesObjectKeywords && !schemaTypes.includes('object')) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath} uses object keywords without object type.`,
    );
  }
  if (parts.items !== undefined && !schemaTypes.includes('array')) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath} uses items without array type.`,
    );
  }
  if (
    parts.required !== undefined &&
    new Set(parts.required).size !== parts.required.length
  ) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.required must not contain duplicates.`,
    );
  }
  if (parts.required !== undefined) {
    const unknownRequiredName = parts.required.find(
      name =>
        parts.properties === undefined ||
        !Object.hasOwn(parts.properties, name),
    );

    if (unknownRequiredName !== undefined) {
      return reject(
        'malformed_tool_definition',
        `Model tool inputContract.${fieldPath}.required includes "${unknownRequiredName}" outside properties.`,
      );
    }
  }

  return undefined;
}

function acceptModelToolJsonSchema(
  parts: ModelToolJsonSchemaParts,
): RuntimePluginValidationResult<ModelToolJsonSchema> {
  return accept(
    Object.freeze({
      ...(parts.type === undefined ? {} : {type: parts.type}),
      ...(parts.description === undefined
        ? {}
        : {description: redactRuntimePluginText(parts.description)}),
      ...(parts.enumValues === undefined ? {} : {enum: parts.enumValues}),
      ...(parts.properties === undefined ? {} : {properties: parts.properties}),
      ...(parts.required === undefined ? {} : {required: parts.required}),
      ...(parts.additionalProperties === undefined
        ? {}
        : {additionalProperties: parts.additionalProperties}),
      ...(parts.items === undefined ? {} : {items: parts.items}),
    } satisfies ModelToolJsonSchema),
  );
}

function requiredModelToolJsonSchemaProperties(
  value: unknown,
  fieldPath: string,
): RuntimePluginValidationResult<
  Readonly<Record<string, ModelToolJsonSchema>> | undefined
> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.properties must be an object.`,
    );
  }

  const properties: Array<readonly [string, ModelToolJsonSchema]> = [];

  for (const [key, item] of Object.entries(value)) {
    if (key.trim().length === 0) {
      return reject(
        'malformed_tool_definition',
        `Model tool inputContract.${fieldPath}.properties key must be non-empty.`,
      );
    }

    const property = requiredModelToolJsonSchema(
      item,
      `${fieldPath}.properties.${key}`,
    );

    if (property.status === 'rejected') {
      return property;
    }

    properties.push([key, property.value]);
  }

  return accept(Object.freeze(Object.fromEntries(properties)));
}

function optionalModelToolJsonSchemaType(
  value: unknown,
  fieldPath: string,
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
          `Model tool inputContract.${fieldPath}.type is not supported.`,
        );
      }

      types.push(item);
    }

    return accept(Object.freeze(types));
  }

  return reject(
    'malformed_tool_definition',
    `Model tool inputContract.${fieldPath}.type is not supported.`,
  );
}

function requiredModelToolInputField(
  value: unknown,
): RuntimePluginValidationResult<ModelToolInputField> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract field must be an object.',
    );
  }

  const name = requiredIdentifier(value['name'], 'name');
  const description = requiredNonEmptyString(
    value['description'],
    'description',
  );
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
    return firstRejected([
      name,
      description,
      required,
      valueType,
      allowedValues,
    ]);
  }
  if (
    allowedValues.value?.some(
      allowedValue => redactRuntimePluginText(allowedValue) !== allowedValue,
    ) === true
  ) {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract field allowedValues must not contain credential-bearing values.',
    );
  }

  return accept(
    Object.freeze({
      name: name.value,
      description: redactRuntimePluginText(description.value),
      required: required.value,
      ...(valueType.value === undefined ? {} : {valueType: valueType.value}),
      ...(allowedValues.value === undefined
        ? {}
        : {allowedValues: allowedValues.value}),
    } satisfies ModelToolInputField),
  );
}

function optionalModelToolInputFieldValueType(
  value: unknown,
): RuntimePluginValidationResult<ModelToolInputFieldValueType | undefined> {
  if (value === undefined) {
    return accept(undefined);
  }

  if (isOneOf(value, modelToolInputFieldValueTypes)) {
    return accept(value);
  }

  return reject(
    'malformed_tool_definition',
    'Model tool inputContract field valueType is not supported.',
  );
}

const supportedModelToolJsonSchemaKeywords = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
]);
