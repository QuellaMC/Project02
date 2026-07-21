/**
 * Composition-root character activation: resolves the runtime's one
 * character definition from the discovered character packages, selected
 * by the project02.character config field (default: the bundled
 * character). Diagnostics that concern other characters do not block
 * activation — they surface as warnings so a broken unrelated operator
 * package cannot take the runtime down.
 */
import {
  defaultCharacterPackageSources,
  discoverCharacterPackages,
  type CharacterDefinition,
  type CharacterPackageDiagnostic,
} from '../characters/index.ts';
import type {CharacterProfile} from '../core/index.ts';
import {defaultProject02CharacterId} from '../runtime/config/index.ts';
import type {RoleModelCharacterRef} from '../role-model/index.ts';
import {createCanonicalJsonFingerprint} from '../shared/canonical-json.ts';

export {defaultProject02CharacterId};

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

export function prepareProject02CharacterActivation(
  options: {
    readonly storeRoot?: string;
    readonly configuredCharacterId?: string;
  } = {},
): Project02CharacterActivation {
  const configuredCharacterId =
    options.configuredCharacterId ?? defaultProject02CharacterId;
  const discovery = discoverCharacterPackages({
    sources: defaultCharacterPackageSources(options.storeRoot),
  });
  const blockingMessages = discovery.diagnostics
    .filter(
      diagnostic =>
        diagnostic.characterId === configuredCharacterId ||
        diagnostic.code === 'package_source_unavailable',
    )
    .map(formatCharacterDiagnostic);
  const warnings = discovery.diagnostics
    .filter(
      diagnostic =>
        diagnostic.characterId !== configuredCharacterId &&
        diagnostic.code !== 'package_source_unavailable',
    )
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

function formatCharacterDiagnostic(
  diagnostic: CharacterPackageDiagnostic,
): string {
  return `${diagnostic.message} (${diagnostic.code} at ${diagnostic.path})`;
}
