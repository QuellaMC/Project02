import {readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {
  entryOf,
  fileOf,
  lookup,
  publish,
  quiet,
  reminders,
  type App,
} from './harness/apps.ts';
import {startCatalogServer} from './harness/catalog-server.ts';
import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Frame} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
import {exchange, jsonFrom} from './harness/http.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  type ModelRequest,
  type ModelServer,
} from './harness/model-server.ts';
import {converse, saveConfig, wireOf} from './harness/wire.ts';

const mira = {scope: 'character', characterId: 'mira'} as const;

/** A home where Mira answers through `model`, the person goes by Sam, her heartbeat is off, and `installed` is on her phone from the store, as her phone keeps an app installed. */
function storeHome(model: ModelServer, ...installed: readonly App[]): string {
  const listed = installed.map(({manifest}) => ({
    id: manifest.id,
    name: manifest.name,
    summary: manifest.summary,
    version: manifest.version,
    icon: manifest.icon,
    tint: manifest.tint,
    wakes: manifest.wakes,
    views: manifest.views,
    opensOn: manifest.opensOn,
    source: 'catalog',
  }));

  return createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    'character-data': {
      mira: {
        'config.json': configJson({project02: {heartbeat: 'off'}}),
        'plugin-data': {
          phone: {
            'installed.json': JSON.stringify({apps: listed}),
            apps: Object.fromEntries(
              installed.map(app => [`${app.manifest.id}.txt`, fileOf(app)]),
            ),
          },
        },
      },
    },
  });
}

/** Where her phone keeps its files, in Mira's data. */
function phoneData(home: string): string {
  return join(home, 'character-data', 'mira', 'plugin-data', 'phone');
}

/** `app` at `version`, the rest of it as it is. */
function at(app: App, version: string): App {
  return {...app, manifest: {...app.manifest, version}};
}

/** The ids of her apps, as a client reads her phone. */
function appsOf(phone: unknown): readonly string[] {
  return (phone as {readonly apps: readonly {readonly id: string}[]}).apps.map(
    app => app.id,
  );
}

/** The lines of the system messages the model was shown. */
function systemLines(request: ModelRequest | undefined): readonly string[] {
  return messagesOf(request)
    .filter(message => message.role === 'system')
    .flatMap(message => String(message.content).split('\n'));
}

function toolNames(request: ModelRequest | undefined): readonly string[] {
  return (
    request?.body as {
      readonly tools: readonly {readonly function: {readonly name: string}}[];
    }
  ).tools.map(tool => tool.function.name);
}

function confirmationId(frame: Frame): string {
  return (JSON.parse(frame.data ?? '') as {readonly id: string}).id;
}

