import type {RuntimePlugin, RuntimePluginManifest} from './types.ts';
import type {
  RedactedRuntimeSectionConfig,
  ResolvedRuntimeSectionConfig,
} from '../../runtime/config/index.ts';

export type RuntimePluginFactoryInput = {
  readonly pluginId: string;
  readonly manifest: RuntimePluginManifest;
  readonly storeRoot: string;
  /** Resolved character scope; absent only for direct factory callers. */
  readonly characterId?: string;
  /** Resolved user display name; absent only for direct factory callers. */
  readonly userDisplayName?: string;
  readonly resolvedConfig: ResolvedRuntimeSectionConfig;
  readonly redactedConfig: RedactedRuntimeSectionConfig;
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

export type RuntimePluginFactoryDefinition = {
  readonly manifest: RuntimePluginManifest;
  readonly create: RuntimePluginFactoryFunction;
};

export type RuntimePluginPackageCatalogEntry = {
  readonly catalogKind: 'package';
  readonly manifest: RuntimePluginManifest;
  readonly load: RuntimePluginPackageLoadFunction;
};
