import {describe, expect, it} from 'vitest';

import type {
  CharacterSummary,
  GatewayHealth,
  PhoneApp,
  PhoneDid,
  PhoneFront,
  PhoneOutcome,
  PhoneRing,
  Screen,
  ScreenRow,
} from '@project02/wire/contract';
import {
  ago,
  clockParts,
  healthSaid,
  initialPhoneState,
  lineOf,
  liveAt,
  looked,
  phoneRead,
  phoneReady,
  phoneRefused,
  screenOf,
  screenRead,
  type PhoneState,
  type ViewLook,
} from './phone.ts';
import {streamLost} from './store.ts';

const mira: CharacterSummary = {
  id: 'mira',
  displayName: 'Mira',
  enabled: true,
  builtIn: true,
  state: 'ready',
};

const clock: PhoneApp = {
  id: 'clock',
  name: 'Clock',
  icon: 'clock',
  tint: 'graphite',
  views: [
    {id: 'world', title: 'World Clock', icon: 'globe'},
    {id: 'alarms', title: 'Alarms', icon: 'alarm'},
    {id: 'stopwatch', title: 'Stopwatch', icon: 'stopwatch'},
    {id: 'timers', title: 'Timers', icon: 'timer'},
  ],
  opensOn: 'alarms',
};

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
/** The moment the tests call now, 9:00 on November 11, 2026. */
const now = Date.parse('2026-11-11T09:00:00.000Z');

function health(...characters: readonly CharacterSummary[]): GatewayHealth {
  return {
    protocolVersion: 11,
    homeRoot: '/home/person/.project02',
    config: {diagnostics: []},
    packages: {diagnostics: []},
    characters,
    connectors: [],
  };
}

/** Her phone as a read gives it: the Clock, and what she has in front, did and what rings. */
function herPhone(
  parts: {
    readonly front?: PhoneFront;
    readonly did?: PhoneDid;
    readonly ringing?: readonly PhoneRing[];
  } = {},
): PhoneOutcome {
  return {status: 'ok', apps: [clock], ringing: [], ...parts};
}

/** What she did, `seconds` after the minute before now. */
function did(words: string, seconds: number): PhoneDid {
  return {
    appId: 'clock',
    words,
    at: new Date(now - minute + seconds * 1000).toISOString(),
  };
}

/** One list of these rows, or the Clock's words for none. */
function alarmList(...rows: readonly ScreenRow[]): Screen {
  return {
    items:
      rows.length === 0
        ? [{kind: 'text', text: 'No Alarms'}]
        : [{kind: 'list', rows}],
  };
}

/** Alarm `id` as the Clock lists it. */
function alarm(id: string, time: string): ScreenRow {
  return {id, time, subtitle: 'Alarm', switch: true};
}

/** The Clock's Alarms view in front of her, its screen holding `screen`. */
function alarmsInFront(screen: Screen): PhoneFront {
  return {appId: 'clock', viewId: 'alarms', screen};
}

const world: ViewLook = {kind: 'view', appId: 'clock', viewId: 'world'};
const timers: ViewLook = {kind: 'view', appId: 'clock', viewId: 'timers'};
const noCities: Screen = {items: [{kind: 'text', text: 'No World Clocks'}]};
const wakeSam: PhoneRing = {
  appName: 'Clock',
  title: 'Alarm',
  body: 'Wake Sam',
  at: '2026-11-11T07:00:00.000Z',
};

/** Mira's window, live, with her phone as `outcome` says it. */
function watching(outcome: PhoneOutcome = herPhone()): PhoneState {
  return phoneRead(
    phoneReady(initialPhoneState('mira'), health(mira)),
    outcome,
  );
}

