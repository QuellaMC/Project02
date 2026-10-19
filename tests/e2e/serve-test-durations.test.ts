import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {subscribeToEvents} from '../support/gateway-http.ts';
import {spawnDaemon} from '../support/spawn-daemon.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('serve, with the test durations set', () => {
  it('pings on the stream at the heartbeat the variable sets', async () => {
    const homeRoot = createTestTempRoot('project02-test-durations-');
    const daemon = await spawnDaemon(
      'src/cli/serve/main.ts',
      ['--store', homeRoot, '--init'],
      {PROJECT02_TEST_DURATIONS: 'heartbeat=100'},
    );
    const address = new URL(daemon.url);
    const events = await subscribeToEvents(
      address.origin,
      new URLSearchParams(address.hash.slice(1)).get('token') ?? '',
    );

    await events.next(frame => frame.event === 'ready');
    // A third of the default 15 s: room for a daemon still starting its
    // characters, and no room for the default.
    await events.next(frame => frame.comment === 'ping', 5_000);
    await events.cancel();
    expect((await daemon.stop()).code).toBe(0);
  });

  it("refuses to start on a key it does not read, the connector's among them, before it writes anything", () => {
    const homeRoot = createTestTempRoot('project02-test-durations-refused-');
    const serve = spawnSync(
      process.execPath,
      ['src/cli/serve/main.ts', '--store', homeRoot, '--init'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {...process.env, PROJECT02_TEST_DURATIONS: 'edit=50'},
      },
    );

    expect(serve.status).toBe(1);
    expect(serve.stderr).toBe(
      'Error: PROJECT02_TEST_DURATIONS: unknown key "edit"; the keys here are confirmation, pairing, silence, heartbeat, grace, hold.\n',
    );
    expect(readdirSync(homeRoot)).toEqual([]);
  });
});
