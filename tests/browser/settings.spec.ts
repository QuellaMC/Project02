import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, type Locator, type Page} from '@playwright/test';

import {startAuthServer} from '../conformance/harness/auth-server.ts';
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
import {
  planResponded,
  responded,
  replying,
} from '../conformance/harness/responses.ts';
import {startTelegramServer} from '../conformance/harness/telegram-server.ts';
import {test} from './fixture.ts';

/**
 * Mira on the model server as NVIDIA, which also stands in for the OpenAI
 * API and a ChatGPT plan's service, the home's config.json holding these
 * settings beside the model's, and the daemon's switches `env` too.
 */
async function miraHome(
  config: {readonly project02?: object; readonly [section: string]: unknown},
  seed: Parameters<typeof createHome>[0] = {},
  env: Readonly<Record<string, string>> = {},
) {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      ...config,
      project02: {...model.settings, ...config.project02},
    }),
    ...seed,
  });

  return {
    model,
    home,
    daemon: await startDaemon(home, {
      ...model.openai.env,
      ...model.chatgpt.env,
      ...env,
    }),
  };
}

/** The home's config.json as it stands. */
function homeConfig(home: string): unknown {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
}

/** A character's own config.json as it stands; none until something of hers is saved. */
function characterConfig(home: string, characterId: string): unknown {
  const path = join(home, 'character-data', characterId, 'config.json');

  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

/** The accounts paired with Telegram, as the home's config.json holds them. */
function pairedIn(home: string): unknown {
  return (
    homeConfig(home) as {
      readonly connectors: {
        readonly telegram: {readonly config: {readonly pairedUsers: unknown}};
      };
    }
  ).connectors.telegram.config.pairedUsers;
}

/**
 * Holds the page's next change at the daemon's door until the function
 * it answers with is called: a save still on its way.
 */
async function holdNextChange(page: Page): Promise<() => void> {
  const gate: {open: () => void} = {open: () => undefined};
  const held = new Promise<void>(resolve => {
    gate.open = resolve;
  });
  let waiting = true;

  await page.route('**/api/config', async route => {
    if (waiting && route.request().method() === 'POST') {
      waiting = false;
      await held;
    }

    await route.continue();
  });

  return () => {
    gate.open();
  };
}

/** An entry of the window's sidebar, by the start of its name. */
function entry(page: Page, name: string): Locator {
  return page
    .getByRole('navigation', {name: 'Settings'})
    .getByRole('button', {name: new RegExp(`^${name}`, 'u')});
}

/** A group of the page the window is on, by its title. */
function group(page: Page, title: string): Locator {
  return page
    .locator('.group')
    .filter({has: page.getByRole('heading', {name: title, exact: true})});
}

/** A row of the page the window is on that opens another page, by the start of its name. */
function link(within: Page | Locator, name: string): Locator {
  return within.getByRole('button', {name: new RegExp(`^${name}`, 'u')});
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

test('page.welcome-later: a person with no key at hand leaves the welcome for the chat, where she says what she needs and that leads to AI Model', async ({
  page,
}) => {
  const daemon = await startDaemon(createHome());

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Continue'}).click();
  await expect(
    page.getByRole('heading', {name: 'Choose an AI Model'}),
  ).toBeVisible();
  await page.getByRole('button', {name: 'Set Up Later'}).click();
  await page.getByRole('button', {name: 'Choose an AI service.'}).click();
  await expect(page.getByRole('heading', {name: 'AI Model'})).toBeVisible();
});

test("page.welcome-chatgpt-plan: the ChatGPT Plan chosen in the welcome asks for no key: the sign-in its page shows stands in the key's place, Continue is offered once the code is approved, and she answers through the plan; the sidebar's AI Model then names it, its own name whole at the window's narrowest", async ({
  page,
}) => {
  const auth = await startAuthServer();
  const model = await startModelServer();
  const daemon = await startDaemon(createHome(), {
    ...auth.env,
    ...model.chatgpt.env,
  });
  const next = page.getByRole('button', {name: 'Continue'});

  await page.goto(daemon.url);
  await page.getByRole('textbox', {name: 'Your Name'}).fill('Sam');
  await next.click();
  await page.getByRole('combobox', {name: 'Service'}).selectOption('chatgpt');
  await expect(
    page.getByText('This is not an official way to use a plan in another app.'),
  ).toBeVisible();
  await expect(page.getByLabel('API Key')).toHaveCount(0);
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', {name: 'Sign In', exact: true}).click();
  await expect(page.getByText('CODE-1', {exact: true})).toBeVisible();
  auth.approve();
  await expect(page.getByText('sam@example.com')).toBeVisible();
  await expect(next).toHaveAttribute('aria-disabled', 'false');
  await next.click();
  await expect(
    page.getByRole('heading', {name: "You're All Set, Sam"}),
  ).toBeVisible();

  model.answer(planResponded(replying('Hello, Sam.')));
  await page.getByRole('button', {name: 'Start Chatting'}).click();
  await say(page, 'Hi.');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Hello, Sam.',
  ]);
  expect(model.requests.at(-1)).toMatchObject({
    path: '/chatgpt/responses',
    body: {model: 'gpt-6.1-sol'},
  });

  // The narrowest window that keeps the sidebar beside the page, on AI
  // Model, where its entry's name is bold and so at its widest.
  await page.setViewportSize({width: 820, height: 760});
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'AI Model').click();
  await expect(entry(page, 'AI Model')).toContainText('ChatGPT Plan');
  expect(
    (await page.getByRole('navigation', {name: 'Settings'}).boundingBox())
      ?.width,
  ).toBeLessThan(300);
  expect(
    await page.evaluate<boolean>(`(() => {
      const name = [...document.querySelectorAll('.side-label')].find(
        label => label.textContent === 'AI Model',
      );

      return name.scrollWidth <= name.clientWidth;
    })()`),
  ).toBe(true);
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
  await link(group(page, 'Connected'), 'NVIDIA').click();

  const key = page.getByLabel('API Key', {exact: true});

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

  // A key saved a moment ago can be taken away like any other.
  await key.focus();
  await expect(
    page.getByRole('button', {name: 'Remove API Key'}),
  ).toBeVisible();
});

