/**
 * The manifest gate for a tool's input contract. A contract is valid
 * when it is a JSON object schema that Ajv compiles — the same Ajv, in
 * the same configuration, that enforces the contract against every
 * proposed input. There is no keyword list of this module's own to
 * drift from what the engine actually supports.
 */
import {
  compileModelToolInputContract,
  type ModelToolInputContract,
} from '../../role-model/api/index.ts';
import {createJsonBoundaryObjectSnapshot} from '../../shared/json-boundary.ts';
import type {RuntimePluginValidationResult} from './types.ts';
import {accept, isRecord, reject} from './validation-primitives.ts';

export function requiredModelToolInputContract(
  value: unknown,
): RuntimePluginValidationResult<ModelToolInputContract> {
  if (!isRecord(value)) {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract must be a JSON Schema object.',
    );
  }

  // A tool takes named arguments, so its contract is always an object
  // schema — that root is what a provider renders. Everything below the
  // root means what JSON Schema says it means.
  if (value['type'] !== 'object') {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract must declare root type "object".',
    );
  }

  let contract: ModelToolInputContract;

  try {
    // The snapshot is the contract: deep-frozen, bounded, and known to
    // round-trip through the store as written. The cast states that a
    // JSON projection of an object schema is still that schema.
    contract = createJsonBoundaryObjectSnapshot(value, {
      field: 'Model tool inputContract',
    }) as ModelToolInputContract;
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return reject('malformed_tool_definition', error.message);
    }

    throw error;
  }

  const compilation = compileModelToolInputContract(contract);

  if (compilation.status === 'invalid') {
    return reject(
      'malformed_tool_definition',
      `Model tool inputContract is not valid JSON Schema: ${compilation.details}.`,
    );
  }

  return accept(contract);
}
