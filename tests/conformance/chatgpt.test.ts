import {existsSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {
  codexClient,
  sam,
  startAuthServer,
  type AuthServer,
} from './harness/auth-server.ts';
import {inspect, startDaemon} from './harness/daemon.ts';
import {
  frameOf,
  openEvents,
  type Events,
  type Frame,
} from './harness/events.ts';
import {
  characterJson,
  configJson,
  createHome,
  snapshot,
} from './harness/home.ts';
import {
  reply,
  responseStream,
  startModelServer,
  type ModelRequest,
  type ModelServer,
} from './harness/model-server.ts';
import {
  erred,
  functionCall,
  inputOf,
  planEvents,
  planResponded,
  replying,
  unauthorized,
  usageLimitReached,
} from './harness/responses.ts';
import {converse, wireOf, type Wire} from './harness/wire.ts';

/** Sam's sign-in, on the Plus plan, as a client is told it. */
const samSignedIn = {
  state: 'signed_in',
  email: 'sam@example.com',
  plan: 'plus',
};

/** Where the home keeps its sign-in. */
function signInFile(home: string): string {
  return join(home, 'chatgpt-sign-in.json');
}

/** A frame saying the home's sign-in now stands as `chatgpt` says, in the fields it names. */
function told(chatgpt: object): (frame: Frame) => boolean {
  return frameOf('health_changed', {health: {chatgpt}});
}

/** The home's sign-in as a frame of health says it. */
function signInIn(frame: Frame): unknown {
  return (
    JSON.parse(frame.data ?? '') as {
      readonly health: {readonly chatgpt: unknown};
    }
  ).health.chatgpt;
}

/** The home's sign-in as health says it now. */
async function signInOf(wire: Wire): Promise<unknown> {
  return ((await wire.health()) as {readonly chatgpt: unknown}).chatgpt;
}

/** Signs the home in as Sam, approving the code as he would on OpenAI's page, once the stream says it is done. */
async function signIn(
  wire: Wire,
  events: Events,
  auth: AuthServer,
): Promise<void> {
  await wire.chatgptSignIn();
  auth.approve();
  await events.next(told(samSignedIn));
}

it("chatgpt.sign-in: a sign-in asks OpenAI for a code under Codex's client and answers it with where the person types it and when it stops working; once they approve it there, the daemon trades it for the tokens, and the stream says the home is signed in as their account on their plan, as health then does", async () => {
  const auth = await startAuthServer();
  const daemon = await startDaemon(createHome(), auth.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  expect(await wire.chatgptSignIn()).toEqual({
    status: 'ok',
    signIn: {
      state: 'waiting',
      code: 'CODE-1',
      url: auth.page,
      expiresAt: auth.code()?.expiresAt,
    },
  });
  await events.next(told({state: 'waiting', code: 'CODE-1'}));
  auth.approve();
  await events.next(told(samSignedIn));
  expect(await signInOf(wire)).toEqual(samSignedIn);
  expect(auth.requests[0]).toEqual({
    path: '/api/accounts/deviceauth/usercode',
    fields: {client_id: codexClient},
  });
  expect(auth.requests.at(-2)).toEqual({
    path: '/api/accounts/deviceauth/token',
    fields: {
      device_auth_id: expect.stringMatching(/^device-/u) as string,
      user_code: 'CODE-1',
    },
  });
  expect(auth.requests.at(-1)).toEqual({
    path: '/oauth/token',
    fields: {
      grant_type: 'authorization_code',
      client_id: codexClient,
      code: expect.stringMatching(/^authorization-/u) as string,
      redirect_uri: auth.callback,
      code_verifier: expect.stringMatching(/^verifier-/u) as string,
    },
  });
});

it('chatgpt.waiting-told-again: while a code waits, health and the ready frame of a stream opened later tell it again, with where the person types it and when it stops working', async () => {
  const auth = await startAuthServer();
  const daemon = await startDaemon(createHome(), auth.env);
  const wire = wireOf(daemon);
  const {signIn: waiting} = (await wire.chatgptSignIn()) as {
    readonly signIn: object;
  };

  expect(waiting).toMatchObject({state: 'waiting', code: 'CODE-1'});
  expect(await signInOf(wire)).toEqual(waiting);

  const later = await openEvents(daemon);

  expect(JSON.parse((await later.next(() => true)).data ?? '')).toMatchObject({
    health: {chatgpt: waiting},
  });
});

it('chatgpt.cancel: calling off a wait leaves the home signed out with nothing said to have failed, and every surface hears it', async () => {
  const auth = await startAuthServer();
  const daemon = await startDaemon(createHome(), auth.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  await wire.chatgptSignIn();
  await events.next(told({state: 'waiting'}));
  expect(await wire.chatgptCancel()).toEqual({
    status: 'ok',
    signIn: {state: 'signed_out'},
  });
  expect(signInIn(await events.next(told({state: 'signed_out'})))).toEqual({
    state: 'signed_out',
  });
  expect(await signInOf(wire)).toEqual({state: 'signed_out'});
});

it('chatgpt.code-expires: a code that runs out before it is approved ends the wait, and the stream and health say so, and to start again', async () => {
  const auth = await startAuthServer(-60_000);
  const daemon = await startDaemon(createHome(), auth.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const expired = {
    state: 'signed_out',
    message: 'The code expired before it was approved. Start again.',
  };

  await wire.chatgptSignIn();
  await events.next(told(expired));
  expect(await signInOf(wire)).toEqual(expired);
});

it('chatgpt.no-plan: an OpenAI account with no ChatGPT plan attached is refused, saying to sign in with the account used for ChatGPT, and nothing is kept', async () => {
  const auth = await startAuthServer();
  const home = createHome();
  const daemon = await startDaemon(home, auth.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const refused = {
    state: 'signed_out',
    message:
      'This OpenAI account has no ChatGPT plan attached. Sign in with the account you use for ChatGPT.',
  };

  await wire.chatgptSignIn();
  auth.approve({email: 'pat@example.com'});
  await events.next(told(refused));
  expect(await signInOf(wire)).toEqual(refused);
  expect(existsSync(signInFile(home))).toBe(false);
});

it('chatgpt.sign-out: signing out takes the tokens out of the home, and every surface hears the home is signed out', async () => {
  const auth = await startAuthServer();
  const home = createHome();
  const daemon = await startDaemon(home, auth.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  await signIn(wire, events, auth);
  expect(existsSync(signInFile(home))).toBe(true);
  expect(await wire.chatgptSignOut()).toEqual({
    status: 'ok',
    signIn: {state: 'signed_out'},
  });
  await events.next(told({state: 'signed_out'}));
  expect(await signInOf(wire)).toEqual({state: 'signed_out'});
  expect(existsSync(signInFile(home))).toBe(false);
});

it('chatgpt.restart: the sign-in is kept in the home, readable by the person alone, and the next run finds the person still signed in', async () => {
  const auth = await startAuthServer();
  const home = createHome();
  const first = await startDaemon(home, auth.env);
  const events = await openEvents(first);

  await signIn(wireOf(first), events, auth);
  expect(statSync(signInFile(home)).mode & 0o777).toBe(0o600);
  first.signal('SIGINT');
  expect(await first.exit()).toBe(0);
  expect(await signInOf(wireOf(await startDaemon(home, auth.env)))).toEqual(
    samSignedIn,
  );
});

it('chatgpt.unreadable: a sign-in whose file does not read is no sign-in: health says so and to sign in again, and signing in again replaces it', async () => {
  const auth = await startAuthServer();
  const home = createHome();
  const first = await startDaemon(home, auth.env);

  // Signed in first: the daemon alone keeps this file, in a folder it has
  // made a home, and a file that does not read is one it kept and that
  // was damaged since.
  await signIn(wireOf(first), await openEvents(first), auth);
  first.signal('SIGINT');
  expect(await first.exit()).toBe(0);
  writeFileSync(signInFile(home), '{"accessToken": "cut sho');

  const daemon = await startDaemon(home, auth.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  expect(await signInOf(wire)).toEqual({
    state: 'signed_out',
    message:
      'Your ChatGPT sign-in could not be read, so this home is signed out. Sign in again.',
  });
  await signIn(wire, events, auth);
  expect(await signInOf(wire)).toEqual(samSignedIn);
});

it('chatgpt.tokens-never-shown: no token of the sign-in, nor the account it is made on, is in anything a client reads: health, the views of the home and of a character, the stream, inspect, or what the daemon prints; inspect says only that the home is signed in, as whom, on which plan', async () => {
  const auth = await startAuthServer();
  const home = createHome();
  const daemon = await startDaemon(home, auth.env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  await signIn(wire, events, auth);

  const report = inspect(['--store', home]);

  expect(await report.exit(), report.stderr()).toBe(0);
  expect(JSON.parse(report.stdout())).toMatchObject({chatgpt: samSignedIn});

  const read = JSON.stringify([
    await wire.health(),
    await wire.configView({scope: 'global'}),
    await wire.configView({scope: 'character', characterId: 'mira'}),
    events.frames,
    report.stdout(),
    report.stderr(),
    daemon.stdout(),
    daemon.stderr(),
  ]);

  expect(auth.secrets().length).toBeGreaterThan(0);

  for (const hidden of [...auth.secrets(), sam.chatgpt.accountId]) {
    expect(read).not.toContain(hidden);
  }
});

/** What a character on the plan needs while the home is signed out. */
const signInNeeded = 'Sign in to your ChatGPT plan.';

/**
 * A home whose characters think with a ChatGPT plan, beside the model
 * server as its service and the auth server as OpenAI's sign-in, signed in
 * as Sam on the Plus plan; `project02` adds to its settings.
 */
async function onPlan(project02: object = {}): Promise<{
  readonly auth: AuthServer;
  readonly model: ModelServer;
  readonly wire: Wire;
  readonly events: Events;
  readonly home: string;
}> {
  const auth = await startAuthServer();
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: {...model.chatgpt.settings, ...project02},
    }),
  });
  const daemon = await startDaemon(home, {...auth.env, ...model.chatgpt.env});
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  await signIn(wire, events, auth);

  return {auth, model, wire, events, home};
}

/** The headers a request to the plan's service carried that say who sends it, and its session. */
function signedBy(request: ModelRequest | undefined): object {
  return {
    authorization: request?.authorization,
    account: request?.headers['chatgpt-account-id'],
    originator: request?.headers['originator'],
    accept: request?.headers.accept,
    session: request?.headers['session-id'],
  };
}

it("chatgpt.plan-turn: a home on a ChatGPT plan answers a turn through the plan's service as OpenAI's Codex app asks it: the sign-in's access token and ChatGPT account, Codex's originator and a session of the request's own that keys the prompt's cache; instructions empty, the system's lines as the developer's and each text one part; the plan's first model until another is chosen, a little reasoning handed back, streamed, nothing stored, and no bound on the output", async () => {
  const {auth, model, wire} = await onPlan();
  const say = await converse(wire, 'mira');

  model.answer(planResponded(replying('Through the plan.')));
  expect(await say('Hello?', 'planned')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Through the plan.'}],
  });

  const [request] = model.requests;
  const body = request?.body as Readonly<Record<string, unknown>>;
  const input = inputOf(request);

  expect(request?.path).toBe('/chatgpt/responses');
  expect(signedBy(request)).toEqual({
    authorization: `Bearer ${String(auth.accessToken())}`,
    account: sam.chatgpt.accountId,
    originator: 'codex-tui',
    accept: 'text/event-stream',
    session: body['prompt_cache_key'],
  });
  expect(body).toMatchObject({
    model: 'gpt-6.1-sol',
    instructions: '',
    stream: true,
    store: false,
    reasoning: {effort: 'low'},
    include: ['reasoning.encrypted_content'],
    tools: expect.arrayContaining([
      expect.objectContaining({type: 'function', name: 'visible_reply'}),
    ]) as unknown,
  });
  expect(body).not.toHaveProperty('max_output_tokens');
  expect(input[0]).toMatchObject({
    type: 'message',
    role: 'developer',
    content: [{type: 'input_text'}],
  });
  expect(input.filter(item => item.role === 'system')).toEqual([]);
  expect(input.at(-1)).toEqual({
    type: 'message',
    role: 'user',
    content: [{type: 'input_text', text: 'Hello?'}],
  });
});

it('chatgpt.plan-drafts: her reply through a ChatGPT plan is drafted as the model writes its arguments, and committed whole once the response ends, though the event that ends it carries none of it', async () => {
  const {model, wire, events} = await onPlan();
  const say = await converse(wire, 'mira');
  const words = 'Hello there, you.';
  // The arguments' first piece ends inside her words: `{"text":"Hello`.
  const streamed = planEvents(replying(words, 14));
  const bytes = (part: typeof streamed) =>
    new TextEncoder().encode(responseStream(part));
  const driven = model.stream();
  const turn = say('Hi?', 'drafted');

  await driven.arrived();
  // The response created, the call's item added, its first piece.
  driven.send(bytes(streamed.slice(0, 3)));
  await events.next(
    frameOf('turn_running', {
      clientMessageId: 'drafted',
      drafts: [{text: 'Hello'}],
    }),
  );
  driven.send(bytes(streamed.slice(3)));
  driven.end();
  expect(await turn).toMatchObject({
    status: 'completed',
    messages: [{}, {text: words}],
  });
});

it('chatgpt.plan-tool-round: a tool her model calls through a ChatGPT plan goes out as a function call, and the next request carries the call and its result, tied to it by one call id', async () => {
  const {model, wire} = await onPlan();
  const say = await converse(wire, 'mira');

  model.answer(
    planResponded(functionCall('runtime_plugin_list', '{}')),
    planResponded(replying('Here they are.')),
  );
  expect(await say('What can you do?', 'listed')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'Here they are.'}],
  });

  const input = inputOf(model.requests[1]);
  const call = input.find(item => item.type === 'function_call');
  const result = input.find(item => item.type === 'function_call_output');

  expect(call).toEqual({
    type: 'function_call',
    call_id: call?.call_id,
    name: 'runtime_plugin_list',
    arguments: '{}',
  });
  expect(result).toMatchObject({
    type: 'function_call_output',
    call_id: call?.call_id,
  });
  expect(JSON.parse(result?.output ?? 'null')).toMatchObject({
    status: 'accepted',
    toolName: 'runtime.plugin.list',
  });
});

