import {expect, type Page} from '@playwright/test';

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
import {converse, wireOf} from '../conformance/harness/wire.ts';
import {test} from './fixture.ts';

test.use({locale: 'en-US', timezoneId: 'UTC'});

/** Her world's address on the daemon: the page's own, naming her, the token in its fragment. */
function worldOf(daemon: Daemon, characterId: string): string {
  return `${daemon.origin}/?world=${encodeURIComponent(characterId)}#token=${daemon.token}`;
}

/** A home where Mira, whose package brings The Port, answers through `model`, and Nova, whose package brings no world; their heartbeats off. */
function portHome(model: ModelServer): string {
  const quiet = {'config.json': configJson({project02: {heartbeat: 'off'}})};

  return createHome({
    'config.json': configJson({project02: model.settings}),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {mira: quiet, nova: quiet},
  });
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

/** A tab of her world's window. */
function tab(page: Page, name: string) {
  return page
    .getByRole('navigation', {name: 'Her world'})
    .getByRole('button', {name});
}

/** The lines of the section headed `header`, each its words, who said to a reader of the screen. */
function linesUnder(page: Page, header: string) {
  return page
    .locator('.ui-section')
    .filter({has: page.getByRole('heading', {name: header, exact: true})})
    .locator('.world-name');
}

test("page.world-button: her chat's Her World opens her world's window and is pressed while it shows her world, which is named in its title; closing the window leaves it plain; a browser that blocks the window is told what to allow; a character whose package brings no world has no such button, and her world's address says so in its place", async ({
  page,
}) => {
  const model = await startModelServer();
  const daemon = await startDaemon(portHome(model));
  const button = page.getByRole('button', {name: 'Her World'});

  await page.goto(daemon.url);
  await chatWith(page, 'Mira');
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  const [world] = await Promise.all([
    page.waitForEvent('popup'),
    button.click(),
  ]);

  await expect(world).toHaveURL(worldOf(daemon, 'mira'));
  await expect(world).toHaveTitle('The Port');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await Promise.all([
    world.waitForEvent('close'),
    // The click closes the very window it is made in, which may be gone
    // before the click is said to have landed: only then is that no failure.
    world
      .getByRole('button', {name: 'Close her world'})
      .click()
      .catch((error: unknown) => {
        if (!world.isClosed()) {
          throw error;
        }
      }),
  ]);
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  // A browser that blocks the window answers its opening with nothing.
  await page.evaluate('void (window.open = () => null)');
  await button.click();
  await expect(page.locator('main > .notice')).toHaveText([
    "This browser blocked her world's window. Allow pop-ups for this page, then click Her World again.",
  ]);

  await chatWith(page, 'Nova');
  await expect(page.getByRole('button', {name: /^Her Phone/u})).toBeVisible();
  await expect(button).toHaveCount(0);

  await page.goto(worldOf(daemon, 'nova'));
  await expect(page.getByRole('status')).toHaveText('Nova has no world.');
});

test("page.world-now: her world's Now says where she is, since when, and what is there, and follows her when she goes somewhere", async ({
  page,
}) => {
  const model = await startModelServer();
  const daemon = await startDaemon(portHome(model));
  const say = await converse(wireOf(daemon), 'mira');
  const here = page.locator('.world-cards > .ui-card');

  await page.goto(worldOf(daemon, 'mira'));
  await expect(page.getByRole('img', {name: 'Mira lives here'})).toBeVisible();
  await expect(here.getByRole('button')).toHaveText(['The Flat']);
  await expect(here.locator('.world-living .world-name')).toHaveText(['Mira']);
  await expect(here.locator('.world-living .ui-value')).toHaveText([
    /^since \d/u,
  ]);
  await expect(here.locator('.ui-token')).toHaveText([
    'Kitchen table',
    'Tin of pencils',
    'Teapot',
    'Bed',
    'Bike',
  ]);

  model.answer(calling(['world_go', {place: 'studio'}]), reply('Off to work.'));
  await say('Where are you off to?', 'where');
  await expect(here.getByRole('button')).toHaveText(['The Studio']);
  await expect(here.locator('.ui-token')).toHaveText([
    'Printing machines',
    'Proofs',
  ]);
  await expect(linesUnder(page, 'Lately')).toHaveText([
    'Mira: Went to The Studio',
  ]);
});

test('page.world-leave: the person leaves her a thing where she is, as a gift at first: it is there, not seen yet, waiting on Now and among the things of its place; after her next turn there, she has seen it', async ({
  page,
}) => {
  const model = await startModelServer();
  const daemon = await startDaemon(portHome(model));
  const say = await converse(wireOf(daemon), 'mira');
  const sheet = page.getByRole('dialog', {name: 'Leave Something'});
  const waiting = page.getByRole('button', {
    name: 'A jar of honey Not seen yet',
  });

  await page.goto(worldOf(daemon, 'mira'));
  await page.getByRole('button', {name: 'Leave Something'}).click();
  await expect(sheet.getByRole('button', {name: 'Gift'})).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    sheet.getByRole('button', {name: 'The Flat', exact: true}),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    sheet.getByRole('button', {name: 'Leave It in The Flat'}),
  ).toBeDisabled();

  await sheet.getByRole('textbox', {name: 'What it is'}).fill('A jar of honey');
  await sheet.getByRole('button', {name: 'Food'}).click();
  await sheet
    .getByRole('textbox', {name: 'A note with it'})
    .fill('For your toast.');
  await sheet.getByRole('button', {name: 'Leave It in The Flat'}).click();
  await expect(sheet).toHaveCount(0);
  await expect(waiting).toBeVisible();
  await expect(page.locator('.world-cards .ui-token')).toContainText([
    'A jar of honey',
  ]);

  await tab(page, 'Places').click();
  await page.getByRole('button', {name: /^The Flat/u}).click();
  await expect(waiting).toBeVisible();

  model.answer(reply('Honey!'));
  await say('Look on the table.', 'look');
  await expect(
    page.getByRole('button', {name: 'A jar of honey'}),
  ).toBeVisible();
  await expect(page.getByText('Not seen yet')).toHaveCount(0);
  await tab(page, 'Now').click();
  await expect(
    page.getByRole('heading', {name: 'Waiting to Be Found'}),
  ).toHaveCount(0);
});

