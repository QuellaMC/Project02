/**
 * Public contract surface of src/characters/api.
 */
export {
  characterPackageDescriptorFileName,
  characterPackageDescriptorFormat,
  maxCharacterPersonaSectionLength,
  maxCharacterPersonaSections,
  parseCharacterPackageDescriptor,
  type CharacterDefinition,
  type CharacterMeta,
  type CharacterPackageDescriptorIssue,
  type CharacterPackageDescriptorParseResult,
  type CharacterPersona,
} from './package-descriptor.ts';
