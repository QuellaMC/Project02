import type {
  RuntimePlugin,
  RuntimePluginManifest
} from './plugin-types.ts';
import type {
  RedactedPluginRuntimeConfig,
  ResolvedPluginRuntimeConfig
} from '../runtime/config/types.ts';

export type RuntimePluginFactoryInput = {
  readonly pluginId: string;
  readonly manifest: RuntimePluginManifest;
  readonly storeRoot: string;
  readonly resolvedConfig: ResolvedPluginRuntimeConfig;
  readonly redactedConfig: RedactedPluginRuntimeConfig;
};

export type RuntimePluginFactoryFunction = (
  input: RuntimePluginFactoryInput
) => Promise<RuntimePlugin> | RuntimePlugin;

export type RuntimePluginFactoryCreate = (
  ...args: never[]
) => Promise<RuntimePlugin> | RuntimePlugin;

export type RuntimePluginFactoryDefinition<
  TCreate extends RuntimePluginFactoryCreate = RuntimePluginFactoryCreate
> = {
  readonly manifest: RuntimePluginManifest;
  readonly create: TCreate;
};

export type RuntimePluginPackageCatalogEntry = {
  readonly catalogKind: 'package';
  readonly manifest: RuntimePluginManifest;
  readonly load: RuntimePluginFactoryFunction;
};
