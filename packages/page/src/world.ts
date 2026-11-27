/**
 * Everything her world's window shows, as one value, and every change to
 * it as a pure function of the previous value and one input: a read of her
 * world, the stream's coming and going, the person going from view to
 * view, opening a thing's card or the sheet for leaving something and
 * typing there, what the daemon answered when they left or removed a
 * thing, and what the window it is drawn in says of itself. And what each
 * view holds, worked out from her world as read and the viewer's clock.
 * Her world's session applies the changes and React reads the value; a
 * reducer that changes nothing returns the value it was given. Nothing
 * here touches the DOM or reads a clock, so the window's rules are tested
 * in Node.
 */
import type {
  GatewayEvent,
  LeaveThingBody,
  LeaveThingOutcome,
  RemoveThingOutcome,
  WorldDeed,
  WorldEntry,
  WorldHand,
  WorldOutcome,
  WorldPlace,
  WorldThing,
} from '@project02/wire/contract';
import type {Frame} from './her-windows.ts';
import type {Connection} from './store.ts';
import {whenOf, writer, type Clock} from './thread-layout.ts';

/** Her world as a read gave it. */
export type HerWorld = Extract<WorldOutcome, {status: 'ok'}>;

/** Where the person is in the window: one of its three tabs, or a place they opened. */
export type Shows =
  | {readonly kind: 'now' | 'places' | 'journal'}
  | {readonly kind: 'place'; readonly placeId: string};

/** What the person writes in the sheet for leaving something. */
export type Draft = {
  readonly name: string;
  /** One of her world's kinds, by its id. */
  readonly kind: string;
  /** The place it is left in, by its id. */
  readonly place: string;
  readonly note: string;
};

/**
 * A sheet over the window: a thing's card, whose removal was asked for
 * once while it is `confirming`, or the sheet for leaving something. While
 * what it asks of the daemon is on its way it is `sending`; what the daemon
 * refused, or why it failed, is its `problem` until the person changes
 * something there.
 */
export type Sheet = (
  | {
      readonly kind: 'thing';
      readonly thingId: string;
      readonly confirming: boolean;
    }
  | {readonly kind: 'leave'; readonly draft: Draft}
) & {readonly sending: boolean; readonly problem?: string | undefined};

export type WorldState = {
  /** Whose world the window shows: the address names her. */
  readonly characterId: string;
  readonly connection: Connection;
  /** Her world as last read. */
  readonly world?: HerWorld;
  /** Why her world could not be read, in the daemon's sentence; gone once it is. */
  readonly unread?: string | undefined;
  /** The window her world is drawn in, when it has no frame of its own and the page draws one. */
  readonly frame?: Frame;
  readonly shows: Shows;
  readonly sheet?: Sheet | undefined;
};

/** Whose deed a line is, or whom a thing is from, and the name the window gives them: the person, You; the world itself, by its name; or a character, by hers. */
export type Who =
  | {readonly kind: 'person' | 'world'; readonly name: string}
  | {readonly kind: 'character'; readonly id: string; readonly name: string};

/** A line of the journal as the window says it: who, what happened, the name it was written with, and when. */
export type Line = {
  readonly who: Who;
  readonly what: string;
  readonly name: string;
  readonly when: string;
};

/** A character living there, by her name, and since when. */
export type Living = {
  readonly id: string;
  readonly name: string;
  readonly since: string;
};

/** What Now shows: each place somebody is in, with who is there, the first things around them and how many more; the things the person left that nobody living there has seen; and the newest lines of the journal. */
export type Now = {
  readonly here: readonly {
    readonly place: WorldPlace;
    readonly living: readonly Living[];
    readonly around: readonly WorldThing[];
    readonly more: number;
  }[];
  readonly waiting: readonly WorldThing[];
  readonly lately: readonly Line[];
};

/** A place as Places shows it: who is there, its first things, how many more, and whether something there is new. */
export type PlaceCard = {
  readonly place: WorldPlace;
  readonly living: readonly Living[];
  readonly peek: readonly WorldThing[];
  readonly more: number;
  readonly fresh: boolean;
};

/** A day of the journal: its word, and its lines, newest first, each with its time. */
export type Day = {readonly day: string; readonly lines: readonly Line[]};

