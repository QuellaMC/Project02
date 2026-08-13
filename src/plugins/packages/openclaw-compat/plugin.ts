import {
  createMemoryProviderRuntimePlugin,
  memoryProviderMaxTextLength,
} from '../../builtin/memory-provider/index.ts';
import {readRuntimePluginPackageDescriptor} from '../../api/package-descriptor.ts';
import {isRecord} from '../../api/validation-primitives.ts';
import {RuntimePluginConstructionError} from '../../api/construction-error.ts';
import type {RuntimePluginFactoryInput} from '../../api/factory.ts';
import type {RuntimePlugin, RuntimePluginManifest} from '../../api/types.ts';
import type {Project02MemoryProvider} from '../../builtin/memory-provider/index.ts';
import {
  assembledContextText,
  loadOpenClawContextEngine,
  type OpenClawContextEngineV1,
} from './engine.ts';

export const openClawCompatPluginId = 'openclaw-compat';

const openClawCompatPluginEntry = './index.ts';
const openClawCompatPluginDescriptorUrl = new URL(
  './project02.plugin.json',
  import.meta.url,
);
/**
 * What one recall item can actually carry downstream: bounding at 600
 * characters, the engine is told the truth about its budget instead of
 * selecting context this path would silently truncate.
 */
const openClawCompatAssembleTokenBudget = Math.floor(
  memoryProviderMaxTextLength / 4,
);

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
    throw new RuntimePluginConstructionError(
      'openclaw-compat needs the modulePath config field pointing at the plugin module.',
    );
  }

  const engineId = configuredStringValue(input, 'engineId');
  const engineConfig = configuredEngineConfig(input);
  const engine = await loadOpenClawContextEngine({
    modulePath,
    ...(engineId === undefined ? {} : {engineId}),
    engineConfig,
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
      const addition = assembledContextText({
        result: assembled,
        suppliedContents: [request.currentUserMessage.trim()],
      });

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
      await ingestMessage(engine, turn.sessionId, {
        role: 'user',
        content: turn.userMessage,
      });
      if (turn.characterMessage !== undefined) {
        await ingestMessage(engine, turn.sessionId, {
          role: 'assistant',
          content: turn.characterMessage,
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

/**
 * An engine reports a declined ingestion -- an authentication, quota, or
 * persistence rejection -- in its result, so a turn is only captured when
 * the engine says it took it.
 */
async function ingestMessage(
  engine: OpenClawContextEngineV1,
  sessionId: string,
  message: {readonly role: 'user' | 'assistant'; readonly content: string},
): Promise<void> {
  const result: unknown = await Promise.resolve(
    engine.ingest({sessionId, message, isHeartbeat: false}),
  );

  if (result === undefined || result === null) {
    return;
  }

  if (!isRecord(result) || result['ok'] === false) {
    throw new TypeError(
      'openclaw-compat engine declined the ingested message; the turn was not captured.',
    );
  }
}

/**
 * The credential arrives through a secret field so it lives in the
 * environment file, and reaches the engine on the one config argument its
 * factory already takes.
 */
function configuredEngineConfig(
  input: RuntimePluginFactoryInput,
): Readonly<Record<string, unknown>> {
  const value = input.resolvedConfig['engineConfig']?.value;
  const settings = isRecord(value) ? value : {};
  const apiKey = configuredStringValue(input, 'engineApiKey');

  return Object.freeze(
    apiKey === undefined ? {...settings} : {...settings, apiKey},
  );
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
