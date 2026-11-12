import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {
  frameOf,
  nextMoment,
  openEvents,
  own,
  silent,
} from './harness/events.ts';
import {configJson, createHome, sessionRecords} from './harness/home.ts';
import {
  calling,
  finish,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  visibleReply,
  type ModelRequest,
  type ModelServer,
} from './harness/model-server.ts';
import {converse, saveConfig, wireOf, type Wire} from './harness/wire.ts';

/** The person is where the clocks read UTC, so an alarm's ring lands at a moment the test can name. */
const utc = {TZ: 'UTC'};
/** UTC, and a ping each half second the stream is silent: a clock to see no turn begin by. */
const pinging = {...utc, PROJECT02_TEST_DURATIONS: 'ping=500'};
/** Alarm a1's line in her note when it rings late: its ring was set for a long-gone morning. */
const lateAlarm =
  'Clock, Alarm: Wake Sam (set for Monday, January 5, at 07:00).';

async function stop(daemon: Daemon): Promise<void> {
  daemon.signal('SIGINT');
  await daemon.exit();
}

/** Where her phone keeps what its apps save, in Mira's data. */
function phoneData(home: string): string {
  return join(home, 'character-data', 'mira', 'plugin-data', 'phone');
}

/** What the Clock keeps, in its one file. */
function clockOf(home: string): unknown {
  return JSON.parse(
    readFileSync(join(phoneData(home), 'apps', 'clock.json'), 'utf8'),
  );
}

/** A home where Mira answers through `model`, the person goes by Sam and her heartbeat is off; her Clock keeps `clock`, when the test gives it one. */
function quietHome(model: ModelServer, clock?: object): string {
  const phone =
    clock === undefined
      ? {}
      : {
          'plugin-data': {
            phone: {apps: {'clock.json': JSON.stringify(clock)}},
          },
        };

  return createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    'character-data': {
      mira: {
        'config.json': configJson({project02: {heartbeat: 'off'}}),
        ...phone,
      },
    },
  });
}

/** A home where Mira answers through `model`, the person goes by Sam, her heartbeat is off and her settings switch her phone off, whose Clock holds alarm a1 to ring once, its ring long gone. */
function phoneOffHome(model: ModelServer): string {
  return createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    'character-data': {
      mira: {
        'config.json': configJson({
          project02: {heartbeat: 'off'},
          plugins: {phone: {enabled: false}},
        }),
        'plugin-data': {
          phone: {apps: {'clock.json': JSON.stringify(wakeSam([]))}},
        },
      },
    },
  });
}

/** A home where Mira answers through `model`, the person goes by Sam and her heartbeat is off; her Clock holds alarm a1 to ring once, its ring long gone, and Sam said the Clock may not wake her; and Notes, added from a file, does not say it wakes her and keeps a ring of a version that did, long gone too. */
function mutedHome(model: ModelServer): string {
  const notes = {
    id: 'notes',
    name: 'Notes',
    summary: 'What she writes down',
    version: '2.0.0',
    icon: 'doc',
    tint: 'gray',
    wakes: false,
    views: [{id: 'all', title: 'All', icon: 'doc'}],
    opensOn: 'all',
  };

  return createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    'character-data': {
      mira: {
        'config.json': configJson({project02: {heartbeat: 'off'}}),
        'plugin-data': {
          phone: {
            'muted.json': JSON.stringify({apps: ['clock']}),
            'installed.json': JSON.stringify({
              apps: [{...notes, source: 'file'}],
            }),
            apps: {
              'clock.json': JSON.stringify(wakeSam([])),
              'notes.txt': `export const manifest = ${JSON.stringify({format: 'project02.app.v1', ...notes, actions: []})};\nexport function screen() { return {items: []}; }\n`,
              'notes.json': JSON.stringify({
                storage: {},
                rings: [
                  {id: 'n1', at: '2026-01-05T08:00:00.000Z', title: 'Note'},
                ],
              }),
            },
          },
        },
      },
    },
  });
}

/** Her phone switched on in her settings, as her settings page switches it. */
async function switchPhoneOn(wire: Wire): Promise<void> {
  await saveConfig(
    wire,
    {scope: 'character', characterId: 'mira'},
    {kind: 'section_enabled', namespace: 'plugins', id: 'phone', enabled: true},
  );
}

