import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, type Page} from '@playwright/test';

import {startDaemon} from '../conformance/harness/daemon.ts';
import {frameOf, openEvents} from '../conformance/harness/events.ts';
import {
  characterJson,
  configJson,
  createHome,
} from '../conformance/harness/home.ts';
import {bearer, exchange} from '../conformance/harness/http.ts';
import {startModelServer} from '../conformance/harness/model-server.ts';
import {test} from './fixture.ts';

/** Mira on the model server, the home's config.json holding these settings beside the model's. */
async function miraHome(
  config: {readonly project02?: object; readonly [section: string]: unknown},
  seed: Parameters<typeof createHome>[0] = {},
) {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      ...config,
      project02: {...model.settings, ...config.project02},
    }),
    ...seed,
  });

  return {home, daemon: await startDaemon(home)};
}

/** The row of one field, host or section, by its key. */
function row(page: Page, key: string) {
  return page.locator(`[data-field="${key}"]`);
}

/** The home's config.json as it stands. */
function homeConfig(home: string): unknown {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
}

test("page.settings-setup-frame: a fresh home with no model provider chosen opens on Set up your home with the home's messaging app rows; a chosen provider starts the character, a saved name shows Saved from the home while she stays ready, and Chat leads to the composer", async ({
  page,
}) => {
  const model = await startModelServer();
  const {roleModelProvider, ...endpoint} = model.settings;
  const daemon = await startDaemon(
    createHome({'config.json': configJson({project02: endpoint})}),
  );
  const events = await openEvents(daemon);
  const mira = page.getByRole('button', {name: /^Mira\b/u});
  const settled = (state: string) =>
    events.next(frameOf('state_changed', {characterId: 'mira', state}));

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

  const provider = row(page, 'project02.roleModelProvider');

  await provider
    .getByRole('combobox', {name: 'Role model provider'})
    .selectOption(roleModelProvider);
  await provider.getByRole('button', {name: 'Save'}).click();
  await expect(provider.getByRole('button', {name: 'Saved'})).toBeVisible();
  await expect(provider).toContainText('the home');
  await settled('ready');
  await expect(mira).toContainText('ready');

  const name = row(page, 'project02.userDisplayName');

  await expect(name).toContainText('default: You');
  await name.getByRole('textbox', {name: 'User display name'}).fill('Sam');
  await name.getByRole('button', {name: 'Save'}).click();
  await expect(name.getByRole('button', {name: 'Saved'})).toBeVisible();
  // The view is read again: the value is the home's now.
  await expect(name).toContainText('the home');
  await expect(mira).toContainText('ready');

  // The exit is the person's.
  await expect(
    page.getByRole('heading', {name: 'Set up your home'}),
  ).toBeVisible();
  await page.getByRole('button', {name: 'Chat'}).click();
  await expect(page.getByRole('textbox', {name: 'Message Mira'})).toBeVisible();
});

test("page.settings-save-and-sync: a character's plugin field, a secret and her bot token save from her screen, a secret shown only as set and never in the page; a second page follows saves through the stream; and a page that fell behind is told that someone saved first", async ({
  context,
  page,
}) => {
  const {daemon} = await miraHome({plugins: {'demo-config': {enabled: true}}});

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

  // A page whose read did not land is behind, and says so; its next save
  // is told that someone saved first.
  await second.route('**/api/config?*', route => route.abort(), {times: 1});
  await noteBox.fill('kept');
  await note.getByRole('button', {name: 'Save'}).click();
  await expect(note.getByRole('button', {name: 'Saved'})).toBeVisible();
  await expect(second.locator('.notice')).toBeVisible();

  const staleSignoff = row(second, 'plugins/demo-config/signoff');

  await staleSignoff.getByRole('textbox', {name: 'Signoff'}).fill('bye');
  await staleSignoff.getByRole('button', {name: 'Save'}).click();
  await expect(second.locator('.notice')).toContainText(
    'Someone else saved first',
  );
  // The screen shows what is there now, with the person's own text still in its row.
  await expect(secondNote).toHaveValue('kept');
  await expect(
    staleSignoff.getByRole('textbox', {name: 'Signoff'}),
  ).toHaveValue('bye');

  // A character clicked in the roster is a thread wanted: settings give way.
  await page.getByRole('button', {name: /^Mira\b/u}).click();
  await expect(page.getByRole('textbox', {name: 'Message Mira'})).toBeVisible();
});