it('store.look-through: before she opens the App Store a look at it says so; her note names it; her opening it reads the catalog and lists its apps, each with whether it is on her phone; show_app answers what one is and may do and turns her phone to its page, which a client reads as what she has in front without a request reaching the catalog; with the catalog out of reach her open says so, the store still shows what it showed, and the Clock still opens', async () => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();
  const notes = quiet('notes', 'Notes', '1.1.0');

  publish(catalog, [reminders], [notes]);

  const daemon = await startDaemon(
    storeHome(model, quiet('notes', 'Notes', '1.0.0')),
    catalog.env,
  );
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const page = {
    items: [
      {
        kind: 'app',
        id: 'reminders',
        tile: {icon: 'list', tint: 'orange'},
        name: 'Reminders',
        subtitle: 'Reviewed · Project02 Apps',
        status: 'Not on her phone',
      },
      {kind: 'text', text: 'Things to do, on a day and time'},
      {
        kind: 'list',
        header: 'It may',
        rows: [
          {title: 'Keep its own data'},
          {title: 'Wake her when something is due'},
        ],
      },
      {
        kind: 'list',
        header: "What's New",
        rows: [{caption: 'Version 1.0.0', title: 'The first version.'}],
      },
    ],
    page: 'reminders',
  };

  expect(await wire.phoneScreen('mira', 'store', 'apps')).toEqual({
    status: 'ok',
    screen: {
      items: [
        {kind: 'text', text: 'The App Store shows its apps once she opens it.'},
      ],
    },
  });

  model.answer(
    calling(['phone_open', {app: 'store'}]),
    calling([
      'phone_use',
      {app: 'store', action: 'show_app', input: {app: 'reminders'}},
    ]),
    reply('Reminders looks useful.'),
  );
  await say('Anything good in the App Store?', 'look');

  expect(systemLines(model.requests[0])).toContain(
    '- On your phone: Clock ("clock") — Alarms, timers, and the time anywhere; Notes ("notes") — Notes, quietly; App Store ("store") — More apps, each reviewed by Project02. Open an app with phone.open to see its screen and what you can do in it, then act in it with phone.use.',
  );
  expect(toolResults(model.requests[2])).toMatchObject([
    {
      status: 'accepted',
      toolName: 'phone.open',
      output: {
        app: 'store',
        name: 'App Store',
        view: 'apps',
        actions: [{name: 'show_app'}],
        screen: {
          items: [
            {
              kind: 'list',
              header: 'Reviewed by Project02',
              rows: [
                {
                  id: 'reminders',
                  tile: {icon: 'list', tint: 'orange'},
                  title: 'Reminders',
                  subtitle: 'Things to do, on a day and time',
                },
                {
                  id: 'notes',
                  tile: {icon: 'doc', tint: 'gray'},
                  title: 'Notes',
                  subtitle: 'Notes, quietly',
                  value: 'Update',
                },
              ],
            },
          ],
        },
      },
    },
    {
      status: 'accepted',
      toolName: 'phone.use',
      output: {
        answer: {
          app: 'reminders',
          name: 'Reminders',
          summary: 'Things to do, on a day and time',
          version: '1.0.0',
          changes: 'The first version.',
          itMay: ['Keep its own data', 'Wake her when something is due'],
          status: 'Not on her phone',
        },
        view: 'apps',
        screen: page,
      },
    },
  ]);

  const asked = catalog.requests.length;

  expect(await wire.phone('mira')).toMatchObject({
    status: 'ok',
    front: {appId: 'store', viewId: 'apps', screen: page},
  });
  expect(catalog.requests).toHaveLength(asked);

  catalog.away();
  model.answer(
    calling(['phone_open', {app: 'store'}], ['phone_open', {app: 'clock'}]),
    reply('The store is closed.'),
  );
  await say('And now?', 'again');

  expect(toolResults(model.requests.at(-1)).slice(2)).toMatchObject([
    {
      status: 'rejected',
      toolName: 'phone.open',
      reason: 'store_unavailable',
      message: 'The App Store cannot be reached right now.',
    },
    {status: 'accepted', toolName: 'phone.open', output: {app: 'clock'}},
  ]);
  expect(await wire.phoneScreen('mira', 'store', 'apps')).toEqual({
    status: 'ok',
    screen: page,
  });
});

