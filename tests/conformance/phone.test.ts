import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {configJson, createHome} from './harness/home.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  type ModelRequest,
} from './harness/model-server.ts';
import {converse, wireOf} from './harness/wire.ts';

/** The person is where the clocks read UTC, so an alarm's ring lands at a moment the test can name. */
const utc = {TZ: 'UTC'};

async function stop(daemon: Daemon): Promise<void> {
  daemon.signal('SIGINT');
  await daemon.exit();
}

/** Where her phone keeps what its apps save, in Mira's data. */
function phoneData(home: string): string {
  return join(home, 'character-data', 'mira', 'plugin-data', 'phone');
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
    '- On your phone: Clock ("clock") — Alarms, timers, and the time anywhere. Open an app with phone.open to see its screen and what you can do in it, then act in it with phone.use.',
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
  expect(
    JSON.parse(
      readFileSync(join(phoneData(home), 'apps', 'clock.json'), 'utf8'),
    ),
  ).toMatchObject({
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
      'There is no app "weather" on the phone. Your apps: Clock ("clock").',
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
