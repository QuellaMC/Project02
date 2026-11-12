/**
 * Everything her phone's window shows, as one value, and every change to
 * it as a pure function of the previous value and one input: the daemon's
 * health, a read of her phone, a read of a view the person opened, the
 * person looking around, the stream's coming and going and what it says of
 * confirmations, what the window it is drawn in says of itself. Her
 * phone's session applies them and React reads the value; a reducer that
 * changes nothing returns the value it was given. Nothing here touches the
 * DOM or reads a clock, so the window's rules are tested in Node.
 */
import type {
  GatewayEvent,
  GatewayHealth,
  GatewayReady,
  LiveReading,
  PendingConfirmation,
  PhoneApp,
  PhoneDid,
  PhoneFront,
  PhoneOutcome,
  PhoneRing,
  Screen,
  ScreenOutcome,
  ScreenRow,
} from '@project02/wire/contract';
import {installAskOf} from './ask-words.ts';
import type {Connection} from './store.ts';

/** Her phone as a read gave it. */
export type HerPhone = Extract<PhoneOutcome, {status: 'ok'}>;

/** One view of an app, which the person opens while looking around. */
export type ViewLook = {
  readonly kind: 'view';
  readonly appId: string;
  readonly viewId: string;
};

/** What the person can open while looking around: her home screen, or a view of an app. */
export type Look = {readonly kind: 'home'} | ViewLook;

/**
 * What the window shows: what she has in front, or what the person opened
 * while looking around, a view with its screen once read or the sentence
 * saying why it cannot be shown.
 */
export type Shows =
  | {readonly kind: 'hers'}
  | {readonly kind: 'home'}
  | {
      readonly kind: 'view';
      readonly appId: string;
      readonly viewId: string;
      readonly screen?: Screen;
      readonly message?: string;
    };

/** A view as her phone's screen draws it: its screen, or the sentence saying why there is none. */
type ShownView = {
  readonly appId: string;
  readonly viewId: string;
  readonly screen?: Screen | undefined;
  readonly message?: string | undefined;
};

export type PhoneState = {
  /** Whose phone the window shows: the address names her. */
  readonly characterId: string;
  readonly connection: Connection;
  /** Her name as the daemon's health lists her; none while it does not. */
  readonly name?: string | undefined;
  /** Her phone as last read. */
  readonly phone?: HerPhone;
  readonly shows: Shows;
  /**
   * The rows of the view she has in front that the read before did not
   * hold, when what she did is new: each is marked New until the next read.
   */
  readonly fresh: ReadonlySet<string>;
  /** Why her phone could not be read, in a sentence; gone once it is. */
  readonly unread?: string | undefined;
  /**
   * Her asks to install an app that wait for the person, by the id of the
   * confirmation that asks: the app's id in the App Store. The stream says
   * them, and the daemon keeps none.
   */
  readonly asks: ReadonlyMap<string, string>;
  /**
   * The window her phone is drawn in, when it has no frame of its own and
   * the page draws one: whether it stays on top of other windows. None in
   * a window with a frame of its own, as a browser's popup.
   */
  readonly frame?: {readonly pinned: boolean};
};

/** What her phone's screen draws now. */
export type OnScreen =
  /** Nothing read yet. */
  | {readonly kind: 'blank'}
  | {readonly kind: 'ringing'; readonly ring: PhoneRing}
  | {readonly kind: 'home'; readonly apps: readonly PhoneApp[]}
  | {
      readonly kind: 'view';
      readonly app: PhoneApp;
      readonly viewId: string;
      readonly screen?: Screen | undefined;
      readonly message?: string | undefined;
      readonly fresh: ReadonlySet<string>;
      /** The apps she waits on the person to install, by their ids, which a row or a header of that id says. */
      readonly waiting: ReadonlySet<string>;
    };

/** The line under her phone, lit while what it says is under a minute old. */
export type Line = {
  readonly what: string;
  readonly when?: string;
  readonly lit: boolean;
};

