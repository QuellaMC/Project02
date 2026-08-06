import type {RuntimePluginProvidedTool} from '../../api/types.ts';

export function memorySearchTool(name: string): RuntimePluginProvidedTool {
  return Object.freeze({
    name,
    description: 'Search configured memory for relevant context.',
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
    annotations: {readOnlyHint: false},
    concurrency: 'exclusive',
    requiresConfirmation: false,
  } satisfies RuntimePluginProvidedTool);
}