test('page.settings-key-removed: a stored key is taken away by the button its own box shows while it is in use, and the box asks for a key again', async ({
  page,
}) => {
  const {home, daemon} = await miraHome({});

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'AI Model').click();
  await link(group(page, 'Connected'), 'NVIDIA').click();

  const key = page.getByLabel('API Key', {exact: true});

  await expect(checkOf(page, key)).toBeVisible();
  await key.focus();
  await page.getByRole('button', {name: 'Remove API Key'}).click();
  await expect(key).toHaveAttribute('placeholder', 'Paste key');
  expect(homeConfig(home)).not.toHaveProperty(['project02', 'nvidiaApiKey']);
});

test('page.settings-close-keeps-saves: a box left by the very click that closes the window is saved, even behind a save still on its way', async ({
  page,
}) => {
  const {home, daemon} = await miraHome({});

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'AI Model').click();

  const release = await holdNextChange(page);

  // Leaving the model's box for NVIDIA's page sends it, held at the door.
  await page.getByRole('textbox', {name: 'Model'}).fill('nvidia/small');
  await link(group(page, 'Connected'), 'NVIDIA').click();
  await page.getByLabel('API Key', {exact: true}).fill('nvapi-second');
  await page.getByRole('button', {name: 'Back to Chat'}).click();
  release();
  await expect(page.getByRole('textbox', {name: 'Message Mira'})).toBeVisible();
  await expect
    .poll(() => homeConfig(home))
    .toMatchObject({
      project02: {nvidiaModel: 'nvidia/small', nvidiaApiKey: 'nvapi-second'},
    });
});

