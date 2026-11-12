/**
 * The dock above the message box, as rules of the tab's one value:
 * everything that waits for the person's answer, one at a time in one
 * spot — the one that expires first in front, up to two more as faint
 * edges behind it — and the moment an ask that ended in front keeps its
 * room to say how before the next takes the spot or the dock closes. Each
 * change is a pure function of the value and one input, as the store's
 * are: the stream's word on what waits and on her turn, and the moments
 * the page counts. Nothing here touches the DOM.
 */
import type {
  ConfigView,
  PairingRequest,
  PendingConfirmation,
} from '@project02/wire/contract';

/** What waits for the person's answer: a confirmation of hers, or someone new on a connector. */
export type Ask =
  | {readonly kind: 'confirmation'; readonly pending: PendingConfirmation}
  | {readonly kind: 'pairing'; readonly request: PairingRequest};

/** How an ask in front ended, as its card says it: Allowed, Not allowed, Expired. */
export type Answered = 'allowed' | 'not_allowed' | 'expired';

/**
 * The ask that was in front when it ended, keeping the spot to say how:
 * for half a second whatever else waits, and then, with nothing else
 * waiting, until her next line begins, her turn ends or the wait is over.
 */
export type Held = {
  readonly ask: Ask;
  readonly answered: Answered;
  /** Its half second is over and nothing else waited: it keeps the room for her. */
  readonly lingering: boolean;
};

/** Her settings as a page shows them. */
export type HerSettings = Extract<ConfigView, {status: 'ok'}>;

/** What the dock's rules read and change of the tab's value. */
export type Asking = {
  /** Every confirmation still waiting, whatever surface raised it. */
  readonly confirmations: readonly PendingConfirmation[];
  /** Every pairing request waiting for the person's answer, whatever connector asked. */
  readonly pairings: readonly PairingRequest[];
  /** The ask that was in front when it ended, keeping the spot a moment to say how. */
  readonly held?: Held | undefined;
  /** Character id → her settings as read for an ask of hers to change one: their words say the change. */
  readonly herSettings: ReadonlyMap<string, HerSettings>;
};

/** The card in the spot, and how it ended once it has. */
export type Front = {readonly ask: Ask; readonly answered?: Answered};

export function confirmationKey(id: string): string {
  return `confirmation:${id}`;
}

export function pairingKey(code: string): string {
  return `pairing:${code}`;
}

/** An ask's own key among everything that waits, whichever kind it is. */
export function askKey(ask: Ask): string {
  return ask.kind === 'confirmation'
    ? confirmationKey(ask.pending.id)
    : pairingKey(ask.request.code);
}

/** When an ask expires, in milliseconds since the Unix epoch. */
export function expiryOf(ask: Ask): number {
  return ask.kind === 'confirmation'
    ? ask.pending.deadlineAt
    : ask.request.expiresAt;
}

/** Everything waiting for the person's answer, the one that expires first first. */
export function waitingAsks(state: Asking): readonly Ask[] {
  return [
    ...state.confirmations.map(pending => ({
      kind: 'confirmation' as const,
      pending,
    })),
    ...state.pairings.map(request => ({kind: 'pairing' as const, request})),
  ].toSorted((one, other) => expiryOf(one) - expiryOf(other));
}

/** The card in the spot: one that ended while it keeps the room to say so, else what expires first. */
export function frontOf(state: Asking): Front | undefined {
  if (state.held !== undefined) {
    return {ask: state.held.ask, answered: state.held.answered};
  }

  const first = waitingAsks(state)[0];

  return first === undefined ? undefined : {ask: first};
}

/**
 * The faint edges behind the card in front, one for each more that waits,
 * two at most. While an answered card shows, the next is behind it
 * unseen, so the stack keeps its edges when the next takes the spot.
 */
export function edgesOf(state: Asking): number {
  return Math.min(2, Math.max(0, waitingAsks(state).length - 1));
}

/** The characters with an ask of hers waiting: her row in the roster says she asks. */
export function askersOf(state: Asking): ReadonlySet<string> {
  return new Set(state.confirmations.map(pending => pending.characterId));
}

/**
 * An ask ended as `answered` says, given the value before it leaves what
 * waits: in front, it keeps the spot to say so; behind, it just leaves the
 * stack. One that ended in a way no card says — cancelled when she
 * stopped, or one the daemon no longer knows — simply leaves, and the
 * next takes its place at once.
 */
export function askEnded<State extends Asking>(
  state: State,
  key: string,
  answered: Answered,
): State {
  const front = frontOf(state);

  return front === undefined ||
    front.answered !== undefined ||
    askKey(front.ask) !== key
    ? state
    : {...state, held: {ask: front.ask, answered, lingering: false}};
}

/**
 * A new ask, given the value before it joins: one that comes while an
 * answered card keeps the room and nothing else waits takes the spot at
 * once. With others waiting, the first of them is next, half a second
 * after the answer, as ever.
 */
export function askArrived<State extends Asking>(state: State): State {
  return state.held !== undefined && waitingAsks(state).length === 0
    ? withoutHeld(state)
    : state;
}

/**
 * Half a second after the ask with `key` ended in front: the next that
 * waits takes the spot, or, with nothing waiting, the answered card keeps
 * its room for her a while.
 */
export function dockStepped<State extends Asking>(
  state: State,
  key: string,
): State {
  const {held} = state;

  if (held === undefined || held.lingering || askKey(held.ask) !== key) {
    return state;
  }

  return waitingAsks(state).length > 0
    ? withoutHeld(state)
    : {...state, held: {...held, lingering: true}};
}

/** The wait is over: the answered card with `key` gives up its room, and the dock closes. */
export function dockWaited<State extends Asking>(
  state: State,
  key: string,
): State {
  const {held} = state;

  return held?.lingering === true && askKey(held.ask) === key
    ? withoutHeld(state)
    : state;
}

/**
 * She went on: her next line began, or her turn ended. An answered ask of
 * hers gives up its room then, so the dock closes as her line makes its
 * own, unless something else waits for the spot.
 */
export function sheWentOn<State extends Asking>(
  state: State,
  characterId: string,
): State {
  const {held} = state;

  return held?.ask.kind === 'confirmation' &&
    held.ask.pending.characterId === characterId &&
    waitingAsks(state).length === 0
    ? withoutHeld(state)
    : state;
}

/** Nothing can be answered any more: no card keeps the room. */
export function dockCleared<State extends Asking>(state: State): State {
  return state.held === undefined ? state : withoutHeld(state);
}

/**
 * Her settings as read for an ask of hers to change one: the card says
 * the change in their words. A view the daemon refused says nothing new,
 * and the card keeps the preview's own.
 */
export function herSettingsRead<State extends Asking>(
  state: State,
  characterId: string,
  view: ConfigView,
): State {
  return view.status !== 'ok' || state.herSettings.get(characterId) === view
    ? state
    : {
        ...state,
        herSettings: new Map(state.herSettings).set(characterId, view),
      };
}

function withoutHeld<State extends Asking>(state: State): State {
  return {...state, held: undefined};
}