it('store.install-approved: phone_install asks the person first, its preview saying what would be installed, and her phone holds nothing new while it waits; on approval the app is among her apps, the stream says her phone changed, the store lists it Installed, and in the same turn she opens it and uses it', async () => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();

  publish(catalog, [reminders]);

  const daemon = await startDaemon(storeHome(model), catalog.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'mira');

  model.answer(
    calling(['phone_open', {app: 'store'}]),
    calling(['phone_install', {app: 'reminders'}]),
    calling(['phone_open', {app: 'reminders'}]),
    calling([
      'phone_use',
      {app: 'reminders', action: 'add', input: {title: 'Call the dentist'}},
    ]),
    reply('It is on my phone now.'),
  );

  const turn = say('Get a reminders app.', 'get');
  const asked = await events.next(frameOf('confirmation_requested'));

  expect(JSON.parse(asked.data ?? '')).toMatchObject({
    characterId: 'mira',
    request: {
      pluginId: 'phone',
      toolName: 'phone.install',
      preview: {
        kind: 'phone_app_install',
        app: {
          id: 'reminders',
          name: 'Reminders',
          summary: 'Things to do, on a day and time',
          icon: 'list',
          tint: 'orange',
          version: '1.0.0',
          wakes: true,
          reachesInternet: false,
        },
        source: 'catalog',
      },
    },
  });
  expect(appsOf(await wire.phone('mira'))).toEqual(['clock', 'store']);
  expect(await wire.answer(confirmationId(asked), 'approved')).toEqual({
    status: 'answered',
  });
  expect(await turn).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'It is on my phone now.'}],
  });
  expect(appsOf(await wire.phone('mira'))).toEqual([
    'clock',
    'reminders',
    'store',
  ]);

  const said = events.frames.filter(frame => frame.comment === undefined);
  const installed = said.findIndex(
    frameOf('turn_progress', {
      progress: {
        kind: 'tool_call_completed',
        toolName: 'phone.install',
        status: 'accepted',
      },
    }),
  );

  expect(said[installed + 1]).toSatisfy(
    frameOf('phone_changed', {characterId: 'mira'}),
  );
  expect(await wire.phoneScreen('mira', 'store', 'apps')).toMatchObject({
    status: 'ok',
    screen: {
      items: [{kind: 'list', rows: [{id: 'reminders', value: 'Installed'}]}],
    },
  });
  expect(toolResults(model.requests.at(-1)).slice(1)).toMatchObject([
    {
      status: 'accepted',
      toolName: 'phone.install',
      output: {
        status: 'installed',
        app: 'reminders',
        version: '1.0.0',
        message:
          'Reminders is on your phone now: you can open it with phone.open.',
      },
    },
    {
      status: 'accepted',
      toolName: 'phone.open',
      output: {
        app: 'reminders',
        screen: {items: [{kind: 'text', text: 'No Reminders'}]},
      },
    },
    {
      status: 'accepted',
      toolName: 'phone.use',
      output: {
        answer: {title: 'Call the dentist'},
        screen: {items: [{kind: 'list', rows: [{title: 'Call the dentist'}]}]},
      },
    },
  ]);
});

it("store.not-installed: a denied ask, whose preview says the app reaches the internet on the person's Tavily account, leaves her phone as it was and she reads the host's refusal; an app the store does not have, the Clock, the store itself, an app whose file does not match its SHA-256 and one already on her phone are each refused to her in a sentence with nobody asked; with Ask to Install Apps off she is offered no such tool and still opens the store", async () => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();
  const notes = quiet('notes', 'Notes', '1.0.0');
  const broken = quiet('broken', 'Broken', '1.0.0');

  publish(
    catalog,
    [lookup],
    [notes],
    [broken, entryOf(broken, 'another file')],
  );

  const daemon = await startDaemon(storeHome(model, notes), catalog.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'mira');
  const refused = (reason: string, message: string) => ({
    status: 'rejected',
    pluginId: 'phone',
    toolName: 'phone.install',
    reason,
    message,
  });

  model.answer(
    calling(['phone_install', {app: 'lookup'}]),
    reply('Never mind.'),
  );

  const denied = say('Get lookup.', 'denied');
  const asked = await events.next(frameOf('confirmation_requested'));

  expect(JSON.parse(asked.data ?? '')).toMatchObject({
    request: {
      preview: {
        kind: 'phone_app_install',
        app: {
          id: 'lookup',
          wakes: false,
          reachesInternet: true,
          account: 'Tavily',
        },
      },
    },
  });
  expect(await wire.answer(confirmationId(asked), 'denied')).toEqual({
    status: 'answered',
  });
  await denied;
  expect(toolResults(model.requests.at(-1))).toEqual([
    refused(
      'approval_denied',
      'Tool "phone.install" was denied by the user, so it did nothing.',
    ),
  ]);
  expect(appsOf(await wire.phone('mira'))).toEqual(['clock', 'notes', 'store']);

  model.answer(
    calling(
      ['phone_install', {app: 'weather'}],
      ['phone_install', {app: 'clock'}],
      ['phone_install', {app: 'store'}],
      ['phone_install', {app: 'broken'}],
      ['phone_install', {app: 'notes'}],
    ),
    reply('None of those.'),
  );
  await say('Get anything.', 'anything');
  expect(toolResults(model.requests.at(-1)).slice(1)).toEqual([
    refused(
      'not_in_store',
      'There is no app "weather" in the App Store. Its apps: Lookup ("lookup"), Notes ("notes"), Broken ("broken").',
    ),
    refused(
      'comes_with_phone',
      'Clock comes with your phone: there is nothing to install.',
    ),
    refused(
      'comes_with_phone',
      'App Store comes with your phone: there is nothing to install.',
    ),
    refused(
      'app_not_as_listed',
      'Broken in the App Store does not match its listing, so it cannot be installed.',
    ),
    refused('already_installed', 'Notes 1.0.0 is on your phone already.'),
  ]);
  expect(events.frames.filter(frameOf('confirmation_requested'))).toHaveLength(
    1,
  );

  await saveConfig(wire, mira, {
    kind: 'section_field_set',
    namespace: 'plugins',
    id: 'phone',
    field: 'askToInstall',
    value: false,
  });
  model.answer(calling(['phone_open', {app: 'store'}]), reply('Just looking.'));
  await say('Just look.', 'look');

  const offered = toolNames(model.requests.at(-2));

  expect(offered).toContain('phone_open');
  expect(offered).not.toContain('phone_install');
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    status: 'accepted',
    toolName: 'phone.open',
    output: {app: 'store'},
  });
});

