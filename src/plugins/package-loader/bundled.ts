import type {RuntimePluginFactoryFunction} from '../api/factory.ts';
import {characterStatePluginId} from '../api/contract.ts';
import {createProject02Plugin as createCharacterStatePlugin} from '../packages/character-state/index.ts';
import {createProject02Plugin as createDemoConfigPlugin} from '../packages/demo-config/index.ts';
import {demoConfigPluginId} from '../packages/demo-config/plugin.ts';

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
]);

/**
 * Bundled packages are part of the host executable, so their factories must
 * stay in the host module graph. Filesystem discovery authenticates the
 * bundled root and validates its descriptor; this registry binds that
 * captured descriptor to the factory compiled into the same executable.
 */
export function bundledRuntimePluginFactory(options: {
  readonly pluginId: string;
  readonly entryRelativePath: string;
}): RuntimePluginFactoryFunction | undefined {
  const binding = bundledRuntimePluginFactories.get(options.pluginId);

  return binding?.entryRelativePath === options.entryRelativePath
    ? binding.factory
    : undefined;
}
