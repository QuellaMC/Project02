/**
 * The windows of hers the chat opens beside it, her phone's and her
 * world's, as the chat knows them: whose each one shows, as that window
 * last said, and which characters the daemon last said have what each
 * shows, so that their chat has a button for it; and the frame the page
 * draws for a window of hers that has none of its own. Pure, as the
 * store is, so its rules are tested in Node.
 */
import type {PhoneOutcome, WorldOutcome} from '@project02/wire/contract';

/** A window of hers the chat opens beside it: her phone's, or her world's. */
export type HerWindow = 'phone' | 'world';

/** Each window of hers, in the order her chat's head draws their buttons. */
export const herWindows: readonly HerWindow[] = ['world', 'phone'];

/**
 * A window of hers that has no frame of its own, which the page draws:
 * whether it stays on top of other windows. A window with a frame of its
 * own, as a browser's popup, has none.
 */
export type Frame = {readonly pinned: boolean};

/** What the chat knows of the windows of hers. */
export type HerWindows = {
  /** Whose phone or world each window shows, as it last said; none once it said it went. */
  readonly windowShows: ReadonlyMap<HerWindow, string>;
  /** For each window, the characters the daemon last said have what it shows. */
  readonly windowsHad: ReadonlyMap<HerWindow, ReadonlySet<string>>;
};

export const noWindows: HerWindows = {
  windowShows: new Map(),
  windowsHad: new Map(),
};

/** Whether her chat has a button for `herWindow`: the daemon said she has what it shows. */
export function hasWindow(
  state: HerWindows,
  herWindow: HerWindow,
  characterId: string,
): boolean {
  return state.windowsHad.get(herWindow)?.has(characterId) === true;
}

/** A window of hers says it shows her phone, or her world: her chat's button for it is pressed. */
export function windowShows<State extends HerWindows>(
  state: State,
  herWindow: HerWindow,
  characterId: string,
): State {
  return state.windowShows.get(herWindow) === characterId
    ? state
    : {
        ...state,
        windowShows: new Map(state.windowShows).set(herWindow, characterId),
      };
}

/**
 * A window of hers says what it showed went from it. A window taken over
 * for another character may say so before it says the one it had went:
 * only what it last said it shows can go.
 */
export function windowGone<State extends HerWindows>(
  state: State,
  herWindow: HerWindow,
  characterId: string,
): State {
  if (state.windowShows.get(herWindow) !== characterId) {
    return state;
  }

  const shows = new Map(state.windowShows);

  shows.delete(herWindow);

  return {...state, windowShows: shows};
}

/**
 * What the daemon answered when her phone or her world was read: a refusal
 * says she has none, since she has none to show or it does not know her,
 * and any other answer that she has one.
 */
export function windowAnswered<State extends HerWindows>(
  state: State,
  herWindow: HerWindow,
  characterId: string,
  outcome: PhoneOutcome | WorldOutcome,
): State {
  const had = state.windowsHad.get(herWindow) ?? new Set<string>();
  const has = outcome.status !== 'refused';

  if (had.has(characterId) === has) {
    return state;
  }

  const now = new Set(had);

  if (has) {
    now.add(characterId);
  } else {
    now.delete(characterId);
  }

  return {...state, windowsHad: new Map(state.windowsHad).set(herWindow, now)};
}

/** A window of hers has no frame of its own and stays on top of others, or not: the page draws its frame. */
export function framed<State extends {readonly frame?: Frame | undefined}>(
  state: State,
  pinned: boolean,
): State {
  return state.frame?.pinned === pinned ? state : {...state, frame: {pinned}};
}
