import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, type Locator, type Page} from '@playwright/test';

import {
  fileOf,
  lookup,
  publish,
  quiet,
  reminders,
  type App,
} from '../conformance/harness/apps.ts';
import {startCatalogServer} from '../conformance/harness/catalog-server.ts';
import {startDaemon} from '../conformance/harness/daemon.ts';
import {configJson, createHome} from '../conformance/harness/home.ts';
import {
  reply,
  startModelServer,
  type ModelRequest,
  type ModelServer,
} from '../conformance/harness/model-server.ts';
import {wireOf} from '../conformance/harness/wire.ts';
import {test} from './fixture.ts';

/**
 * A home where Mira answers through `model`, the person goes by Sam and her
 * heartbeat is off, and `installed` is on her phone from the App Store, as
 * her phone keeps an app installed, with what it asks of her phone.
 */
function appsHome(model: ModelServer, ...installed: readonly App[]): string {
  const listed = installed.map(({manifest}) => ({
    id: manifest.id,
    name: manifest.name,
    summary: manifest.summary,
    version: manifest.version,
    icon: manifest.icon,
    tint: manifest.tint,
    wakes: manifest.wakes,
    reaches: manifest.reaches,
    account: manifest.account,
    views: manifest.views,
    opensOn: manifest.opensOn,
    source: 'catalog',
  }));

  return createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    'character-data': {
      mira: {
        'config.json': configJson({project02: {heartbeat: 'off'}}),
        ...(installed.length === 0
          ? {}
          : {
              'plugin-data': {
                phone: {
                  'installed.json': JSON.stringify({apps: listed}),
                  apps: Object.fromEntries(
                    installed.map(app => [
                      `${app.manifest.id}.txt`,
                      fileOf(app),
                    ]),
                  ),
                },
              },
            }),
      },
    },
  });
}

/** `app` at `version`, the rest of it as it is. */
function at(app: App, version: string): App {
  return {...app, manifest: {...app.manifest, version}};
}

/** Mira's own config.json as it stands; none until something of hers is saved. */
function miraConfig(home: string): unknown {
  const path = join(home, 'character-data', 'mira', 'config.json');

  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

/** The home's config.json as it stands. */
function homeConfig(home: string): unknown {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
}

/** Her apps' ids and where each came from, as a client reads her phone. */
function appsOf(phone: unknown): readonly string[] {
  return (
    phone as {
      readonly apps: readonly {readonly id: string; readonly source: string}[];
    }
  ).apps.map(app => `${app.id} ${app.source}`);
}

/** The names of the tools a request to her model offered. */
function toolNames(request: ModelRequest | undefined): readonly string[] {
  return (
    request?.body as {
      readonly tools: readonly {readonly function: {readonly name: string}}[];
    }
  ).tools.map(tool => tool.function.name);
}

/** Her page in the settings window, from her chat's gear. */
async function herPage(page: Page): Promise<void> {
  await page.getByRole('button', {name: 'Settings for Mira'}).click();
  await expect(page.getByRole('switch', {name: 'Mira is on'})).toBeVisible();
}

/** The icons of her apps on her page. */
function strip(page: Page): Locator {
  return page.locator('.app-strip').getByRole('button');
}

/** A sub-page's way back to her page. */
function backToHer(page: Page): Locator {
  return page
    .getByRole('main')
    .getByRole('button', {name: 'Mira', exact: true});
}

/** The file chooser this button opens, given an app's file of this name and text. */
async function chooseApp(
  page: Page,
  button: Locator,
  name: string,
  text: string,
): Promise<void> {
  const chooser = page.waitForEvent('filechooser');

  await button.click();
  await (
    await chooser
  ).setFiles({name, mimeType: 'text/javascript', buffer: Buffer.from(text)});
}

test("page.apps-give: her page shows the Clock among her apps and not the App Store; Get More Apps lists the App Store's apps for her; Get puts an app in her strip and on her phone, and its page says its version and that it came from the App Store", async ({
  page,
}) => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();

  publish(catalog, [reminders], [quiet('notes', 'Notes', '1.0.0')]);

  const daemon = await startDaemon(appsHome(model), catalog.env);
  const row = (name: string) => page.locator('.cell').filter({hasText: name});

  await page.goto(daemon.url);
  await herPage(page);
  await expect(strip(page)).toHaveText(['Clock']);

  await page.getByRole('button', {name: 'Get More Apps'}).click();
  await expect(
    page.getByRole('heading', {name: 'Get More Apps'}),
  ).toBeVisible();
  await expect(row('Reminders')).toContainText(
    'Things to do, on a day and time',
  );
  await expect(row('Notes')).toContainText('Notes, quietly');
  await row('Reminders').getByRole('button', {name: 'Get Reminders'}).click();
  await expect(row('Reminders')).toContainText('Installed');
  expect(appsOf(await wireOf(daemon).phone('mira'))).toEqual([
    'clock built_in',
    'reminders catalog',
    'store built_in',
  ]);

  await backToHer(page).click();
  await expect(strip(page)).toHaveText(['Clock', 'Reminders']);
  await strip(page).filter({hasText: 'Reminders'}).click();
  await expect(
    page.getByText("On Mira's phone. Version 1.0.0, from the App Store."),
  ).toBeVisible();
});

