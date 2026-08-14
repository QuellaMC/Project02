import {createMemoryProviderRuntimePlugin} from '../../builtin/memory-provider/index.ts';
import {readRuntimePluginPackageDescriptor} from '../../api/package-descriptor.ts';
import type {RuntimePluginFactoryInput} from '../../api/factory.ts';
import type {RuntimePlugin, RuntimePluginManifest} from '../../api/types.ts';
import {
  createMem0PlatformBackend,
  createMem0ServerBackend,
  type Mem0Backend,
  type Mem0FetchFunction,
} from './backend.ts';
import {
  createMem0MemoryProvider,
  createMisconfiguredMem0Backend,
} from './provider.ts';

export {mem0PluginId} from './provider.ts';

const mem0PluginEntry = './index.ts';
const mem0PluginDescriptorUrl = new URL(
  './project02.plugin.json',
  import.meta.url,
);
const mem0DefaultUserId = 'project02-user';

export function createMem0PluginManifest(): RuntimePluginManifest {
  return readRuntimePluginPackageDescriptor({
    descriptorUrl: mem0PluginDescriptorUrl,
    expectedEntry: mem0PluginEntry,
  }).manifest;
}

export function createProject02Plugin(
  input: RuntimePluginFactoryInput,
): RuntimePlugin {
  return createMem0PluginFromInput(input);
}

export function createMem0PluginFromInput(
  input: RuntimePluginFactoryInput,
  transport: {readonly fetchFn?: Mem0FetchFunction} = {},
): RuntimePlugin {
  const provider = createMem0MemoryProvider({
    backend: configuredMem0Backend(input, transport),
    userId: configuredStringValue(input, 'userId') ?? mem0DefaultUserId,
    agentId: input.characterId ?? 'default',
  });

  return createMemoryProviderRuntimePlugin(provider, {
    manifest: input.manifest,
  });
}

function configuredMem0Backend(
  input: RuntimePluginFactoryInput,
  transport: {readonly fetchFn?: Mem0FetchFunction},
): Mem0Backend {
  const backendKind = configuredStringValue(input, 'backend') ?? 'platform';
  const apiKey = configuredStringValue(input, 'apiKey');
  const baseUrl = configuredStringValue(input, 'baseUrl');

  if (backendKind === 'server') {
    if (baseUrl === undefined) {
      return createMisconfiguredMem0Backend(
        'Mem0 server backend needs the baseUrl config field.',
      );
    }

    // Without this, "localhost:8765" reaches fetch as a bad URL and every
    // verb reports the backend unreachable, naming nothing the operator
    // can fix.
    if (!isAbsoluteHttpOrigin(baseUrl)) {
      return createMisconfiguredMem0Backend(invalidEndpointMessage('baseUrl'));
    }

    return createMem0ServerBackend({
      baseUrl,
      ...(apiKey === undefined ? {} : {apiKey}),
      ...(transport.fetchFn === undefined ? {} : {fetchFn: transport.fetchFn}),
    });
  }

  if (apiKey === undefined) {
    return createMisconfiguredMem0Backend(
      'Mem0 platform backend needs the apiKey config field (MEM0_API_KEY).',
    );
  }

  if (baseUrl !== undefined && !isAbsoluteHttpOrigin(baseUrl)) {
    return createMisconfiguredMem0Backend(invalidEndpointMessage('baseUrl'));
  }

  return createMem0PlatformBackend({
    apiKey,
    ...(baseUrl === undefined ? {} : {baseUrl}),
    ...(transport.fetchFn === undefined ? {} : {fetchFn: transport.fetchFn}),
  });
}

/**
 * Never echoes the value: a rejected endpoint can carry userinfo or a
 * token in its query, and this message travels through health into logs
 * and durable evidence. The field name is what the operator needs.
 */
function invalidEndpointMessage(fieldName: string): string {
  return `Mem0 ${fieldName} must be an absolute http:// or https:// origin with no embedded credentials, query, or fragment.`;
}

function isAbsoluteHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);

    // Endpoint paths are appended as text, so a query or fragment would
    // silently move where every request lands. URL userinfo is rejected
    // too: Node's fetch refuses such requests, which would surface as a
    // fake outage instead of the field to fix.
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function configuredStringValue(
  input: RuntimePluginFactoryInput,
  fieldName: string,
): string | undefined {
  const field = input.resolvedConfig[fieldName];

  if (
    field === undefined ||
    !field.resolved ||
    typeof field.value !== 'string'
  ) {
    return undefined;
  }

  const value = field.value.trim();

  return value.length === 0 ? undefined : value;
}