it("chatgpt.plan-limit: a ChatGPT plan whose usage is used up is asked once, and her turn ends saying the plan's limit is reached and resets later", async () => {
  const {model, wire} = await onPlan();
  const say = await converse(wire, 'mira');

  model.answer(usageLimitReached());
  expect(await say('Hello?', 'limited')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
    message: "ChatGPT says your plan's limit is reached; it resets later.",
  });
  expect(model.requests).toHaveLength(1);
});

it("chatgpt.plan-refresh: a 401 from a ChatGPT plan's service renews the sign-in at OpenAI, whatever its age, and the turn goes on, asked again on the new access token", async () => {
  const {auth, model, wire} = await onPlan();
  const say = await converse(wire, 'mira');
  const first = auth.accessToken();

  model.answer(unauthorized(), planResponded(replying('After a renewal.')));
  expect(await say('Hello?', 'renewed')).toMatchObject({
    status: 'completed',
    messages: [{}, {text: 'After a renewal.'}],
  });
  expect(auth.accessToken()).not.toBe(first);
  expect(model.requests.map(request => request.authorization)).toEqual([
    `Bearer ${String(first)}`,
    `Bearer ${String(auth.accessToken())}`,
  ]);
  expect(auth.requests.at(-1)).toMatchObject({
    path: '/oauth/token',
    fields: {grant_type: 'refresh_token', client_id: codexClient},
  });
});

