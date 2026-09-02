/** A broken package for another character warns instead of blocking. */
import {
  defaultCharacterPackageSources,
  discoverCharacterPackages,
  type CharacterDefinition,
  type CharacterPackageDiagnostic,
} from '../characters/index.ts';
import type {CharacterProfile} from '../core/index.ts';
import {
  bindProject02CharacterRuntimeLocation,
  createLayeredProject02RuntimeConfigSnapshot,
  readCharacterOverlayForScope,
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
    const {overlay} = readCharacterOverlayForScope(
      bindProject02CharacterRuntimeLocation({
        configLocation: home.runtimeLocation,
        characterId,
      }).characterScope,
    );

    return (
      createLayeredProject02RuntimeConfigSnapshot({
        loadedConfig: home.loadedConfig,
        overlayConfig: overlay,
      }).effective.config?.project02?.enabled ?? true
    );
  } catch {
    // One character's damaged data directory must not take the roster
    // down; the damage speaks, in full, when that character is started.
    return true;
  }
}

export type Project02CharacterSelection =
  | {readonly status: 'selected'; readonly characterId: string}
  | {readonly status: 'failed'; readonly message: string};

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

  const selection = selectProject02CharacterId(characters);

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

/**
 * The one selection rule: an explicit id wins (activation validates it);
 * otherwise exactly one enabled character is the character to talk to.
 */
export function selectProject02CharacterId(
  characters: readonly {readonly id: string; readonly enabled: boolean}[],
  explicitCharacterId?: string,
): Project02CharacterSelection {
  if (explicitCharacterId !== undefined) {
    return Object.freeze({
      status: 'selected',
      characterId: explicitCharacterId.trim(),
    });
  }

  const enabled = characters.filter(character => character.enabled);
  const [sole] = enabled;

  if (sole !== undefined && enabled.length === 1) {
    return Object.freeze({status: 'selected', characterId: sole.id});
  }

  return Object.freeze({
    status: 'failed',
    message:
      enabled.length === 0
        ? 'No enabled character. Install a character package, or set ' +
          'project02.enabled to true for an installed one — a global ' +
          'project02.enabled of false disables them all.'
        : 'Several characters are enabled: ' +
          `${enabled.map(character => character.id).join(', ')}. ` +
          'Pick one explicitly.',
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
