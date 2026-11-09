import {readdirSync} from 'node:fs';

import {expect, it} from 'vitest';

import {inspect, startDaemon} from './harness/daemon.ts';
import {
  characterJson,
  configJson,
  createHome,
  sessionLog,
  snapshot,
} from './harness/home.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};

/** What inspect printed on the home, once it exited 0. */
async function reportOn(
  home: string,
  args: readonly string[],
): Promise<unknown> {
  const run = inspect(['--store', home, ...args]);

  expect(await run.exit(), run.stderr()).toBe(0);

  return JSON.parse(run.stdout()) as unknown;
}

it("inspect.session-records: inspect --session prints the session's records as its log stores them, one JSON object per line", async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  await say('Hello.', 'hello');

  const session = `${conversationId}.1`;
  const run = inspect(['--store', home, '--session', session]);

  expect(await run.exit(), run.stderr()).toBe(0);
  expect(
    run
      .stdout()
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as unknown),
  ).toEqual(sessionLog(home, 'mira', session));
});

it('inspect.secrets-redacted: the settings report shows every key and token the settings hold only as [redacted], never its value', async () => {
  const home = createHome({
    'config.json': configJson({
      project02: {nvidiaApiKey: 'nvapi-home-secret'},
      connectors: {
        telegram: {config: {managementBotToken: '123456:home-secret'}},
      },
    }),
    'character-data': {
      mira: {
        'config.json': configJson({
          connectors: {telegram: {config: {botToken: '654321:mira-secret'}}},
        }),
      },
    },
  });
  const run = inspect(['--store', home]);

  expect(await run.exit(), run.stderr()).toBe(0);
  expect(run.stdout()).toContain('[redacted]');
  expect(run.stdout()).not.toMatch(
    /nvapi-home-secret|123456:home-secret|654321:mira-secret/u,
  );
});

it('inspect.read-only: inspect writes nothing: on a directory with no store it reports nothing with exit 0 and leaves it empty, and it writes no overlay, marker or schema.json for a character that never started or for one whose overlay needs repair', async () => {
  const empty = createHome();

  expect(await reportOn(empty, ['--sessions'])).toMatchObject({sessions: []});
  expect(readdirSync(empty)).toEqual([]);

  const overlay = configJson({project02: {userDisplayName: 42}});
  const home = createHome({
    'config.json': configJson({}),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {mira: {'config.json': overlay}},
  });
  const before = snapshot(home);

  await reportOn(home, ['--character', 'nova', '--sessions']);
  await inspect(['--store', home, '--character', 'mira', '--sessions']).exit();
  expect(snapshot(home)).toEqual(before);
});
