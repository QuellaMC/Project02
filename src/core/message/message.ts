export type CharacterProfile = {
  readonly id: string;
  readonly displayName: string;
};

export const visibleMessageRoleValues = ['user', 'character'] as const;

export type VisibleMessageRole = (typeof visibleMessageRoleValues)[number];

export type VisibleMessage = {
  readonly id: string;
  readonly role: VisibleMessageRole;
  readonly speakerId: string;
  readonly speakerName: string;
  readonly text: string;
};

export function freezeCharacterProfile(character: CharacterProfile): CharacterProfile {
  return Object.freeze({
    id: character.id,
    displayName: character.displayName
  } satisfies CharacterProfile);
}

// Documented domain default (migration plan keep-decision): the local
// deployment persona referenced by durable-evidence validation.
export const localCharacterProfile: CharacterProfile = freezeCharacterProfile({
  id: 'mira',
  displayName: 'Mira'
});