test("page.apps-page: on her app's page, Can Wake Her Up off is what the daemon then says of it; with a newer version in the App Store, Update replaces it; Remove App asks, then takes it from her page and her phone; and the Clock, which her phone comes with, has no Remove App", async ({
  page,
}) => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();

  publish(catalog, [at(reminders, '1.1.0')]);

  const daemon = await startDaemon(appsHome(model, reminders), catalog.env);
  const wire = wireOf(daemon);
  const wake = page.getByRole('switch', {name: 'Can Wake Her Up'});
  const update = page.locator('.cell').filter({hasText: 'Update Available'});

  await page.goto(daemon.url);
  await herPage(page);
  await strip(page).filter({hasText: 'Clock'}).click();
  await expect(
    page.getByText("On Mira's phone. Version 1.0.0, built in."),
  ).toBeVisible();
  await expect(
    page.getByText('Her alarms and timers can start a moment of her own.'),
  ).toBeVisible();
  await expect(page.getByRole('button', {name: /^Remove App/u})).toHaveCount(0);

  await backToHer(page).click();
  await strip(page).filter({hasText: 'Reminders'}).click();
  await expect(wake).toBeChecked();
  await wake.click();
  await expect(wake).not.toBeChecked();
  expect(await wire.phone('mira')).toMatchObject({
    apps: [{id: 'clock'}, {id: 'reminders', mayWake: false}, {id: 'store'}],
  });

  await expect(update).toContainText('Version 1.1.0');
  await update.getByRole('button', {name: 'Update Reminders'}).click();
  await expect(
    page.getByText("On Mira's phone. Version 1.1.0, from the App Store."),
  ).toBeVisible();
  await expect(update).toHaveCount(0);
  expect(await wire.phone('mira')).toMatchObject({
    apps: [{id: 'clock'}, {id: 'reminders', version: '1.1.0'}, {id: 'store'}],
  });

  await page.getByRole('button', {name: /^Remove App/u}).click();
  await expect(page.getByRole('alertdialog')).toContainText(
    'everything it kept is deleted with it',
  );
  await page
    .getByRole('alertdialog')
    .getByRole('button', {name: 'Remove', exact: true})
    .click();
  await expect(page.getByRole('switch', {name: 'Mira is on'})).toBeVisible();
  await expect(strip(page)).toHaveText(['Clock']);
  expect(appsOf(await wire.phone('mira'))).toEqual([
    'clock built_in',
    'store built_in',
  ]);
});

test("page.apps-account: an app's page lists what it may do and, for one that uses the person's Tavily account, Set Up, which opens the account's page; a key pasted there is saved and never shown back, the app's page then says the account by name, and Connections lists it; the key taken away, Connections no longer does", async ({
  page,
}) => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();
  const home = appsHome(model, lookup);
  const daemon = await startDaemon(home, catalog.env);
  const main = page.getByRole('main');
  const tavily = page
    .getByRole('navigation', {name: 'Settings'})
    .getByRole('button', {name: /^Tavily/u});
  const key = main.getByLabel('API Key', {exact: true});
  const pasted = 'tvly-pasted-0123456789';

  await page.goto(daemon.url);
  await herPage(page);
  await strip(page).filter({hasText: 'Lookup'}).click();

  for (const line of [
    'Keep its own data',
    'Reach the internet at api.tavily.com and api.open-meteo.com',
    'Use your Tavily account',
    'What she does in it uses your Tavily account.',
  ]) {
    await expect(main.getByText(line, {exact: true})).toBeVisible();
  }

  await expect(tavily).toHaveCount(0);

  await main.getByRole('button', {name: 'Set Up'}).click();
  await expect(main.getByRole('heading', {name: 'Tavily'})).toBeVisible();
  await expect(main.getByText('Get a free key at tavily.com.')).toBeVisible();
  await key.fill(pasted);
  await key.press('Enter');
  await expect
    .poll(() => homeConfig(home))
    .toMatchObject({plugins: {phone: {config: {tavilyApiKey: pasted}}}});
  await expect(key).toHaveValue('');
  await expect(tavily).toContainText('On');
  expect(await page.content()).not.toContain(pasted);

  await main.getByRole('button', {name: 'Lookup', exact: true}).click();
  await expect(
    main.getByRole('button', {name: 'Tavily', exact: true}),
  ).toBeVisible();
  await expect(main.getByRole('button', {name: 'Set Up'})).toHaveCount(0);

  await tavily.click();
  await key.focus();
  await main.getByRole('button', {name: 'Remove API Key'}).click();
  await expect(tavily).toHaveCount(0);
  expect(homeConfig(home)).not.toHaveProperty([
    'plugins',
    'phone',
    'config',
    'tavilyApiKey',
  ]);
});

