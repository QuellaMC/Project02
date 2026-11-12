import {createHash} from 'node:crypto';

import {expect, it} from 'vitest';

import {
  startCatalogServer,
  type CatalogServer,
} from './harness/catalog-server.ts';
import {startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents, type Frame} from './harness/events.ts';
import {configJson, createHome} from './harness/home.ts';
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

/** An app as its one file says it: its manifest, and its functions beside it. */
type App = {
  readonly manifest: {
    readonly id: string;
    readonly name: string;
    readonly summary: string;
    readonly version: string;
    readonly icon: string;
    readonly tint: string;
    readonly wakes: boolean;
    readonly views: readonly object[];
    readonly opensOn: string;
    readonly actions: readonly object[];
  };
  readonly script: string;
};

/** Reminders, which keeps what she adds and says it wakes her. */
const reminders: App = {
  manifest: {
    id: 'reminders',
    name: 'Reminders',
    summary: 'Things to do, on a day and time',
    version: '1.0.0',
    icon: 'list',
    tint: 'orange',
    wakes: true,
    views: [{id: 'all', title: 'All', icon: 'list'}],
    opensOn: 'all',
    actions: [
      {
        name: 'add',
        description: 'Add a reminder.',
        did: 'Added a reminder',
        view: 'all',
        input: {
          type: 'object',
          properties: {title: {type: 'string'}},
          required: ['title'],
          additionalProperties: false,
        },
      },
    ],
  },
  script: `export function screen() {
  const kept = phone.storage.get('reminders') ?? [];

  return {items: kept.length === 0
    ? [{kind: 'text', text: 'No Reminders'}]
    : [{kind: 'list', rows: kept.map((title) => ({title}))}]};
}

export function add({title}) {
  phone.storage.set('reminders', [...(phone.storage.get('reminders') ?? []), title]);

  return {title};
}`,
};

/** An app of `name` that shows a line and does nothing, at `version`. */
function quiet(id: string, name: string, version: string): App {
  return {
    manifest: {
      id,
      name,
      summary: `${name}, quietly`,
      version,
      icon: 'doc',
      tint: 'gray',
      wakes: false,
      views: [{id: 'all', title: 'All', icon: 'doc'}],
      opensOn: 'all',
      actions: [],
    },
    script: `export function screen() { return {items: [{kind: 'text', text: 'No ${name}'}]}; }`,
  };
}

const mira = {scope: 'character', characterId: 'mira'} as const;

function fileOf(app: App): string {
  return `export const manifest = ${JSON.stringify({format: 'project02.app.v1', ...app.manifest})};\n\n${app.script}\n`;
}

/** The catalog's entry of `app`, listing the file whose text is `listed`, its own unless the test says otherwise. */
function entryOf(app: App, listed = fileOf(app)): object {
  const {id, name, summary, icon, tint, version, wakes} = app.manifest;

  return {
    id,
    name,
    summary,
    icon,
    tint,
    version,
    changes: 'The first version.',
    wakes,
    sha256: createHash('sha256').update(listed).digest('hex'),
  };
}

/** The catalog of `apps`, in their order, each beside its file where the catalog's rule puts it; an entry given with an app lists in its place. */
function publish(
  catalog: CatalogServer,
  ...apps: readonly (readonly [App, object?])[]
): void {
  catalog.publish(
    'catalog.json',
    JSON.stringify({
      format: 'project02.catalog.v1',
      apps: apps.map(([app, entry]) => entry ?? entryOf(app)),
    }),
  );

  for (const [app] of apps) {
    catalog.publish(
      `apps/${app.manifest.id}/${app.manifest.version}.js`,
      fileOf(app),
    );
  }
}

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
      {kind: 'text', text: 'Version 1.0.0 — The first version.'},
    ],
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

it("store.not-installed: a denied ask leaves her phone as it was and she reads the host's refusal; an app the store does not have, the Clock, the store itself, an app whose file does not match its SHA-256 and one already on her phone are each refused to her in a sentence with nobody asked; with Ask to Install Apps off she is offered no such tool and still opens the store", async () => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();
  const notes = quiet('notes', 'Notes', '1.0.0');
  const broken = quiet('broken', 'Broken', '1.0.0');

  publish(
    catalog,
    [reminders],
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
    calling(['phone_install', {app: 'reminders'}]),
    reply('Never mind.'),
  );

  const denied = say('Get reminders.', 'denied');

  expect(
    await wire.answer(
      confirmationId(await events.next(frameOf('confirmation_requested'))),
      'denied',
    ),
  ).toEqual({status: 'answered'});
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
      'There is no app "weather" in the App Store. Its apps: Reminders ("reminders"), Notes ("notes"), Broken ("broken").',
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
