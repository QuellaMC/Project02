import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test as base} from '@playwright/test';

import {createGatewayClient} from '../../src/gateway/client/index.ts';
import {spawnDaemon, type SpawnedDaemon} from '../support/spawn-daemon.ts';

/** A daemon of its own per test, stopped the way an operator stops it. */
const test = base.extend<{daemon: SpawnedDaemon}>({
  daemon: async ({}, use) => {
    const daemon = await spawnDaemon('tests/browser/daemon-entry.ts', []);

    await use(daemon);

    const stopped = await daemon.stop();

    expect(stopped.code, stopped.stderr).toBe(0);
  },
});

test('opens the printed address, chats with the reply drafted ahead of its commit, and shows the same thread in a second tab', async ({
  daemon,
  context,
  page,
}) => {
  await page.goto(daemon.url);
  await expect(page.getByRole('button', {name: /^Mira\b/u})).toContainText(
    'ready',
  );

  // One character opens itself.
  const composer = page.getByRole('textbox', {name: 'Message Mira'});
  const line = `slowly ${Array.from({length: 300}, (_, word) => `word${String(word)}`).join(' ')}`;

  await composer.fill(line);
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(page.locator('.bubble-own .bubble-text')).toHaveText(line);

  // The draft fills ahead of the commit, then the commit replaces it, whole.
  await expect(page.locator('[data-draft]')).toBeVisible();
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText(
    `noted: ${line}`,
  );
  await expect(page.locator('[data-draft]')).toHaveCount(0);
  await expect(page.locator('[data-pending]')).toHaveCount(0);

  const second = await context.newPage();

  await second.goto(daemon.url);
  await expect(second.locator('.bubble-own .bubble-text')).toHaveText(line);
  await expect(second.locator('.bubble-theirs .bubble-text')).toHaveText(
    `noted: ${line}`,
  );
});

base(
  'says it is connecting once the daemon stops, comes back on the same address once another starts on the home, and answers the next line without a click',
  async ({page}) => {
    // A home the test owns, so two daemons can share it; two characters,
    // so no thread opens itself and a restart cannot hide behind that.
    const homeRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'project02-browser-home-')),
    );
    const start = () =>
      spawnDaemon('tests/browser/daemon-entry.ts', [
        '--home',
        homeRoot,
        'nova',
      ]);
    let daemon = await start();

    try {
      await page.goto(daemon.url);
      await page.getByRole('button', {name: /^Mira\b/u}).click();

      const composer = page.getByRole('textbox', {name: 'Message Mira'});
      const replies = page.locator('.bubble-theirs .bubble-text');

      await composer.fill('hello');
      await composer.press('Enter');
      await expect(replies).toHaveText(['noted: hello']);

      const stopped = await daemon.stop();

      expect(stopped.code, stopped.stderr).toBe(0);
      await expect(page.getByText('Connecting…')).toBeVisible();
      await expect(replies).toHaveText(['noted: hello']);

      const url = daemon.url;

      daemon = await start();
      expect(daemon.url).toBe(url);
      await expect(page.getByText('Connecting…')).toHaveCount(0);
      await expect(replies).toHaveText(['noted: hello']);
      await composer.fill('again');
      await composer.press('Enter');
      await expect(replies).toHaveText(['noted: hello', 'noted: again']);
    } finally {
      const stopped = await daemon.stop();

      expect(stopped.code, stopped.stderr).toBe(0);
      rmSync(homeRoot, {recursive: true, force: true});
    }
  },
);

test('shows a confirmation card for a tool round and lets the turn finish once approved', async ({
  daemon,
  page,
}) => {
  await page.goto(daemon.url);

  const composer = page.getByRole('textbox', {name: 'Message Mira'});

  await composer.fill('confirm');
  await composer.press('Enter');

  const card = page.getByRole('group', {name: 'Confirmation'});

  await expect(card).toContainText('Confirm runtime.plugin.config.update');
  await expect(card).toContainText('"fieldName": "tone"');
  await expect(card).toContainText('"value": "warm"');
  await card.getByRole('button', {name: 'Approve'}).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText('done');
});

test('shows a pairing card for an account a connector asks to let in, and pairs the account once approved', async ({
  daemon,
  page,
}) => {
  const client = createGatewayClient({url: daemon.url});
  const alice = {id: '123456789', label: 'Alice (@alice)'};
  const asked = await client.requestPairing('telegram', alice);

  if (asked.status !== 'pending') {
    throw new Error(`The daemon did not hold the request: ${asked.status}.`);
  }

  await page.goto(daemon.url);

  const card = page.getByRole('group', {name: 'Pairing'});

  await expect(card).toContainText(alice.label);
  await expect(card).toContainText(asked.request.code);
  await card.getByRole('button', {name: 'Approve'}).click();
  await expect(card).toHaveCount(0);
  await expect(client.connectorConfig('telegram')).resolves.toMatchObject({
    home: {values: {pairedUsers: {[alice.id]: alice.label}}},
  });
});

test('keeps a line whose turn the daemon rejected on the thread and says why', async ({
  daemon,
  page,
}) => {
  await page.goto(daemon.url);

  const composer = page.getByRole('textbox', {name: 'Message Mira'});

  await composer.fill('reject');
  await composer.press('Enter');
  await expect(page.locator('.bubble-own .bubble-text')).toHaveText('reject');
  await expect(page.locator('.notice')).not.toBeEmpty();
  await expect(page.locator('[data-pending]')).toHaveCount(0);
  await expect(composer).toHaveValue('');
});

test('gives a line the daemon refuses back to the composer, with what it said', async ({
  daemon,
  page,
}) => {
  await page.goto(daemon.url);

  const composer = page.getByRole('textbox', {name: 'Message Mira'});
  // Longer than the wire takes, as a paste can be: the daemon refuses it
  // before any turn runs, so the line is the person's again.
  const tooLong = 'x'.repeat(17 * 1024);

  await composer.fill(tooLong);
  await composer.press('Enter');
  await expect(page.locator('.notice')).toContainText(
    'Mira: The message.text exceeds',
  );
  await expect(composer).toHaveValue(tooLong);
  await expect(page.locator('[data-pending]')).toHaveCount(0);
});
