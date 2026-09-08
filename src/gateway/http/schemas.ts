import {Ajv, type JSONSchemaType, type SchemaObject} from 'ajv';

import {clientStampPattern} from '../../core/index.ts';
import {createJsonBoundarySnapshot} from '../../shared/json-boundary.ts';
import type {
  ConfigChange,
  GatewayConfirmationDecision,
  GatewayMessage,
} from '../api/contract.ts';

export type OpenConversationBody = {
  readonly characterId: string;
};

export type AnswerConfirmationBody = {
  readonly decision: GatewayConfirmationDecision;
};

export type BodyValidation<T> =
  | {readonly ok: true; readonly value: T}
  | {readonly ok: false; readonly message: string};

export type BodyValidator<T> = (value: unknown) => BodyValidation<T>;

/** Bounded well above any message a person types, well below the 64 KiB body cap. */
const maxTextLength = 16 * 1024;
const maxIdentifierLength = 128;

// ownProperties stops inherited prototype members satisfying a field;
// addUsedSchema is off so a schema $id cannot collide on recompile.
const ajv = new Ajv({
  allErrors: false,
  strict: true,
  ownProperties: true,
  addUsedSchema: false,
  discriminator: true,
});

const identifier = {
  type: 'string',
  minLength: 1,
  maxLength: maxIdentifierLength,
} as const;

/** The same one-token rule the façade and the codec apply. */
const clientStamp = {
  type: 'string',
  pattern: clientStampPattern.source,
} as const;

const openConversationBodySchema: JSONSchemaType<OpenConversationBody> = {
  type: 'object',
  properties: {characterId: identifier},
  required: ['characterId'],
  additionalProperties: false,
};

const gatewayMessageSchema: JSONSchemaType<GatewayMessage> = {
  type: 'object',
  properties: {
    conversationId: identifier,
    senderId: identifier,
    text: {type: 'string', minLength: 1, maxLength: maxTextLength},
    source: clientStamp,
    clientMessageId: clientStamp,
  },
  required: ['conversationId', 'senderId', 'text', 'source', 'clientMessageId'],
  additionalProperties: false,
};

const answerConfirmationBodySchema: JSONSchemaType<AnswerConfirmationBody> = {
  type: 'object',
  properties: {decision: {type: 'string', enum: ['approved', 'denied']}},
  required: ['decision'],
  additionalProperties: false,
};

/**
 * The change body, a branch per operation kind. A value slot admits any
 * JSON the boundary admits; the config seam judges it against the field.
 * Written as a plain schema: the contract's value type is recursive, which
 * the compile-checked schema type cannot spell.
 */
function operationBranch(
  kind: ConfigChange['operation']['kind'],
  properties: Record<string, SchemaObject>,
  optional: readonly string[] = [],
): SchemaObject {
  return {
    type: 'object',
    properties: {kind: {const: kind}, ...properties},
    required: [
      'kind',
      ...Object.keys(properties).filter(name => !optional.includes(name)),
    ],
    additionalProperties: false,
  };
}

const anyValue: SchemaObject = {};

const configChangeSchema: SchemaObject = {
  type: 'object',
  properties: {
    target: {
      oneOf: [
        {
          type: 'object',
          properties: {scope: {const: 'global'}},
          required: ['scope'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {scope: {const: 'character'}, characterId: identifier},
          required: ['scope', 'characterId'],
          additionalProperties: false,
        },
      ],
    },
    expectedFingerprint: identifier,
    operation: {
      type: 'object',
      discriminator: {propertyName: 'kind'},
      oneOf: [
        operationBranch('set', {path: identifier, value: anyValue}),
        operationBranch('unset', {path: identifier}),
        operationBranch(
          'plugin_enabled',
          {pluginId: identifier, enabled: {type: 'boolean'}},
          ['enabled'],
        ),
        operationBranch('plugin_field_set', {
          pluginId: identifier,
          field: identifier,
          value: anyValue,
        }),
        operationBranch('plugin_field_unset', {
          pluginId: identifier,
          field: identifier,
        }),
        operationBranch('plugin_secret_set', {
          pluginId: identifier,
          field: identifier,
          value: {type: 'string', minLength: 1},
        }),
      ],
    },
  },
  required: ['target', 'expectedFingerprint', 'operation'],
  additionalProperties: false,
};

/**
 * Untrusted JSON meets the boundary's size and depth limits first, then the
 * schema; either failure is the message the client gets back.
 */
function createBodyValidator<T>(
  field: string,
  schema: JSONSchemaType<T> | SchemaObject,
): BodyValidator<T> {
  const validate = ajv.compile<T>(schema);

  return value => {
    let snapshot: unknown;

    try {
      snapshot = createJsonBoundarySnapshot(value, {field});
    } catch (error: unknown) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (validate(snapshot)) {
      return {ok: true, value: snapshot};
    }

    return {
      ok: false,
      message: `${field} ${ajv.errorsText(validate.errors, {dataVar: ''})}`,
    };
  };
}

export const openConversationBody = createBodyValidator(
  'The open request',
  openConversationBodySchema,
);

export const gatewayMessageBody = createBodyValidator(
  'The message',
  gatewayMessageSchema,
);

export const answerConfirmationBody = createBodyValidator(
  'The answer',
  answerConfirmationBodySchema,
);

export const configChangeBody = createBodyValidator<ConfigChange>(
  'The config change',
  configChangeSchema,
);