it("store.her-apps: a client reads each of her apps with the line she knows it by, its version, where it came from, whether it says it wakes her and whether the person lets it, which the person says for an app that wakes her and no other; the App Store's catalog for the person lists each app as its page there says it, with how it stands on her phone, and refuses a character nobody has as reading her phone does; with the catalog out of reach that is a failure in a sentence, and her phone still reads", async () => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();

  publish(catalog, [reminders], [quiet('notes', 'Notes', '1.1.0')]);

  const daemon = await startDaemon(
    storeHome(model, quiet('notes', 'Notes', '1.0.0')),
    catalog.env,
  );
  const wire = wireOf(daemon);
  const listed = (
    id: string,
    summary: string,
    source: string,
    wakes: boolean,
    mayWake = true,
  ) => ({id, summary, version: '1.0.0', source, wakes, mayWake});

  expect(await wire.letAppWake('mira', 'clock', false)).toEqual({
    status: 'ok',
  });
  expect(await wire.letAppWake('mira', 'notes', false)).toEqual({
    status: 'refused',
    reason: 'cannot_wake',
    message: 'Notes cannot wake her, so there is nothing to change.',
  });
  expect(await wire.phone('mira')).toMatchObject({
    status: 'ok',
    apps: [
      listed(
        'clock',
        'Alarms, timers, and the time anywhere',
        'built_in',
        true,
        false,
      ),
      listed('notes', 'Notes, quietly', 'catalog', false),
      listed(
        'store',
        'More apps, each reviewed by Project02',
        'built_in',
        false,
      ),
    ],
  });
  expect(await wire.phoneStore('mira')).toEqual({
    status: 'ok',
    apps: [
      {
        id: 'reminders',
        name: 'Reminders',
        summary: 'Things to do, on a day and time',
        icon: 'list',
        tint: 'orange',
        version: '1.0.0',
        changes: 'The first version.',
        wakes: true,
        itMay: ['Keep its own data', 'Wake her when something is due'],
        status: 'not_on_phone',
      },
      {
        id: 'notes',
        name: 'Notes',
        summary: 'Notes, quietly',
        icon: 'doc',
        tint: 'gray',
        version: '1.1.0',
        changes: 'The first version.',
        wakes: false,
        itMay: ['Keep its own data'],
        status: 'update',
      },
    ],
  });
  expect(await wire.phoneStore('nova')).toEqual({
    status: 'refused',
    reason: 'unknown_character',
    message: 'Character "nova" was not found; the characters are mira.',
  });

  catalog.away();
  expect(await wire.phoneStore('mira')).toEqual({
    status: 'failed',
    message: 'The App Store cannot be reached right now.',
  });
  expect(await wire.phone('mira')).toMatchObject({status: 'ok'});
});

