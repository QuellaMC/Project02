import {
  freezeCharacterProfile,
  type CharacterProfile,
} from '../../src/core/index.ts';

/**
 * Shared test character matching the runtime's built-in default ("mira").
 * Tests pass it explicitly wherever a session, decision context, or plugin
 * context needs a character, so no test relies on an implicit default; a
 * later slice makes the character a required input everywhere.
 */
export const testCharacterProfile: CharacterProfile = freezeCharacterProfile({
  id: 'mira',
  displayName: 'Mira',
});
