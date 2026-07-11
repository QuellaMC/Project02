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
import type { RuntimePluginValidationResult } from './plugin-types.ts';
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
  requiredStringArray
} from './validation-primitives.ts';

export function requiredModelToolCallLimit(
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

export function requiredModelToolInputContract(
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
  if (
    enumValues.value?.some(
      (enumValue) => redactRuntimePluginText(enumValue) !== enumValue
    ) === true
  ) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.enum must not contain credential-bearing values.`
    );
  }

  const schemaTypes =
    type.value === undefined
      ? []
      : Array.isArray(type.value)
        ? type.value
        : [type.value];
  if (Array.isArray(type.value) && type.value.length === 0) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.type must be non-empty.`
    );
  }
  if (
    Array.isArray(type.value) &&
    new Set(type.value).size !== type.value.length
  ) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.type must not contain duplicates.`
    );
  }

  const usesObjectKeywords =
    properties.value !== undefined ||
    required.value !== undefined ||
    additionalProperties.value !== undefined;
  if (usesObjectKeywords && !schemaTypes.includes('object')) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath} uses object keywords without object type.`
    );
  }
  if (items.value !== undefined && !schemaTypes.includes('array')) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath} uses items without array type.`
    );
  }
  if (
    required.value !== undefined &&
    new Set(required.value).size !== required.value.length
  ) {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract.${fieldPath}.required must not contain duplicates.`
    );
  }
  if (required.value !== undefined) {
    const unknownRequiredName = required.value.find(
      (name) =>
        properties.value === undefined ||
        !Object.hasOwn(properties.value, name)
    );

    if (unknownRequiredName !== undefined) {
      return reject(
        'malformed_tool_definition',
        `Model tool inputContract.${fieldPath}.required includes "${unknownRequiredName}" outside properties.`
      );
    }
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

  const properties: Array<readonly [string, ModelToolJsonSchema]> = [];

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

    properties.push([key, property.value]);
  }

  return accept(Object.freeze(Object.fromEntries(properties)));
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
  if (
    allowedValues.value?.some(
      (allowedValue) => redactRuntimePluginText(allowedValue) !== allowedValue
    ) === true
  ) {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract field allowedValues must not contain credential-bearing values.'
    );
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

const supportedModelToolJsonSchemaKeywords = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items'
]);
