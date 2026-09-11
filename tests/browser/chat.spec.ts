import {expect, test as base} from '@playwright/test';

import {spawnDaemon, type SpawnedDaemon} from '../support/spawn-daemon.ts';

/** A daemon of its own per test, stopped the way an operator stops it. */
const test = base.extend<{
  /** Characters installed disabled beside Mira, so the roster has one that is not running. */
  disabledCharacters: readonly string[];
  daemon: SpawnedDaemon;
}>({
  disabledCharacters: [[], {option: true}],
  daemon: async ({disabledCharacters}, use) => {
    const daemon = await spawnDaemon('tests/browser/daemon-entry.ts', [
      ...disabledCharacters,
    ]);

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
  await expect(page.getByRole('button', {name: /Mira/u})).toContainText(
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

test.describe('a roster with a character that is not running', () => {
  test.use({disabledCharacters: ['nova']});

  test('offers Start beside the character, and says why an open was refused', async ({
    daemon,
    page,
  }) => {
    await page.goto(daemon.url);

    const nova = page.getByRole('listitem').filter({hasText: 'Nova'});

    await expect(nova).toContainText('not started');
    // Two characters: none opens itself.
    await expect(page.getByText('Pick a character.')).toBeVisible();

    await nova.getByRole('button', {name: /Nova/u}).click();
    await expect(page.locator('.notice')).toContainText('has not been started');

    // The daemon's answer to a start reaches the roster: a disabled
    // character cannot start, and the reason shows where the person looks.
    await nova.getByRole('button', {name: 'Start', exact: true}).click();
    await expect(nova).toContainText('failed');
    await expect(nova).toContainText('disabled');
  });
});
