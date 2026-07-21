import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

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

/**
 * Writes an operator character package under `<storeRoot>/characters/<id>`
 * so e2e tests can exercise discovery, selection, and persona rendering
 * end to end.
 */
export function writeTestCharacterPackage(
  storeRoot: string,
  options: {
    readonly id: string;
    readonly displayName: string;
    readonly personaSections?: readonly string[];
    readonly version?: string;
  },
): void {
  const packageRoot = join(storeRoot, 'characters', options.id);

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'project02.character.json'),
    `${JSON.stringify(
      {
        format: 'project02.character.v1',
        identity: {id: options.id, displayName: options.displayName},
        persona: {
          system: options.personaSections ?? [
            `You are ${options.displayName}.`,
          ],
        },
        meta: {version: options.version ?? '1.0.0'},
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
