/**
 * Public contract surface of src/characters/api.
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
} from './package-descriptor.ts';
