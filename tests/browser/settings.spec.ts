import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, type Locator, type Page} from '@playwright/test';

import {connector, startDaemon} from '../conformance/harness/daemon.ts';
import {
  characterJson,
  configJson,
  createHome,
} from '../conformance/harness/home.ts';
import {startMem0Server} from '../conformance/harness/mem0-server.ts';
import {
  messagesOf,
  reply,
  startModelServer,
} from '../conformance/harness/model-server.ts';
import {startTelegramServer} from '../conformance/harness/telegram-server.ts';
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

  return {model, home, daemon: await startDaemon(home)};
}

/** The home's config.json as it stands. */
function homeConfig(home: string): unknown {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
}

/** An entry of the window's sidebar, by the start of its name. */
function entry(page: Page, name: string): Locator {
  return page
    .getByRole('navigation', {name: 'Settings'})
    .getByRole('button', {name: new RegExp(`^${name}`, 'u')});
}

/** The green check in the box of this field. */
function checkOf(page: Page, box: Locator): Locator {
  return page.locator('.box', {has: box}).locator('.box-check');
}

async function say(page: Page, line: string, to = 'Mira'): Promise<void> {
  const composer = page.getByRole('textbox', {name: `Message ${to}`});

  await composer.fill(line);
  await composer.press('Enter');
}

/** The file chooser this button opens, given a file of this name and text. */
async function chooseFile(
  page: Page,
  button: Locator,
  name: string,
  text: string,
): Promise<void> {
  const chooser = page.waitForEvent('filechooser');

  await button.click();
  await (
    await chooser
  ).setFiles({name, mimeType: 'application/json', buffer: Buffer.from(text)});
}

/** The folders of the characters added to the home. */
function addedTo(home: string): string[] {
  const packages = join(home, 'characters');

  return existsSync(packages) ? readdirSync(packages) : [];
}

test('page.welcome-first-run: a home whose settings give her no AI model opens on the welcome; the name, the service and the key save as each is given, Start Chatting opens the chat, and she answers through the key', async ({
  page,
}) => {
  const model = await startModelServer();
  const {roleModelProvider, nvidiaApiKey, ...server} = model.settings;
  const home = createHome({'config.json': configJson({project02: server})});
  const daemon = await startDaemon(home);
  const next = page.getByRole('button', {name: 'Continue'});

  await page.goto(daemon.url);
  await expect(page.getByRole('heading', {name: 'Welcome'})).toBeVisible();
  await expect(
    page.getByText('Mira is ready to meet you. What should she call you?'),
  ).toBeVisible();
  await page.getByRole('textbox', {name: 'Your Name'}).fill('Sam');
  await next.click();
  await expect(
    page.getByRole('heading', {name: 'Choose an AI Model'}),
  ).toBeVisible();
  expect(homeConfig(home)).toMatchObject({project02: {userDisplayName: 'Sam'}});
  await expect(next).toHaveAttribute('aria-disabled', 'true');

  await page
    .getByRole('combobox', {name: 'Service'})
    .selectOption(roleModelProvider);

  const key = page.getByLabel('API Key');

  await key.fill(nvidiaApiKey);
  await key.press('Enter');
  await expect(checkOf(page, key)).toBeVisible();
  await expect(key).toHaveValue('');
  await next.click();
  await expect(
    page.getByRole('heading', {name: "You're All Set, Sam"}),
  ).toBeVisible();
  expect(homeConfig(home)).toMatchObject({
    project02: {roleModelProvider, nvidiaApiKey},
  });

  model.answer(reply('Hello, Sam.'));
  await page.getByRole('button', {name: 'Start Chatting'}).click();
  await say(page, 'Hi.');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Hello, Sam.',
  ]);
  expect(model.requests.at(-1)?.authorization).toBe(`Bearer ${nvidiaApiKey}`);
  expect(await page.content()).not.toContain(nvidiaApiKey);
});