const hers: Shows = {kind: 'hers'};
const noRows: ReadonlySet<string> = new Set();
const noAsks: ReadonlyMap<string, string> = new Map();

export function initialPhoneState(characterId: string): PhoneState {
  return {
    characterId,
    connection: {status: 'connecting'},
    shows: hers,
    fresh: noRows,
    asks: noAsks,
  };
}

/**
 * Every `ready`: the stream is live, health says who she is, and what she
 * asked to install and waits on the person for is what the confirmations
 * waiting now say.
 */
export function phoneReady(
  state: PhoneState,
  snapshot: GatewayReady,
): PhoneState {
  return snapshot.confirmations.reduce(
    askRaised,
    healthSaid(
      {...state, connection: {status: 'live'}, asks: noAsks},
      snapshot.health,
    ),
  );
}

/**
 * A confirmation raised: when it is her ask to install an app, that app's
 * row and page in the store say she waits on the person until it is
 * settled. Another character asks for her own phone, not this one.
 */
export function askRaised(
  state: PhoneState,
  pending: PendingConfirmation,
): PhoneState {
  const app =
    pending.characterId === state.characterId
      ? installAskOf(pending.request.preview)?.app.id
      : undefined;

  return app === undefined || state.asks.get(pending.id) === app
    ? state
    : {...state, asks: new Map(state.asks).set(pending.id, app)};
}

/** A confirmation settled, approved, denied or cancelled: an ask of hers it was waits no more. */
export function askSettled(
  state: PhoneState,
  settled: Extract<GatewayEvent, {kind: 'confirmation_settled'}>,
): PhoneState {
  if (!state.asks.has(settled.id)) {
    return state;
  }

  const asks = new Map(state.asks);

  asks.delete(settled.id);

  return {...state, asks};
}

/** Who she is as the daemon's health says it now: her name, while it lists her. */
export function healthSaid(
  state: PhoneState,
  health: GatewayHealth,
): PhoneState {
  const name = health.characters.find(
    character => character.id === state.characterId,
  )?.displayName;

  return name === state.name ? state : {...state, name};
}

/** The address will never work again: the window says why, in place of her phone. */
export function phoneRefused(state: PhoneState, message: string): PhoneState {
  return {...state, connection: {status: 'refused', message}};
}

/** The window her phone is drawn in has no frame of its own and stays on top of others, or not: the page draws its frame. */
export function framed(state: PhoneState, pinned: boolean): PhoneState {
  return state.frame?.pinned === pinned ? state : {...state, frame: {pinned}};
}

/**
 * A read of her phone. The window follows her: the next thing she does —
 * a read in which what she did, what she has in front or what rings is
 * not what it was — takes it back from wherever the person was looking.
 * When what she did is new, the rows of the view she has in front that
 * the read before did not hold are fresh until the next read. A read that
 * did not give her phone says why, in place of it.
 */
export function phoneRead(
  state: PhoneState,
  outcome: PhoneOutcome,
): PhoneState {
  if (outcome.status !== 'ok') {
    return {...state, unread: outcome.message};
  }

  const before = state.phone;
  const acted = before === undefined || !sameDid(before.did, outcome.did);
  const moved =
    acted ||
    !sameFront(before.front, outcome.front) ||
    !sameRings(before.ringing, outcome.ringing);

  return {
    ...state,
    phone: outcome,
    unread: undefined,
    shows: moved ? hers : state.shows,
    fresh:
      before !== undefined && acted
        ? freshRows(before.front, outcome.front)
        : noRows,
  };
}

/**
 * The person opened an app on a view, switched to another of its views,
 * or went to her home screen: the window shows that until she does
 * something. Opening what it shows already leaves it as it is. Nothing of
 * hers changes.
 */
