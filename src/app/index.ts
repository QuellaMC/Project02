/**
 * Public API of src/app — the composition root. It wires runtime config,
 * plugin activation, and host construction together; nothing below it
 * (runtime, plugins, role-model, core, shared) may import it.
 */
export {
  createConfiguredProject02PluginHost,
  createConfiguredProject02PluginHostFromPlan,
  createRuntimePluginCatalogSnapshot,
  prepareConfiguredProject02PluginActivation,
  resolveRuntimePluginActivation,
  type PreparedProject02PluginActivationPlan,
  type Project02ConfiguredPluginActivation,
  type Project02ConfiguredPluginHost,
  type RuntimePluginActivationResult,
  type RuntimePluginActivationSnapshot,
  type RuntimePluginActivationStatus,
  type RuntimePluginCatalogSnapshot,
  type RuntimePluginFactoryDefinition,
} from './activation.ts';
export {resolveRuntimeCliStartup} from './startup.ts';
export {
  defaultProject02CharacterId,
  prepareProject02CharacterActivation,
  type Project02CharacterActivation,
} from './character.ts';
export {
  characterOverlaySeedDocument,
  enforceCharacterPluginExpectations,
  validateCharacterOverlaySeedAgainstManifests,
  type CharacterOverlaySeed,
} from './character-plugins.ts';
