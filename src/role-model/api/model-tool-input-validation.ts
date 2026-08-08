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

// strictRequired is off: it rejects contracts the engine does enforce.
// ownProperties stops inherited prototype members satisfying a field.
// addUsedSchema is off so a contract $id cannot collide on recompile.
const ajv = new Ajv({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
  ownProperties: true,
  addUsedSchema: false,
});

// Content-keyed: the storage codec rebuilds the contract on every decode.
const compiledContracts = new Map<string, ValidateFunction>();

export type ModelToolInputContractCompilation =
  | {readonly status: 'compiled'}
  | {readonly status: 'invalid'; readonly details: string};

/** The gate's compile is cached, so it becomes the session's validator. */
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

  const validate = ajv.compile(inputContract);

  // An $async validator returns a Promise, which would read as accepted.
  // Ajv's compile() type omits $async, so the marker needs a cast.
  if ((validate as {readonly $async?: boolean}).$async === true) {
    throw new TypeError(
      'asynchronous schemas ($async) cannot gate tool dispatch',
    );
  }

  compiledContracts.set(contractKey, validate);
  return validate;
}

// A failed oneOf/anyOf speaks alone: its branch errors describe the
// alternatives, not the input, and a $ref branch cannot be filtered out.
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

  // A propertyName error's instancePath points at the container, not the key.
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

function allowedValueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function expectedTypeNames(error: ErrorObject): readonly string[] {
  const params: unknown = error.params;
  const expected = isJsonRecord(params) ? params['type'] : undefined;

  if (Array.isArray(expected)) {
    return expected.map(value => String(value));
  }

  return typeof expected === 'string' ? [expected] : ['valid'];
}

// Ajv instancePaths are JSON Pointers: ~1 and ~0 decode to / and ~.
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
