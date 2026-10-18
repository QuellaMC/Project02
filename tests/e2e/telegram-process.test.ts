import {join} from 'node:path';

import {describe, expect, it, vi} from 'vitest';

import {characterOverlayConfigPath} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  ensureCharacterDataDir,
} from '../../src/runtime/storage/index.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {spawnDaemon, spawnProcess} from '../support/spawn-daemon.ts';
import {createFakeTelegram} from '../support/telegram-api.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

const homeToken = '123456:home';
const miraToken = '987654:mira';

describe('the Telegram connector, as a process', () => {
  it("finds the daemon by the home's record, runs a bot for each token, and exits 0 on SIGINT", async () => {
    const homeRoot = createTestTempRoot('project02-telegram-process-');
    const telegram = await createFakeTelegram();
    const methods = (token: string): readonly string[] =>
      telegram.calls(token).map(call => call.method);

    writeRuntimeConfig(join(homeRoot, 'config.json'), {
      connectors: {telegram: {config: {managementBotToken: homeToken}}},
    });
    await ensureCharacterDataDir({homeRoot, characterId: 'mira'});
    writeRuntimeConfig(
      characterOverlayConfigPath(characterDataDirPath(homeRoot, 'mira')),
      {connectors: {telegram: {config: {botToken: miraToken}}}},
    );
    telegram.registerBot(homeToken, {id: 123456, username: 'home_bot'});
    telegram.registerBot(miraToken, {id: 987654, username: 'mira_bot'});

    const daemon = await spawnDaemon('src/cli/serve/main.ts', [
      '--store',
      homeRoot,
      '--init',
    ]);
    const connector = await spawnProcess(
      'src/frontends/telegram/main.ts',
      ['--store', homeRoot],
      line => line === 'Telegram: @mira_bot answers for Mira.',
      {PROJECT02_TEST_TELEGRAM_API: telegram.baseUrl},
    );

    expect(connector.stdout).toContain(
      `Telegram connector: connected to ${new URL(daemon.url).origin}.\n`,
    );
    await vi.waitFor(
      () => {
        expect(methods(homeToken)).toEqual(['getMe', 'getUpdates']);
        expect(methods(miraToken)).toEqual(['getMe', 'getUpdates']);
      },
      {timeout: 5_000},
    );
    expect(await connector.stop()).toEqual({code: 0, stderr: ''});
    expect((await daemon.stop()).code).toBe(0);
    await telegram.close();
  });
});