/** A thing's card: the thing, where it is, and its facts, a label and a value each. */
export type ThingCard = {
  readonly thing: WorldThing;
  readonly place: WorldPlace;
  readonly facts: readonly {readonly label: string; readonly value: string}[];
};

/** How many lines of the journal Now shows. */
const lately = 4;

/** How many things of a place Places names. */
const peeked = 2;

/** How many things around her Now names: a place's page lists them all. */
const aroundHer = 6;

const deeds: Readonly<Record<WorldDeed, string>> = {
  went: 'Went to',
  made: 'Made',
  used: 'Used',
  left: 'Left',
  removed: 'Removed',
};

export function initialWorldState(characterId: string): WorldState {
  return {
    characterId,
    connection: {status: 'connecting'},
    shows: {kind: 'now'},
  };
}

/** Every `ready`: the stream is live. */
export function worldReady(state: WorldState): WorldState {
  return state.connection.status === 'live'
    ? state
    : {...state, connection: {status: 'live'}};
}

/** The address will never work again: the window says why, in place of her world. */
export function worldRefused(state: WorldState, message: string): WorldState {
  return {...state, connection: {status: 'refused', message}};
}

/**
 * A read of her world: it shows what the read gave, and a thing's card
 * goes once the thing is no longer there. A read that did not give her
 * world says why, in its place, until one does.
 */
export function worldRead(
  state: WorldState,
  outcome: WorldOutcome,
): WorldState {
  if (outcome.status !== 'ok') {
    return {...state, unread: outcome.message};
  }

  const {sheet} = state;
  const gone =
    sheet?.kind === 'thing' && thingOf(outcome, sheet.thingId) === undefined;

  return {
    ...state,
    world: outcome,
    unread: undefined,
    sheet: gone ? undefined : sheet,
  };
}

/**
 * Whether what the stream says calls for her world to be read again: it
 * changed, or a turn of a character who lives there began or ended, since
 * that is when she is told what is around her, which is what makes a thing
 * seen, and nothing says so. Before the window knows her world, any world's
 * change might be hers.
 */
export function readsAgain(state: WorldState, event: GatewayEvent): boolean {
  switch (event.kind) {
    case 'world_changed':
      return state.world === undefined || state.world.id === event.world;
    case 'turn_running':
    case 'turn_completed':
      return (
        event.characterId === state.characterId ||
        state.world?.characters.some(her => her.id === event.characterId) ===
          true
      );
    default:
      return false;
  }
}

/** The person goes to a tab, or a place: a sheet open closes. */
export function looked(state: WorldState, shows: Shows): WorldState {
  return state.sheet === undefined && sameShows(state.shows, shows)
    ? state
    : {...state, shows, sheet: undefined};
}

/** The person opens a thing's card. */
export function thingOpened(state: WorldState, thingId: string): WorldState {
  return {
    ...state,
    sheet: {kind: 'thing', thingId, confirming: false, sending: false},
  };
}

/**
 * The person opens the sheet for leaving something: nothing typed, the
 * world's first kind chosen, in the place they are looking at, else where
 * she is.
 */
export function leaveOpened(state: WorldState): WorldState {
  const {world, shows} = state;

  if (world === undefined) {
    return state;
  }

  const place =
    shows.kind === 'place'
      ? shows.placeId
      : (world.characters.find(her => her.id === state.characterId)?.place ??
        world.places[0]?.id ??
        '');

  return {
    ...state,
    sheet: {
      kind: 'leave',
      draft: {name: '', kind: world.kinds[0]?.id ?? '', place, note: ''},
      sending: false,
    },
  };
}

export function sheetClosed(state: WorldState): WorldState {
  return state.sheet === undefined ? state : {...state, sheet: undefined};
}

/** The person types or chooses in the sheet for leaving something: what the daemon last said of it goes. */
export function drafted(state: WorldState, change: Partial<Draft>): WorldState {
  const {sheet} = state;

  return sheet?.kind === 'leave'
    ? {
        ...state,
        sheet: {
          ...sheet,
          draft: {...sheet.draft, ...change},
          problem: undefined,
        },
      }
    : state;
}

