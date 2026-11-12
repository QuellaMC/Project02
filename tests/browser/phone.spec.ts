import {expect, type Page} from '@playwright/test';

import {publish, quiet, reminders} from '../conformance/harness/apps.ts';
import {startCatalogServer} from '../conformance/harness/catalog-server.ts';
import {startDaemon, type Daemon} from '../conformance/harness/daemon.ts';
import {
  characterJson,
  configJson,
  createHome,
} from '../conformance/harness/home.ts';
import {
  calling,
  reply,
  startModelServer,
  type ModelServer,
} from '../conformance/harness/model-server.ts';
import {converse, saveConfig, wireOf} from '../conformance/harness/wire.ts';
import {test} from './fixture.ts';

// A ring's time is drawn on the person's clock, in their language and zone:
// here American English and UTC, so the time an alarm was set for reads as
// the test names it.
test.use({locale: 'en-US', timezoneId: 'UTC'});

/** Her phone's address on the daemon: the page's own, naming her, the token in its fragment. */
function phoneOf(daemon: Daemon, characterId: string): string {
  return `${daemon.origin}/?phone=${encodeURIComponent(characterId)}#token=${daemon.token}`;
}

/** A home where Mira answers through `model`, the person goes by Sam and her heartbeat is off; her Clock keeps `clock`, when the test gives it one. */
function quietHome(model: ModelServer, clock?: object): string {
  return createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    'character-data': {
      mira: {
        'config.json': configJson({project02: {heartbeat: 'off'}}),
        ...(clock === undefined
          ? {}
          : {
              'plugin-data': {
                phone: {apps: {'clock.json': JSON.stringify(clock)}},
              },
            }),
      },
    },
  });
}

/** A home of Mira's and Nova's, both answering through `model`, their heartbeats off. */
function twoHome(model: ModelServer): string {
  const quiet = {'config.json': configJson({project02: {heartbeat: 'off'}})};

  return createHome({
    'config.json': configJson({project02: model.settings}),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {mira: quiet, nova: quiet},
  });
}

/** Mira's phone switched off or on in her settings, as her settings page switches a plugin. */
async function switchPhone(daemon: Daemon, enabled: boolean): Promise<void> {
  await saveConfig(
    wireOf(daemon),
    {scope: 'character', characterId: 'mira'},
    {kind: 'section_enabled', namespace: 'plugins', id: 'phone', enabled},
  );
}

/** Her home screen's Clock, which a tab named World Clock is not. */
function clockIcon(page: Page) {
  return page.getByRole('button', {name: 'Clock', exact: true});
}

/** The chat's Her Phone button, for the character whose chat is on screen. */
function herPhoneButton(page: Page) {
  return page.getByRole('button', {name: /^Her Phone/u});
}

/** A line to Mira, sent from her chat. */
async function tellMira(page: Page, line: string): Promise<void> {
  const composer = page.getByRole('textbox', {name: 'Message Mira'});

  await composer.fill(line);
  await composer.press('Enter');
}

/** Her chat, opened from the roster. */
async function chatWith(page: Page, name: string): Promise<void> {
  await page
    .getByRole('complementary', {name: 'Characters'})
    .getByRole('button', {name: new RegExp(`^${name}\\b`, 'u')})
    .click();
  await expect(
    page.getByRole('textbox', {name: `Message ${name}`}),
  ).toBeVisible();
}

test("page.phone-follows-her: her phone's address shows her home screen with the Clock; she sets an alarm and the window goes to the Alarms view with the alarm on it and says what she did; the person opens another view and her home screen, and what she has in front is untouched; her settings switching her phone off is said where her phone was, and on again brings it back; an address naming nobody says so where her phone would be", async ({
  page,
}) => {
  const model = await startModelServer();
  const daemon = await startDaemon(quietHome(model));
  const wire = wireOf(daemon);
  const line = page.locator('.phone-line');

  await page.goto(phoneOf(daemon, 'mira'));
  await expect(page).toHaveTitle("Mira's Phone");
  await expect(page.getByText('Watching')).toBeVisible();
  await expect(clockIcon(page)).toBeVisible();
  await expect(line).toHaveText('Nothing open');

  const say = await converse(wire, 'mira');

  model.answer(
    calling(['phone_open', {app: 'clock'}]),
    calling([
      'phone_use',
      {
        app: 'clock',
        action: 'set_alarm',
        input: {hour: 7, minute: 0, label: 'Wake Sam'},
      },
    ]),
    reply('Set for seven.'),
  );
  await say('Wake me at seven.', 'wake');
  await expect(page.getByRole('heading', {name: 'Alarms'})).toBeVisible();
  await expect(page.locator('.phone-row')).toContainText('7:00 AMWake Sam');
  await expect(page.getByRole('img', {name: 'On'})).toBeVisible();
  await expect(line).toContainText('Set an alarm');

  await page.getByRole('button', {name: 'World Clock'}).click();
  await expect(page.getByRole('heading', {name: 'World Clock'})).toBeVisible();
  await expect(page.getByText('No World Clocks')).toBeVisible();
  await page.getByRole('button', {name: 'Home'}).click();
  await expect(clockIcon(page)).toBeVisible();
  expect(await wire.phone('mira')).toMatchObject({
    status: 'ok',
    front: {appId: 'clock', viewId: 'alarms'},
    did: {words: 'Set an alarm'},
  });

  await switchPhone(daemon, false);
  await expect(page.locator('.phone-said')).toHaveText(
    'Mira has no phone: her settings switch it off.',
  );
  await switchPhone(daemon, true);
  await expect(clockIcon(page)).toBeVisible();

  await page.goto(phoneOf(daemon, 'nova'));
  await expect(page.locator('.phone-said')).toHaveText(
    'Character "nova" was not found; the characters are mira.',
  );
});