/** The Clock's file as the Clock writes it, holding alarm a1, Wake Sam at 07:00 on `days`, none for once, its ring set for 07:00 on Monday, January 5, 2026, long gone. */
function wakeSam(days: readonly number[]): object {
  return {
    storage: {
      issued: {a: 1},
      alarms: [
        {id: 'a1', hour: 7, minute: 0, label: 'Wake Sam', days, on: true},
      ],
    },
    rings: [
      {
        id: 'a1',
        at: '2026-01-05T07:00:00.000Z',
        title: 'Alarm',
        body: 'Wake Sam',
      },
    ],
  };
}

/** The lines of what the model read where the person's line would be. */
function openingOf(request: ModelRequest | undefined): readonly string[] {
  return String(messagesOf(request).at(-1)?.content).split('\n');
}

/** Her phone ringing as the model reads it where a line would be, what rang a line each. */
function ringing(...rang: readonly string[]): readonly string[] {
  return [
    '<moment_of_your_own>',
    'Your phone is ringing — nobody has written to you, and nothing here is something Sam said.',
    expect.stringMatching(/^It is .+\.$/u) as string,
    ...rang,
    'What you do about it is yours. If there is something you want Sam to read, send it with visible_reply; anything else you write stays your own thought.',
    '</moment_of_your_own>',
  ];
}

/** The lines of the system messages the model was shown. */
function systemLines(request: ModelRequest | undefined): readonly string[] {
  return messagesOf(request)
    .filter(message => message.role === 'system')
    .flatMap(message => String(message.content).split('\n'));
}

it('phone.clock-alarm: she opens the Clock and is shown its views, its actions and its screen, then sets an alarm and is shown its answer and the screen with the alarm on it; every request names her apps, the Clock keeps the alarm and its ring in its one file, and after a restart the Clock opens with the alarm still there', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const first = await startDaemon(home, utc);
  const say = await converse(wireOf(first), 'mira');
  const someDay = /^(?:today|tomorrow)$/u;

  model.answer(
    calling(['phone_open', {app: 'clock'}]),
    calling([
      'phone_use',
      {
        app: 'clock',
        action: 'set_alarm',
        input: {hour: 7, minute: 0, label: 'Wake Sam'},
      },
    ]),
    reply('Set for seven.'),
  );
  expect(await say('Wake me at seven.', 'wake')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Set for seven.'}],
  });
  expect(systemLines(model.requests[0])).toContain(
    '- On your phone: Clock ("clock") — Alarms, timers, and the time anywhere; App Store ("store") — More apps, each reviewed by Project02. Open an app with phone.open to see its screen and what you can do in it, then act in it with phone.use.',
  );

  const [opened, used] = toolResults(model.requests[2]);
  const {actions} = (
    opened as {
      readonly output: {readonly actions: readonly {readonly name: string}[]};
    }
  ).output;

  expect(opened).toMatchObject({
    status: 'accepted',
    toolName: 'phone.open',
    output: {
      app: 'clock',
      name: 'Clock',
      view: 'alarms',
      views: [
        {id: 'world', title: 'World Clock'},
        {id: 'alarms', title: 'Alarms'},
        {id: 'stopwatch', title: 'Stopwatch'},
        {id: 'timers', title: 'Timers'},
      ],
      screen: {items: [{kind: 'text', text: 'No Alarms'}]},
    },
  });
  expect(actions.map(action => action.name)).toEqual([
    'set_alarm',
    'change_alarm',
    'delete_alarm',
    'start_timer',
    'cancel_timer',
    'start_stopwatch',
    'stop_stopwatch',
    'lap_stopwatch',
    'reset_stopwatch',
    'add_city',
    'remove_city',
  ]);
  expect(actions[0]).toMatchObject({
    description:
      'Set an alarm for a time of day, ringing once or on the days you give.',
    input: {
      type: 'object',
      required: ['hour', 'minute'],
      additionalProperties: false,
    },
  });
  expect(used).toMatchObject({
    status: 'accepted',
    toolName: 'phone.use',
    output: {
      answer: {
        id: 'a1',
        time: '7:00 AM',
        label: 'Wake Sam',
        repeats: 'never',
        on: true,
        rings: expect.stringMatching(someDay) as string,
      },
      view: 'alarms',
      screen: {
        items: [
          {
            kind: 'list',
            rows: [
              {
                id: 'a1',
                time: '7:00 AM',
                subtitle: expect.stringMatching(
                  /^Wake Sam, (?:today|tomorrow)$/u,
                ) as string,
                switch: true,
              },
            ],
          },
        ],
      },
    },
  });
  expect(clockOf(home)).toMatchObject({
    storage: {
      alarms: [
        {id: 'a1', hour: 7, minute: 0, label: 'Wake Sam', days: [], on: true},
      ],
    },
    rings: [
      {
        id: 'a1',
        at: expect.stringMatching(/T07:00:00\.000Z$/u) as string,
        title: 'Alarm',
        body: 'Wake Sam',
      },
    ],
  });
  await stop(first);

  const again = await converse(wireOf(await startDaemon(home, utc)), 'mira');

  model.answer(
    calling(['phone_open', {app: 'clock', view: 'alarms'}]),
    reply('Still set.'),
  );
  await again('Is my alarm still on?', 'still');
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    status: 'accepted',
    output: {
      view: 'alarms',
      screen: {
        items: [
          {kind: 'list', rows: [{id: 'a1', time: '7:00 AM', switch: true}]},
        ],
      },
    },
  });
});

