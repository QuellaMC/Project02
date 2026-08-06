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
 *
 * The accepted input is the JSON boundary snapshot of the proposal, not
 * the proposal itself: normalized, bounded, and frozen. Callers execute
 * that snapshot, so what a plugin receives is what validation accepted
 * and what the log records, on every path into the seam.
 */
import {Ajv, type ErrorObject, type ValidateFunction} from 'ajv';
import {
  createJsonBoundaryObjectSnapshot,
  isJsonRecord,
  type JsonBoundaryObject,
} from '../../shared/json-boundary.ts';
import {type ModelToolInputContract} from './model-tools.ts';

export type ModelToolInputValidationResult =
  | {
      readonly status: 'accepted';
      readonly input: JsonBoundaryObject;
    }
  | {
      readonly status: 'rejected';
      readonly details: string;
    };

// Schemas reach Ajv already meta-validated by the plugin manifest gate,
// which enforces a narrower keyword set than Ajv's strict mode would.
// Union types are part of that set. Own-property iteration keeps a
// declared field named after an Object.prototype member — "toString",
// "constructor" — from being satisfied by the inherited value.
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  ownProperties: true,
});

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
  let input: JsonBoundaryObject;

  try {
    input = createJsonBoundaryObjectSnapshot(options.input, {
      field: `Model tool "${options.toolName}" input`,
    });
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return rejectModelToolInput(error.message);
    }

    throw error;
  }

  if (!validate(input)) {
    return rejectModelToolInput(
      modelToolInputRejectionDetails({
        toolName: options.toolName,
        errors: validate.errors ?? [],
      }),
    );
  }

  return Object.freeze({
    status: 'accepted',
    input,
  } satisfies ModelToolInputValidationResult);
}

function compiledContractValidator(
  inputContract: ModelToolInputContract,
): ValidateFunction {
  const compiled = compiledContracts.get(inputContract);

  if (compiled !== undefined) {
    return compiled;
  }

  // Compiled from the frozen contract itself: Ajv reads the schema
  // without mutating it, so a defensive copy would only split the
  // compile cache key from the contract the runtime holds.
  const validate = ajv.compile(inputContract);
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
    return `must be ${expectedTypeNames(error).join(' or ')}`;
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

// A type failure's expectation lives in params.type — a name or an array
// of names for a union — not on the error's absent schema member.
function expectedTypeNames(error: ErrorObject): readonly string[] {
  const params: unknown = error.params;
  const expected = isJsonRecord(params) ? params['type'] : undefined;

  if (Array.isArray(expected)) {
    return expected.map(value => String(value));
  }

  return typeof expected === 'string' ? [expected] : ['valid'];
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
