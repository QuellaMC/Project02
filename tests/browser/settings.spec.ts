import {expect, test as base, type Page} from '@playwright/test';

import {spawnDaemon, type SpawnedDaemon} from '../support/spawn-daemon.ts';

/** A daemon of its own per test, stopped the way an operator stops it. */
const test = base.extend<{
  /** Characters installed off beside Mira, so the roster has one that is not running. */
  disabledCharacters: readonly string[];
  /** A home whose provider is not chosen yet, the way a first run finds it. */
  freshHome: boolean;
  daemon: SpawnedDaemon;
}>({
  disabledCharacters: [[], {option: true}],
  freshHome: [false, {option: true}],
  daemon: async ({disabledCharacters, freshHome}, use) => {
    const daemon = await spawnDaemon('tests/browser/daemon-entry.ts', [
      ...(freshHome ? ['--fresh'] : []),
      ...disabledCharacters,
    ]);

    await use(daemon);

    const stopped = await daemon.stop();

    expect(stopped.code, stopped.stderr).toBe(0);
  },
});

/** The row of one field, host or section, by its key. */
function row(page: Page, key: string) {
  return page.locator(`[data-field="${key}"]`);
}

test.describe('a fresh home', () => {
  test.use({freshHome: true});

  test("opens on the setup frame with the home's messaging app settings; a saved name reloads the character, a saved provider stays, and Chat leads to the composer", async ({
    daemon,
    page,
  }) => {
    await page.goto(daemon.url);
    await expect(
      page.getByRole('heading', {name: 'Set up your home'}),
    ).toBeVisible();

    // A bot answers as one character, so its token is not the home's to set.
    await expect(
      page.getByRole('heading', {name: 'Messaging apps'}),
    ).toBeVisible();
    await expect(
      row(page, 'connectors/telegram/managementBotToken'),
    ).toBeVisible();
    await expect(row(page, 'connectors/telegram/mirror')).toBeVisible();
    await expect(row(page, 'connectors/telegram/botToken')).toHaveCount(0);
    await expect(row(page, 'connectors/telegram')).toContainText(
      'Characters that set their own switch keep it',
    );

    const name = row(page, 'project02.userDisplayName');

    await expect(name).toContainText('default: You');
    await name.getByRole('textbox', {name: 'User display name'}).fill('Sam');
    await name.getByRole('button', {name: 'Save'}).click();
    await expect(name.getByRole('button', {name: 'Saved'})).toBeVisible();
    // The view is read again: the value is the home's now.
    await expect(name).toContainText('the home');
    // The change reached the running character; the roster says how.
    await expect(page.getByRole('button', {name: /^Mira\b/u})).toContainText(
      'ready',
    );

    const provider = row(page, 'project02.roleModelProvider');

    await provider
      .getByRole('combobox', {name: 'Role model provider'})
      .selectOption('local');
    await provider.getByRole('button', {name: 'Save'}).click();
    await expect(provider.getByRole('button', {name: 'Saved'})).toBeVisible();
    await expect(provider).toContainText('the home');

    // The exit is the person's.
    await expect(
      page.getByRole('heading', {name: 'Set up your home'}),
    ).toBeVisible();
    await page.getByRole('button', {name: 'Chat'}).click();
    await expect(
      page.getByRole('textbox', {name: 'Message Mira'}),
    ).toBeVisible();
  });
});

