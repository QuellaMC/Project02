import type {RuntimePluginFactoryFunction} from '../api/factory.ts';
import {
  characterStatePluginId,
  sessionHistoryPluginId,
} from '../api/contract.ts';
import {createProject02Plugin as createCharacterStatePlugin} from '../packages/character-state/index.ts';
import {createProject02Plugin as createDemoConfigPlugin} from '../packages/demo-config/index.ts';
import {demoConfigPluginId} from '../packages/demo-config/plugin.ts';
import {createProject02Plugin as createSessionHistoryPackagePlugin} from '../packages/session-history/index.ts';

const bundledRuntimePluginFactories = new Map<
  string,
  Readonly<{
    entryRelativePath: string;
    factory: RuntimePluginFactoryFunction;
  }>
>([
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
