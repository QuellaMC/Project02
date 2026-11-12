import {join} from 'node:path';

import {expect, it} from 'vitest';

import {asker, fileOf, publish} from './harness/apps.ts';
import {sam, startAuthServer, type AuthServer} from './harness/auth-server.ts';
import {startCatalogServer} from './harness/catalog-server.ts';
import {inspect, startDaemon, type Daemon} from './harness/daemon.ts';
import {
  frameOf,
  openEvents,
  type Events,
  type Frame,
} from './harness/events.ts';
import {configJson, createHome, snapshot} from './harness/home.ts';
import {
  calling,
  reply,
  startModelServer,
  toolResults,
  type ModelServer,
} from './harness/model-server.ts';
import {
  erred,
  inputOf,
  planResponded,
  respondedWhole,
  saying,
} from './harness/responses.ts';
import {
  conversationOf,
  converse,
  saveConfig,
  wireOf,
  type Wire,
} from './harness/wire.ts';

/** What her app asks the model besides the question, its own instructions and the most it is handed. */
const instructions =
  'Answer in one sentence.\n\nAnswer in 4096 characters at most.';

/** The ChatGPT plan as a connection her app can sign in with, on Sam's Plus plan. */
const plan = {
  id: 'chatgpt',
  name: 'ChatGPT Plan',
  models: [
    {id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol'},
    {id: 'gpt-6-sol', name: 'GPT-6 Sol'},
    {id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra'},
    {id: 'gpt-6-luna', name: 'GPT-6 Luna'},
    {id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol'},
    {id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra'},
    {id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna'},
  ],
  defaultModel: 'gpt-6.1-sol',
};

/** The OpenAI API as a connection her app can sign in with. */
const api = {
  id: 'openai',
  name: 'OpenAI API',
  models: [
    {id: 'gpt-6-astra', name: 'GPT-6 Astra'},
    {id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol'},
    {id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra'},
    {id: 'gpt-6-luna', name: 'GPT-6 Luna'},
  ],
  defaultModel: 'gpt-6-luna',
};

type Connected = {
  readonly model: ModelServer;
  readonly auth: AuthServer;
  readonly daemon: Daemon;
  readonly wire: Wire;
  readonly events: Events;
  readonly home: string;
};

/**
 * Mira's home and daemon: she thinks with the model server as NVIDIA's,
 * the person goes by Sam and her heartbeat is off; the daemon reaches the
 * model server as the OpenAI API and as a ChatGPT plan's service, and the
 * auth server as OpenAI's sign-in, and `env` besides. The home's settings
 * hold the OpenAI API's key when `key` says so, and the home is signed in
 * to Sam's Plus plan when `plan` says so.
 */
async function connected(
  linked: {readonly key: boolean; readonly plan: boolean},
  env: Readonly<Record<string, string>> = {},
): Promise<Connected> {
  const model = await startModelServer();
  const auth = await startAuthServer();
  const home = createHome({
    'config.json': configJson({
      project02: {
        ...model.settings,
        userDisplayName: 'Sam',
        ...(linked.key
          ? {openaiApiKey: model.openai.settings.openaiApiKey}
          : {}),
      },
    }),
    'character-data': {
      mira: {'config.json': configJson({project02: {heartbeat: 'off'}})},
    },
  });
  const daemon = await startDaemon(home, {
    ...auth.env,
    ...model.openai.env,
    ...model.chatgpt.env,
    ...env,
  });
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  if (linked.plan) {
    await wire.chatgptSignIn();
    auth.approve();
    await events.next(
      frameOf('health_changed', {health: {chatgpt: {state: 'signed_in'}}}),
    );
  }

  return {model, auth, daemon, wire, events, home};
}

/** Her taking Asker's `ask` on `question`. */
function asking(question: string): readonly [string, object] {
  return ['phone_use', {app: 'asker', action: 'ask', input: {question}}];
}

/** Asker as a client reads it among her apps. */
async function askerOn(wire: Wire): Promise<Readonly<Record<string, unknown>>> {
  const phone = (await wire.phone('mira')) as {
    readonly apps: readonly Readonly<Record<string, unknown>>[];
  };

  return phone.apps.find(app => app['id'] === 'asker') ?? {};
}

function confirmationId(frame: Frame): string {
  return (JSON.parse(frame.data ?? '') as {readonly id: string}).id;
}

it("connections.asked: her app's question is asked through the connection the person signed it in with, by the adapter she would think with on it: the ChatGPT plan, on the home's sign-in, of the best model the plan offers until another is chosen, and the OpenAI API, on the home's key, of the model the person chose; each takes the app's instructions with the most an app is handed, and she reads the model's words", async () => {
  const {model, auth, wire} = await connected({key: true, plan: true});

  await wire.addApp('mira', fileOf(asker));
  expect(
    await wire.signInApp('mira', 'asker', {connection: 'chatgpt'}),
  ).toEqual({status: 'ok'});

  const say = await converse(wire, 'mira');

  model.answer(
    calling(asking('What wakes someone gently?')),
    planResponded(saying('Light, slowly.')),
    reply('Light, it says.'),
  );
  await say('Ask Asker.', 'plan');

  const [, onPlan] = model.requests;

  expect(onPlan?.path).toBe('/chatgpt/responses');
  expect(onPlan?.authorization).toBe(`Bearer ${String(auth.accessToken())}`);
  expect(onPlan?.headers['chatgpt-account-id']).toBe(sam.chatgpt.accountId);
  expect(onPlan?.body).toMatchObject({model: 'gpt-6.1-sol'});
  expect(inputOf(onPlan)).toEqual([
    {
      type: 'message',
      role: 'developer',
      content: [{type: 'input_text', text: instructions}],
    },
    {
      type: 'message',
      role: 'user',
      content: [{type: 'input_text', text: 'What wakes someone gently?'}],
    },
  ]);
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {
      status: 'accepted',
      toolName: 'phone.use',
      output: {answer: {text: 'Light, slowly.'}},
    },
  ]);

  expect(
    await wire.signInApp('mira', 'asker', {
      connection: 'openai',
      model: 'gpt-6.1-terra',
    }),
  ).toEqual({status: 'ok'});
  model.answer(
    calling(asking('And then?')),
    respondedWhole(saying('Open the curtains.')),
    reply('Curtains.'),
  );
  await say('Ask again.', 'api');

  const onApi = model.requests.at(-2);

  expect(onApi?.path).toBe('/openai/v1/responses');
  expect(onApi?.authorization).toBe(
    `Bearer ${model.openai.settings.openaiApiKey}`,
  );
  expect(onApi?.body).toMatchObject({model: 'gpt-6.1-terra'});
  expect(inputOf(onApi)).toEqual([
    {type: 'message', role: 'system', content: instructions},
    {type: 'message', role: 'user', content: 'And then?'},
  ]);
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    status: 'accepted',
    toolName: 'phone.use',
    output: {answer: {text: 'Open the curtains.'}},
  });
});

it("connections.ask-to-sign-in: she installs an app that asks a model, its card saying it asks ChatGPT and no account of a key; her app, not signed in, tells her so and names phone.sign_in; her ask to sign in shows the person the app and the first connection of theirs connected, the plan before the API key, and Don't Allow leaves it signed out; Allow signs it in with the plan, the stream says her phone changed, her phone says so, and her question is then answered through the plan", async () => {
  const catalog = await startCatalogServer();

  publish(catalog, [asker]);

  const {model, wire, events} = await connected(
    {key: true, plan: true},
    catalog.env,
  );
  const say = await converse(wire, 'mira');

  model.answer(
    calling(['phone_install', {app: 'asker'}]),
    calling(asking('Is it morning?')),
    calling(['phone_sign_in', {app: 'asker'}]),
    calling(['phone_sign_in', {app: 'asker'}]),
    calling(asking('Is it morning yet?')),
    planResponded(saying('Not yet.')),
    reply('Not yet, it says.'),
  );

  const turn = say('Get Asker and ask it.', 'sign-in');
  const install = await events.next(frameOf('confirmation_requested'));
  const installPreview = (
    JSON.parse(install.data ?? '') as {
      readonly request: {readonly preview: {readonly app: object}};
    }
  ).request.preview;

  expect(installPreview).toMatchObject({
    kind: 'phone_app_install',
    app: {id: 'asker', reachesInternet: false, connection: 'ChatGPT'},
  });
  expect(installPreview.app).not.toHaveProperty('account');
  await wire.answer(confirmationId(install), 'approved');

  const denied = await events.next(frameOf('confirmation_requested'));

  expect(JSON.parse(denied.data ?? '')).toMatchObject({
    request: {
      pluginId: 'phone',
      toolName: 'phone.sign_in',
      summary:
        "Sign in to an app on your phone with one of the person's AI connections.",
      preview: {
        kind: 'phone_app_sign_in',
        app: {id: 'asker', name: 'Asker', icon: 'bulb', tint: 'indigo'},
        connection: {id: 'chatgpt', name: 'ChatGPT Plan'},
      },
    },
  });
  expect(await wire.answer(confirmationId(denied), 'denied')).toEqual({
    status: 'answered',
  });
  expect(await askerOn(wire)).toEqual(
    expect.objectContaining({signIn: {connections: [plan, api]}}),
  );

  const allowed = await events.next(frameOf('confirmation_requested'));

  await wire.answer(confirmationId(allowed), 'approved');
  expect(await turn).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Not yet, it says.'}],
  });
  expect(toolResults(model.requests.at(-1)).slice(1)).toMatchObject([
    {
      status: 'accepted',
      toolName: 'phone.use',
      output: {
        answer: {
          error:
            'Asker is not signed in on this phone. Ask Sam to let you sign in, with phone.sign_in.',
        },
      },
    },
    {
      status: 'rejected',
      toolName: 'phone.sign_in',
      reason: 'approval_denied',
      message:
        'Tool "phone.sign_in" was denied by the user, so it did nothing.',
    },
    {
      status: 'accepted',
      toolName: 'phone.sign_in',
      output: {
        status: 'signed_in',
        app: 'asker',
        connection: 'ChatGPT Plan',
        message:
          "Asker is signed in with Sam's ChatGPT Plan now: use it with phone.use.",
      },
    },
    {
      status: 'accepted',
      toolName: 'phone.use',
      output: {answer: {text: 'Not yet.'}},
    },
  ]);
  expect(model.requests.at(-2)).toMatchObject({path: '/chatgpt/responses'});

  const said = events.frames.filter(frame => frame.comment === undefined);
  const signedIn = said.findIndex(
    frameOf('turn_progress', {
      progress: {
        kind: 'tool_call_completed',
        toolName: 'phone.sign_in',
        status: 'accepted',
      },
    }),
  );

  expect(said[signedIn + 1]).toSatisfy(
    frameOf('phone_changed', {characterId: 'mira'}),
  );

  const signedInAsker = await askerOn(wire);

  expect(signedInAsker).toMatchObject({
    itMay: [
      'Keep its own data',
      'Ask ChatGPT with a connection of yours, once you allow it',
    ],
    signIn: {
      connections: [plan, api],
      signedIn: {connection: 'chatgpt', model: 'gpt-6.1-sol'},
    },
  });
  expect(signedInAsker).not.toHaveProperty('account');
});

it("connections.unasked: her ask to sign in is refused before anyone is asked, each in a sentence to her: with none of Sam's connections connected, saying what it needs and where; for the Clock, which signs in to nothing; for an app her phone lacks, with her apps; and for an app signed in already", async () => {
  const {model, wire, events} = await connected({key: false, plan: false});

  await wire.addApp('mira', fileOf(asker));
  expect(await askerOn(wire)).toEqual(
    expect.objectContaining({signIn: {connections: []}}),
  );

  const say = await converse(wire, 'mira');
  const refused = (reason: string, message: string) => ({
    status: 'rejected',
    pluginId: 'phone',
    toolName: 'phone.sign_in',
    reason,
    message,
  });

  model.answer(
    calling(
      ['phone_sign_in', {app: 'asker'}],
      ['phone_sign_in', {app: 'clock'}],
      ['phone_sign_in', {app: 'nope'}],
    ),
    reply('None of those.'),
  );
  await say('Sign in, please.', 'none');
  expect(toolResults(model.requests.at(-1))).toEqual([
    refused(
      'not_connected',
      "This needs Sam's ChatGPT plan or OpenAI API key, connected under AI Model in Settings.",
    ),
    refused('signs_in_to_nothing', 'Clock signs in to nothing.'),
    refused(
      'app_not_found',
      'There is no app "nope" on the phone. Your apps: Clock ("clock"), Asker ("asker"), App Store ("store").',
    ),
  ]);

  await saveConfig(
    wire,
    {scope: 'global'},
    {
      kind: 'set',
      path: 'project02.openaiApiKey',
      value: model.openai.settings.openaiApiKey,
    },
  );
  await wire.signInApp('mira', 'asker', {connection: 'openai'});
  model.answer(
    calling(['phone_sign_in', {app: 'asker'}]),
    reply('It is signed in.'),
  );
  await say('Sign in again.', 'already');
  expect(toolResults(model.requests.at(-1)).at(-1)).toEqual(
    refused('already_signed_in', 'Asker is signed in already.'),
  );
  expect(events.frames.filter(frameOf('confirmation_requested'))).toEqual([]);
});

it('connections.person-chooses: the person signs her app in with a connection of theirs, chooses the model it asks among those it offers, and signs it out, each kept with her phone, which says it, and each said on the stream; a connection not connected, a model it does not offer, an app that signs in to nothing and an app not on her phone are each refused in a sentence', async () => {
  const {wire, events} = await connected({key: true, plan: true});

  await wire.addApp('mira', fileOf(asker));

  const phone = (await wire.phone('mira')) as {
    readonly apps: readonly Readonly<Record<string, unknown>>[];
  };
  const clock = phone.apps.find(app => app['id'] === 'clock');

  expect(clock).not.toHaveProperty('signIn');
  expect(clock).not.toHaveProperty('account');
  expect(await askerOn(wire)).toEqual(
    expect.objectContaining({signIn: {connections: [plan, api]}}),
  );

  const signs = async (signIn: object, signedIn?: object) => {
    const changed = events.frames.length;

    expect(await wire.signInApp('mira', 'asker', signIn)).toEqual({
      status: 'ok',
    });
    await events.holding('her phone to change', frames =>
      frames
        .slice(changed)
        .find(frameOf('phone_changed', {characterId: 'mira'})),
    );
    expect(await askerOn(wire)).toEqual(
      expect.objectContaining({
        signIn: {
          connections: [plan, api],
          ...(signedIn === undefined ? {} : {signedIn}),
        },
      }),
    );
  };

  await signs(
    {connection: 'openai'},
    {connection: 'openai', model: 'gpt-6-luna'},
  );
  await signs(
    {connection: 'openai', model: 'gpt-6-astra'},
    {connection: 'openai', model: 'gpt-6-astra'},
  );
  await signs(
    {connection: 'chatgpt'},
    {connection: 'chatgpt', model: 'gpt-6.1-sol'},
  );
  await signs({});

  for (const [app, signIn, reason, message] of [
    [
      'asker',
      {connection: 'openai', model: 'gpt-9'},
      'unknown_model',
      'Your OpenAI API offers no model "gpt-9".',
    ],
    [
      'clock',
      {connection: 'chatgpt'},
      'signs_in_to_nothing',
      'Clock signs in to nothing.',
    ],
    ['nope', {}, 'unknown_app', 'There is no app "nope" on the phone.'],
  ] as const) {
    expect(await wire.signInApp('mira', app, signIn)).toEqual({
      status: 'refused',
      reason,
      message,
    });
  }

  await wire.chatgptSignOut();
  expect(await askerOn(wire)).toEqual(
    expect.objectContaining({signIn: {connections: [api]}}),
  );
  expect(
    await wire.signInApp('mira', 'asker', {connection: 'chatgpt'}),
  ).toEqual({
    status: 'refused',
    reason: 'not_connected',
    message:
      'Your ChatGPT Plan is not connected. Connect it under AI Model first.',
  });
});

it("connections.gone: her app signed in with a connection that is no longer connected asks nothing: once Sam takes away the OpenAI API's key, her question is not asked, and her app tells her Sam's OpenAI API is no longer connected and to ask Sam; her phone still says what it is signed in with, and no connection it can sign in with; and her ask to sign in is then judged as for an app not signed in", async () => {
  const {model, wire} = await connected({key: true, plan: false});

  await wire.addApp('mira', fileOf(asker));
  await wire.signInApp('mira', 'asker', {connection: 'openai'});
  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'unset', path: 'project02.openaiApiKey'},
  );

  const say = await converse(wire, 'mira');

  model.answer(calling(asking('Still there?')), reply('It cannot ask.'));
  await say('Ask Asker.', 'gone');
  expect(model.requests.map(request => request.path)).toEqual([
    '/v1/chat/completions',
    '/v1/chat/completions',
  ]);
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {
      status: 'accepted',
      toolName: 'phone.use',
      output: {
        answer: {
          error:
            "Asker is signed in with Sam's OpenAI API, which is no longer connected. Ask Sam to connect it again.",
        },
      },
    },
  ]);
  expect(await askerOn(wire)).toEqual(
    expect.objectContaining({
      signIn: {
        connections: [],
        signedIn: {connection: 'openai', model: 'gpt-6-luna'},
      },
    }),
  );

  model.answer(
    calling(['phone_sign_in', {app: 'asker'}]),
    reply('Nothing to sign in with.'),
  );
  await say('Sign in again.', 'again');
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    status: 'rejected',
    toolName: 'phone.sign_in',
    reason: 'not_connected',
    message:
      "This needs Sam's ChatGPT plan or OpenAI API key, connected under AI Model in Settings.",
  });
});

