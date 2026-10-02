import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {spawnDaemon} from '../support/spawn-daemon.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

/** A real serve process on a fresh home. */
async function serveOn(prefix: string) {
  const homeRoot = createTestTempRoot(prefix);

  writeRuntimeConfig(join(homeRoot, 'config.json'), {});

  return {
    homeRoot,
    daemon: await spawnDaemon('src/cli/serve/main.ts', [
      '--store',
      homeRoot,
      '--init',
    ]),
  };
}

function runningIn(homeRoot: string): unknown {
  return (
    JSON.parse(readFileSync(join(homeRoot, 'daemon.json'), 'utf8')) as {
      running?: unknown;
    }
  ).running;
}

describe('serve, across processes', () => {
  it("hands a second process the first's address and exits", async () => {
    const {homeRoot, daemon: first} = await serveOn('project02-instances-');
    const second = await spawnDaemon('src/cli/serve/main.ts', [
      '--store',
      homeRoot,
    ]);

    expect(second.url).toBe(first.url);
    expect(await second.exited).toBe(0);
    expect((await first.stop()).code).toBe(0);
  });

  it('is succeeded on the same address by the next start after being killed outright', async () => {
    const {homeRoot, daemon: first} = await serveOn(
      'project02-instances-killed-',
    );

    first.child.kill('SIGKILL');
    expect(await first.exited).toBeNull();
    // The crash left the run in the record; the lease is what the next
    // start reclaims.
    expect(runningIn(homeRoot)).toBeDefined();

    const second = await spawnDaemon('src/cli/serve/main.ts', [
      '--store',
      homeRoot,
    ]);

    expect(second.url).toBe(first.url);
    expect((await second.stop()).code).toBe(0);
  });

  it('stops on SIGHUP the way it stops on SIGINT, and leaves the record saying so', async () => {
    const {homeRoot, daemon} = await serveOn('project02-instances-hup-');

    daemon.child.kill('SIGHUP');
    expect(await daemon.exited).toBe(0);
    expect(runningIn(homeRoot)).toBeUndefined();
  });
});
