/**
 * A daemon for the browser suite, the way serve runs it: on a temporary
 * home — or one the test owns, given as `--home <dir>`, so two daemons can
 * share it across a restart — with the demo-config plugin enabled and a
 * model scripted by the line it reads. Character ids on the command line
 * are installed disabled, for a roster with a character that is not
 * running; `--fresh` leaves the home's provider unchosen, the way a first
 * run finds it. Spawned as a process (tests/support/spawn-daemon.ts), so
 * Playwright's own loader never enters the daemon's graph. Prints what
 * serve prints; stops on SIGINT and removes a home of its own.
 */
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';

import {runServeCliFromArgs} from '../../src/cli/serve/main.ts';
import {demoConfigPluginId} from '../../src/plugins/packages/demo-config/plugin.ts';
import {
  characterOverlayConfigPath,
  ensureInitializedProject02Store,
} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  ensureCharacterDataDir,
} from '../../src/runtime/storage/index.ts';
import {writeTestCharacterPackage} from '../support/character-fixtures.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createScriptedAdapter} from '../support/scripted-adapter.ts';

const args = process.argv.slice(2);
const homeFlag = args.indexOf('--home');
const {homeRoot, own} = chooseHome(
  homeFlag === -1 ? undefined : args[homeFlag + 1],
);
const abort = new AbortController();
const onSignal = (): void => {
  abort.abort();
};

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

const fresh = args.includes('--fresh');
const disabledIds = args.filter(
  (arg, index) =>
    arg !== '--fresh' && arg !== '--home' && args[index - 1] !== '--home',
);

await ensureInitializedProject02Store({homeRoot});
writeRuntimeConfig(join(homeRoot, 'config.json'), {
  ...(fresh ? {} : {project02: {roleModelProvider: 'nvidia'}}),
  plugins: {[demoConfigPluginId]: {enabled: true}},
});

for (const id of disabledIds) {
  writeTestCharacterPackage(homeRoot, {
    id,
    displayName: id.slice(0, 1).toUpperCase() + id.slice(1),
  });
  await ensureCharacterDataDir({homeRoot, characterId: id});
  writeRuntimeConfig(
    characterOverlayConfigPath(characterDataDirPath(homeRoot, id)),
    {project02: {enabled: false}},
  );
}

try {
  process.exitCode = await runServeCliFromArgs(
    ['--store', homeRoot, '--init'],
    {
      stdin: Readable.from([]),
      stdout: process.stdout,
      stderr: process.stderr,
      signal: abort.signal,
      roleModelAdapter: createScriptedAdapter({homeRoot, characterId: 'mira'}),
    },
  );
} finally {
  if (own !== undefined) {
    rmSync(own, {recursive: true, force: true});
  }
}

/** The home given, or a temporary one of this process's own, removed at the end. */
function chooseHome(given: string | undefined): {
  readonly homeRoot: string;
  readonly own?: string;
} {
  if (given !== undefined) {
    return {homeRoot: given};
  }

  const own = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'project02-browser-')),
  );

  return {homeRoot: join(own, 'home'), own};
}
