/**
 * Which character a person talks to when they did not say. One rule for
 * every surface, so the daemon's own startup and a terminal agree.
 */
export type CharacterSelection =
  | {readonly status: 'selected'; readonly characterId: string}
  | {readonly status: 'failed'; readonly message: string};

/**
 * An explicit id wins (whoever starts the character validates it);
 * otherwise exactly one enabled character is the character to talk to.
 */
export function selectCharacterId(
  characters: readonly {readonly id: string; readonly enabled: boolean}[],
  explicitCharacterId?: string,
): CharacterSelection {
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
