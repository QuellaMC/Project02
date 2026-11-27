import {describe, expect, it} from 'vitest';

import type {
  WorldEntry,
  WorldHand,
  WorldPlace,
  WorldThing,
} from '@project02/wire/contract';
import type {Clock} from './thread-layout.ts';
import {
  drafted,
  hereNow,
  initialWorldState,
  journalOf,
  leaveAnswered,
  leaveOpened,
  looked,
  nowOf,
  placesOf,
  readsAgain,
  removeAnswered,
  removeAsked,
  removeKept,
  sent,
  sheetClosed,
  thingCard,
  thingOpened,
  toLeave,
  toRemove,
  worldRead,
  worldReady,
  worldRefused,
  type HerWorld,
  type WorldState,
} from './world.ts';

/** The moment the tests call now: Thursday, November 26, 2026, at 10:40 AM in London. */
const now = Date.parse('2026-11-26T10:40:00.000Z');
const london: Clock = {now, locale: 'en-US', timeZone: 'Europe/London'};

/** A moment that day, or a day before it, as `26T10:10`, the way the daemon writes one. */
function at(dayAndTime: string): string {
  return `2026-11-${dayAndTime}:00.000Z`;
}

function thing(
  id: string,
  from: WorldHand,
  more: Partial<WorldThing> = {},
): WorldThing {
  return {
    id,
    name: id,
    icon: 'grid',
    tint: 'gray',
    from,
    came: at('20T09:00'),
    seen: [],
    ...more,
  };
}

const world = {kind: 'world'} as const;
const person = {kind: 'person'} as const;
const mira = {kind: 'character', id: 'mira'} as const;

/** Who a line of the journal is by, as the window names them. */
const you = {kind: 'person', name: 'You'} as const;
const her = {kind: 'character', id: 'mira', name: 'Mira'} as const;

function place(id: string, name: string, things: WorldThing[]): WorldPlace {
  return {id, name, icon: 'bed', tint: 'indigo', things};
}

function entry(
  when: string,
  who: WorldHand,
  what: WorldEntry['what'],
  placeName: string,
  thingName?: string,
): WorldEntry {
  return {
    when: at(when),
    who,
    what,
    place: {id: placeName.toLowerCase(), name: placeName},
    ...(thingName === undefined
      ? {}
      : {thing: {id: thingName, name: thingName}}),
  };
}

/**
 * The Port: Mira in the studio since 10:10 today; in the flat a table of
 * the world's, honey the person left that she has not seen, and tea she
 * has; a pencil she made; and a journal of six lines over three days.
 */
const port: HerWorld = {
  status: 'ok',
  id: 'the-port',
  name: 'The Port',
  places: [
    place('flat', 'The Flat', [
      thing('table', world),
      thing('honey', person, {
        name: 'A jar of honey',
        icon: 'fork',
        tint: 'orange',
        came: at('26T10:32'),
        note: 'For your toast.',
      }),
      thing('tea', person, {came: at('25T18:05'), seen: ['mira']}),
      thing('pencil', mira, {came: at('24T20:00')}),
    ]),
    place('studio', 'The Studio', [thing('proofs', world)]),
    place('bakery', 'The Bakery', []),
  ],
  characters: [
    {id: 'mira', displayName: 'Mira', place: 'studio', since: at('26T10:10')},
  ],
  journal: [
    entry('26T10:32', person, 'left', 'The Flat', 'A jar of honey'),
    entry('26T10:10', mira, 'went', 'The Studio'),
    entry('26T09:30', mira, 'used', 'The Flat', 'Teapot'),
    entry('25T22:40', mira, 'made', 'The Flat', 'Paper boat'),
    entry('25T18:05', person, 'removed', 'The Flat', 'Bread'),
    entry('22T08:00', {kind: 'character', id: 'juno'}, 'went', 'The Bakery'),
  ],
  kinds: [
    {id: 'gift', name: 'Gift', icon: 'gift', tint: 'pink'},
    {id: 'food', name: 'Food', icon: 'fork', tint: 'orange'},
  ],
};

/** Mira's world's window, live, her world read. */
function read(): WorldState {
  return worldRead(worldReady(initialWorldState('mira')), port);
}