it('store.person-gives: the person gives her an app of the App Store and nobody is asked: it is on her phone from the catalog, the stream says her phone changed, her next note names it and she uses it; given again it is refused as on her phone already; once the store lists a newer version, giving it again replaces hers, and what it kept is still there', async () => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();

  publish(catalog, [reminders]);

  const daemon = await startDaemon(storeHome(model), catalog.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'mira');

  expect(await wire.installApp('mira', 'reminders')).toEqual({
    status: 'ok',
    app: {
      id: 'reminders',
      name: 'Reminders',
      summary: 'Things to do, on a day and time',
      version: '1.0.0',
      source: 'catalog',
      icon: 'list',
      tint: 'orange',
      wakes: true,
      mayWake: true,
      itMay: ['Keep its own data', 'Wake her when something is due'],
      views: [{id: 'all', title: 'All', icon: 'list'}],
      opensOn: 'all',
    },
  });
  await events.next(frameOf('phone_changed', {characterId: 'mira'}));
  expect(events.frames.filter(frameOf('confirmation_requested'))).toEqual([]);

  model.answer(
    calling([
      'phone_use',
      {app: 'reminders', action: 'add', input: {title: 'Call the dentist'}},
    ]),
    reply('Noted.'),
  );
  await say('Remind me to call the dentist.', 'dentist');
  expect(systemLines(model.requests[0])).toContain(
    '- On your phone: Clock ("clock") — Alarms, timers, and the time anywhere; Reminders ("reminders") — Things to do, on a day and time; App Store ("store") — More apps, each reviewed by Project02. Open an app with phone.open to see its screen and what you can do in it, then act in it with phone.use.',
  );
  expect(toolResults(model.requests[1])).toMatchObject([
    {
      status: 'accepted',
      toolName: 'phone.use',
      output: {answer: {title: 'Call the dentist'}},
    },
  ]);
  expect(await wire.installApp('mira', 'reminders')).toEqual({
    status: 'refused',
    reason: 'already_installed',
    message: 'Reminders 1.0.0 is on her phone already.',
  });

  publish(catalog, [at(reminders, '1.1.0')]);
  expect(await wire.installApp('mira', 'reminders')).toMatchObject({
    status: 'ok',
    app: {id: 'reminders', version: '1.1.0', source: 'catalog'},
    replaced: '1.0.0',
  });
  expect(await wire.phoneScreen('mira', 'reminders', 'all')).toEqual({
    status: 'ok',
    screen: {items: [{kind: 'list', rows: [{title: 'Call the dentist'}]}]},
  });
});