test('page.settings-services: beside NVIDIA, the OpenAI API added by pasting its key on its own page is listed under Connected; chosen at the top with a model from its list or typed in, the next reply comes through it; and its key removed puts it back under Add a Service, the page saying what every character needs', async ({
  page,
}) => {
  const {model, home, daemon} = await miraHome({});
  const {openaiApiKey} = model.openai.settings;
  const connected = group(page, 'Connected');
  const others = group(page, 'Add a Service');
  const thinksWith = group(page, 'Characters Think With');
  const service = thinksWith.getByRole('combobox', {name: 'Service'});
  const choice = thinksWith.getByRole('combobox', {name: 'Model'});
  const back = page
    .getByRole('main')
    .getByRole('button', {name: 'AI Model', exact: true});

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'AI Model').click();
  await expect(link(connected, 'NVIDIA')).toContainText('In Use');
  await link(others, 'OpenAI API').click();
  await expect(page.getByRole('heading', {name: 'OpenAI API'})).toBeVisible();
  await expect(
    page.getByText(
      'Paste a key and press Return; it is never shown again. Get one at platform.openai.com.',
    ),
  ).toBeVisible();

  const key = page.getByLabel('API Key', {exact: true});

  await key.fill(openaiApiKey);
  await key.press('Enter');
  await expect(page.getByRole('button', {name: 'Remove Key'})).toBeVisible();
  await back.click();
  await expect(link(connected, 'OpenAI API')).toContainText('Key saved');
  await expect(entry(page, 'AI Model')).toContainText('2 Services');

  await service.selectOption('openai');
  await choice.selectOption('gpt-6.1-sol');
  await expect(link(connected, 'OpenAI API')).toContainText('In Use');
  await expect
    .poll(() => homeConfig(home))
    .toMatchObject({
      project02: {roleModelProvider: 'openai', openaiModel: 'gpt-6.1-sol'},
    });

  // Another model typed in is then one of the choices.
  await choice.selectOption('Other…');

  const typed = thinksWith.getByRole('textbox', {name: 'Model'});

  await typed.fill('gpt-7-preview');
  await typed.press('Enter');
  await expect(choice).toHaveValue('gpt-7-preview');
  await expect
    .poll(() => homeConfig(home))
    .toMatchObject({project02: {openaiModel: 'gpt-7-preview'}});

  model.answer(responded(replying('Through OpenAI.')));
  await page.getByRole('button', {name: 'Back to Chat'}).click();
  await say(page, 'Hello.');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Through OpenAI.',
  ]);
  expect(model.requests.at(-1)).toMatchObject({
    path: '/openai/v1/responses',
    authorization: `Bearer ${openaiApiKey}`,
    body: {model: 'gpt-7-preview'},
  });
  expect(await page.content()).not.toContain(openaiApiKey);

  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'AI Model').click();
  await link(connected, 'OpenAI API').click();
  await page.getByRole('button', {name: 'Remove Key'}).click();
  await expect(page.getByRole('button', {name: 'Remove Key'})).toHaveCount(0);
  await back.click();
  await expect(link(others, 'OpenAI API')).toBeVisible();
  await expect(service).toHaveValue('openai');
  await expect(thinksWith).toContainText('Add your OpenAI API key.');
  expect(homeConfig(home)).not.toHaveProperty(['project02', 'openaiApiKey']);
});