/** What the sheet would leave: none while it names nothing, or while what it sent is on its way. */
export function toLeave(sheet: Sheet | undefined): LeaveThingBody | undefined {
  if (
    sheet?.kind !== 'leave' ||
    sheet.sending ||
    sheet.draft.name.trim() === ''
  ) {
    return undefined;
  }

  const {name, kind, place, note} = sheet.draft;

  return note.trim() === '' ? {name, kind, place} : {name, kind, place, note};
}

/** The person presses Remove once: the card asks again, in place. */
export function removeAsked(state: WorldState): WorldState {
  const {sheet} = state;

  return sheet?.kind === 'thing' && !sheet.confirming
    ? {...state, sheet: {...sheet, confirming: true, problem: undefined}}
    : state;
}

/** The person keeps the thing after all: the card is as it was. */
export function removeKept(state: WorldState): WorldState {
  const {sheet} = state;

  return sheet?.kind === 'thing' && sheet.confirming && !sheet.sending
    ? {...state, sheet: {...sheet, confirming: false}}
    : state;
}

/** The thing the card would remove, the second time it is pressed: none before, or while its removal is on its way. */
export function toRemove(sheet: Sheet | undefined): string | undefined {
  return sheet?.kind === 'thing' && sheet.confirming && !sheet.sending
    ? sheet.thingId
    : undefined;
}

/** What the sheet open asks of the daemon is on its way. */
export function sent(state: WorldState): WorldState {
  const {sheet} = state;

  return sheet === undefined || sheet.sending
    ? state
    : {...state, sheet: {...sheet, sending: true, problem: undefined}};
}

/** What the daemon answered when the sheet left something: left, the sheet closes; else it says why, keeping what was typed. */
export function leaveAnswered(
  state: WorldState,
  outcome: LeaveThingOutcome,
): WorldState {
  return state.sheet?.kind === 'leave' && state.sheet.sending
    ? answered(state, state.sheet, outcome)
    : state;
}

/** What the daemon answered when the card removed its thing: removed, the card closes; else it says why, its button as it was. */
export function removeAnswered(
  state: WorldState,
  thingId: string,
  outcome: RemoveThingOutcome,
): WorldState {
  const {sheet} = state;

  return sheet?.kind === 'thing' && sheet.thingId === thingId && sheet.sending
    ? answered(state, {...sheet, confirming: false}, outcome)
    : state;
}

/** A thing the person left that nobody living there has been told of yet. */
export function isUnseen(world: HerWorld, thing: WorldThing): boolean {
  return (
    thing.from.kind === 'person' &&
    !world.characters.some(her => thing.seen.includes(her.id))
  );
}

/** What Now shows, at the viewer's `clock`. */
export function nowOf(world: HerWorld, clock: Clock): Now {
  const said = momentsOf(clock);

  return {
    here: world.places.flatMap(place => {
      const living = livingIn(world, place.id, said);

      return living.length === 0
        ? []
        : [
            {
              place,
              living,
              around: place.things.slice(0, aroundHer),
              more: Math.max(place.things.length - aroundHer, 0),
            },
          ];
    }),
    waiting: world.places.flatMap(place =>
      place.things.filter(thing => isUnseen(world, thing)),
    ),
    lately: world.journal
      .slice(0, lately)
      .map(entry => lineOf(world, entry, said(entry.when))),
  };
}

/** Each place as Places shows it, in the world's order. */
export function placesOf(world: HerWorld, clock: Clock): readonly PlaceCard[] {
  const said = momentsOf(clock);

  return world.places.map(place => ({
    place,
    living: livingIn(world, place.id, said),
    peek: place.things.slice(0, peeked),
    more: Math.max(place.things.length - peeked, 0),
    fresh: place.things.some(thing => isUnseen(world, thing)),
  }));
}

/** Who is in the place of id `placeId`, since when. */
export function hereNow(
  world: HerWorld,
  placeId: string,
  clock: Clock,
): readonly Living[] {
  return livingIn(world, placeId, momentsOf(clock));
}