it('connections.stop: her stop while her app waits for its answer does not wait for it: the question in flight ends at once, her app reads that it was stopped, her turn ends as a stop lets it, and the daemon exits', async () => {
  const {model, daemon, wire} = await connected({key: true, plan: false});

  await wire.addApp('mira', fileOf(asker));
  await wire.signInApp('mira', 'asker', {connection: 'openai'});

  const say = await converse(wire, 'mira');

  model.answer(calling(asking('Will you wait?')));

  // Never released: a stop that waited for this question would not end.
  const held = model.hold();

  model.answer(reply('It was stopped.'));

  const turn = say('Ask Asker.', 'held');

  await held.arrived();
  daemon.signal('SIGINT');
  await daemon.printed('Stopping; finishing what is in flight.');
  expect(await turn).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'It was stopped.'}],
  });
  expect(toolResults(model.requests.at(-1))).toMatchObject([
    {
      status: 'accepted',
      toolName: 'phone.use',
      output: {
        answer: {error: 'The question was stopped before it was answered.'},
      },
    },
  ]);
  expect(await daemon.exit()).toBe(0);
});

it("connections.secrets-never-said: no key, token or account id of a connection is in anything a client reads or the home records but where the person put it and the sign-in's own, though the services repeat them in their refusals, which her app reads with them taken out", async () => {
  const {model, auth, daemon, wire, events, home} = await connected({
    key: true,
    plan: true,
  });
  const key = model.openai.settings.openaiApiKey;
  const token = String(auth.accessToken());

  await wire.addApp('mira', fileOf(asker));
  await wire.signInApp('mira', 'asker', {connection: 'chatgpt'});

  const say = await converse(wire, 'mira');

  model.answer(
    calling(asking('Through the plan?')),
    erred(`Token ${token} of ${sam.chatgpt.accountId} was refused.`),
    reply('The plan refused.'),
  );
  await say('Ask through the plan.', 'plan');
  await wire.signInApp('mira', 'asker', {connection: 'openai'});
  model.answer(
    calling(asking('Through the key?')),
    {status: 400, body: {error: {message: `The key ${key} was refused.`}}},
    reply('The key was refused.'),
  );
  await say('Ask through the key.', 'key');
  expect(
    toolResults(model.requests.at(-1)).filter(
      result =>
        (result as {readonly toolName?: string}).toolName === 'phone.use',
    ),
  ).toMatchObject([
    {
      output: {
        answer: {
          error:
            'ChatGPT provider error: Token [redacted] of [redacted] was refused.',
        },
      },
    },
    {
      output: {
        answer: {
          error: 'OpenAI provider error: The key [redacted] was refused.',
        },
      },
    },
  ]);

  const {conversationId} = await conversationOf(wire, 'mira');
  const settings = inspect(['--store', home]);
  const session = inspect([
    '--store',
    home,
    '--session',
    `${conversationId}.1`,
  ]);

  expect(await settings.exit(), settings.stderr()).toBe(0);
  expect(await session.exit(), session.stderr()).toBe(0);

  const kept = Object.entries(snapshot(home)).filter(
    ([path]) =>
      path !== join(home, 'config.json') &&
      path !== join(home, 'chatgpt-sign-in.json'),
  );
  const read = JSON.stringify([
    events.frames,
    await wire.phone('mira'),
    await wire.phoneScreen('mira', 'asker', 'asked'),
    await wire.health(),
    settings.stdout(),
    session.stdout(),
    daemon.stdout(),
    daemon.stderr(),
    kept,
  ]);

  for (const hidden of [key, ...auth.secrets(), sam.chatgpt.accountId]) {
    expect(read).not.toContain(hidden);
  }
});