test("page.world-thing: a thing's card says what it is, its note, where it is, whom it is from and whether she has seen it, or the world it came with; removing it takes two presses, Cancel keeping it, and it is gone", async ({
  page,
}) => {
  const model = await startModelServer();
  const daemon = await startDaemon(portHome(model));
  const card = page.getByRole('dialog', {name: 'A jar of honey'});
  const remove = card.getByRole('button', {name: 'Remove from The Port'});

  await wireOf(daemon).leaveThing('mira', {
    name: 'A jar of honey',
    kind: 'food',
    place: 'flat',
    note: 'For your toast.',
  });
  await page.goto(worldOf(daemon, 'mira'));
  await page.getByRole('button', {name: 'A jar of honey Not seen yet'}).click();
  await expect(card.locator('.world-note')).toHaveText('For your toast.');
  await expect(card.locator('.world-fact')).toHaveText([
    'WhereThe Flat',
    /^Left byYou, \d/u,
    'Seen by MiraNot yet',
  ]);

  await remove.click();
  await card.getByRole('button', {name: 'Cancel'}).click();
  await remove.click();
  await card.getByRole('button', {name: 'Remove', exact: true}).click();
  await expect(card).toHaveCount(0);
  await expect(
    page.getByRole('heading', {name: 'Waiting to Be Found'}),
  ).toHaveCount(0);
  await expect(linesUnder(page, 'Lately')).toHaveText([
    'You: Removed A jar of honey',
    'You: Left A jar of honey',
  ]);

  await page.getByRole('button', {name: 'The Flat'}).click();
  await expect(page.getByRole('button', {name: 'A jar of honey'})).toHaveCount(
    0,
  );
  await page.getByRole('button', {name: 'Teapot'}).click();
  await expect(
    page.getByRole('dialog', {name: 'Teapot'}).locator('.world-fact'),
  ).toHaveText(['WhereThe Flat', 'Came withThe Port']);
});

test('page.world-refused: what the daemon refuses is said in the sheet for leaving something, which keeps what was typed', async ({
  page,
}) => {
  const model = await startModelServer();
  const daemon = await startDaemon(portHome(model));
  const sheet = page.getByRole('dialog', {name: 'Leave Something'});
  const note = 'For the window. '.repeat(20).trim();

  await page.goto(worldOf(daemon, 'mira'));
  await page.getByRole('button', {name: 'Leave Something'}).click();
  await sheet.getByRole('textbox', {name: 'What it is'}).fill('Tulips');
  await sheet.getByRole('textbox', {name: 'A note with it'}).fill(note);
  await sheet.getByRole('button', {name: 'Leave It in The Flat'}).click();
  await expect(sheet.getByRole('alert')).toHaveText(
    'A note is not blank, and is 280 characters at most.',
  );
  await expect(sheet.getByRole('textbox', {name: 'What it is'})).toHaveValue(
    'Tulips',
  );
  await expect(
    sheet.getByRole('textbox', {name: 'A note with it'}),
  ).toHaveValue(note);
});

test('page.world-journal: the journal says what happened by day, newest first: who did it, what, and the name it was about', async ({
  page,
}) => {
  const model = await startModelServer();
  const daemon = await startDaemon(portHome(model));
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');

  model.answer(
    calling(['world_go', {place: 'studio'}]),
    calling(['world_make', {name: 'Paper boat', kind: 'gift'}]),
    calling(['world_use', {thing: 'Proofs'}]),
    reply('At the studio.'),
  );
  await say('What are you up to?', 'up');
  await wire.leaveThing('mira', {
    name: 'A jar of honey',
    kind: 'food',
    place: 'flat',
  });
  await page.goto(worldOf(daemon, 'mira'));
  await tab(page, 'Journal').click();
  await expect(linesUnder(page, 'Today')).toHaveText([
    'You: Left A jar of honey',
    'Mira: Used Proofs',
    'Mira: Made Paper boat',
    'Mira: Went to The Studio',
  ]);
});
