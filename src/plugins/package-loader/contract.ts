import {fileURLToPath} from 'node:url';

import type {RuntimePluginPackageCatalogEntry} from '../api/factory.ts';

export const bundledRuntimePluginPackageRoot = fileURLToPath(
  new URL('../packages/', import.meta.url),
);

export type RuntimePluginPackageProvenance = 'bundled' | 'operator';

export type RuntimePluginPackageSource = {
  readonly root: string;
};

export type RuntimePluginPackageDiagnostic = {
  readonly severity: 'error';
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly provenance: RuntimePluginPackageProvenance;
  readonly pluginId?: string;
  readonly claimedPluginId?: string;
};

export type DiscoveredRuntimePluginPackage =
  RuntimePluginPackageCatalogEntry & {
    readonly provenance: RuntimePluginPackageProvenance;
  };

export type RuntimePluginPackageDiscovery = {
  readonly packages: readonly DiscoveredRuntimePluginPackage[];
  readonly diagnostics: readonly RuntimePluginPackageDiagnostic[];
};
