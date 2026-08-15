import {join} from 'node:path';

import {createMemoryProviderRuntimePlugin} from '../../builtin/memory-provider/index.ts';
import {readRuntimePluginPackageDescriptor} from '../../api/package-descriptor.ts';
import type {RuntimePluginFactoryInput} from '../../api/factory.ts';
import type {RuntimePlugin, RuntimePluginManifest} from '../../api/types.ts';
import {
  createDefaultMem0OssEngineLoader,
  createMem0OssBackend,
  createMem0PlatformBackend,
  createMem0ServerBackend,
  type Mem0Backend,
  type Mem0FetchFunction,
  type Mem0OssEngineLoader,
  mem0OssOpenAiEndpoint,
  type Mem0OssSettings,
} from './backend.ts';
import {
  createMem0MemoryProvider,
  createMisconfiguredMem0Backend,
  mem0PluginId,
} from './provider.ts';

export {mem0PluginId} from './provider.ts';

const mem0PluginEntry = './index.ts';
const mem0PluginDescriptorUrl = new URL(
  './project02.plugin.json',
  import.meta.url,
);
const mem0DefaultUserId = 'project02-user';

export type Mem0PluginTransport = {
  readonly fetchFn?: Mem0FetchFunction;
  readonly ossEngineLoader?: Mem0OssEngineLoader;
};

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
  transport: Mem0PluginTransport = {},
): RuntimePlugin {
  const provider = createMem0MemoryProvider({
    backend: configuredMem0Backend(input, transport),
    userId: configuredStringValue(input, 'userId') ?? mem0DefaultUserId,
    agentId: input.characterId ?? 'default',
    userName: input.userDisplayName ?? 'You',
  });

  return createMemoryProviderRuntimePlugin(provider, {
    manifest: input.manifest,
  });
}

function configuredMem0Backend(
  input: RuntimePluginFactoryInput,
  transport: Mem0PluginTransport,
): Mem0Backend {
  const backendKind = configuredStringValue(input, 'backend') ?? 'platform';
  const apiKey = configuredStringValue(input, 'apiKey');
  const baseUrl = configuredStringValue(input, 'baseUrl');

  if (backendKind === 'oss') {
    const settings = mem0OssSettingsFromInput(input);

    if (settings.status === 'rejected') {
      return createMisconfiguredMem0Backend(settings.message);
    }

    return createMem0OssBackend({
      loadEngine:
        transport.ossEngineLoader ??
        createDefaultMem0OssEngineLoader(settings.value),
    });
  }

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

/**
 * Two spellings of one endpoint are one endpoint: comparing raw strings
 * would withhold the inherited key over a trailing slash and leave the
 * embedder authenticating with nothing.
 */
function sameEndpoint(first: string, second: string): boolean {
  try {
    const left = new URL(first);
    const right = new URL(second);

    return (
      left.origin === right.origin &&
      left.pathname.replace(/\/+$/u, '') === right.pathname.replace(/\/+$/u, '')
    );
  } catch {
    return first === second;
  }
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

type Mem0OssSettingsResolution =
  | {readonly status: 'resolved'; readonly value: Mem0OssSettings}
  | {readonly status: 'rejected'; readonly message: string};

/**
 * Everything speaks the OpenAI wire format, so the surface is endpoints,
 * optional keys, and model names. Every rule below runs on the effective
 * endpoints -- an unset field resolved to the OpenAI cloud -- so a
 * spelled-out default behaves exactly like the default: the embedder
 * reuses the extraction endpoint and key unless given its own, and the
 * cloud is the one endpoint that requires a key.
 */
export function mem0OssSettingsFromInput(
  input: RuntimePluginFactoryInput,
): Mem0OssSettingsResolution {
  const configuredLlmBaseUrl = configuredStringValue(input, 'ossLlmBaseUrl');
  const configuredEmbedderBaseUrl = configuredStringValue(
    input,
    'ossEmbedderBaseUrl',
  );

  // Same rule as the REST endpoints: a schemeless spelling would fail
  // inside the SDK on first use, naming nothing the operator can fix.
  for (const [field, value] of [
    ['ossLlmBaseUrl', configuredLlmBaseUrl],
    ['ossEmbedderBaseUrl', configuredEmbedderBaseUrl],
  ] as const) {
    if (value !== undefined && !isAbsoluteHttpOrigin(value)) {
      return {
        status: 'rejected',
        message: invalidEndpointMessage(field),
      };
    }
  }

  const llmApiKey = configuredStringValue(input, 'ossLlmApiKey');
  const llmBaseUrl = configuredLlmBaseUrl ?? mem0OssOpenAiEndpoint;
  const embedderBaseUrl = configuredEmbedderBaseUrl ?? llmBaseUrl;
  // The key travels with its endpoint: inheriting it while the embedder
  // points somewhere else would hand the extraction credential to a
  // different service.
  const embedderApiKey =
    configuredStringValue(input, 'ossEmbedderApiKey') ??
    (sameEndpoint(embedderBaseUrl, llmBaseUrl) ? llmApiKey : undefined);

  if (
    sameEndpoint(llmBaseUrl, mem0OssOpenAiEndpoint) &&
    llmApiKey === undefined
  ) {
    return {
      status: 'rejected',
      message:
        'Mem0 OSS extraction needs the ossLlmApiKey config field (MEM0_OSS_LLM_API_KEY), or an ossLlmBaseUrl pointing at an OpenAI-compatible server such as LM Studio or Ollama.',
    };
  }

  if (
    sameEndpoint(embedderBaseUrl, mem0OssOpenAiEndpoint) &&
    embedderApiKey === undefined
  ) {
    return {
      status: 'rejected',
      message:
        'Mem0 OSS embedding at the OpenAI endpoint needs the ossEmbedderApiKey config field (MEM0_OSS_EMBEDDER_API_KEY).',
    };
  }

  const llmModel = configuredStringValue(input, 'ossLlmModel');
  const embedderModel = configuredStringValue(input, 'ossEmbedderModel');
  const embedderDims = configuredEmbedderDims(input);

  if (embedderDims === 'invalid') {
    return {
      status: 'rejected',
      message:
        'Mem0 OSS ossEmbedderDims must be a positive whole number matching the embedding model width.',
    };
  }

  return {
    status: 'resolved',
    value: {
      ...(llmModel === undefined ? {} : {llmModel}),
      ...(llmApiKey === undefined ? {} : {llmApiKey}),
      llmBaseUrl,
      ...(embedderModel === undefined ? {} : {embedderModel}),
      ...(embedderApiKey === undefined ? {} : {embedderApiKey}),
      embedderBaseUrl,
      ...(embedderDims === undefined ? {} : {embedderDims}),
      // Mirrors characterPluginDataDirPath; the layout helper lives in
      // runtime storage, which packages cannot import without a cycle.
      storageDir: join(input.storeRoot, 'plugin-data', mem0PluginId, 'oss'),
    },
  };
}

/**
 * A width that cannot describe a vector is a configuration error, not a
 * reason to fall back to a default that mismatches at the first search,
 * so an authored-but-unusable value is distinguished from an absent one.
 */
function configuredEmbedderDims(
  input: RuntimePluginFactoryInput,
): number | undefined | 'invalid' {
  const field = input.resolvedConfig['ossEmbedderDims'];

  if (field === undefined || !field.resolved || field.value === undefined) {
    return undefined;
  }

  const value = field.value;

  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : 'invalid';
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