export function looked(state: PhoneState, look: Look): PhoneState {
  const now = underneath(state);
  const same =
    look.kind === 'view'
      ? now.kind === 'view' &&
        now.appId === look.appId &&
        now.viewId === look.viewId
      : now.kind === 'home';

  return same ? state : {...state, shows: look};
}

/**
 * The screen of a view the person opened, or the sentence saying why it
 * cannot be shown; an answer for a view the window no longer shows is let
 * go.
 */
export function screenRead(
  state: PhoneState,
  look: ViewLook,
  outcome: ScreenOutcome,
): PhoneState {
  const {shows} = state;

  if (
    shows.kind !== 'view' ||
    shows.appId !== look.appId ||
    shows.viewId !== look.viewId
  ) {
    return state;
  }

  const {appId, viewId} = look;

  return {
    ...state,
    shows:
      outcome.status === 'ok'
        ? {kind: 'view', appId, viewId, screen: outcome.screen}
        : {kind: 'view', appId, viewId, message: outcome.message},
  };
}

/**
 * What her phone's screen draws now: over everything, the soonest of what
 * rings; else what the window shows, her home screen when that is an app
 * no longer on her phone, and on a view, the apps she waits on the person
 * to install.
 */
export function screenOf(state: PhoneState): OnScreen {
  const {phone, shows} = state;

  if (phone === undefined) {
    return {kind: 'blank'};
  }

  const ring = soonest(phone.ringing);

  if (ring !== undefined) {
    return {kind: 'ringing', ring};
  }

  const waiting = new Set(state.asks.values());

  if (shows.kind === 'hers') {
    return phone.front === undefined
      ? {kind: 'home', apps: phone.apps}
      : viewOn(phone, phone.front, state.fresh, waiting);
  }

  return shows.kind === 'home'
    ? {kind: 'home', apps: phone.apps}
    : viewOn(phone, shows, noRows, waiting);
}

/**
 * The line under her phone at the moment `now`: that the window is
 * connecting, that her phone is ringing, or what she last did and how
 * long ago, or that she has nothing open; none while her phone is not
 * shown.
 */
export function lineOf(state: PhoneState, now: number): Line | undefined {
  const {connection, phone} = state;

  if (connection.status === 'connecting') {
    return {what: 'Connecting…', lit: false};
  }

  if (
    connection.status === 'refused' ||
    state.unread !== undefined ||
    phone === undefined
  ) {
    return undefined;
  }

  if (phone.ringing.length > 0) {
    return {what: 'Her phone is ringing', when: 'now', lit: true};
  }

  if (phone.did === undefined) {
    return {what: 'Nothing open', lit: false};
  }

  const since = now - Date.parse(phone.did.at);

  return {what: phone.did.words, when: ago(since), lit: since < 60_000};
}