test("page.settings-her-service: a character given a service of her own on her AI Model page answers through it while another keeps everyone's, and Same as Everyone gives her everyone's again", async ({
  page,
}) => {
  const {model, home, daemon} = await miraHome(
    {project02: {openaiApiKey: 'sk-home'}},
    {
      characters: {
        nova: {'project02.character.json': characterJson('nova', 'Nova')},
      },
    },
  );
  const roster = page.getByRole('complementary', {name: 'Characters'});
  const service = page.getByRole('combobox', {name: 'Service'});

  await page.goto(daemon.url);
  await roster.getByRole('button', {name: 'Settings for Nova'}).click();
  await entry(page, 'Advanced').click();
  await page.getByRole('switch', {name: 'Show Advanced Settings'}).click();
  await entry(page, 'Nova').click();
  await link(page.getByRole('main'), 'AI Model').click();
  await expect(service.locator('option:checked')).toHaveText(
    'Same as Everyone (NVIDIA)',
  );
  await service.selectOption('openai');
  await page
    .getByRole('combobox', {name: 'Model'})
    .selectOption('gpt-6.1-terra');
  await expect(
    page.getByText(
      'Only for Nova. Everyone else keeps the one on the AI Model page.',
    ),
  ).toBeVisible();
  await expect
    .poll(() => characterConfig(home, 'nova'))
    .toMatchObject({
      project02: {roleModelProvider: 'openai', openaiModel: 'gpt-6.1-terra'},
    });

  model.answer(
    responded(replying('Through my own.')),
    reply("Through everyone's."),
  );
  await page.getByRole('button', {name: 'Back to Chat'}).click();
  await link(roster, 'Nova').click();
  await say(page, 'Hi, Nova.', 'Nova');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Through my own.',
  ]);
  await link(roster, 'Mira').click();
  await say(page, 'Hi, Mira.');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    "Through everyone's.",
  ]);
  expect(model.requests.map(request => request.path)).toEqual([
    '/openai/v1/responses',
    '/v1/chat/completions',
  ]);
  expect(model.requests[0]).toMatchObject({
    authorization: 'Bearer sk-home',
    body: {model: 'gpt-6.1-terra'},
  });

  await roster.getByRole('button', {name: 'Settings for Nova'}).click();
  await link(page.getByRole('main'), 'AI Model').click();
  await service.selectOption('');
  await expect
    .poll(() => characterConfig(home, 'nova'))
    .not.toHaveProperty(['project02', 'openaiModel']);
  expect(characterConfig(home, 'nova')).not.toHaveProperty([
    'project02',
    'roleModelProvider',
  ]);
  await expect(service.locator('option:checked')).toHaveText(
    'Same as Everyone (NVIDIA)',
  );
});

test("page.settings-chatgpt-plan: beside NVIDIA, the ChatGPT Plan's page signs in by a code it shows with the warning that this is no official way, to copy or to approve on OpenAI's page, and moves on by itself to the account and its plan once the code is approved; chosen at the top with a model, the next reply comes through the plan; and Sign Out puts it back under Add a Service", async ({
  context,
  page,
}) => {
  const auth = await startAuthServer();
  const {model, home, daemon} = await miraHome({}, {}, auth.env);
  const thinksWith = group(page, 'Characters Think With');
  const back = page
    .getByRole('main')
    .getByRole('button', {name: 'AI Model', exact: true});
  const signIn = page.getByRole('button', {name: 'Sign In', exact: true});
  const warning = page.getByText(
    'This is not an official way to use a plan in another app.',
  );

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'AI Model').click();
  await expect(
    link(group(page, 'Add a Service'), 'ChatGPT Plan'),
  ).toContainText('Sign in with the plan you already pay for');
  await link(group(page, 'Add a Service'), 'ChatGPT Plan').click();
  await expect(warning).toBeVisible();
  await signIn.click();
  await expect(page.getByText('CODE-1', {exact: true})).toBeVisible();
  await expect(warning).toBeVisible();
  await expect(page.getByRole('link', {name: 'Open OpenAI'})).toHaveAttribute(
    'href',
    auth.page,
  );
  await page.getByRole('button', {name: 'Copy Code'}).click();
  await expect(page.getByRole('button', {name: 'Copied'})).toBeVisible();
  expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(
    'CODE-1',
  );

  auth.approve();
  await expect(page.getByText('sam@example.com')).toBeVisible();
  await expect(page.getByText('Plus', {exact: true})).toBeVisible();
  await expect(warning).toHaveCount(0);
  await back.click();
  await expect(link(group(page, 'Connected'), 'ChatGPT Plan')).toContainText(
    'sam@example.com · Plus',
  );
  await thinksWith
    .getByRole('combobox', {name: 'Service'})
    .selectOption('chatgpt');
  await thinksWith
    .getByRole('combobox', {name: 'Model'})
    .selectOption('gpt-6-luna');
  await expect
    .poll(() => homeConfig(home))
    .toMatchObject({
      project02: {roleModelProvider: 'chatgpt', chatgptModel: 'gpt-6-luna'},
    });

  model.answer(planResponded(replying('Through the plan.')));
  await page.getByRole('button', {name: 'Back to Chat'}).click();
  await say(page, 'Hello.');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Through the plan.',
  ]);
  expect(model.requests.at(-1)).toMatchObject({
    path: '/chatgpt/responses',
    authorization: `Bearer ${String(auth.accessToken())}`,
    body: {model: 'gpt-6-luna'},
  });

  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'AI Model').click();
  await link(group(page, 'Connected'), 'ChatGPT Plan').click();
  await page.getByRole('button', {name: 'Sign Out'}).click();
  await expect(signIn).toBeVisible();
  await back.click();
  await expect(
    link(group(page, 'Add a Service'), 'ChatGPT Plan'),
  ).toBeVisible();
  await expect(thinksWith).toContainText('Sign in to your ChatGPT plan.');
});

