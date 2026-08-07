import {
  isModelToolJsonSchemaType,
  type ModelToolInputContract,
  type ModelToolJsonSchema,
  type ModelToolJsonSchemaType,
} from '../../role-model/api/index.ts';
import type {RuntimePluginValidationResult} from './types.ts';
import {
  accept,
  isRecord,
  reject,
  requiredBoolean,
  requiredNonEmptyString,
  requiredStringArray,
} from './validation-primitives.ts';

export function requiredModelToolInputContract(
  value: unknown,
): RuntimePluginValidationResult<ModelToolInputContract> {
  const schema = requiredModelToolJsonSchema(value, '');

  if (schema.status === 'rejected') {
    return schema;
  }

  // A tool takes named arguments, so its contract is always a complete
  // object schema. The three members below are what a provider needs to
  // render the tool and what the input validator enforces, so a contract
  // missing any of them is not renderable rather than merely terse.
  if (
    schema.value.type !== 'object' ||
    schema.value.properties === undefined ||
    schema.value.required === undefined ||
    schema.value.additionalProperties === undefined
  ) {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract must be a complete object JSON Schema with properties, required, and additionalProperties.',
    );
  }

  return accept(schema.value as ModelToolInputContract);
}

function requiredModelToolJsonSchema(
  value: unknown,
  fieldPath: string,
): RuntimePluginValidationResult<ModelToolJsonSchema> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      `${contractPath(fieldPath)} must be a JSON Schema object.`,
    );
  }

  const unsupportedKeyword = Object.keys(value).find(
    keyword => !supportedModelToolJsonSchemaKeywords.has(keyword),
  );

  if (unsupportedKeyword !== undefined) {
    return reject(
      'malformed_tool_definition',
      `${contractPath(childPath(fieldPath, unsupportedKeyword))} is not supported.`,
    );
  }

  const type = optionalModelToolJsonSchemaType(value['type'], fieldPath);
  const description =
    value['description'] === undefined
      ? accept(undefined)
      : requiredNonEmptyString(
          value['description'],
          childPath(fieldPath, 'description'),
        );
  const enumValues =
    value['enum'] === undefined
      ? accept(undefined)
      : requiredStringArray(value['enum'], childPath(fieldPath, 'enum'));
  const required =
    value['required'] === undefined
      ? accept(undefined)
      : requiredStringArray(
          value['required'],
          childPath(fieldPath, 'required'),
        );
  const additionalProperties =
    value['additionalProperties'] === undefined
      ? accept(undefined)
      : requiredBoolean(
          value['additionalProperties'],
          childPath(fieldPath, 'additionalProperties'),
        );
  const properties = requiredModelToolJsonSchemaProperties(
    value['properties'],
    fieldPath,
  );
  const items =
    value['items'] === undefined
      ? accept(undefined)
      : requiredModelToolJsonSchema(
          value['items'],
          childPath(fieldPath, 'items'),
        );

  if (type.status === 'rejected') return type;
  if (description.status === 'rejected') return description;
  if (enumValues.status === 'rejected') return enumValues;
  if (required.status === 'rejected') return required;
  if (additionalProperties.status === 'rejected') return additionalProperties;
  if (properties.status === 'rejected') return properties;
  if (items.status === 'rejected') return items;

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
      `${contractPath(childPath(fieldPath, 'type'))} must be non-empty.`,
    );
  }
  if (
    Array.isArray(parts.type) &&
    new Set(parts.type).size !== parts.type.length
  ) {
    return reject(
      'malformed_tool_definition',
      `${contractPath(childPath(fieldPath, 'type'))} must not contain duplicates.`,
    );
  }

  const usesObjectKeywords =
    parts.properties !== undefined ||
    parts.required !== undefined ||
    parts.additionalProperties !== undefined;
  if (usesObjectKeywords && !schemaTypes.includes('object')) {
    return reject(
      'malformed_tool_definition',
      `${contractPath(fieldPath)} uses object keywords without object type.`,
    );
  }
  if (parts.items !== undefined && !schemaTypes.includes('array')) {
    return reject(
      'malformed_tool_definition',
      `${contractPath(fieldPath)} uses items without array type.`,
    );
  }
  if (
    parts.required !== undefined &&
    new Set(parts.required).size !== parts.required.length
  ) {
    return reject(
      'malformed_tool_definition',
      `${contractPath(childPath(fieldPath, 'required'))} must not contain duplicates.`,
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
        `${contractPath(childPath(fieldPath, 'required'))} includes "${unknownRequiredName}" outside properties.`,
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
        : {description: parts.description}),
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
      `${contractPath(childPath(fieldPath, 'properties'))} must be an object.`,
    );
  }

  const properties: Array<readonly [string, ModelToolJsonSchema]> = [];

  for (const [key, item] of Object.entries(value)) {
    if (key.trim().length === 0) {
      return reject(
        'malformed_tool_definition',
        `${contractPath(childPath(fieldPath, 'properties'))} key must be non-empty.`,
      );
    }

    const property = requiredModelToolJsonSchema(
      item,
      childPath(childPath(fieldPath, 'properties'), key),
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
          `${contractPath(childPath(fieldPath, 'type'))} is not supported.`,
        );
      }

      types.push(item);
    }

    return accept(Object.freeze(types));
  }

  return reject(
    'malformed_tool_definition',
    `${contractPath(childPath(fieldPath, 'type'))} is not supported.`,
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

function contractPath(fieldPath: string): string {
  return fieldPath === ''
    ? 'Model tool inputContract'
    : `Model tool inputContract.${fieldPath}`;
}

function childPath(fieldPath: string, key: string): string {
  return fieldPath === '' ? key : `${fieldPath}.${key}`;
}
