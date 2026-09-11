/**
 * A daemon for the browser suite, the way serve runs it: on a temporary
 * home, with the demo-config plugin enabled and a model scripted by the
 * line it reads. Spawned as a process (tests/support/spawn-daemon.ts), so
 * Playwright's own loader never enters the daemon's graph. Prints what
 * serve prints; stops on SIGINT and removes its home.
 */
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';

import {runServeCliFromArgs} from '../../src/cli/serve/main.ts';
import {demoConfigPluginId} from '../../src/plugins/packages/demo-config/plugin.ts';
import {ensureInitializedProject02Store} from '../../src/runtime/config/index.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createScriptedAdapter} from '../support/scripted-adapter.ts';

const tempRoot = realpathSync.native(
  mkdtempSync(join(tmpdir(), 'project02-browser-')),
);
const homeRoot = join(tempRoot, 'home');
const abort = new AbortController();
const onSignal = (): void => {
  abort.abort();
};

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

await ensureInitializedProject02Store({homeRoot});
writeRuntimeConfig(join(homeRoot, 'config.json'), {
  plugins: {[demoConfigPluginId]: {enabled: true}},
});

try {
  process.exitCode = await runServeCliFromArgs(
    ['--store', homeRoot, '--init'],
    {
      stdin: Readable.from([]),
      stdout: process.stdout,
      stderr: process.stderr,
      // A developer's .env must not pick the provider over the script.
      env: {},
      signal: abort.signal,
      roleModelAdapter: createScriptedAdapter({homeRoot, characterId: 'mira'}),
      port: 0,
    },
  );
} finally {
  rmSync(tempRoot, {recursive: true, force: true});
}
