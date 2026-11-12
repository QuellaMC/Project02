import {describe, expect, it} from 'vitest';

import type {
  CharacterSummary,
  GatewayHealth,
  GatewayReady,
  PendingConfirmation,
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
  askRaised,
  askSettled,
  clockParts,
  framed,
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
  summary: 'Alarms, timers, and the time anywhere',
  version: '1.0.0',
  source: 'built_in',
  icon: 'clock',
  tint: 'graphite',
  wakes: true,
  mayWake: true,
  itMay: ['Keep its own data', 'Wake her when something is due'],
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
    protocolVersion: 13,
    homeRoot: '/home/person/.project02',
    config: {diagnostics: []},
    packages: {diagnostics: []},
    characters,
    connectors: [],
    accounts: [],
  };
}

/** The stream's first frame: health as `said`, and the confirmations waiting. */
function ready(
  said: GatewayHealth,
  ...confirmations: readonly PendingConfirmation[]
): GatewayReady {
  return {
    protocolVersion: 13,
    health: said,
    confirmations,
    pairings: [],
    turns: [],
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

const store: PhoneApp = {
  id: 'store',
  name: 'App Store',
  summary: 'More apps, each reviewed by Project02',
  version: '1.0.0',
  source: 'built_in',
  icon: 'bag',
  tint: 'blue',
  wakes: false,
  mayWake: true,
  itMay: ['Keep its own data'],
  views: [{id: 'apps', title: 'App Store', icon: 'bag'}],
  opensOn: 'apps',
};

/** Her ask to install the App Store's `app`, as confirmation `id` asks the person; Mira's unless it names another. */
function askFor(
  id: string,
  app: string,
  characterId = 'mira',
): PendingConfirmation {
  return {
    characterId,
    id,
    request: {
      pluginId: 'phone',
      toolName: 'phone.install',
      summary: `Install "${app}" 1.0.0 from the App Store.`,
      preview: {
        kind: 'phone_app_install',
        app: {
          id: app,
          name: app,
          summary: 'An app',
          icon: 'list',
          tint: 'orange',
          version: '1.0.0',
          wakes: true,
          reachesInternet: false,
        },
        source: 'catalog',
      },
    },
    deadlineAt: now + 5 * minute,
  };
}

/** The apps her phone's window shows she waits on the person to install, on the view in front. */
function waitingOn(state: PhoneState): ReadonlySet<string> {
  const shown = screenOf(state);

  if (shown.kind !== 'view') {
    throw new Error('The window shows no view.');
  }

  return shown.waiting;
}

/** Mira's window, live, with her phone as `outcome` says it. */
function watching(outcome: PhoneOutcome = herPhone()): PhoneState {
  return phoneRead(
    phoneReady(initialPhoneState('mira'), ready(health(mira))),
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
      waiting: new Set(),
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
    let state = phoneReady(nova, ready(health(mira)));

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

  it("marks no row New when the view she has in front shows another page of it, as the App Store's list and its page of an app are, and still marks the rows that the same page gains", () => {
    const keep: ScreenRow = {title: 'Keep its own data'};
    const wake: ScreenRow = {title: 'Wake her when something is due'};
    const list: Screen = {
      items: [
        {
          kind: 'list',
          header: 'Reviewed by Project02',
          rows: [{id: 'reminders', title: 'Reminders'}],
        },
      ],
    };
    const page = (...rows: readonly ScreenRow[]): Screen => ({
      items: [{kind: 'list', header: 'It may', rows}],
      page: 'reminders',
    });
    const inStore = (
      screen: Screen,
      words: string,
      seconds: number,
    ): PhoneOutcome => ({
      status: 'ok',
      apps: [clock, store],
      front: {appId: 'store', viewId: 'apps', screen},
      did: {...did(words, seconds), appId: 'store'},
      ringing: [],
    });
    let state = watching(inStore(list, 'Opened App Store', 1));

    state = phoneRead(state, inStore(page(keep), 'Looked at an app', 2));
    expect(state.fresh).toEqual(new Set());
    state = phoneRead(state, inStore(page(keep, wake), 'Looked at an app', 3));
    expect(state.fresh).toEqual(new Set([JSON.stringify(wake)]));
    state = phoneRead(state, inStore(list, 'Opened App Store', 4));
    expect(state.fresh).toEqual(new Set());
  });

  it("knows which apps she waits on the person to install: those she asked for that wait when the window connects, then each she asks for, until it is settled, approved or denied; another character's ask and a confirmation of anything else are not hers to wait on, and each new connection says again what waits", () => {
    const tone: PendingConfirmation = {
      ...askFor('c0', 'tone'),
      request: {
        pluginId: 'runtime.plugin',
        toolName: 'runtime.plugin.config.update',
        summary: 'Set the tone to warm.',
        preview: {fieldName: 'tone', value: 'warm'},
      },
    };
    const inStore: PhoneOutcome = {
      status: 'ok',
      apps: [clock, store],
      front: {
        appId: 'store',
        viewId: 'apps',
        screen: {items: [{kind: 'list', rows: []}]},
      },
      ringing: [],
    };
    let state = phoneRead(
      phoneReady(
        initialPhoneState('mira'),
        ready(
          health(mira),
          askFor('c1', 'reminders'),
          askFor('c2', 'weather', 'nova'),
          tone,
        ),
      ),
      inStore,
    );

    expect(waitingOn(state)).toEqual(new Set(['reminders']));

    state = askRaised(state, askFor('c3', 'notes'));
    expect(waitingOn(state)).toEqual(new Set(['reminders', 'notes']));
    expect(askRaised(state, askFor('c4', 'search', 'nova'))).toBe(state);
    expect(askRaised(state, tone)).toBe(state);

    state = askSettled(state, {
      kind: 'confirmation_settled',
      characterId: 'mira',
      id: 'c1',
      decision: 'approved',
    });
    expect(waitingOn(state)).toEqual(new Set(['notes']));
    expect(
      askSettled(state, {
        kind: 'confirmation_settled',
        characterId: 'nova',
        id: 'c2',
        decision: 'denied',
      }),
    ).toBe(state);

    // Settled while the window's stream was away: the next connection's
    // confirmations no longer hold it.
    expect(waitingOn(phoneReady(state, ready(health(mira))))).toEqual(
      new Set(),
    );

    state = askSettled(state, {
      kind: 'confirmation_settled',
      characterId: 'mira',
      id: 'c3',
      decision: 'denied',
    });
    expect(waitingOn(state)).toEqual(new Set());
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

  it('draws the frame of a window that has none of its own, its pin pressed while the window stays on top, and none for a window with a frame of its own', () => {
    const popup = initialPhoneState('mira');
    const pinned = framed(popup, true);

    expect(popup.frame).toBeUndefined();
    expect(pinned.frame).toEqual({pinned: true});
    expect(framed(pinned, true)).toBe(pinned);
    expect(framed(pinned, false).frame).toEqual({pinned: false});
  });
});