it('chatgpt.needs-sign-in: the plan chosen while the home is signed out leaves a character needing a model, the sentence saying to sign in, and the view lists the plan first, not connected; signed in, she is ready and the plan connected as the account on its plan, its model offering what the plan offers with the first in effect; signed out again, she needs a model again', async () => {
  const auth = await startAuthServer();
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({project02: model.chatgpt.settings}),
    }),
    {...auth.env, ...model.chatgpt.env},
  );
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const view = () => wire.configView({scope: 'global'});
  const plan = {
    id: 'chatgpt',
    name: 'ChatGPT Plan',
    summary: 'Sign in with the plan you already pay for',
    model: 'chatgptModel',
    fields: ['chatgptModel'],
  };
  const modelField = async () =>
    (
      (await view()) as {
        readonly project02: readonly {readonly name: string}[];
      }
    ).project02.find(field => field.name === 'chatgptModel');

  await wire.start('mira');
  expect(await wire.health()).toMatchObject({
    characters: [{id: 'mira', state: 'needs_model', diagnostic: signInNeeded}],
  });
  expect(await view()).toMatchObject({
    model: {ready: false, message: signInNeeded},
    services: [
      {...plan, connected: false},
      {id: 'openai'},
      {id: 'anthropic'},
      {id: 'nvidia'},
    ],
  });
  expect(
    ((await view()) as {readonly services: readonly object[]}).services[0],
  ).not.toHaveProperty('account');

  await signIn(wire, events, auth);
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );
  expect(await view()).toMatchObject({
    model: {ready: true},
    services: [
      {
        ...plan,
        connected: true,
        account: {email: sam.email, plan: 'plus'},
      },
      {id: 'openai'},
      {id: 'anthropic'},
      {id: 'nvidia'},
    ],
  });
  expect(await modelField()).toMatchObject({
    suggestedValues: [
      'gpt-6.1-sol',
      'gpt-6-sol',
      'gpt-6.1-terra',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ],
    choices: {'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-5.6-luna': 'GPT-5.6 Luna'},
    effective: {source: 'default', value: 'gpt-6.1-sol'},
  });

  await wire.chatgptSignOut();
  await events.next(
    frameOf('state_changed', {
      characterId: 'mira',
      state: 'needs_model',
      message: signInNeeded,
    }),
  );
  expect(await view()).toMatchObject({
    model: {ready: false, message: signInNeeded},
    services: [
      {...plan, connected: false},
      {id: 'openai'},
      {id: 'anthropic'},
      {id: 'nvidia'},
    ],
  });
});