it("store.from-a-file: the person adds an app from a file nobody read: its preview says what it is, what it may do and the version of hers it would replace, and writes nothing; adding it puts it on her phone from a file in place of the App Store's, the file longer than any other body the daemon reads, and the App Store's older version of it then stands as installed and is not given over it; a file that makes no app, one under the Clock's id and one past what a text file holds are each refused in a sentence", async () => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();

  publish(catalog, [quiet('notes', 'Notes', '1.0.0')]);

  const daemon = await startDaemon(
    storeHome(model, quiet('notes', 'Notes', '1.0.0')),
    catalog.env,
  );
  const wire = wireOf(daemon);
  const notes = quiet('notes', 'Notes', '2.0.0');
  // Past the 64 KiB every other body is held to, within what a text file holds.
  const file = `${fileOf(notes)}// ${'x'.repeat(70 * 1024)}\n`;
  const withNotes = (version: string, source: string) => ({
    status: 'ok',
    apps: [{id: 'clock'}, {id: 'notes', version, source}, {id: 'store'}],
  });
  const named = (manifest: Partial<App['manifest']>) =>
    fileOf({...notes, manifest: {...notes.manifest, ...manifest}});

  expect(await wire.previewApp('mira', file)).toEqual({
    status: 'ok',
    id: 'notes',
    name: 'Notes',
    summary: 'Notes, quietly',
    icon: 'doc',
    tint: 'gray',
    version: '2.0.0',
    wakes: false,
    itMay: ['Keep its own data'],
    replaces: '1.0.0',
  });
  expect(await wire.phone('mira')).toMatchObject(withNotes('1.0.0', 'catalog'));
  expect(await wire.addApp('mira', file)).toMatchObject({
    status: 'ok',
    app: {id: 'notes', version: '2.0.0', source: 'file'},
    replaced: '1.0.0',
  });
  expect(await wire.phone('mira')).toMatchObject(withNotes('2.0.0', 'file'));
  expect(await wire.phoneStore('mira')).toMatchObject({
    status: 'ok',
    apps: [{id: 'notes', version: '1.0.0', status: 'installed'}],
  });
  expect(await wire.installApp('mira', 'notes')).toEqual({
    status: 'refused',
    reason: 'already_installed',
    message: 'Notes 2.0.0 is on her phone already.',
  });

  expect(await wire.previewApp('mira', named({name: ' '}))).toEqual({
    status: 'refused',
    reason: 'not_an_app',
    message: 'Manifest name must not be blank.',
  });
  expect(
    await wire.addApp('mira', named({id: 'clock', name: 'My Clock'})),
  ).toEqual({
    status: 'refused',
    reason: 'comes_with_phone',
    message: 'The phone comes with an app of the same id, Clock.',
  });

  const past = await exchange(daemon, {
    method: 'POST',
    path: '/api/characters/mira/phone/apps',
    headers: jsonFrom(daemon),
    body: 'x'.repeat(256 * 1024 + 1),
  });

  expect(past.status).toBe(413);
  expect(JSON.parse(await past.whole())).toEqual({
    error: {
      code: 'payload_too_large',
      message: 'The request body is too large.',
    },
  });
  expect(await wire.phone('mira')).toMatchObject(withNotes('2.0.0', 'file'));
});

it('store.remove: the person removes an app installed on her phone: it is gone from her phone with what it kept, its rings and what the person said of it, and her home screen is in front where she had it, so added again it comes back new; the Clock, the App Store and an app not on her phone are each refused in a sentence', async () => {
  const model = await startModelServer();
  const home = storeHome(model, reminders);
  const phone = phoneData(home);

  writeFileSync(
    join(phone, 'apps', 'reminders.json'),
    JSON.stringify({
      storage: {reminders: ['Call the dentist']},
      rings: [
        {
          id: 'dentist',
          at: '2099-01-05T09:00:00.000Z',
          title: 'Reminder',
          body: 'Call the dentist',
        },
      ],
    }),
  );
  writeFileSync(
    join(phone, 'phone.json'),
    JSON.stringify({front: {app: 'reminders', view: 'all'}}),
  );

  const wire = wireOf(await startDaemon(home));

  expect(await wire.letAppWake('mira', 'reminders', false)).toEqual({
    status: 'ok',
  });
  expect(await wire.phone('mira')).toMatchObject({
    front: {appId: 'reminders', viewId: 'all'},
  });
  expect(await wire.removeApp('mira', 'reminders')).toEqual({status: 'ok'});

  const removed = await wire.phone('mira');

  expect(appsOf(removed)).toEqual(['clock', 'store']);
  expect(removed).not.toHaveProperty('front');
  expect(readdirSync(join(phone, 'apps'))).toEqual([]);

  for (const [id, reason, message] of [
    [
      'clock',
      'comes_with_phone',
      'Clock comes with the phone and cannot be removed.',
    ],
    [
      'store',
      'comes_with_phone',
      'App Store comes with the phone and cannot be removed.',
    ],
    ['reminders', 'unknown_app', 'There is no app "reminders" on the phone.'],
  ] as const) {
    expect(await wire.removeApp('mira', id)).toEqual({
      status: 'refused',
      reason,
      message,
    });
  }

  expect(await wire.addApp('mira', fileOf(reminders))).toMatchObject({
    status: 'ok',
    app: {id: 'reminders', mayWake: true},
  });
  expect(await wire.phoneScreen('mira', 'reminders', 'all')).toEqual({
    status: 'ok',
    screen: {items: [{kind: 'text', text: 'No Reminders'}]},
  });
});
