import type {RuntimePluginProvidedTool} from '../../api/types.ts';

export function memorySearchTool(name: string): RuntimePluginProvidedTool {
  return Object.freeze({
    name,
    description: 'Search your long-term memory for anything relevant.',
    inputContract: {
      type: 'object',
      properties: {
        query: {type: 'string', description: 'Search query.'},
      },
      required: ['query'],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    concurrency: 'shared',
    requiresConfirmation: false,
  } satisfies RuntimePluginProvidedTool);
}

export function memoryAddTool(name: string): RuntimePluginProvidedTool {
  return Object.freeze({
    name,
    description: 'Keep a short memory for later.',
    inputContract: {
      type: 'object',
      properties: {
        text: {type: 'string', description: 'Memory text.'},
      },
      required: ['text'],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    concurrency: 'exclusive',
    requiresConfirmation: false,
  } satisfies RuntimePluginProvidedTool);
}