it('chatgpt.refresh-refused: a renewal OpenAI refuses ends the sign-in: the turn that needed it ends saying so and to sign in again, health says the home is signed out and why, the tokens leave the home, and every other character on the plan needs a model', async () => {
  const auth = await startAuthServer();
  const model = await startModelServer();
  const env = {...auth.env, ...model.chatgpt.env};
  const home = createHome({
    'config.json': configJson({project02: model.chatgpt.settings}),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
  });
  const first = await startDaemon(home, env);

  // Signed in first, so the folder is a home that keeps a sign-in; then
  // its tokens are planted over: run out long ago, on a refresh token
  // OpenAI never gave.
  await signIn(wireOf(first), await openEvents(first), auth);
  first.signal('SIGINT');
  expect(await first.exit()).toBe(0);
  writeFileSync(
    signInFile(home),
    JSON.stringify({
      accessToken: 'access-planted',
      refreshToken: 'refresh-planted',
      accountId: sam.chatgpt.accountId,
      email: sam.email,
      plan: 'plus',
      expiresAt: 0,
    }),
  );

  const daemon = await startDaemon(home, env);
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const ended =
    'OpenAI no longer accepts your ChatGPT sign-in, so this home is signed out. Sign in again.';

  await wire.start('nova');

  const say = await converse(wire, 'mira');

  expect(await say('Hello?', 'refused')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
    message: `ChatGPT could not be asked: ${ended}`,
  });
  expect(await signInOf(wire)).toEqual({state: 'signed_out', message: ended});
  await events.next(
    frameOf('state_changed', {
      characterId: 'nova',
      state: 'needs_model',
      message: signInNeeded,
    }),
  );
  expect(existsSync(signInFile(home))).toBe(false);
  expect(model.requests).toEqual([]);
  expect(
    auth.requests.filter(
      request => request.fields['grant_type'] === 'refresh_token',
    ),
  ).toMatchObject([
    {path: '/oauth/token', fields: {refresh_token: 'refresh-planted'}},
  ]);
});