test("page.phone-rings: while a moment of hers that a ring began runs, her phone's window shows it ringing, with the ring's title, the time it was set for and its body, and says so under it; once the moment ends, her phone again", async ({
  page,
}) => {
  const model = await startModelServer();
  // Her Clock holds alarm a1, Wake Sam at 07:00 once, its ring long gone:
  // it rings at her start, in a moment of her own whose answer is held.
  const asked = model.hold();
  const daemon = await startDaemon(
    quietHome(model, {
      storage: {
        issued: {a: 1},
        alarms: [
          {id: 'a1', hour: 7, minute: 0, label: 'Wake Sam', days: [], on: true},
        ],
      },
      rings: [
        {
          id: 'a1',
          at: '2026-01-05T07:00:00.000Z',
          title: 'Alarm',
          body: 'Wake Sam',
        },
      ],
    }),
  );
  const ringing = page.locator('.phone-ringing');

  await asked.arrived();
  await page.goto(phoneOf(daemon, 'mira'));
  await expect(ringing.locator('.phone-ringing-title')).toHaveText('Alarm');
  await expect(ringing.locator('.phone-ringing-time')).toHaveText('7:00');
  await expect(ringing.locator('.phone-ringing-body')).toHaveText('Wake Sam');
  await expect(ringing).toContainText('Ringing');
  await expect(page.locator('.phone-line')).toContainText(
    'Her phone is ringing',
  );

  asked.release(reply('Up you get, Sam.'));
  await expect(ringing).toHaveCount(0);
  await expect(clockIcon(page)).toBeVisible();
});

test("page.phone-button: her chat's Her Phone button opens her phone's address in a window and is pressed while that window shows her phone, a browser's popup with no pin; closing the window, or clicking the button again, leaves it plain; with her phone open, another character's takes the same window; a browser that blocks the window is told what to allow; once her settings switch her phone off, her chat has no button", async ({
  context,
  page,
}) => {
  const model = await startModelServer();
  const daemon = await startDaemon(twoHome(model));
  const button = herPhoneButton(page);

  await page.goto(daemon.url);
  await chatWith(page, 'Mira');
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  const [phone] = await Promise.all([
    page.waitForEvent('popup'),
    button.click(),
  ]);

  await expect(phone).toHaveURL(phoneOf(daemon, 'mira'));
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(
    phone.getByRole('button', {name: 'Keep on top of other windows'}),
  ).toHaveCount(0);
  await Promise.all([
    phone.waitForEvent('close'),
    phone.getByRole('button', {name: 'Close her phone'}).click(),
  ]);
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  const [again] = await Promise.all([
    page.waitForEvent('popup'),
    button.click(),
  ]);

  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await Promise.all([again.waitForEvent('close'), button.click()]);
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  const [shared] = await Promise.all([
    page.waitForEvent('popup'),
    button.click(),
  ]);

  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await chatWith(page, 'Nova');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.click();
  await expect(shared).toHaveURL(phoneOf(daemon, 'nova'));
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(context.pages()).toEqual([page, shared]);
  await chatWith(page, 'Mira');
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  // A browser that blocks the window answers its opening with nothing.
  await page.evaluate('void (window.open = () => null)');
  await button.click();
  await expect(page.locator('main > .notice')).toHaveText([
    "This browser blocked her phone's window. Allow pop-ups for this page, then click Her Phone again.",
  ]);

  await switchPhone(daemon, false);
  await expect(button).toHaveCount(0);
});