it("phone.refusals: what her phone refuses she reads as its sentence with what there is instead: an app not on her phone with her apps, a view the app has not with its views, an action it has not with its actions, and input the action's contract refuses as the contract says it; the turn goes on to its reply, and nothing is saved", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const say = await converse(wireOf(await startDaemon(home)), 'mira');
  const refused = (toolName: string, reason: string, message: string) => ({
    status: 'rejected',
    pluginId: 'phone',
    toolName,
    reason,
    message,
  });

  model.answer(
    calling(
      ['phone_open', {app: 'weather'}],
      ['phone_open', {app: 'clock', view: 'calendar'}],
      ['phone_use', {app: 'clock', action: 'snooze'}],
      [
        'phone_use',
        {app: 'clock', action: 'set_alarm', input: {hour: 25, minute: 0}},
      ],
    ),
    reply('My phone would not.'),
  );
  expect(await say('Wake me at 25:00.', 'refused')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'My phone would not.'}],
  });
  expect(toolResults(model.requests.at(-1))).toEqual([
    refused(
      'phone.open',
      'app_not_found',
      'There is no app "weather" on the phone. Your apps: Clock ("clock"), App Store ("store").',
    ),
    refused(
      'phone.open',
      'view_not_found',
      'Clock has no view "calendar". Its views: world, alarms, stopwatch, timers.',
    ),
    refused(
      'phone.use',
      'action_not_found',
      'Clock has no action "snooze". Its actions: set_alarm, change_alarm, delete_alarm, start_timer, cancel_timer, start_stopwatch, stop_stopwatch, lap_stopwatch, reset_stopwatch, add_city, remove_city.',
    ),
    refused(
      'phone.use',
      'invalid_input',
      'Clock cannot take that: set_alarm input field "hour" is refused: its value is greater than the maximum of 23.',
    ),
  ]);
  expect(existsSync(phoneData(home))).toBe(false);
});

it("phone.ring-wakes-her: a timer she starts rings when it ends: a turn of her own begins, with no line's stamps, its request opening with the note that her phone is ringing and naming the Clock's timer; what she writes in it is hers on the stream, and after it the Clock's file holds no ring and no running timer", async () => {
  const model = await startModelServer();
  const home = quietHome(model);
  const daemon = await startDaemon(home);
  const events = await openEvents(daemon);
  const say = await converse(wireOf(daemon), 'mira');

  model.answer(
    calling([
      'phone_use',
      {app: 'clock', action: 'start_timer', input: {seconds: 1}},
    ]),
    reply('A second, starting now.'),
    {chunks: [...visibleReply('Your second is up.'), finish('tool_calls')]},
  );
  await say('Give me a second.', 'second');

  const moment = await nextMoment(events);

  expect(openingOf(model.requests.at(-1))).toEqual(
    ringing(
      expect.stringMatching(
        /^Clock, Timer: 1 sec \(set for [^)]+\)\.$/u,
      ) as string,
    ),
  );
  expect(
    moment.filter(
      frameOf('turn_progress', {
        progress: {
          kind: 'visible_reply',
          speakerId: 'mira',
          text: 'Your second is up.',
        },
      }),
    ),
  ).toHaveLength(1);
  expect(moment.at(-1)).toSatisfy(
    frameOf('turn_completed', {status: 'completed'}),
  );
  expect(clockOf(home)).toMatchObject({storage: {timers: []}, rings: []});
});