test('page.settings-character-switch: a character that is off shows off with no Start, and with two characters none opens itself; her Enabled switch turns her on to ready and off again', async ({
  page,
}) => {
  const {daemon} = await miraHome(
    {},
    {
      characters: {
        nova: {'project02.character.json': characterJson('nova', 'Nova')},
      },
      'character-data': {
        nova: {'config.json': configJson({project02: {enabled: false}})},
      },
    },
  );

  await page.goto(daemon.url);

  const nova = page.getByRole('listitem').filter({hasText: 'Nova'});

  await expect(nova).toContainText('off');
  await expect(
    nova.getByRole('button', {name: 'Start', exact: true}),
  ).toHaveCount(0);
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

test("page.settings-connector-presence: a connector's block says from health whether its process is on the daemon's stream, and how to start it when it is not", async ({
  page,
}) => {
  const {daemon} = await miraHome({});
  const telegram = page.locator('[data-section="connectors/telegram"]');
  const notRunning =
    'Connector: not running. Opening the app starts it; at a terminal, run project02 telegram.';

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await expect(telegram).toContainText(notRunning);

  const connector = await exchange(daemon, {
    path: '/api/events?connector=telegram',
    headers: bearer(daemon),
  });

  await connector.received('event: ready');
  await expect(telegram).toContainText('Connector: running.');
  connector.hangUp();
  await expect(telegram).toContainText(notRunning);
});

test("page.settings-field-editing: each row saves its field as its kind — text, a number, a switch, a secret, JSON for a structure, a section's switch — Reset unsets it, and a value shows as the text that saves it back as it was", async ({
  page,
}) => {
  const kim = {'7': 'Kim'};
  const {home, daemon} = await miraHome({
    // A model's name that reads as a number, and a structure.
    project02: {nvidiaModel: '1234'},
    connectors: {telegram: {config: {pairedUsers: kim}}},
  });
  const landed = (key: string) =>
    expect(row(page, key).getByText('Saved', {exact: true})).toBeVisible();
  const saved = async (key: string, button = 'Save') => {
    await row(page, key).getByRole('button', {name: button}).click();
    await landed(key);
  };
  /** The value as the box shows it, typed back in. */
  const retyped = async (key: string, label: string) => {
    const box = row(page, key).getByLabel(label, {exact: true});
    const shown = await box.inputValue();

    await box.fill('');
    await box.fill(shown);

    return shown;
  };

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();

  expect(await retyped('project02.nvidiaModel', 'Nvidia model')).toBe('1234');
  await saved('project02.nvidiaModel');
  expect(await retyped('connectors/telegram/pairedUsers', 'Paired users')).toBe(
    JSON.stringify(kim),
  );
  await saved('connectors/telegram/pairedUsers');
  expect(homeConfig(home)).toMatchObject({
    project02: {nvidiaModel: '1234'},
    connectors: {telegram: {config: {pairedUsers: kim}}},
  });

  await row(page, 'project02.contextWindowTokens')
    .getByLabel('Context window tokens', {exact: true})
    .fill('4096');
  await saved('project02.contextWindowTokens');
  await row(page, 'connectors/telegram/mirror')
    .getByRole('checkbox', {name: 'Mirror'})
    .uncheck();
  await landed('connectors/telegram/mirror');
  await row(page, 'connectors/telegram/managementBotToken')
    .getByLabel('Management bot token', {exact: true})
    .fill('123456:home-bot');
  await saved('connectors/telegram/managementBotToken', 'Replace');
  await row(page, 'plugins/demo-config')
    .getByRole('checkbox', {name: 'Demo Config enabled'})
    .check();
  await landed('plugins/demo-config');
  expect(homeConfig(home)).toMatchObject({
    project02: {contextWindowTokens: 4096},
    connectors: {
      telegram: {
        config: {mirror: false, managementBotToken: '123456:home-bot'},
      },
    },
    plugins: {'demo-config': {enabled: true}},
  });
  await expect(
    row(page, 'connectors/telegram/managementBotToken'),
  ).not.toContainText('not set');
  expect(await page.content()).not.toContain('123456:home-bot');

  await saved('project02.contextWindowTokens', 'Reset');
  await expect(row(page, 'project02.contextWindowTokens')).toContainText(
    'default: 32768',
  );
  expect(homeConfig(home)).not.toHaveProperty([
    'project02',
    'contextWindowTokens',
  ]);
});