test("page.phone-in-use: while a turn of hers that called a tool of her phone waits for her reply, her chat's Her Phone button carries a dot and the thread says she is using her phone, her phone's window closed; once the turn ends, both are gone", async ({
  page,
}) => {
  const model = await startModelServer();
  const daemon = await startDaemon(quietHome(model));
  const using = page.getByText('Mira is using her phone…');
  const dot = herPhoneButton(page).getByRole('img', {name: 'In use'});

  await page.goto(daemon.url);
  await expect(herPhoneButton(page)).toBeVisible();
  model.answer(calling(['phone_open', {app: 'clock'}]));

  const asked = model.hold();

  await tellMira(page, 'Is my alarm on?');
  await asked.arrived();
  await expect(using).toBeVisible();
  await expect(dot).toBeVisible();

  asked.release(reply('No alarm yet.'));
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'No alarm yet.',
  ]);
  await expect(using).toHaveCount(0);
  await expect(dot).toHaveCount(0);
});

test("page.store-app-approved: her phone's window shows the App Store's list as she opens it, each app with its name, its summary and how it stands on her phone, then the page of the app she looks at; once she asks to install it the page says it waits for the person while her chat's card says in a sentence what she wants; Allow takes the card away, the page says Installed, and the app is on her home screen", async ({
  context,
  page,
}) => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();

  publish(catalog, [reminders], [quiet('notes', 'Notes', '1.0.0')]);

  const daemon = await startDaemon(quietHome(model), catalog.env);
  const phone = await context.newPage();
  const card = page.getByRole('group', {
    name: 'Mira wants to install Reminders',
  });
  const pill = phone.locator('.phone-pill');

  expect(await wireOf(daemon).installApp('mira', 'notes')).toMatchObject({
    status: 'ok',
  });
  await phone.goto(phoneOf(daemon, 'mira'));
  await page.goto(daemon.url);
  model.answer(calling(['phone_open', {app: 'store'}]));

  const looking = model.hold();

  await tellMira(page, 'Is there an app for reminders?');
  await looking.arrived();
  await expect(phone.getByRole('heading', {name: 'App Store'})).toBeVisible();
  await expect(phone.locator('.phone-row')).toHaveText([
    'RemindersThings to do, on a day and time',
    'NotesNotes, quietlyInstalled',
  ]);

  const asking = model.hold();

  looking.release(
    calling([
      'phone_use',
      {app: 'store', action: 'show_app', input: {app: 'reminders'}},
    ]),
  );
  await asking.arrived();
  await expect(
    phone.getByRole('heading', {name: 'Reminders', exact: true}),
  ).toBeVisible();
  await expect(pill).toHaveText('Not on her phone');
  // The app's page is another page of the store's view, not rows it gained.
  await expect(phone.locator('.phone-row-new')).toHaveCount(0);

  model.answer(reply('It is on my phone now.'));
  asking.release(calling(['phone_install', {app: 'reminders'}]));
  await expect(pill).toHaveText('Waiting for you');
  await expect(card).toHaveAccessibleDescription(
    'From the App Store. It keeps its own data and can wake her up.',
  );

  await card.getByRole('button', {name: 'Allow', exact: true}).click();
  await expect(card).toHaveCount(0);
  await expect(pill).toHaveText('Installed');
  await phone.getByRole('button', {name: 'Home'}).click();
  await expect(
    phone.getByRole('button', {name: 'Reminders', exact: true}),
  ).toBeVisible();
});

test("page.store-app-denied: while her ask to install an app on the App Store's list waits for the person, the app's row says Waiting and her chat's card what she wants; Don't Allow takes the card away, she answers, and the row says nothing of the app being on her phone", async ({
  context,
  page,
}) => {
  const model = await startModelServer();
  const catalog = await startCatalogServer();

  publish(catalog, [reminders]);

  const daemon = await startDaemon(quietHome(model), catalog.env);
  const phone = await context.newPage();
  const card = page.getByRole('group', {
    name: 'Mira wants to install Reminders',
  });
  const row = phone.locator('.phone-row');

  await phone.goto(phoneOf(daemon, 'mira'));
  await page.goto(daemon.url);
  model.answer(
    calling(['phone_open', {app: 'store'}]),
    calling(['phone_install', {app: 'reminders'}]),
    reply('Maybe later, then.'),
  );
  await tellMira(page, 'Get the reminders app.');
  await expect(row).toHaveText(
    'RemindersThings to do, on a day and timeWaiting',
  );
  await expect(card).toBeVisible();

  await card.getByRole('button', {name: "Don't Allow"}).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Maybe later, then.',
  ]);
  await expect(row).toHaveText('RemindersThings to do, on a day and time');
});
