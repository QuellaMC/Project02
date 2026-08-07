/**
 * Model tool input validation: checks a proposed tool call's input
 * against the tool's declared JSON Schema input contract before the call
 * may commit.
 *
 * Both judgments about the contract belong to Ajv: whether the schema is
 * valid at the manifest gate, and whether an input satisfies it in the
 * loop. One engine, one configuration — a contract the gate admits is
 * exactly a contract the runtime can enforce. What stays here is what
 * Ajv does not answer: whether a value survives the JSON boundary, and
 * how a failure is phrased, because rejection details are fed back to
 * the model as its correction note.
 *
 * The accepted input is the JSON boundary snapshot of the proposal, not
 * the proposal itself: normalized, bounded, and frozen. Callers execute
 * that snapshot, so what a plugin receives is what validation accepted
 * and what the log records, on every path into the seam.
 */
import {Ajv, type ErrorObject, type ValidateFunction} from 'ajv';
import {canonicalJsonStringify} from '../../shared/canonical-json.ts';
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

// One instance judges the contract and the input, so what the gate
// admits and what the runtime enforces can never drift. Strict mode
// makes an author's mistake a compile failure instead of a silently
// unenforced wish: an unknown keyword, an object keyword on a
// non-object type. strictRequired stays off because it is the one
// strict flag that polices more than the engine enforces — a required
// name is enforced wherever it is declared, composed allOf included,
// and is never silently ignored — and the gate must not reject what the
// engine would enforce. Own-property iteration keeps a declared field
// named after an Object.prototype member — "toString", "constructor" —
// from being satisfied by the inherited value. The instance registers
// nothing it compiles, so a contract carrying an $id cannot collide
// with a later compile of the same or another contract.
const ajv = new Ajv({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
  ownProperties: true,
  addUsedSchema: false,
});

// Keyed by canonical content, not object identity: the storage codec
// re-derives a fresh contract object for every decoded record, and each
// distinct schema should cost one compile per session, not one per
// decode.
const compiledContracts = new Map<string, ValidateFunction>();

export type ModelToolInputContractCompilation =
  | {readonly status: 'compiled'}
  | {readonly status: 'invalid'; readonly details: string};

/**
 * Whether Ajv accepts the contract as JSON Schema — the manifest gate's
 * validity question. A contract that compiles here is enforceable, and
 * the compile is cached, so the gate's answer is the session's
 * validator.
 */
export function compileModelToolInputContract(
  inputContract: ModelToolInputContract,
): ModelToolInputContractCompilation {
  try {
    compiledContractValidator(inputContract);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return Object.freeze({
        status: 'invalid',
        details: error.message,
      } satisfies ModelToolInputContractCompilation);
    }

    throw error;
  }

  return Object.freeze({
    status: 'compiled',
  } satisfies ModelToolInputContractCompilation);
}

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
  const contractKey = canonicalJsonStringify(inputContract);
  const compiled = compiledContracts.get(contractKey);

  if (compiled !== undefined) {
    return compiled;
  }

  // Compiled from the frozen contract itself: Ajv reads the schema
  // without mutating it, so a defensive copy would only split the
  // compile cache key from the contract the runtime holds.
  const validate = ajv.compile(inputContract);

  // Tool dispatch is synchronous policy; an $async validator returns a
  // Promise where every caller expects a verdict, which would read as
  // "accepted" and detonate later as an unhandled rejection. Ajv types
  // compile() as synchronous even for $async schemas, so the runtime
  // marker is read through a cast the types omit.
  if ((validate as {readonly $async?: boolean}).$async === true) {
    throw new TypeError(
      'asynchronous schemas ($async) cannot gate tool dispatch',
    );
  }

  compiledContracts.set(contractKey, validate);
  return validate;
}

/**
 * The first failure, phrased for the model. Ajv reports every failure;
 * the model can only act on one at a time, and the order below is the
 * order a reader would notice them: a missing field before an unexpected
 * one, either before a value that is merely the wrong shape.
 *
 * A failed oneOf or anyOf speaks first, and alone. Its branch failures
 * describe alternatives rather than the input — an input mixing two
 * closed branches earns an "unsupported field" from each side — and Ajv
 * gives branch-local errors no stable marking to filter by once a
 * branch is a $ref. The one statement that is always true of the input
 * is the combinator's own: match one alternative.
 */
function modelToolInputRejectionDetails(options: {
  readonly toolName: string;
  readonly errors: readonly ErrorObject[];
}): string {
  const combinator = options.errors.find(
    error => error.keyword === 'oneOf' || error.keyword === 'anyOf',
  );

  if (combinator !== undefined) {
    return `${options.toolName} input field "${fieldPathFor(
      combinator.instancePath,
    )}" ${describeExpectation(combinator)}.`;
  }

  const missing = options.errors.find(error => error.keyword === 'required');

  if (missing !== undefined) {
    return `${options.toolName} input missing required field "${fieldPathFor(
      missing.instancePath,
      errorParamString(missing, 'missingProperty'),
    )}".`;
  }

  const unsupported = options.errors.filter(
    error => error.keyword === 'additionalProperties',
  );

  if (unsupported.length > 0) {
    return `${options.toolName} input includes unsupported fields: ${unsupported
      .map(error =>
        fieldPathFor(
          error.instancePath,
          errorParamString(error, 'additionalProperty'),
        ),
      )
      .join(', ')}.`;
  }

  const first = options.errors[0];

  if (first === undefined) {
    return `${options.toolName} input does not match its declared contract.`;
  }

  // An error raised while checking a property name carries the name; the
  // value path would point at the container and hide which key to fix.
  if (typeof first.propertyName === 'string') {
    return `${options.toolName} input property name "${first.propertyName}" ${describeExpectation(first)}.`;
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

  if (error.keyword === 'const') {
    const params: unknown = error.params;

    return isJsonRecord(params) && Object.hasOwn(params, 'allowedValue')
      ? `must be ${allowedValueText(params['allowedValue'])}`
      : 'must be the declared constant';
  }

  if (error.keyword === 'type') {
    return `must be ${expectedTypeNames(error).join(' or ')}`;
  }

  return error.message ?? 'is not valid';
}

function errorParamString(error: ErrorObject, key: string): string | undefined {
  const params: unknown = error.params;
  const value = isJsonRecord(params) ? params[key] : undefined;

  return typeof value === 'string' ? value : undefined;
}

function enumValues(error: ErrorObject): readonly string[] {
  const params: unknown = error.params;
  const allowed = isJsonRecord(params) ? params['allowedValues'] : undefined;

  return Array.isArray(allowed) ? allowed.map(allowedValueText) : [];
}

// An allowed value is named for the model's retry: strings read best
// bare, and anything structured is its JSON text — String() would
// collapse an object alternative to "[object Object]" and tell the
// model nothing.
function allowedValueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
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
 * Segments are JSON Pointer text, so `~1` and `~0` decode back to the
 * `/` and `~` the field was declared with. The root is `$` so a
 * whole-input failure still names something.
 */
function fieldPathFor(instancePath: string, property?: string): string {
  const segments = instancePath
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

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
