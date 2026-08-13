import {createMemoryProviderRuntimePlugin} from '../../builtin/memory-provider/index.ts';
import {readRuntimePluginPackageDescriptor} from '../../api/package-descriptor.ts';
import {RuntimePluginConstructionError} from '../../api/construction-error.ts';
import type {RuntimePluginFactoryInput} from '../../api/factory.ts';
import type {RuntimePlugin, RuntimePluginManifest} from '../../api/types.ts';
import {
  hermesCompatPluginId,
  loadHermesMemoryProviderModule,
  wrapHermesMemoryProvider,
} from './foreign.ts';

export {hermesCompatPluginId} from './foreign.ts';

const hermesCompatPluginEntry = './index.ts';
const hermesCompatPluginDescriptorUrl = new URL(
  './project02.plugin.json',
  import.meta.url,
);

export function createHermesCompatPluginManifest(): RuntimePluginManifest {
  return readRuntimePluginPackageDescriptor({
    descriptorUrl: hermesCompatPluginDescriptorUrl,
    expectedEntry: hermesCompatPluginEntry,
  }).manifest;
}

export async function createProject02Plugin(
  input: RuntimePluginFactoryInput,
): Promise<RuntimePlugin> {
  const modulePath = configuredStringValue(input, 'modulePath');

  if (modulePath === undefined) {
    throw new RuntimePluginConstructionError(
      'hermes-compat needs the modulePath config field pointing at the provider module.',
    );
  }

  const foreign = await loadHermesMemoryProviderModule({
    modulePath,
    storeRoot: input.storeRoot,
  });

  return createMemoryProviderRuntimePlugin(wrapHermesMemoryProvider(foreign), {
    manifest: input.manifest,
    toolNamespace: hermesCompatPluginId,
  });
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