/** The journal by day, newest first, each line with its time. */
export function journalOf(world: HerWorld, clock: Clock): readonly Day[] {
  const write = writer(clock);
  const days: {day: number; words: string; lines: Line[]}[] = [];

  for (const entry of world.journal) {
    const written = write(Date.parse(entry.when));
    const line = lineOf(world, entry, written.time);
    const last = days.at(-1);

    if (last?.day === written.day) {
      last.lines.push(line);
    } else {
      days.push({day: written.day, words: written.words, lines: [line]});
    }
  }

  return days.map(({words, lines}) => ({day: words, lines}));
}

/**
 * The card of the thing of id `thingId`, as `characterId`'s window shows
 * it: where it is; whom it is from, and when, or the world it came with;
 * and, for a thing the person left, whether she has seen it. None once it
 * is gone.
 */
export function thingCard(
  world: HerWorld,
  characterId: string,
  thingId: string,
  clock: Clock,
): ThingCard | undefined {
  const found = thingOf(world, thingId);

  if (found === undefined) {
    return undefined;
  }

  const {thing, place} = found;
  const came = momentsOf(clock)(thing.came);
  const from = whoOf(world, thing.from);
  const facts = [{label: 'Where', value: place.name}];

  if (from.kind === 'person') {
    facts.push(
      {label: 'Left by', value: `${from.name}, ${came}`},
      {
        label: `Seen by ${nameOf(world, characterId)}`,
        value: thing.seen.includes(characterId) ? 'Yes' : 'Not yet',
      },
    );
  } else {
    facts.push(
      from.kind === 'character'
        ? {label: 'Made by', value: `${from.name}, ${came}`}
        : {label: 'Came with', value: from.name},
    );
  }

  return {thing, place, facts};
}

/** The thing of id `thingId`, and the place it is in. */
function thingOf(
  world: HerWorld,
  thingId: string,
): {readonly thing: WorldThing; readonly place: WorldPlace} | undefined {
  for (const place of world.places) {
    const thing = place.things.find(held => held.id === thingId);

    if (thing !== undefined) {
      return {thing, place};
    }
  }

  return undefined;
}

/** Each character living in the place of id `placeId`, since when, said by `said`. */
function livingIn(
  world: HerWorld,
  placeId: string,
  said: (at: string) => string,
): readonly Living[] {
  return world.characters
    .filter(her => her.place === placeId)
    .map(her => ({
      id: her.id,
      name: her.displayName,
      since: `since ${said(her.since)}`,
    }));
}

/** A line of the journal, its moment said as `when`. */
function lineOf(world: HerWorld, entry: WorldEntry, when: string): Line {
  return {
    who: whoOf(world, entry.who),
    what: deeds[entry.what],
    name:
      entry.what === 'went'
        ? entry.place.name
        : (entry.thing?.name ?? entry.place.name),
    when,
  };
}

function whoOf(world: HerWorld, hand: WorldHand): Who {
  switch (hand.kind) {
    case 'person':
      return {kind: 'person', name: 'You'};
    case 'world':
      return {kind: 'world', name: world.name};
    case 'character':
      return {kind: 'character', id: hand.id, name: nameOf(world, hand.id)};
  }
}

/** A character living there by her name; one who no longer does, by her id. */
function nameOf(world: HerWorld, characterId: string): string {
  return (
    world.characters.find(her => her.id === characterId)?.displayName ??
    characterId
  );
}

/** How the window says a moment where no day stands above it, at the viewer's `clock`: as the chat says when a message was read. */
function momentsOf(clock: Clock): (at: string) => string {
  const write = writer(clock);

  return at => whenOf(write, clock.now, Date.parse(at));
}

/** What the daemon answered of what `sheet` sent: done, it closes; else it says why. */
function answered(
  state: WorldState,
  sheet: Sheet,
  outcome: LeaveThingOutcome | RemoveThingOutcome,
): WorldState {
  return outcome.status === 'ok'
    ? {...state, sheet: undefined}
    : {...state, sheet: {...sheet, sending: false, problem: outcome.message}};
}

function sameShows(one: Shows, other: Shows): boolean {
  const keyOf = (shows: Shows): string =>
    shows.kind === 'place' ? `place ${shows.placeId}` : shows.kind;

  return keyOf(one) === keyOf(other);
}
