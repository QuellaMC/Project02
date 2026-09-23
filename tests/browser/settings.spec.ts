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

/** The row of one field, host or plugin, by its key. */
function row(page: Page, key: string) {
  return page.locator(`[data-field="${key}"]`);
}

test.describe('a fresh home', () => {
  test.use({freshHome: true});

  test('opens on the setup frame; a saved name reloads the character, a saved provider stays, and Chat leads to the composer', async ({
    daemon,
    page,
  }) => {
    await page.goto(daemon.url);
    await expect(
      page.getByRole('heading', {name: 'Set up your home'}),
    ).toBeVisible();

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

test("saves a character's plugin field and secret, shows the secret only as set, and tells a stale page that someone saved first", async ({
  daemon,
  context,
  page,
}) => {
  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings for Mira'}).click();
  await expect(
    page.getByRole('heading', {name: 'Settings · Mira'}),
  ).toBeVisible();

  const tone = row(page, 'plugins.demo-config.tone');

  await expect(tone).toContainText('default');
  await tone.getByRole('combobox', {name: 'Tone'}).selectOption('warm');
  await tone.getByRole('button', {name: 'Save'}).click();
  await expect(tone.getByRole('button', {name: 'Saved'})).toBeVisible();
  await expect(tone).toContainText('this character');
  await expect(tone.getByRole('combobox', {name: 'Tone'})).toHaveValue('warm');

  const secret = row(page, 'plugins.demo-config.apiKey');

  await expect(secret).toContainText('not set');
  await secret.getByLabel('Api key').fill('sk-live-secret');
  await secret.getByRole('button', {name: 'Replace'}).click();
  await expect(secret).toContainText('set');
  await expect(secret).not.toContainText('not set');
  await expect(secret.getByLabel('Api key')).toHaveValue('');
  expect(await page.content()).not.toContain('sk-live-secret');

  // A second page on the same screen reads the view now, then falls
  // behind a save made here.
  const second = await context.newPage();

  await second.goto(daemon.url);
  await second.getByRole('button', {name: 'Settings for Mira'}).click();
  await expect(row(second, 'plugins.demo-config.tone')).toContainText(
    'this character',
  );

  const note = row(page, 'plugins.demo-config.operatorNote');

  await note.getByRole('textbox', {name: 'Operator note'}).fill('kept');
  await note.getByRole('button', {name: 'Save'}).click();
  await expect(note.getByRole('button', {name: 'Saved'})).toBeVisible();

  const staleSignoff = row(second, 'plugins.demo-config.signoff');

  await staleSignoff.getByRole('textbox', {name: 'Signoff'}).fill('bye');
  await staleSignoff.getByRole('button', {name: 'Save'}).click();
  await expect(second.locator('.notice')).toContainText(
    'Someone else saved first',
  );
  // The screen shows what is there now, with the person's own text still in its row.
  await expect(
    row(second, 'plugins.demo-config.operatorNote').getByRole('textbox', {
      name: 'Operator note',
    }),
  ).toHaveValue('kept');
  await expect(
    staleSignoff.getByRole('textbox', {name: 'Signoff'}),
  ).toHaveValue('bye');
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