describe("her world's window", () => {
  it('shows on Now each place somebody is in with who is there since when and the first six things there with how many more, the things the person left that nobody living there has seen, and the newest four lines of the journal, at their time today and by their day before', () => {
    const shown = nowOf(port, london);
    const crowded: HerWorld = {
      ...port,
      places: port.places.map(where =>
        where.id === 'studio'
          ? {
              ...where,
              things: Array.from({length: 8}, (_, at) =>
                thing(`thing-${String(at)}`, world),
              ),
            }
          : where,
      ),
    };

    expect(
      nowOf(crowded, london).here.map(({around, more}) => [
        around.map(near => near.id),
        more,
      ]),
    ).toEqual([
      [['thing-0', 'thing-1', 'thing-2', 'thing-3', 'thing-4', 'thing-5'], 2],
    ]);

    expect(
      shown.here.map(({place: where, living}) => [where.id, living]),
    ).toEqual([
      ['studio', [{id: 'mira', name: 'Mira', since: 'since 10:10 AM'}]],
    ]);
    expect(shown.waiting.map(left => left.id)).toEqual(['honey']);
    expect(shown.lately).toEqual([
      {who: you, what: 'Left', name: 'A jar of honey', when: '10:32 AM'},
      {
        who: her,
        what: 'Went to',
        name: 'The Studio',
        when: '10:10 AM',
      },
      {
        who: her,
        what: 'Used',
        name: 'Teapot',
        when: '9:30 AM',
      },
      {
        who: her,
        what: 'Made',
        name: 'Paper boat',
        when: 'Yesterday',
      },
    ]);
    expect(
      hereNow(port, 'studio', {...london, now: Date.parse(at('27T09:00'))}),
    ).toEqual([{id: 'mira', name: 'Mira', since: 'since Yesterday'}]);
    expect(nowOf({...port, journal: []}, london).lately).toEqual([]);
  });

  it('says the journal by day, newest first, each day in the words the chat gives a day and each line with its time, who did what, and the name it was written with, a character the world no longer has by her id', () => {
    expect(journalOf(port, london)).toEqual([
      {
        day: 'Today',
        lines: [
          {who: you, what: 'Left', name: 'A jar of honey', when: '10:32 AM'},
          {
            who: her,
            what: 'Went to',
            name: 'The Studio',
            when: '10:10 AM',
          },
          {
            who: her,
            what: 'Used',
            name: 'Teapot',
            when: '9:30 AM',
          },
        ],
      },
      {
        day: 'Yesterday',
        lines: [
          {
            who: her,
            what: 'Made',
            name: 'Paper boat',
            when: '10:40 PM',
          },
          {who: you, what: 'Removed', name: 'Bread', when: '6:05 PM'},
        ],
      },
      {
        day: 'Sunday',
        lines: [
          {
            who: {kind: 'character', id: 'juno', name: 'juno'},
            what: 'Went to',
            name: 'The Bakery',
            when: '8:00 AM',
          },
        ],
      },
    ]);
  });

  it('shows on Places each place in the order of her world, who is there, its first two things and how many more, and New while something the person left there is not seen', () => {
    expect(
      placesOf(port, london).map(card => ({
        place: card.place.id,
        living: card.living.map(her => her.id),
        peek: card.peek.map(held => held.id),
        more: card.more,
        fresh: card.fresh,
      })),
    ).toEqual([
      {
        place: 'flat',
        living: [],
        peek: ['table', 'honey'],
        more: 2,
        fresh: true,
      },
      {
        place: 'studio',
        living: ['mira'],
        peek: ['proofs'],
        more: 0,
        fresh: false,
      },
      {place: 'bakery', living: [], peek: [], more: 0, fresh: false},
    ]);
  });

  it("gives a thing's card where it is and whom it is from and when, or the world it came with, and for a thing the person left whether she has seen it; and none once it is gone", () => {
    const factsOf = (id: string) =>
      thingCard(port, 'mira', id, london)?.facts.map(
        ({label, value}) => `${label}: ${value}`,
      );

    expect(factsOf('honey')).toEqual([
      'Where: The Flat',
      'Left by: You, 10:32 AM',
      'Seen by Mira: Not yet',
    ]);
    expect(factsOf('tea')).toEqual([
      'Where: The Flat',
      'Left by: You, Yesterday',
      'Seen by Mira: Yes',
    ]);
    expect(factsOf('pencil')).toEqual([
      'Where: The Flat',
      'Made by: Mira, Tuesday',
    ]);
    expect(factsOf('proofs')).toEqual([
      'Where: The Studio',
      'Came with: The Port',
    ]);
    expect(thingCard(port, 'mira', 'gone', london)).toBeUndefined();
  });

  it('shows her world as each read gives it, says why in its place when a read does not until one does, lets go of the card of a thing no longer there, and reads again when her world changes or a turn of hers begins or ends', () => {
    const opened = thingOpened(read(), 'honey');
    const failed = worldRead(opened, {
      status: 'failed',
      message: 'Her world could not be reached.',
    });
    const honeyless: HerWorld = {
      ...port,
      places: port.places.map(held => ({
        ...held,
        things: held.things.filter(kept => kept.id !== 'honey'),
      })),
    };

    const live = read();

    expect(live.connection).toEqual({status: 'live'});
    expect(worldReady(live)).toBe(live);
    expect(failed.unread).toBe('Her world could not be reached.');
    expect(worldRead(failed, port)).toMatchObject({unread: undefined});
    expect(worldRead(opened, port).sheet).toMatchObject({thingId: 'honey'});
    expect(worldRead(opened, honeyless).sheet).toBeUndefined();
    expect(worldRefused(read(), 'Gone.').connection).toEqual({
      status: 'refused',
      message: 'Gone.',
    });

    const turn = (characterId: string) =>
      ({
        kind: 'turn_completed',
        characterId,
        conversationId: 'conv-1',
        status: 'completed',
        committed: true,
      }) as const;

    expect([
      readsAgain(read(), {kind: 'world_changed', world: 'the-port'}),
      readsAgain(read(), {kind: 'world_changed', world: 'the-yard'}),
      readsAgain(initialWorldState('mira'), {
        kind: 'world_changed',
        world: 'the-yard',
      }),
      readsAgain(read(), turn('mira')),
      readsAgain(read(), turn('nova')),
      readsAgain(read(), {
        kind: 'turn_running',
        characterId: 'mira',
        conversationId: 'conv-1',
        writing: true,
      }),
      readsAgain(read(), {kind: 'phone_changed', characterId: 'mira'}),
    ]).toEqual([true, false, true, true, false, true, false]);
  });

  it('opens the sheet for leaving something with nothing typed and the first kind, in the place looked at or else where she is; leaves only what has a name, and a note only when one is written; says what the daemon refused and keeps what was typed until it changes; and closes once it is left', () => {
    const fromNow = leaveOpened(read());
    const fromFlat = leaveOpened(
      looked(read(), {kind: 'place', placeId: 'flat'}),
    );

    expect(fromNow.sheet).toEqual({
      kind: 'leave',
      draft: {name: '', kind: 'gift', place: 'studio', note: ''},
      sending: false,
    });
    expect(fromFlat.sheet).toMatchObject({draft: {place: 'flat'}});
    expect(toLeave(fromNow.sheet)).toBeUndefined();
    expect(toLeave(drafted(fromNow, {name: '  '}).sheet)).toBeUndefined();

    const named = drafted(fromNow, {name: 'Honey', kind: 'food', note: ' '});

    expect(toLeave(named.sheet)).toEqual({
      name: 'Honey',
      kind: 'food',
      place: 'studio',
    });
    expect(toLeave(drafted(named, {note: 'For toast.'}).sheet)).toMatchObject({
      note: 'For toast.',
    });

    const sending = sent(named);
    const refused = leaveAnswered(sending, {
      status: 'refused',
      reason: 'invalid_note',
      message: 'A note is not blank, and is 280 characters at most.',
    });

    expect(toLeave(sending.sheet)).toBeUndefined();
    expect(sent(sending)).toBe(sending);
    expect(leaveAnswered(named, {status: 'failed', message: 'No.'})).toBe(
      named,
    );
    expect(refused.sheet).toMatchObject({
      draft: {name: 'Honey', kind: 'food'},
      sending: false,
      problem: 'A note is not blank, and is 280 characters at most.',
    });
    expect(drafted(refused, {note: ''}).sheet?.problem).toBeUndefined();
    expect(
      leaveAnswered(sending, {status: 'ok', thing: thing('honey', person)})
        .sheet,
    ).toBeUndefined();
    expect(sheetClosed(named).sheet).toBeUndefined();

    const nothingOpen = read();

    expect(sheetClosed(nothingOpen)).toBe(nothingOpen);
    expect(leaveOpened(initialWorldState('mira')).sheet).toBeUndefined();
  });

  it('takes two presses to remove a thing from its card: the first asks again in place and Cancel keeps it; the second sends; removed, the card closes, and refused, it says why with its button as it was; going to another view closes it, and going where the window is already changes nothing', () => {
    const card = thingOpened(read(), 'honey');
    const asked = removeAsked(card);

    expect(toRemove(card.sheet)).toBeUndefined();
    expect(asked.sheet).toMatchObject({confirming: true});
    expect(removeAsked(asked)).toBe(asked);
    expect(removeKept(asked).sheet).toMatchObject({confirming: false});
    expect(removeKept(card)).toBe(card);
    expect(toRemove(asked.sheet)).toBe('honey');

    const removing = sent(asked);

    expect(toRemove(removing.sheet)).toBeUndefined();
    expect(removeAnswered(removing, 'tea', {status: 'ok'})).toBe(removing);
    expect(removeAnswered(removing, 'honey', {status: 'ok'}).sheet).toBe(
      undefined,
    );
    expect(
      removeAnswered(removing, 'honey', {
        status: 'refused',
        reason: 'unknown_thing',
        message: 'There is no thing "honey" in The Port.',
      }).sheet,
    ).toEqual({
      kind: 'thing',
      thingId: 'honey',
      confirming: false,
      sending: false,
      problem: 'There is no thing "honey" in The Port.',
    });
    expect(looked(card, {kind: 'journal'})).toMatchObject({
      shows: {kind: 'journal'},
      sheet: undefined,
    });
    const onNow = read();

    expect(looked(onNow, {kind: 'now'})).toBe(onNow);
    expect(
      looked(looked(read(), {kind: 'place', placeId: 'flat'}), {
        kind: 'place',
        placeId: 'studio',
      }).shows,
    ).toEqual({kind: 'place', placeId: 'studio'});
  });
});
