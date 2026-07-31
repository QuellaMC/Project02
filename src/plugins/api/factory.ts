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
  /**
   * Receives a fully constructed candidate when package acceptance rejects it.
   * The caller can then route the candidate through its ordinary lifecycle
   * cleanup without weakening the package loader's manifest boundary.
   */
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