it("chatgpt.own-plan: a character whose own settings choose the ChatGPT plan thinks with it on the home's sign-in, while every other character keeps the home's service", async () => {
  const auth = await startAuthServer();
  const model = await startModelServer();
  const daemon = await startDaemon(
    createHome({
      'config.json': configJson({project02: model.settings}),
      characters: {
        nova: {'project02.character.json': characterJson('nova', 'Nova')},
      },
      'character-data': {
        nova: {
          'config.json': configJson({
            project02: {
              roleModelProvider: 'chatgpt',
              chatgptModel: 'gpt-6-luna',
            },
          }),
        },
      },
    }),
    {...auth.env, ...model.chatgpt.env},
  );
  const wire = wireOf(daemon);

  await signIn(wire, await openEvents(daemon), auth);

  for (const [characterId, answer] of [
    ['mira', reply('Hello.')],
    ['nova', planResponded(replying('Hello.'))],
  ] as const) {
    const say = await converse(wire, characterId);

    model.answer(answer);
    expect(await say('Hello?', characterId)).toMatchObject({
      status: 'completed',
    });
  }

  expect(
    model.requests.map(request => ({
      path: request.path,
      authorization: request.authorization,
      model: (request.body as {readonly model?: unknown}).model,
    })),
  ).toEqual([
    {
      path: '/v1/chat/completions',
      authorization: `Bearer ${model.settings.nvidiaApiKey}`,
      model: 'nvidia/nemotron-3-nano-30b-a3b',
    },
    {
      path: '/chatgpt/responses',
      authorization: `Bearer ${String(auth.accessToken())}`,
      model: 'gpt-6-luna',
    },
  ]);
});

it("chatgpt.plan-tokens-never-said: where a ChatGPT plan's service repeats the token or the account a request went with, her turn's rejection, its events and every record the home keeps but the sign-in's own say neither", async () => {
  const {auth, model, wire, events, home} = await onPlan();
  const say = await converse(wire, 'mira');
  const token = String(auth.accessToken());

  model.answer(
    erred(
      `Token ${token} of ${sam.chatgpt.accountId} was refused.`,
      replying('Half a thought', 9),
    ),
  );
  expect(await say('Hello?', 'refused')).toMatchObject({
    status: 'rejected',
    reason: 'provider_error',
    message:
      'ChatGPT provider error: Token [redacted] of [redacted] was refused.',
  });

  const kept = Object.entries(snapshot(home)).filter(
    ([path]) => path !== signInFile(home),
  );
  const read = JSON.stringify([kept, events.frames, await wire.health()]);

  for (const hidden of [...auth.secrets(), sam.chatgpt.accountId]) {
    expect(read).not.toContain(hidden);
  }
});
