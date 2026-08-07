import type {RuntimePlugin, RuntimePluginManifest} from './types.ts';
import type {
  RedactedPluginRuntimeConfig,
  ResolvedPluginRuntimeConfig,
} from '../../runtime/config/index.ts';

export type RuntimePluginFactoryInput = {
  readonly pluginId: string;
  readonly manifest: RuntimePluginManifest;
  readonly storeRoot: string;
  readonly resolvedConfig: ResolvedPluginRuntimeConfig;
  readonly redactedConfig: RedactedPluginRuntimeConfig;
};

export type RuntimePluginFactoryFunction = (
  input: RuntimePluginFactoryInput,
) => Promise<RuntimePlugin> | RuntimePlugin;

export type RuntimePluginPackageLoadOptions = {
  /** A rejected candidate still exists, so the caller can tear it down. */
  readonly retainRejectedCandidate?: (plugin: RuntimePlugin) => void;
};

export type RuntimePluginPackageLoadFunction = (
  input: RuntimePluginFactoryInput,
  options?: RuntimePluginPackageLoadOptions,
) => Promise<RuntimePlugin>;

export type RuntimePluginFactoryCreate = (
  ...args: never[]
) => Promise<RuntimePlugin> | RuntimePlugin;

export type RuntimePluginFactoryDefinition<
  TCreate extends RuntimePluginFactoryCreate = RuntimePluginFactoryCreate,
> = {
  readonly manifest: RuntimePluginManifest;
  readonly create: TCreate;
};

export type RuntimePluginPackageCatalogEntry = {
  readonly catalogKind: 'package';
  readonly manifest: RuntimePluginManifest;
  readonly load: RuntimePluginPackageLoadFunction;
};
