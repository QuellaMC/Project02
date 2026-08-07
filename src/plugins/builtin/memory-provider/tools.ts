import type {RuntimePluginProvidedTool} from '../../api/types.ts';

export function memorySearchTool(name: string): RuntimePluginProvidedTool {
  return Object.freeze({
    name,
    description: 'Search configured memory for relevant context.',
    inputContract: {
      type: 'object',
      properties: {
        query: {type: 'string', description: 'Search query.'},
      },
      required: ['query'],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    annotations: {readOnlyHint: true},
    concurrency: 'shared',
    requiresConfirmation: false,
  } satisfies RuntimePluginProvidedTool);
}

export function memoryAddTool(name: string): RuntimePluginProvidedTool {
  return Object.freeze({
    name,
    description: 'Add a bounded memory item.',
    inputContract: {
      type: 'object',
      properties: {
        text: {type: 'string', description: 'Memory text.'},
      },
      required: ['text'],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    annotations: {readOnlyHint: false},
    concurrency: 'exclusive',
    requiresConfirmation: false,
  } satisfies RuntimePluginProvidedTool);
}