it('phone.late-ring: a ring that came due while she was not running rings at her start, in a turn of her own whose note says when it was set for and whose event keeps what rang; once it completes, the repeating alarm is still on, its ring set for a day yet to come', async () => {
  const model = await startModelServer();
  const home = quietHome(model, wakeSam([1, 2, 3, 4, 5, 6, 7]));
  const asked = model.hold();
  const daemon = await startDaemon(home, utc);
  const request = await asked.arrived();
  const events = await openEvents(daemon);

  expect(openingOf(request)).toEqual(ringing(lateAlarm));
  asked.release(reply('Up you get, Sam.'));
  expect(await events.next(own('turn_completed'))).toSatisfy(
    frameOf('turn_completed', {status: 'completed'}),
  );

  const [event] = sessionRecords(home, 'mira', 'runtime_event_received');
  const clock = clockOf(home) as {
    readonly rings: readonly {readonly at: string}[];
  };

  expect(event).toMatchObject({
    occasion: 'moment',
    rang: [
      {
        app: 'Clock',
        title: 'Alarm',
        body: 'Wake Sam',
        at: '2026-01-05T07:00:00.000Z',
      },
    ],
  });
  expect(clock).toMatchObject({
    storage: {alarms: [{id: 'a1', on: true}]},
    rings: [
      {
        id: 'a1',
        title: 'Alarm',
        at: expect.stringMatching(/T07:00:00\.000Z$/u) as string,
      },
    ],
  });
  // Its day against the day she rang: no wall clock that steps back moves a
  // day, as it can move a moment.
  expect(
    Date.parse(clock.rings[0]?.at.slice(0, 10) ?? ''),
  ).toBeGreaterThanOrEqual(
    Date.parse(String(event?.['createdAt']).slice(0, 10)),
  );
});

it("phone.ring-kept: a ring whose turn the model fails stays set and begins no other turn by itself; once a turn of hers completes, here the person's, a turn of her own rings it again, and then it is gone", async () => {
  const model = await startModelServer();
  const home = quietHome(model, wakeSam([]));
  const asked = model.hold();
  const daemon = await startDaemon(home, pinging);

  await asked.arrived();

  const events = await openEvents(daemon);

  asked.release({status: 401, body: {error: {message: 'Who are you?'}}});
  expect(await events.next(own('turn_completed'))).toSatisfy(
    frameOf('turn_completed', {status: 'rejected', reason: 'provider_error'}),
  );

  const failed = events.frames.length;

  await silent(events, 2);
  expect(events.frames.slice(failed).filter(own('turn_running'))).toEqual([]);
  expect(clockOf(home)).toMatchObject(wakeSam([]));

  const say = await converse(wireOf(daemon), 'mira');

  model.answer(reply('Morning, Sam.'), reply('There it goes again.'));
  await say('Morning.', 'morning');
  expect(await events.next(own('turn_completed'))).toSatisfy(
    frameOf('turn_completed', {status: 'completed'}),
  );
  expect(openingOf(model.requests.at(-1))).toEqual(ringing(lateAlarm));
  expect(clockOf(home)).toMatchObject({
    storage: {alarms: [{id: 'a1', on: false}]},
    rings: [],
  });
});

it('phone.switched-on: while her settings switch her phone off, a ring that came due on it begins no turn; once they switch it on, the ring rings at once, in a turn of her own', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(phoneOffHome(model), pinging);
  const events = await openEvents(daemon);

  await silent(events, 2);
  expect(events.frames.filter(own('turn_running'))).toEqual([]);
  expect(model.requests).toEqual([]);

  model.answer(reply('Up you get, Sam.'));
  await switchPhoneOn(wireOf(daemon));
  expect(await events.next(own('turn_completed'))).toSatisfy(
    frameOf('turn_completed', {status: 'completed'}),
  );
  expect(openingOf(model.requests.at(-1))).toEqual(ringing(lateAlarm));
});

it('phone.may-not-wake: while Sam says the Clock may not wake her, its ring long due begins no turn of hers, her phone reads that it may not, and her note says so beside its name; a ring an app keeps that does not say it wakes her is told to her by nothing either; once Sam lets the Clock, its ring rings at once, late, in a turn of her own, alone', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(mutedHome(model), pinging);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'mira');

  await silent(events, 2);
  expect(events.frames.filter(own('turn_running'))).toEqual([]);
  expect(model.requests).toEqual([]);
  expect(await wire.phone('mira')).toMatchObject({
    status: 'ok',
    apps: [
      {id: 'clock', wakes: true, mayWake: false},
      {id: 'notes', wakes: false},
      {id: 'store'},
    ],
    ringing: [],
  });

  model.answer(reply('Morning, Sam.'));
  await say('Morning.', 'morning');
  expect(systemLines(model.requests[0])).toContain(
    '- On your phone: Clock ("clock", which Sam said may not wake you) — Alarms, timers, and the time anywhere; Notes ("notes") — What she writes down; App Store ("store") — More apps, each reviewed by Project02. Open an app with phone.open to see its screen and what you can do in it, then act in it with phone.use.',
  );

  model.answer(reply('Up you get, Sam.'));
  expect(await wire.letAppWake('mira', 'clock', true)).toEqual({status: 'ok'});
  expect(await events.next(own('turn_completed'))).toSatisfy(
    frameOf('turn_completed', {status: 'completed'}),
  );
  expect(openingOf(model.requests.at(-1))).toEqual(ringing(lateAlarm));
});

