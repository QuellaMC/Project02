/** The same Ajv that enforces a contract is the one that accepts it here. */
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

  // A tool takes named arguments, so the root a provider renders is an object.
  if (value['type'] !== 'object') {
    return reject(
      'malformed_tool_definition',
      'Model tool inputContract must declare root type "object".',
    );
  }

  let contract: ModelToolInputContract;

  try {
    // The cast: a JSON projection of an object schema is still that schema.
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
