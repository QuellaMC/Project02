import type {RuntimePluginFactoryFunction} from '../api/factory.ts';
import {
  characterMemoryPluginId,
  characterStatePluginId,
  sessionHistoryPluginId,
} from '../api/contract.ts';
import {createProject02Plugin as createCharacterMemoryPackagePlugin} from '../packages/character-memory/index.ts';
import {createProject02Plugin as createCharacterStatePlugin} from '../packages/character-state/index.ts';
import {createProject02Plugin as createDemoConfigPlugin} from '../packages/demo-config/index.ts';
import {demoConfigPluginId} from '../packages/demo-config/plugin.ts';
import {createProject02Plugin as createSessionHistoryPackagePlugin} from '../packages/session-history/index.ts';
import {createProject02Plugin as createMem0PackagePlugin} from '../packages/mem0/index.ts';
import {mem0PluginId} from '../packages/mem0/plugin.ts';

const bundledRuntimePluginFactories = new Map<
  string,
  Readonly<{
    entryRelativePath: string;
    factory: RuntimePluginFactoryFunction;
  }>
>([
  [
    characterMemoryPluginId,
    Object.freeze({
      entryRelativePath: 'index.ts',
      factory: createCharacterMemoryPackagePlugin,
    }),
  ],
  [
    characterStatePluginId,
    Object.freeze({
      entryRelativePath: 'index.ts',
      factory: createCharacterStatePlugin,
    }),
  ],
  [
    demoConfigPluginId,
    Object.freeze({
      entryRelativePath: 'index.ts',
      factory: createDemoConfigPlugin,
    }),
  ],
  [
    sessionHistoryPluginId,
    Object.freeze({
      entryRelativePath: 'index.ts',
      factory: createSessionHistoryPackagePlugin,
    }),
  ],
  [
    mem0PluginId,
    Object.freeze({
      entryRelativePath: 'index.ts',
      factory: createMem0PackagePlugin,
    }),
  ],
]);

/** Bundled factories must stay in the host module graph, so they are static. */
export function bundledRuntimePluginFactory(options: {
  readonly pluginId: string;
  readonly entryRelativePath: string;
}): RuntimePluginFactoryFunction | undefined {
  const binding = bundledRuntimePluginFactories.get(options.pluginId);

  return binding?.entryRelativePath === options.entryRelativePath
    ? binding.factory
    : undefined;
}