it("phone.on-the-wire: a client reads her phone: before she touches it, her apps, the Clock with its icon, tint, views and what it may do, and nothing in front, done or ringing; once she opens the Clock and sets an alarm, the stream has named her phone as the plugin of each call and said her phone changed after each, and her phone has the Alarms view in front with the alarm on its screen and what she did in the action's words; a view she is not on, read on request, shows its screen and leaves her phone as it was; a character, an app and a view that are not there are each refused in a sentence", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: model.settings})}),
  );
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'mira');
  const clock = {
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
  const store = {
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

  expect(await wire.phone('mira')).toEqual({
    status: 'ok',
    apps: [clock, store],
    ringing: [],
  });

  model.answer(
    calling(['phone_open', {app: 'clock'}]),
    calling([
      'phone_use',
      {
        app: 'clock',
        action: 'set_alarm',
        input: {hour: 7, minute: 0, label: 'Wake Sam'},
      },
    ]),
    reply('Set for seven.'),
  );
  await say('Wake me at seven.', 'wake');

  const ended = await events.next(
    frameOf('turn_completed', {clientMessageId: 'wake'}),
  );
  const said = events.frames.slice(0, events.frames.indexOf(ended));
  const phone = await wire.phone('mira');

  expect(
    said.filter(
      frameOf('turn_progress', {
        progress: {kind: 'tool_call_completed', pluginId: 'phone'},
      }),
    ),
  ).toHaveLength(2);
  expect(
    said.filter(frameOf('phone_changed', {characterId: 'mira'})),
  ).toHaveLength(2);
  expect(phone).toEqual({
    status: 'ok',
    apps: [clock, store],
    front: {
      appId: 'clock',
      viewId: 'alarms',
      screen: {
        items: [
          {
            kind: 'list',
            rows: [
              {
                id: 'a1',
                time: '7:00 AM',
                subtitle: expect.stringMatching(
                  /^Wake Sam, (?:today|tomorrow)$/u,
                ) as string,
                switch: true,
              },
            ],
          },
        ],
      },
    },
    did: {
      appId: 'clock',
      words: 'Set an alarm',
      at: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
      ) as string,
    },
    ringing: [],
  });
  expect(await wire.phoneScreen('mira', 'clock', 'world')).toEqual({
    status: 'ok',
    screen: {items: [{kind: 'text', text: 'No World Clocks'}]},
  });
  expect(await wire.phone('mira')).toEqual(phone);
  expect(await wire.phone('nova')).toEqual({
    status: 'refused',
    reason: 'unknown_character',
    message: 'Character "nova" was not found; the characters are mira.',
  });
  expect(await wire.phoneScreen('mira', 'weather', 'today')).toEqual({
    status: 'refused',
    reason: 'unknown_app',
    message: 'There is no app "weather" on the phone.',
  });
  expect(await wire.phoneScreen('mira', 'clock', 'calendar')).toEqual({
    status: 'refused',
    reason: 'unknown_view',
    message: 'Clock has no view "calendar".',
  });
});

it('phone.ring-on-the-wire: while her settings switch her phone off, her phone is refused in a sentence; once they switch it on and its ring begins a moment of hers, the stream says her phone changed, and while the moment runs her phone says what rings; once it ends, the stream says her phone changed again before the turn ends, and nothing rings', async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(phoneOffHome(model));
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const changed = frameOf('phone_changed', {characterId: 'mira'});

  await wire.start('mira');
  expect(await wire.phone('mira')).toEqual({
    status: 'refused',
    reason: 'no_phone',
    message: 'Mira has no phone: her settings switch it off.',
  });

  const asked = model.hold();

  await switchPhoneOn(wire);
  await asked.arrived();
  await events.next(changed);
  expect(await wire.phone('mira')).toMatchObject({
    status: 'ok',
    ringing: [
      {
        appName: 'Clock',
        title: 'Alarm',
        body: 'Wake Sam',
        at: '2026-01-05T07:00:00.000Z',
      },
    ],
  });

  asked.release(reply('Up you get, Sam.'));
  await events.next(changed);
  expect(await events.next(own('turn_completed'))).toSatisfy(
    frameOf('turn_completed', {status: 'completed'}),
  );
  expect(await wire.phone('mira')).toMatchObject({status: 'ok', ringing: []});
});