test("saves a character's plugin field and secret and her bot token, shows a secret only as set, keeps a second page in step, and tells one that fell behind that someone saved first", async ({
  daemon,
  context,
  page,
}) => {
  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings for Mira'}).click();
  await expect(
    page.getByRole('heading', {name: 'Settings · Mira'}),
  ).toBeVisible();

  const tone = row(page, 'plugins/demo-config/tone');

  await expect(tone).toContainText('default');
  await tone.getByRole('combobox', {name: 'Tone'}).selectOption('warm');
  await tone.getByRole('button', {name: 'Save'}).click();
  await expect(tone.getByRole('button', {name: 'Saved'})).toBeVisible();
  await expect(tone).toContainText('this character');
  await expect(tone.getByRole('combobox', {name: 'Tone'})).toHaveValue('warm');

  const secret = row(page, 'plugins/demo-config/apiKey');

  await expect(secret).toContainText('not set');
  await secret.getByLabel('Api key').fill('sk-live-secret');
  await secret.getByRole('button', {name: 'Replace'}).click();
  await expect(secret).toContainText('set');
  await expect(secret).not.toContainText('not set');
  await expect(secret.getByLabel('Api key')).toHaveValue('');
  expect(await page.content()).not.toContain('sk-live-secret');

  const botToken = row(page, 'connectors/telegram/botToken');

  await expect(botToken).toContainText('not set');
  await botToken.getByLabel('Bot token').fill('4242:telegram-bot-token');
  await botToken.getByRole('button', {name: 'Replace'}).click();
  await expect(botToken).not.toContainText('not set');
  await expect(botToken).toContainText('set');
  expect(await page.content()).not.toContain('4242:telegram-bot-token');

  // A second page on the same screen follows a save made here without
  // doing anything: the stream says config moved, and it reads again.
  const second = await context.newPage();

  await second.goto(daemon.url);
  await second.getByRole('button', {name: 'Settings for Mira'}).click();
  await expect(row(second, 'plugins/demo-config/tone')).toContainText(
    'this character',
  );

  const note = row(page, 'plugins/demo-config/operatorNote');
  const noteBox = note.getByRole('textbox', {name: 'Operator note'});
  const secondNote = row(second, 'plugins/demo-config/operatorNote').getByRole(
    'textbox',
    {name: 'Operator note'},
  );

  // The read after a save fails at first: the row says Saved only once a
  // read has landed, and then shows what was saved, never the value from
  // before.
  let reads = 'failing';

  await page.route('**/api/config?*', async route => {
    await (reads === 'failing' ? route.abort() : route.continue());
  });
  await noteBox.fill('kept');
  await note.getByRole('button', {name: 'Save'}).click();
  await expect(page.locator('.notice')).toBeVisible();
  await expect(note.getByRole('button', {name: 'Saved'})).toHaveCount(0);
  reads = 'landing';
  await expect(note.getByRole('button', {name: 'Saved'})).toBeVisible();
  expect(await noteBox.inputValue()).toBe('kept');
  await page.unroute('**/api/config?*');
  await expect(secondNote).toHaveValue('kept');

  // A page whose read did not land is behind, and says so; its next save
  // is told that someone saved first.
  await second.route('**/api/config?*', route => route.abort(), {times: 1});
  await noteBox.fill('kept again');
  await note.getByRole('button', {name: 'Save'}).click();
  await expect(note.getByRole('button', {name: 'Saved'})).toBeVisible();
  await expect(second.locator('.notice')).toBeVisible();
  await expect(secondNote).toHaveValue('kept');

  const staleSignoff = row(second, 'plugins/demo-config/signoff');

  await staleSignoff.getByRole('textbox', {name: 'Signoff'}).fill('bye');
  await staleSignoff.getByRole('button', {name: 'Save'}).click();
  await expect(second.locator('.notice')).toContainText(
    'Someone else saved first',
  );
  // The screen shows what is there now, with the person's own text still in its row.
  await expect(secondNote).toHaveValue('kept again');
  await expect(
    staleSignoff.getByRole('textbox', {name: 'Signoff'}),
  ).toHaveValue('bye');

  // A character clicked in the roster is a thread wanted: settings give way.
  await page.getByRole('button', {name: /^Mira\b/u}).click();
  await expect(page.getByRole('textbox', {name: 'Message Mira'})).toBeVisible();
});

test.describe('a roster with a character that is off', () => {
  test.use({disabledCharacters: ['nova']});

  test('shows her off with no Start, and her settings switch turns her on and off again', async ({
    daemon,
    page,
  }) => {
    await page.goto(daemon.url);

    const nova = page.getByRole('listitem').filter({hasText: 'Nova'});

    await expect(nova).toContainText('off');
    await expect(
      nova.getByRole('button', {name: 'Start', exact: true}),
    ).toHaveCount(0);
    // Two characters: none opens itself.
    await expect(page.getByText('Pick a character.')).toBeVisible();

    await nova.getByRole('button', {name: 'Settings for Nova'}).click();
    await expect(
      page.getByRole('heading', {name: 'Settings · Nova'}),
    ).toBeVisible();

    const enabled = row(page, 'project02.enabled');
    const control = enabled.getByRole('checkbox', {name: 'Enabled'});

    await expect(enabled).toContainText('this character');
    await expect(control).not.toBeChecked();
    await control.check();
    await expect(enabled.getByText('Saved')).toBeVisible();
    await expect(nova).toContainText('ready');
    await expect(control).toBeChecked();

    await control.uncheck();
    await expect(nova).toContainText('off');
    await expect(control).not.toBeChecked();
  });
});
