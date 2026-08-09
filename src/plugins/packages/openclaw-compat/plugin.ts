import {createMemoryProviderRuntimePlugin} from '../../builtin/memory-provider/index.ts';
import {readRuntimePluginPackageDescriptor} from '../../api/package-descriptor.ts';
import type {RuntimePluginFactoryInput} from '../../api/factory.ts';
import type {RuntimePlugin, RuntimePluginManifest} from '../../api/types.ts';
import type {Project02MemoryProvider} from '../../builtin/memory-provider/index.ts';
import {
  assembledSystemPromptAddition,
  loadOpenClawContextEngine,
  type OpenClawContextEngineV1,
} from './engine.ts';

export const openClawCompatPluginId = 'openclaw-compat';

const openClawCompatPluginEntry = './index.ts';
const openClawCompatPluginDescriptorUrl = new URL(
  './project02.plugin.json',
  import.meta.url,
);
const openClawCompatAssembleTokenBudget = 512;

export function createOpenClawCompatPluginManifest(): RuntimePluginManifest {
  return readRuntimePluginPackageDescriptor({
    descriptorUrl: openClawCompatPluginDescriptorUrl,
    expectedEntry: openClawCompatPluginEntry,
  }).manifest;
}

export async function createProject02Plugin(
  input: RuntimePluginFactoryInput,
): Promise<RuntimePlugin> {
  const modulePath = configuredStringValue(input, 'modulePath');

  if (modulePath === undefined) {
    throw new TypeError(
      'openclaw-compat needs the modulePath config field pointing at the plugin module.',
    );
  }

  const engineId = configuredStringValue(input, 'engineId');
  const engine = await loadOpenClawContextEngine({
    modulePath,
    ...(engineId === undefined ? {} : {engineId}),
    storeRoot: input.storeRoot,
  });

  return createMemoryProviderRuntimePlugin(
    createOpenClawCompatProvider(engine),
    {manifest: input.manifest},
  );
}

/**
 * The current context-engine surface has no row-backed search or add
 * verbs, so this provider is recall plus capture only: assemble's
 * system-prompt addition becomes the one recall item, and turns are
 * ingested for the engine to use on later assemblies.
 */
function createOpenClawCompatProvider(
  engine: OpenClawContextEngineV1,
): Project02MemoryProvider {
  return {
    id: openClawCompatPluginId,
    displayName: 'OpenClaw Context Engine Compat',
    async recall(request) {
      const assembled: unknown = await engine.assemble({
        sessionId: request.sessionId,
        sessionKey: request.sessionId,
        messages: [{role: 'user', content: request.currentUserMessage}],
        tokenBudget: openClawCompatAssembleTokenBudget,
        availableTools: [],
        citationsMode: 'off',
      });
      const addition = assembledSystemPromptAddition(assembled);

      if (addition === undefined) {
        return {items: []};
      }

      return {
        items: [
          {
            id: 'engine-brief',
            text: addition,
            sourceReferences: [
              {
                kind: 'external_contract',
                id: `${engine.info.id}.assemble`,
                title: 'Context engine assembly',
              },
            ],
          },
        ],
      };
    },
    async captureTurn(turn) {
      await engine.ingest({
        sessionId: turn.sessionId,
        message: {role: 'user', content: turn.userMessage},
        isHeartbeat: false,
      });
      if (turn.characterMessage !== undefined) {
        await engine.ingest({
          sessionId: turn.sessionId,
          message: {role: 'assistant', content: turn.characterMessage},
          isHeartbeat: false,
        });
      }

      return {
        captured: true,
        summary: 'Ingested turn into the context engine.',
        sourceReferences: [
          {
            kind: 'external_contract',
            id: `${engine.info.id}.ingest`,
            title: 'Context engine ingestion',
          },
        ],
      };
    },
    async close() {
      await engine.dispose?.();
    },
  };
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