test('page.settings-saves-as-typed: a box saves on Return with a check and no Save button anywhere, emptied it inherits again, and a key box stays empty, a stored key shown as dots and a new one never shown back', async ({
  page,
}) => {
  const {home, daemon} = await miraHome({});
  const fresh = 'nvapi-fresh-key';

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'You').click();

  const name = page.getByRole('textbox', {name: 'Name'});

  await expect(name).toHaveAttribute('placeholder', 'Your name');
  await name.fill('Sam');
  await name.press('Enter');
  await expect(checkOf(page, name)).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Sam'})).toBeVisible();
  await expect(entry(page, 'Sam')).toBeVisible();
  expect(homeConfig(home)).toMatchObject({project02: {userDisplayName: 'Sam'}});
  await expect(page.getByRole('button', {name: /Save/u})).toHaveCount(0);

  await name.fill('');
  await name.press('Enter');
  await expect(
    page.getByRole('heading', {name: 'You', exact: true}),
  ).toBeVisible();
  expect(homeConfig(home)).not.toHaveProperty(['project02', 'userDisplayName']);

  await entry(page, 'AI Model').click();

  const key = page.getByLabel('API Key');

  await expect(key).toHaveValue('');
  await expect(key).toHaveAttribute('placeholder', '••••••••••••');
  await expect(checkOf(page, key)).toBeVisible();
  await key.fill(fresh);
  await key.press('Enter');
  await expect(key).toHaveValue('');
  await expect
    .poll(() => homeConfig(home))
    .toMatchObject({project02: {nvidiaApiKey: fresh}});
  expect(await page.content()).not.toContain(fresh);
});

test('page.settings-feature-switch: Reply Style switched on from her page, with a tone and a sign-off, takes effect in her next reply', async ({
  page,
}) => {
  const {model, daemon} = await miraHome({});
  const feature = page.getByRole('button', {name: 'Reply Style'});

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings for Mira'}).click();
  await expect(feature).toContainText('Off');
  await feature.click();
  await page.getByRole('switch', {name: 'Reply Style'}).click();
  await page.getByRole('radio', {name: 'Warm'}).click();
  await expect(page.getByRole('radio', {name: 'Warm'})).toHaveAttribute(
    'aria-checked',
    'true',
  );

  const signoff = page.getByRole('textbox', {name: 'Sign-Off'});

  await signoff.fill('Yours, Mira.');
  await signoff.press('Enter');
  await expect(checkOf(page, signoff)).toBeVisible();
  await page.getByRole('main').getByRole('button', {name: 'Mira'}).click();
  await expect(feature).toContainText('Warm');

  model.answer(reply('Warmly, as always. Yours, Mira.'));
  await page.getByRole('button', {name: 'Back to Chat'}).click();
  await say(page, 'Hello.');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Warmly, as always. Yours, Mira.',
  ]);
  expect(JSON.stringify(messagesOf(model.requests.at(-1)))).toContain(
    'warm tone. End everything you say with the exact signoff \\"Yours, Mira.\\"',
  );
});

test('page.settings-memory: Kept At shows only the boxes of the place chosen; switched on for her before it is set up, her row says Set Up and she still answers; set up, it is her switch again', async ({
  page,
}) => {
  const mem0 = await startMem0Server();
  const {model, daemon} = await miraHome(
    {},
    {
      'character-data': {
        mira: {'config.json': configJson({plugins: {mem0: {enabled: true}}})},
      },
    },
  );
  const row = page
    .locator('.cell')
    .filter({hasText: 'Remembers across all chats'});
  const place = (name: string) => page.getByRole('radio', {name});

  model.answer(reply('Still here.'));
  await page.goto(daemon.url);
  await say(page, 'Are you there?');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Still here.',
  ]);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await expect(entry(page, 'Memory')).toContainText('Set Up');
  await row.getByRole('button', {name: 'Set Up'}).click();
  await expect(
    page.getByRole('heading', {name: 'Long-Term Memory'}),
  ).toBeVisible();
  await expect(
    page.getByText('Long-Term Memory needs an API key.'),
  ).toBeVisible();

  await expect(place('Mem0 Cloud')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('API Key')).toHaveCount(1);
  await expect(page.getByLabel('Server Address')).toHaveCount(0);

  await place('This Computer').click();
  await expect(page.getByRole('heading', {name: 'Remembering'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Searching'})).toBeVisible();
  await expect(page.getByLabel('Server Address')).toHaveCount(0);

  await place('Your Server').click();
  await expect(page.getByRole('heading', {name: 'Remembering'})).toHaveCount(0);

  const address = page.getByLabel('Server Address');

  await address.fill(mem0.baseUrl);
  await address.press('Enter');
  await expect(
    page.getByRole('switch', {name: 'Long-Term Memory for Mira'}),
  ).toBeChecked();
  await expect(entry(page, 'Memory')).toContainText('Your Server');

  await entry(page, 'Mira').click();
  await expect(
    row.getByRole('switch', {name: 'Long-Term Memory'}),
  ).toBeChecked();
});

test('page.settings-telegram: the page says when Telegram is not running; a token pasted for her bot shows the name Telegram gave it and is never shown back, one Telegram refuses is said so, and a paired account is removed', async ({
  page,
}) => {
  const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
  const {home, daemon} = await miraHome({
    connectors: {telegram: {config: {pairedUsers: {'4242': 'Alice'}}}},
  });
  const notRunning = page.getByText("Telegram isn't running.", {exact: false});
  const token = page.getByLabel('Token');

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'Telegram').click();
  await expect(notRunning).toBeVisible();

  const telegram = await startTelegramServer([miraBot]);

  connector(['--store', home], telegram.env);
  await expect(notRunning).toHaveCount(0);

  const bot = page.getByRole('main').getByRole('button', {name: /^Mira/u});

  await expect(bot).toContainText('Add');
  await bot.click();
  await expect(page.getByRole('heading', {name: "Mira's Bot"})).toBeVisible();
  await token.fill(miraBot.token);
  await token.press('Enter');
  await expect(page.getByText('@mira_bot')).toBeVisible();
  expect(await page.content()).not.toContain(miraBot.token);

  await page.getByRole('button', {name: 'Remove Bot'}).click();
  await token.fill('111111:unknown');
  await token.press('Enter');
  await expect(page.getByText('Token Refused')).toBeVisible();
  await expect(
    page.getByText("Telegram didn't accept this token.", {exact: false}),
  ).toBeVisible();

  await page.getByRole('main').getByRole('button', {name: 'Telegram'}).click();
  await expect(bot).toContainText('Token Refused');

  const alice = page.locator('.cell').filter({hasText: 'Alice'});

  await expect(alice).toContainText('4242');
  await alice.getByRole('button', {name: 'Remove'}).click();
  await expect(page.getByText('No one yet')).toBeVisible();
  expect(homeConfig(home)).toMatchObject({
    connectors: {telegram: {config: {pairedUsers: {}}}},
  });
});

