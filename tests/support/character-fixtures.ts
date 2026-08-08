import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  freezeCharacterProfile,
  type CharacterProfile,
} from '../../src/core/index.ts';

export const testCharacterProfile: CharacterProfile = freezeCharacterProfile({
  id: 'mira',
  displayName: 'Mira',
});

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
