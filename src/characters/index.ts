/** Cross-module imports of characters land here (arch:check rule 5). */
export {
  characterPackageDescriptorFileName,
  characterPackageDescriptorFormat,
  maxCharacterPersonaSectionLength,
  maxCharacterPersonaSections,
  maxCharacterPluginExpectations,
  parseCharacterPackageDescriptor,
  type CharacterDefinition,
  type CharacterMeta,
  type CharacterPackageDescriptorIssue,
  type CharacterPackageDescriptorParseResult,
  type CharacterPersona,
  type CharacterPluginExpectations,
} from './api/package-descriptor.ts';
export {
  bundledCharacterPackagesRoot,
  defaultCharacterPackageSources,
  discoverCharacterPackages,
  maxCharacterPackageDescriptorBytes,
  operatorCharacterPackagesRoot,
  type CharacterPackageDiagnostic,
  type CharacterPackageDiscovery,
  type CharacterPackageProvenance,
  type CharacterPackageSource,
  type DiscoveredCharacterPackage,
} from './loader/discovery.ts';