test('page.settings-advanced: the Advanced switch shows what most people never need and survives a reload, a row holding a value shows without it, and the plugin list opens what the app knows of a plugin', async ({
  page,
}) => {
  const {daemon} = await miraHome({});
  const contextSize = page.getByLabel('Context Size');
  const advanced = page.getByRole('switch', {name: 'Show Advanced Settings'});

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'AI Model').click();
  // The model server's address is set, so it shows.
  await expect(page.getByLabel('Server Address')).toBeVisible();
  await expect(contextSize).toHaveCount(0);

  await entry(page, 'Advanced').click();
  await advanced.click();
  await expect(entry(page, 'Advanced')).toContainText('On');
  await entry(page, 'AI Model').click();
  await expect(contextSize).toHaveAttribute('placeholder', '32768');

  await page.reload();
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'AI Model').click();
  await expect(contextSize).toBeVisible();

  await entry(page, 'Advanced').click();
  await expect(advanced).toBeChecked();
  await page.getByRole('button', {name: /^Long-Term Memory/u}).click();
  await expect(
    page.getByRole('heading', {name: 'Long-Term Memory'}),
  ).toBeVisible();
  await expect(page.getByText('Built in · Version 1.0.0')).toBeVisible();
  await expect(
    page.getByText('Sends your chats to the service you set up for it'),
  ).toBeVisible();
  await expect(page.getByText('No character uses it right now.')).toBeVisible();
});

test('page.add-character: a character file shows who she is and what she comes with; Add brings her into the sidebar and she answers in the chat; removed, she leaves the window, and added again her chat is still hers', async ({
  page,
}) => {
  const {model, home, daemon} = await miraHome({});
  const file = characterJson('nova', 'Nova', {
    identity: {
      id: 'nova',
      displayName: 'Nova',
      about: 'A quiet one, who notices things.',
    },
    plugins: {recommended: ['reply-style', 'teleport']},
  });
  const add = entry(page, 'Add Character');
  const roster = page.getByRole('complementary', {name: 'Characters'});

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await chooseFile(page, add, 'nova.json', file);
  await expect(page.getByRole('heading', {name: 'Nova'})).toBeVisible();
  await expect(page.getByText('Version 1.0.0 · nova.json')).toBeVisible();
  await expect(
    page.getByText('A quiet one, who notices things.'),
  ).toBeVisible();
  await expect(page.locator('.chip')).toHaveText([
    'Notebook',
    'Look Back',
    'Reply Style',
    'Ask to Change Settings',
  ]);
  await expect(
    page.getByText('This app does not have: teleport.'),
  ).toBeVisible();
  expect(addedTo(home)).toEqual([]);

  await page.getByRole('button', {name: 'Add Nova'}).click();
  await expect(page.getByRole('switch', {name: 'Nova is on'})).toBeVisible();
  await expect(entry(page, 'Nova')).toBeVisible();

  model.answer(reply('Hello. I noticed you.'));
  await page.getByRole('button', {name: 'Back to Chat'}).click();
  await roster.getByRole('button', {name: /^Nova/u}).click();
  await say(page, 'Hi, Nova.', 'Nova');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Hello. I noticed you.',
  ]);

  await page.getByRole('button', {name: 'Settings for Nova'}).click();
  await page.getByRole('button', {name: 'Remove Nova…'}).click();
  await expect(page.getByRole('alertdialog')).toContainText(
    'Her chats and memories stay on this computer',
  );
  await page
    .getByRole('alertdialog')
    .getByRole('button', {name: 'Remove', exact: true})
    .click();
  await expect(
    page.getByRole('heading', {name: 'You', exact: true}),
  ).toBeVisible();
  await expect(entry(page, 'Nova')).toHaveCount(0);
  expect(addedTo(home)).toEqual([]);

  await chooseFile(page, add, 'nova.json', file);
  await expect(
    page.getByText('Her chats and memories from before are still here.'),
  ).toBeVisible();
  await page.getByRole('button', {name: 'Add Nova'}).click();
  await expect(page.getByRole('switch', {name: 'Nova is on'})).toBeVisible();

  // A fresh tab knows only what the daemon keeps.
  await page.reload();
  await roster.getByRole('button', {name: /^Nova/u}).click();
  await expect(page.locator('.bubble-own .bubble-text')).toHaveText([
    'Hi, Nova.',
  ]);
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Hello. I noticed you.',
  ]);
});