test("page.apps-from-file: an app from a file shows what it is and may do and that nobody read it, and adds nothing until Add, which puts it on her phone from a file and opens its page; a file that holds no app is said in the daemon's words", async ({
  page,
}) => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();

  publish(catalog, [reminders]);

  const daemon = await startDaemon(appsHome(model), catalog.env);
  const wire = wireOf(daemon);
  const notes = quiet('notes', 'Notes', '1.0.0');

  await page.goto(daemon.url);
  await herPage(page);
  await page.getByRole('button', {name: 'Get More Apps'}).click();
  await chooseApp(
    page,
    page.getByRole('button', {name: /^From a File/u}),
    'blank.js',
    fileOf({...notes, manifest: {...notes.manifest, name: ' '}}),
  );
  await expect(page.getByRole('alert')).toHaveText(
    'Manifest name must not be blank.',
  );

  await chooseApp(
    page,
    page.getByRole('button', {name: 'Choose Another File'}),
    'notes.js',
    fileOf(notes),
  );
  await expect(page.getByRole('heading', {name: 'Notes'})).toBeVisible();
  await expect(page.getByText('Version 1.0.0 · notes.js')).toBeVisible();
  await expect(page.getByText('Keep its own data')).toBeVisible();
  await expect(
    page.getByText(
      'Nobody at Project02 has read this app. Add it only if it comes from someone you trust.',
    ),
  ).toBeVisible();
  expect(appsOf(await wire.phone('mira'))).toEqual([
    'clock built_in',
    'store built_in',
  ]);

  await page.getByRole('button', {name: 'Add', exact: true}).click();
  await expect(
    page.getByText("On Mira's phone. Version 1.0.0, from a file."),
  ).toBeVisible();
  expect(appsOf(await wire.phone('mira'))).toEqual([
    'clock built_in',
    'notes file',
    'store built_in',
  ]);
});

test('page.apps-ask-to-install: her Ask to Install Apps is among her permissions, and her phone is no connection of the sidebar; switched off, her Apps group no longer says she asks, and she is offered no tool to install an app at her next request', async ({
  page,
}) => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();
  const home = appsHome(model);
  const daemon = await startDaemon(home, catalog.env);
  const ask = page.getByRole('switch', {name: 'Ask to Install Apps'});
  const footer = page.getByText(/^Apps come from the App Store\./u);

  await page.goto(daemon.url);
  await herPage(page);
  await expect(
    page
      .getByRole('navigation', {name: 'Settings'})
      .getByRole('button', {name: /^Phone/u}),
  ).toHaveCount(0);
  await expect(footer).toHaveText(
    'Apps come from the App Store. She can find them herself, and asks before installing one.',
  );
  await expect(ask).toBeChecked();
  await ask.click();
  await expect(ask).not.toBeChecked();
  await expect(footer).toHaveText('Apps come from the App Store.');
  await expect
    .poll(() => miraConfig(home))
    .toMatchObject({plugins: {phone: {config: {askToInstall: false}}}});

  model.answer(reply('Hello, Sam.'));
  await page.getByRole('button', {name: 'Back to Chat'}).click();

  const composer = page.getByRole('textbox', {name: 'Message Mira'});

  await composer.fill('Hi.');
  await composer.press('Enter');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Hello, Sam.',
  ]);

  const offered = toolNames(model.requests.at(-1));

  expect(offered).toContain('phone_open');
  expect(offered).not.toContain('phone_install');
});
