/**
 * Model tool input validation: checks a proposed tool call's input
 * against the tool's declared JSON Schema input contract before the call
 * may commit.
 *
 * The shape decision belongs to Ajv — the contract is ordinary JSON
 * Schema, and a hand-written walker for it was a second implementation
 * of a solved problem. What stays here is what Ajv does not answer:
 * whether the value survives the JSON boundary, and how a failure is
 * phrased, because rejection details are fed back to the model as its
 * correction note.
 */
import {Ajv, type ErrorObject, type ValidateFunction} from 'ajv';
import {isJsonRecord} from '../../shared/json-boundary.ts';
import {type ModelToolInputContract} from './model-tools.ts';

export type ModelToolInputValidationResult =
  | {
      readonly status: 'accepted';
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: 'rejected';
      readonly details: string;
    };

// Schemas reach Ajv already meta-validated by the plugin manifest gate,
// which enforces a narrower keyword set than Ajv's strict mode would.
// Union types are part of that set.
const ajv = new Ajv({allErrors: true, strict: false, allowUnionTypes: true});

// Contracts are frozen and long-lived, so one compile per contract lasts
// the session rather than one per tool call.
const compiledContracts = new WeakMap<
  ModelToolInputContract,
  ValidateFunction
>();

export function validateModelToolInputAgainstContract(options: {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly inputContract: ModelToolInputContract;
}): ModelToolInputValidationResult {
  const validate = compiledContractValidator(options.inputContract);

  if (!validate(options.input)) {
    return rejectModelToolInput(
      modelToolInputRejectionDetails({
        toolName: options.toolName,
        input: options.input,
        errors: validate.errors ?? [],
      }),
    );
  }

  return Object.freeze({
    status: 'accepted',
    input: freezeJsonRecord(options.input),
  } satisfies ModelToolInputValidationResult);
}

function compiledContractValidator(
  inputContract: ModelToolInputContract,
): ValidateFunction {
  const compiled = compiledContracts.get(inputContract);

  if (compiled !== undefined) {
    return compiled;
  }

  // Ajv annotates the schema object it is given, and a contract is
  // frozen, so it compiles from a structural copy.
  const validate = ajv.compile(structuredClone(inputContract));
  compiledContracts.set(inputContract, validate);
  return validate;
}

/**
 * The first failure, phrased for the model. Ajv reports every failure;
 * the model can only act on one at a time, and the order below is the
 * order a reader would notice them: a missing field before an unexpected
 * one, either before a value that is merely the wrong shape.
 */
function modelToolInputRejectionDetails(options: {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly errors: readonly ErrorObject[];
}): string {
  const missing = options.errors.find(error => error.keyword === 'required');

  if (missing !== undefined) {
    return `${options.toolName} input missing required field "${fieldPathFor(
      missing.instancePath,
      requiredPropertyName(missing),
    )}".`;
  }

  const unsupported = options.errors.filter(
    error => error.keyword === 'additionalProperties',
  );

  if (unsupported.length > 0) {
    return `${options.toolName} input includes unsupported fields: ${unsupported
      .map(error =>
        fieldPathFor(error.instancePath, additionalPropertyName(error)),
      )
      .join(', ')}.`;
  }

  const first = options.errors[0];

  if (first === undefined) {
    return `${options.toolName} input does not match its declared contract.`;
  }

  return `${options.toolName} input field "${fieldPathFor(
    first.instancePath,
  )}" ${describeExpectation(first)}.`;
}

function describeExpectation(error: ErrorObject): string {
  if (error.keyword === 'enum') {
    const allowed = enumValues(error);

    return allowed.length > 0
      ? `must be one of: ${allowed.join(', ')}`
      : 'must be an allowed value';
  }

  if (error.keyword === 'type') {
    return `must be ${schemaTypeNames(error).join(' or ')}`;
  }

  return error.message ?? 'is not valid';
}

function requiredPropertyName(error: ErrorObject): string | undefined {
  const params: unknown = error.params;

  return isJsonRecord(params) && typeof params['missingProperty'] === 'string'
    ? params['missingProperty']
    : undefined;
}

function additionalPropertyName(error: ErrorObject): string | undefined {
  const params: unknown = error.params;

  return isJsonRecord(params) &&
    typeof params['additionalProperty'] === 'string'
    ? params['additionalProperty']
    : undefined;
}

function enumValues(error: ErrorObject): readonly string[] {
  const params: unknown = error.params;
  const allowed = isJsonRecord(params) ? params['allowedValues'] : undefined;

  return Array.isArray(allowed) ? allowed.map(value => String(value)) : [];
}

function schemaTypeNames(error: ErrorObject): readonly string[] {
  const schema: unknown = error.schema;

  if (Array.isArray(schema)) {
    return schema.map(value => String(value));
  }

  return typeof schema === 'string' ? [schema] : ['valid'];
}

/**
 * Ajv reports `/memory/tags/0`; the model was shown `memory.tags[0]`.
 * The root is `$` so a whole-input failure still names something.
 */
function fieldPathFor(instancePath: string, property?: string): string {
  const segments = instancePath
    .split('/')
    .filter(segment => segment.length > 0);

  if (property !== undefined) {
    segments.push(property);
  }

  const path = segments.reduce(
    (joined, segment) =>
      /^\d+$/u.test(segment)
        ? `${joined}[${segment}]`
        : joined.length === 0
          ? segment
          : `${joined}.${segment}`,
    '',
  );

  return path.length === 0 ? '$' : path;
}

function rejectModelToolInput(details: string): ModelToolInputValidationResult {
  return Object.freeze({
    status: 'rejected',
    details,
  } satisfies ModelToolInputValidationResult);
}

function freezeJsonRecord(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    snapshot[key] = freezeJsonValue(value);
  }

  return Object.freeze(snapshot);
}

function freezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJsonValue));
  }

  if (isJsonRecord(value)) {
    return freezeJsonRecord(value);
  }

  return value;
}
