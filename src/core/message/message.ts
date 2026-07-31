export type CharacterProfile = {
  readonly id: string;
  readonly displayName: string;
};

// Shared shape for any transcript speaker identity (the character or the
// local user): stable id plus a display name that is a per-message
// historical fact once committed.
export type SpeakerIdentity = {
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

export function freezeCharacterProfile(
  character: CharacterProfile,
): CharacterProfile {
  return Object.freeze({
    id: character.id,
    displayName: character.displayName,
  } satisfies CharacterProfile);
}
