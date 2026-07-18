import type {RuntimePluginProvidedTool} from '../../api/types.ts';

export function memorySearchTool(name: string): RuntimePluginProvidedTool {
  return Object.freeze({
    name,
    description: 'Search configured memory for relevant context.',
    requiredForUserTurn: false,
    callLimit: {
      scope: 'user_turn',
      maxCalls: 2,
    },
    inputContract: {
      type: 'object',
      fields: [
        {
          name: 'query',
          description: 'Search query.',
          required: true,
          valueType: 'string',
        },
      ],
      additionalFields: false,
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'runtime_read',
    requiresConfirmation: false,
    sourceReferencesRequired: true,
  } satisfies RuntimePluginProvidedTool);
}

export function memoryAddTool(name: string): RuntimePluginProvidedTool {
  return Object.freeze({
    name,
    description: 'Add a bounded memory item.',
    requiredForUserTurn: false,
    callLimit: {
      scope: 'user_turn',
      maxCalls: 1,
    },
    inputContract: {
      type: 'object',
      fields: [
        {
          name: 'text',
          description: 'Memory text.',
          required: true,
          valueType: 'string',
        },
      ],
      additionalFields: false,
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'local_memory_write',
    requiresConfirmation: false,
    sourceReferencesRequired: true,
  } satisfies RuntimePluginProvidedTool);
}