/** How long ago something was, given the milliseconds since: now, just now, 2 min ago, 3 hr ago, 2 days ago. */
export function ago(since: number): string {
  const minutes = Math.floor(since / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (since < 10_000) {
    return 'now';
  }

  if (minutes < 1) {
    return 'just now';
  }

  if (hours < 1) {
    return `${String(minutes)} min ago`;
  }

  if (days < 1) {
    return `${String(hours)} hr ago`;
  }

  return days === 1 ? '1 day ago' : `${String(days)} days ago`;
}

/**
 * A reading that moves, at the moment `now`: its text as a stopwatch or a
 * timer shows it, and, counting down, the share of its whole still left.
 */
export function liveAt(
  live: LiveReading,
  now: number,
): {readonly text: string; readonly share?: number} {
  if (live.counts === 'up') {
    return {text: stopwatchText(Math.max(now - live.from, 0))};
  }

  const left = Math.max(live.to - now, 0);

  return {
    text: timerText(left),
    share: live.of > 0 ? Math.min(left / live.of, 1) : 0,
  };
}

/** A clock reading as her phone draws it: its digits, and a day period after them apart, as 7:00 and AM. */
export function clockParts(time: string): {
  readonly digits: string;
  readonly period?: string;
} {
  const [, digits, period] =
    /^(.*\d)\s*([A-Za-z][A-Za-z.]*)$/u.exec(time) ?? [];

  return digits === undefined || period === undefined
    ? {digits: time}
    : {digits, period};
}

/** A row by its own id, or by everything it shows when it has none. */
export function rowKey(row: ScreenRow): string {
  return row.id ?? JSON.stringify(row);
}

/** What the window shows under any ring: what she has in front, or what the person opened. */
function underneath(state: PhoneState): Look {
  const {shows} = state;

  if (shows.kind !== 'hers') {
    return shows;
  }

  const front = state.phone?.front;

  return front === undefined
    ? {kind: 'home'}
    : {kind: 'view', appId: front.appId, viewId: front.viewId};
}

/** A view of one of her apps; her home screen when the app is not on her phone. */
function viewOn(
  phone: HerPhone,
  view: ShownView,
  fresh: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
): OnScreen {
  const app = phone.apps.find(candidate => candidate.id === view.appId);

  return app === undefined
    ? {kind: 'home', apps: phone.apps}
    : {
        kind: 'view',
        app,
        viewId: view.viewId,
        screen: view.screen,
        message: view.message,
        fresh,
        waiting,
      };
}

/**
 * The rows of `after` that `before` did not hold, when both are the same
 * page of the same view: another page, as the App Store's page of an app
 * is to its list, holds rows of its own, none of them new.
 */
function freshRows(
  before: PhoneFront | undefined,
  after: PhoneFront | undefined,
): ReadonlySet<string> {
  if (
    before?.screen === undefined ||
    after?.screen === undefined ||
    !sameFront(before, after) ||
    before.screen.page !== after.screen.page
  ) {
    return noRows;
  }

  const held = new Set(rowsOf(before.screen).map(rowKey));

  return new Set(
    rowsOf(after.screen)
      .map(rowKey)
      .filter(key => !held.has(key)),
  );
}

function rowsOf(screen: Screen): readonly ScreenRow[] {
  return screen.items.flatMap(item => (item.kind === 'list' ? item.rows : []));
}

/** The ring set for the soonest moment, of all that ring. */
function soonest(ringing: readonly PhoneRing[]): PhoneRing | undefined {
  return ringing.reduce<PhoneRing | undefined>(
    (first, ring) => (first === undefined || ring.at < first.at ? ring : first),
    undefined,
  );
}

function sameDid(
  one: PhoneDid | undefined,
  other: PhoneDid | undefined,
): boolean {
  return one === undefined || other === undefined
    ? one === other
    : one.appId === other.appId &&
        one.words === other.words &&
        one.at === other.at;
}

function sameFront(
  one: PhoneFront | undefined,
  other: PhoneFront | undefined,
): boolean {
  return one === undefined || other === undefined
    ? one === other
    : one.appId === other.appId && one.viewId === other.viewId;
}

/** The same rings, in the same order: the daemon writes a ring the same way each time. */
function sameRings(
  one: readonly PhoneRing[],
  other: readonly PhoneRing[],
): boolean {
  return JSON.stringify(one) === JSON.stringify(other);
}

/** Time on a stopwatch: minutes, seconds and hundredths, 00:12.34, with its hours ahead once it has them. */
function stopwatchText(milliseconds: number): string {
  const hundredths = Math.floor(milliseconds / 10);
  const hours = Math.floor(hundredths / 360_000);
  const time = `${pad(Math.floor(hundredths / 6000) % 60)}:${pad(Math.floor(hundredths / 100) % 60)}.${pad(hundredths % 100)}`;

  return hours > 0 ? `${String(hours)}:${time}` : time;
}

/** Time left on a timer, 5:00 or 1:30:00, part of a second shown as a whole one. */
function timerText(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;

  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${String(minutes)}:${pad(seconds % 60)}`;
}

function pad(count: number): string {
  return String(count).padStart(2, '0');
}