test('page.add-character-refused: a file too large to be a character file, and one that holds none, are each refused in plain words in place of a preview; Cancel goes back, and nothing is added', async ({
  page,
}) => {
  const {home, daemon} = await miraHome({});

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings for Mira'}).click();
  await chooseFile(
    page,
    entry(page, 'Add Character'),
    'big.json',
    JSON.stringify({padding: 'x'.repeat(64 * 1024)}),
  );
  await expect(
    page.getByText('This file is too large to be a character file.'),
  ).toBeVisible();

  await chooseFile(
    page,
    page.getByRole('button', {name: 'Choose Another File'}),
    'notes.json',
    '{"name": "Nova"}',
  );
  await expect(
    page.getByText('This file is not a character file this app can read.'),
  ).toBeVisible();
  await page.getByRole('button', {name: 'Cancel'}).click();
  await expect(page.getByRole('switch', {name: 'Mira is on'})).toBeVisible();
  expect(addedTo(home)).toEqual([]);
});

test('page.settings-two-tabs: what one tab changes shows in another without a click, and a tab that fell behind sends its own change again once over the newer settings', async ({
  context,
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
  const nova = page.getByRole('listitem').filter({hasText: 'Nova'});

  await page.goto(daemon.url);
  // Two characters: none opens herself, and one switched off has no Start.
  await expect(page.getByText('Pick a character.')).toBeVisible();
  await expect(nova).toContainText('off');
  await expect(
    nova.getByRole('button', {name: 'Start', exact: true}),
  ).toHaveCount(0);
  await nova.getByRole('button', {name: 'Settings for Nova'}).click();

  const second = await context.newPage();

  await second.goto(daemon.url);
  await second.getByRole('button', {name: 'Settings for Nova'}).click();
  await expect(
    second.getByText("She won't start or reply while she's off."),
  ).toBeVisible();

  await page.getByRole('switch', {name: 'Nova is on'}).click();
  await expect(second.getByRole('switch', {name: 'Nova is on'})).toBeChecked();
  await expect(entry(second, 'Nova')).not.toContainText('Off');
  await expect(second.getByRole('main')).toContainText('Ready');

  // The second tab hears of the next change but cannot read it: it falls
  // behind until it makes a change of its own.
  let behind = true;
  const sent: string[] = [];

  await second.route('**/api/config**', async route => {
    if (route.request().method() === 'POST') {
      behind = false;
      sent.push(route.request().postData() ?? '');
      await route.continue();
    } else if (behind) {
      await route.abort();
    } else {
      await route.continue();
    }
  });
  await entry(page, 'You').click();

  const name = page.getByRole('textbox', {name: 'Name'});

  await name.fill('Sam');
  await name.press('Enter');
  await expect(checkOf(page, name)).toBeVisible();

  await entry(second, 'Telegram').click();
  await second.getByRole('switch', {name: 'Telegram'}).click();
  await expect(
    second.getByRole('switch', {name: 'Telegram'}),
  ).not.toBeChecked();
  await expect(entry(second, 'Sam')).toBeVisible();
  await expect(second.getByRole('alert')).toHaveCount(0);
  expect(sent).toHaveLength(2);
  await expect(entry(page, 'Telegram')).toContainText('Off');
});
