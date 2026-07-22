/**
 * Public API of src/characters.
 *
 * Cross-module imports of characters must land here (arch:check rule 5).
 * Character packages are data-only; this module owns the descriptor
 * contract, discovery, and the bundled default packages. It imports only
 * core and shared (arch:check characters-is-data-only).
 */
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
} from './api/index.ts';
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