test("page.settings-chatgpt-code-expires: a code that runs out before it is approved is said in the daemon's words where the person signs in, with Sign In offered again", async ({
  page,
}) => {
  const auth = await startAuthServer(-60_000);
  const {daemon} = await miraHome({}, {}, auth.env);
  const signIn = page.getByRole('button', {name: 'Sign In', exact: true});

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await entry(page, 'AI Model').click();
  await link(group(page, 'Add a Service'), 'ChatGPT Plan').click();
  await signIn.click();
  await expect(
    page.getByText('The code expired before it was approved. Start again.'),
  ).toBeVisible();
  await expect(signIn).toBeVisible();
  await expect(page.getByText('CODE-1', {exact: true})).toHaveCount(0);
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

test('page.settings-heartbeat: her page has a Heartbeat group whose A Moment to Herself is 30 min on a new home; another choice saves at the click and is still chosen after a reload, and the group is hidden while she is off', async ({
  page,
}) => {
  const {home, daemon} = await miraHome({});
  const group = page.getByRole('heading', {name: 'Heartbeat', exact: true});
  const choice = (name: string) =>
    page
      .getByRole('radiogroup', {name: 'A Moment to Herself'})
      .getByRole('radio', {name, exact: true});

  await page.goto(daemon.url);
  await page.getByRole('button', {name: 'Settings for Mira'}).click();
  await expect(group).toBeVisible();
  await expect(choice('30 min')).toHaveAttribute('aria-checked', 'true');

  await choice('2 hours').click();
  await expect
    .poll(() => characterConfig(home, 'mira'))
    .toMatchObject({project02: {heartbeat: '2h'}});

  await page.reload();
  await page.getByRole('button', {name: 'Settings for Mira'}).click();
  await expect(choice('2 hours')).toHaveAttribute('aria-checked', 'true');
  await expect(choice('30 min')).toHaveAttribute('aria-checked', 'false');

  await page.getByRole('switch', {name: 'Mira is on'}).click();
  await expect(
    page.getByText("She won't start or reply while she's off."),
  ).toBeVisible();
  await expect(group).toHaveCount(0);
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

test('page.settings-telegram: the page says when Telegram is not running; a token pasted for her bot shows the name Telegram gave it and is never shown back, one Telegram refuses is said so, and two paired accounts removed one right after the other are both gone', async ({
  page,
}) => {
  const miraBot = {token: '987654:mira', id: 987654, username: 'mira_bot'};
  const {home, daemon} = await miraHome({
    connectors: {
      telegram: {config: {pairedUsers: {'4242': 'Alice', '5151': 'Bob'}}},
    },
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

  const account = (name: string) =>
    page.locator('.cell').filter({hasText: name});

  await expect(account('Alice')).toContainText('4242');

  // The second removal is asked for while the first is still on its way,
  // and starts from what the first left: neither brings the other back.
  const release = await holdNextChange(page);

  await account('Alice').getByRole('button', {name: 'Remove'}).click();
  await account('Bob').getByRole('button', {name: 'Remove'}).click();
  release();
  await expect(page.getByText('No one yet')).toBeVisible();
  expect(pairedIn(home)).toEqual({});
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
  await expect(contextSize).toHaveCount(0);
  // The model server's address is set, so NVIDIA's page shows it.
  await link(group(page, 'Connected'), 'NVIDIA').click();
  await expect(page.getByLabel('Server Address')).toBeVisible();

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