describe("her phone's window", () => {
  it('follows her: what she has in front, her home screen while nothing is; what the person opens instead, which a read of hers that says nothing new keeps; and her again at the next thing she does, or as a ring begins', () => {
    let state = watching();

    expect(screenOf(state)).toEqual({kind: 'home', apps: [clock]});

    const opened = herPhone({
      front: alarmsInFront(alarmList()),
      did: did('Opened Clock', 1),
    });

    state = phoneRead(state, opened);
    expect(screenOf(state)).toEqual({
      kind: 'view',
      app: clock,
      viewId: 'alarms',
      screen: alarmList(),
      message: undefined,
      fresh: new Set(),
    });

    // The person opens the World Clock, which shows once read; the same
    // read of her phone again, such as each minute's, keeps it there.
    state = looked(state, world);
    expect(screenOf(state)).toMatchObject({viewId: 'world', screen: undefined});
    state = screenRead(state, world, {status: 'ok', screen: noCities});
    state = phoneRead(state, opened);
    expect(screenOf(state)).toMatchObject({viewId: 'world', screen: noCities});

    // Then her home screen, which a click on it again leaves as it is.
    state = looked(state, {kind: 'home'});
    expect(screenOf(state)).toEqual({kind: 'home', apps: [clock]});
    expect(looked(state, {kind: 'home'})).toBe(state);

    // She sets an alarm: back to her, on the view the action shows.
    const set = {
      front: alarmsInFront(alarmList(alarm('a1', '7:00 AM'))),
      did: did('Set an alarm', 2),
    };

    state = phoneRead(state, herPhone(set));
    expect(screenOf(state)).toMatchObject({
      kind: 'view',
      viewId: 'alarms',
      screen: alarmList(alarm('a1', '7:00 AM')),
    });
    // Opening the view she has in front leaves the window on her.
    expect(
      looked(state, {kind: 'view', appId: 'clock', viewId: 'alarms'}),
    ).toBe(state);

    // The person looks at her timers, and a ring begins: what rings is
    // over everything, and under it the window is on her again.
    state = looked(state, timers);
    state = phoneRead(state, herPhone({...set, ringing: [wakeSam]}));
    expect(screenOf(state)).toEqual({kind: 'ringing', ring: wakeSam});
    expect(state.shows).toEqual({kind: 'hers'});

    // Once it ends, her phone again.
    state = phoneRead(state, herPhone(set));
    expect(screenOf(state)).toMatchObject({kind: 'view', viewId: 'alarms'});
  });

  it("shows a view the person opened once its screen is read, or the sentence saying why it cannot be shown, and lets go of a view's answer once the window shows another", () => {
    let state = looked(watching(), world);

    state = screenRead(state, timers, {status: 'ok', screen: noCities});
    expect(screenOf(state)).toMatchObject({viewId: 'world', screen: undefined});

    state = screenRead(state, world, {
      status: 'refused',
      reason: 'app_failed',
      message: 'Clock failed to show its screen: it ran out of time.',
    });
    expect(screenOf(state)).toMatchObject({
      kind: 'view',
      viewId: 'world',
      message: 'Clock failed to show its screen: it ran out of time.',
    });

    // A minute's turn reads what is shown again: a screen now stands in
    // place of the sentence.
    const {shows} = state;

    if (shows.kind !== 'view') {
      throw new Error('The window shows no view.');
    }

    state = screenRead(state, shows, {status: 'ok', screen: noCities});
    expect(screenOf(state)).toMatchObject({
      screen: noCities,
      message: undefined,
    });

    state = looked(state, {kind: 'home'});
    expect(screenRead(state, world, {status: 'ok', screen: noCities})).toBe(
      state,
    );
  });

  it('names her as health lists her, says why in place of her phone when it cannot be read until a read can, and draws the soonest of what rings', () => {
    const nova = initialPhoneState('nova');
    let state = phoneReady(nova, health(mira));

    expect(state.name).toBeUndefined();
    expect(screenOf(state)).toEqual({kind: 'blank'});
    state = healthSaid(
      state,
      health(mira, {...mira, id: 'nova', displayName: 'Nova'}),
    );
    expect(state.name).toBe('Nova');
    expect(
      healthSaid(
        state,
        health(mira, {...mira, id: 'nova', displayName: 'Nova'}),
      ),
    ).toBe(state);

    state = phoneRead(watching(), {
      status: 'refused',
      reason: 'no_phone',
      message: 'Mira has no phone: her settings switch it off.',
    });
    expect(state.unread).toBe('Mira has no phone: her settings switch it off.');
    expect(lineOf(state, now)).toBeUndefined();
    state = phoneRead(state, herPhone());
    expect(state.unread).toBeUndefined();

    const later: PhoneRing = {
      appName: 'Clock',
      title: 'Timer',
      body: '5 min',
      at: '2026-11-11T07:05:00.000Z',
    };

    expect(screenOf(watching(herPhone({ringing: [later, wakeSam]})))).toEqual({
      kind: 'ringing',
      ring: wakeSam,
    });
  });

  it('says under her phone that the window is connecting, that her phone is ringing, that she has nothing open, or what she last did and how long ago, lit while under a minute old; and nothing for an address refused', () => {
    expect(lineOf(initialPhoneState('mira'), now)).toEqual({
      what: 'Connecting…',
      lit: false,
    });
    expect(lineOf(watching(), now)).toEqual({what: 'Nothing open', lit: false});

    const set = watching(herPhone({did: did('Set an alarm', 30)}));

    expect(lineOf(set, now)).toEqual({
      what: 'Set an alarm',
      when: 'just now',
      lit: true,
    });
    expect(lineOf(set, now + 2 * minute)).toEqual({
      what: 'Set an alarm',
      when: '2 min ago',
      lit: false,
    });
    expect(
      lineOf(
        watching(herPhone({did: did('Set an alarm', 30), ringing: [wakeSam]})),
        now,
      ),
    ).toEqual({what: 'Her phone is ringing', when: 'now', lit: true});
    expect(lineOf(streamLost(set), now)).toEqual({
      what: 'Connecting…',
      lit: false,
    });
    expect(
      lineOf(phoneRefused(set, 'The token is not valid.'), now),
    ).toBeUndefined();

    expect(ago(-1800)).toBe('now');
    expect(ago(9_999)).toBe('now');
    expect(ago(10_000)).toBe('just now');
    expect(ago(minute - 1)).toBe('just now');
    expect(ago(minute)).toBe('1 min ago');
    expect(ago(hour - 1)).toBe('59 min ago');
    expect(ago(hour)).toBe('1 hr ago');
    expect(ago(day - 1)).toBe('23 hr ago');
    expect(ago(day)).toBe('1 day ago');
    expect(ago(3 * day + hour)).toBe('3 days ago');
  });

  it('counts a live reading at a moment: up as a stopwatch reads, down as a timer reads with the share of its whole still left, and neither below nothing', () => {
    const from = now - 12_345;

    expect(liveAt({counts: 'up', from}, now)).toEqual({text: '00:12.34'});
    expect(liveAt({counts: 'up', from}, from + 3_723_456)).toEqual({
      text: '1:02:03.45',
    });
    expect(liveAt({counts: 'up', from}, from - 500)).toEqual({
      text: '00:00.00',
    });

    const to = now + 754_000;
    const quarter = {counts: 'down', to, of: 15 * minute} as const;

    expect(liveAt(quarter, now)).toEqual({text: '12:34', share: 754 / 900});
    // Part of a second shows as a whole one, as a timer counting down does.
    expect(liveAt(quarter, now - 500)).toMatchObject({text: '12:35'});
    expect(liveAt(quarter, to + 1_000)).toEqual({text: '0:00', share: 0});
    expect(
      liveAt({counts: 'down', to: now + 90 * minute, of: 2 * hour}, now),
    ).toEqual({text: '1:30:00', share: 0.75});
    expect(liveAt({counts: 'down', to, of: 0}, now)).toMatchObject({
      share: 0,
    });
  });

  it('marks New the rows of the view she has in front that the read before did not hold, right after she did something, by their ids or else by what they show, until the next read', () => {
    const one = alarm('a1', '6:30 AM');
    const two = alarm('a2', '7:00 AM');
    let state = watching(
      herPhone({
        front: alarmsInFront(alarmList(one)),
        did: did('Opened Clock', 1),
      }),
    );

    expect(state.fresh).toEqual(new Set());

    // She sets an alarm, and switches off the one there was: only the
    // alarm she set is new.
    const set = herPhone({
      front: alarmsInFront(alarmList({...one, switch: false}, two)),
      did: did('Set an alarm', 2),
    });

    state = phoneRead(state, set);
    expect(screenOf(state)).toMatchObject({fresh: new Set(['a2'])});

    // The next read, with nothing new she did, marks nothing.
    state = phoneRead(state, set);
    expect(state.fresh).toEqual(new Set());

    // A row without an id is known by what it shows.
    const lap = (count: number): ScreenRow => ({
      title: `Lap ${String(count)}`,
      value: '00:10.00',
    });
    const laps = (...rows: readonly ScreenRow[]): PhoneFront => ({
      appId: 'clock',
      viewId: 'stopwatch',
      screen: {items: [{kind: 'list', header: 'Laps', rows}]},
    });

    state = phoneRead(
      state,
      herPhone({front: laps(lap(1)), did: did('Marked a lap', 3)}),
    );
    // A view that was not the one in front the read before marks nothing.
    expect(state.fresh).toEqual(new Set());
    state = phoneRead(
      state,
      herPhone({front: laps(lap(2), lap(1)), did: did('Marked a lap', 4)}),
    );
    expect(state.fresh).toEqual(new Set([JSON.stringify(lap(2))]));
  });

  it("draws a clock reading's day period apart from its digits, as the design does", () => {
    expect(clockParts('7:00 AM')).toEqual({digits: '7:00', period: 'AM'});
    // A browser writes its own clock with a narrow space before the period.
    expect(clockParts('7:00\u202Fp.m.')).toEqual({
      digits: '7:00',
      period: 'p.m.',
    });
    expect(clockParts('19:00')).toEqual({digits: '19:00'});
    expect(clockParts('00:12.34')).toEqual({digits: '00:12.34'});
  });
});
