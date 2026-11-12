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
import {createHome} from './harness/home.ts';
import {wireOf, type Wire} from './harness/wire.ts';

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
