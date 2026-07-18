/**
 * Public API of the runtime plugin package loader. Cross-module imports
 * land here (arch:check rule 5); loader-internal files may import
 * deeper.
 */
export {
  bundledRuntimePluginPackageRoot,
  maxRuntimePluginPackageMetadataBytes,
  type DiscoveredRuntimePluginPackage,
  type RuntimePluginPackageDiagnostic,
  type RuntimePluginPackageDiscovery,
  type RuntimePluginPackageProvenance,
  type RuntimePluginPackageSource,
} from './contract.ts';
export {runtimePluginPackageDescriptorFormat} from '../api/package-descriptor.ts';
export {discoverRuntimePluginPackages} from './discovery.ts';
