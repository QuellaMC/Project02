/**
 * Public API of the runtime plugin package loader. Cross-module imports
 * land here (arch:check rule 5); loader-internal files may import
 * deeper.
 */
export {
  bundledRuntimePluginPackageRoot,
  maxRuntimePluginPackageMetadataBytes,
  runtimePluginPackageDescriptorFormat,
  type DiscoveredRuntimePluginPackage,
  type RuntimePluginPackageDiagnostic,
  type RuntimePluginPackageDiscovery,
  type RuntimePluginPackageProvenance,
  type RuntimePluginPackageSource,
} from './contract.ts';
export {discoverRuntimePluginPackages} from './discovery.ts';
