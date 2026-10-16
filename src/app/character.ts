/** A broken package for another character warns instead of blocking. */
import {
  defaultCharacterPackageSources,
  discoverCharacterPackages,
  type CharacterDefinition,
  type CharacterPackageDiagnostic,
} from '../characters/index.ts';
import {selectCharacterId, type CharacterProfile} from '../core/index.ts';
import {
  bindProject02CharacterRuntimeLocation,
  readCharacterOverlayForScope,
  resolveLayeredProject02RuntimeConfig,
} from '../runtime/config/index.ts';
import type {RoleModelCharacterRef} from '../role-model/index.ts';
import {createCanonicalJsonFingerprint} from '../shared/canonical-json.ts';
import type {Project02Home} from './home.ts';

export type Project02CharacterListing = {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
};

/** The installed roster, plus the packages discovery could not publish. */
export type Project02CharacterRoster = {
  readonly characters: readonly Project02CharacterListing[];
  readonly diagnostics: readonly CharacterPackageDiagnostic[];
};

/** Installed characters with their effective enabled state. */
export function listProject02Characters(
  home: Project02Home,
): Project02CharacterRoster {
  const discovery = discoverCharacterPackages({
    sources: defaultCharacterPackageSources(home.runtimeLocation.homeRoot),
  });

  return Object.freeze({
    characters: Object.freeze(
      discovery.characters.map(character => {
        const identity = character.definition.identity;

        return Object.freeze({
          id: identity.id,
          displayName: identity.displayName,
          enabled: characterIsEnabled(home, identity.id),
        });
      }),
    ),
    diagnostics: discovery.diagnostics,
  });
}

function characterIsEnabled(home: Project02Home, characterId: string): boolean {
  try {
    const runtimeLocation = bindProject02CharacterRuntimeLocation({
      configLocation: home.runtimeLocation,
      characterId,
    });

    return resolveLayeredProject02RuntimeConfig({
      loadedConfig: home.loadedConfig,
      overlayConfig: readCharacterOverlayForScope(
        runtimeLocation.characterScope,
      ).overlay,
      runtimeLocation,
      // Only the host's own switch is read, and it belongs to no section.
      sections: {plugins: []},
    }).project02.enabled;
  } catch {
    // One character's damaged data directory must not take the roster
    // down; the damage speaks, in full, when that character is started.
    return true;
  }
}

/** The CLI-era default: no explicit character means the sole enabled one. */
export function selectSoleEnabledCharacterId(
  home: Project02Home,
): string | Extract<Project02CharacterActivation, {status: 'failed'}> {
  const {characters} = listProject02Characters(home);
  const [first] = characters;

  // An unloadable global config defaults every enabled value, so the rule
  // would misreport the config problem as ambiguity; any discovered
  // character routes the operator to activation's real diagnostic instead.
  if (
    first !== undefined &&
    home.loadedConfig.diagnostics.some(
      diagnostic => diagnostic.severity === 'error',
    )
  ) {
    return first.id;
  }

  const selection = selectCharacterId(characters);

  return selection.status === 'selected'
    ? selection.characterId
    : Object.freeze({
        status: 'failed' as const,
        configuredCharacterId: '',
        messages: Object.freeze([
          `${selection.message} (pass --character <id>)`,
        ]),
      });
}

export type Project02CharacterActivation =
  | {
      readonly status: 'resolved';
      readonly configuredCharacterId: string;
      readonly definition: CharacterDefinition;
      readonly profile: CharacterProfile;
      readonly personaSections: readonly string[];
      readonly characterRef: RoleModelCharacterRef;
      readonly warnings: readonly string[];
    }
  | {
      readonly status: 'failed';
      readonly configuredCharacterId: string;
      readonly messages: readonly string[];
    };

export function prepareProject02CharacterActivation(options: {
  readonly storeRoot?: string;
  readonly configuredCharacterId: string;
}): Project02CharacterActivation {
  const configuredCharacterId = options.configuredCharacterId;
  const discovery = discoverCharacterPackages({
    sources: defaultCharacterPackageSources(options.storeRoot),
  });
  const blocking = (diagnostic: CharacterPackageDiagnostic): boolean =>
    diagnosticConcernsCharacter(diagnostic, configuredCharacterId) ||
    diagnostic.code === 'package_source_unavailable';
  const blockingMessages = discovery.diagnostics
    .filter(blocking)
    .map(formatCharacterDiagnostic);
  const warnings = discovery.diagnostics
    .filter(diagnostic => !blocking(diagnostic))
    .map(formatCharacterDiagnostic);
  const match = discovery.characters.find(
    character => character.definition.identity.id === configuredCharacterId,
  );

  if (match === undefined || blockingMessages.length > 0) {
    const discoveredIds = discovery.characters.map(
      character => character.definition.identity.id,
    );

    return Object.freeze({
      status: 'failed',
      configuredCharacterId,
      messages: Object.freeze([
        ...blockingMessages,
        ...(match === undefined
          ? [
              `Character "${configuredCharacterId}" was not found. ` +
                `Discovered characters: ${
                  discoveredIds.length === 0
                    ? '(none)'
                    : discoveredIds.join(', ')
                }. Install the character package under the bundled or ` +
                'store characters root, or correct the configured character id.',
            ]
          : []),
      ]),
    });
  }

  return Object.freeze({
    status: 'resolved',
    configuredCharacterId,
    definition: match.definition,
    profile: match.definition.identity,
    personaSections: match.definition.persona.system,
    characterRef: Object.freeze({
      id: match.definition.identity.id,
      version: match.definition.meta.version,
      personaFingerprint: createCanonicalJsonFingerprint({
        persona: {system: [...match.definition.persona.system]},
      }),
    }),
    warnings: Object.freeze(warnings),
  });
}

/** A mismatched folder still declares the selected character's id. */
function diagnosticConcernsCharacter(
  diagnostic: CharacterPackageDiagnostic,
  characterId: string,
): boolean {
  return (
    diagnostic.characterId === characterId ||
    diagnostic.claimedCharacterId === characterId
  );
}

function formatCharacterDiagnostic(
  diagnostic: CharacterPackageDiagnostic,
): string {
  return `${diagnostic.message} (${diagnostic.code} at ${diagnostic.path})`;
}
