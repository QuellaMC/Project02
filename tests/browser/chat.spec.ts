import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, type Locator, type Page} from '@playwright/test';

import {startDaemon} from '../conformance/harness/daemon.ts';
import {frameOf, openEvents} from '../conformance/harness/events.ts';
import {
  characterJson,
  chmod,
  configJson,
  createHome,
} from '../conformance/harness/home.ts';
import {
  calling,
  finish,
  reply,
  startModelServer,
  undecided,
  visibleReply,
  type Answer,
} from '../conformance/harness/model-server.ts';
import {
  conversationOf,
  converse,
  saveConfig,
  sender,
  wireOf,
  type Wire,
} from '../conformance/harness/wire.ts';
import {test} from './fixture.ts';

type Asked = {readonly request: {readonly code: string}};

const mira = {scope: 'character', characterId: 'mira'} as const;
const alice = {id: '381940562', label: 'Alice (@alice)'};
const bob = {id: '987654321', label: 'Bob (@bob)'};

/** Mira on the model server. */
async function miraHome(
  seed: Parameters<typeof createHome>[0] = {},
  env: Readonly<Record<string, string>> = {},
) {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
    ...seed,
  });
  const daemon = await startDaemon(home, env);

  return {model, home, daemon, wire: wireOf(daemon)};
}

function composerFor(page: Page) {
  return page.getByRole('textbox', {name: 'Message Mira'});
}

async function send(page: Page, line: string): Promise<void> {
  await composerFor(page).fill(line);
  await composerFor(page).press('Enter');
}

/** Allow, on the card that asks. */
async function allowOn(card: Locator): Promise<void> {
  await card.getByRole('button', {name: 'Allow', exact: true}).click();
}

/** Within half a pixel: where boxes meet. */
const near = 0.5;

/**
 * Where the card in front sits against her last line, the message box,
 * the dock that holds it and the window, and whether its end is under its
 * words; none while it is not there.
 */
async function placeOf(
  page: Page,
): Promise<Readonly<Record<string, boolean>> | undefined> {
  const card = page.locator('.ask:not([aria-hidden])');
  const [shown, words, end, dock, line, box] = await Promise.all([
    card.boundingBox(),
    card.locator('.ask-words').boundingBox(),
    card.locator('.ask-end').boundingBox(),
    page.locator('.dock').boundingBox(),
    page.locator('.bubble-theirs').last().boundingBox(),
    page.locator('.composer').boundingBox(),
  ]);
  const size = page.viewportSize();

  if (
    shown === null ||
    words === null ||
    end === null ||
    dock === null ||
    line === null ||
    box === null ||
    size === null
  ) {
    return undefined;
  }

  const bottom = shown.y + shown.height;

  return {
    belowHerLine: shown.y + near >= line.y + line.height,
    aboveTheBox: bottom <= box.y + near,
    whole: shown.y + near >= dock.y && bottom <= dock.y + dock.height + near,
    inTheWindow:
      shown.x >= 0 &&
      shown.y >= 0 &&
      shown.x + shown.width <= size.width &&
      bottom <= size.height,
    answerUnderWords: end.y + near >= words.y + words.height,
  };
}

/**
 * Every word the dock's cards say of how an ask ended, on every frame
 * from now until the card in front is the one titled `title`.
 */
function saidUntil(page: Page, title: string): Promise<string[]> {
  return page.evaluate<string[]>(`new Promise(resolve => {
    const said = new Set();
    const look = () => {
      for (const words of document.querySelectorAll('.ask-said')) {
        said.add(words.textContent);
      }

      const front = document.querySelector('.ask:not([aria-hidden]) .ask-title');

      if (front !== null && front.textContent === ${JSON.stringify(title)}) {
        resolve([...said].filter(words => words !== ''));
      } else {
        requestAnimationFrame(look);
      }
    };

    look();
  })`);
}

/**
 * On every frame from now until the dock has opened and closed again,
 * where the chat's first line sits in the window.
 */
function firstLineWhileTheDockMoves(page: Page): Promise<number[]> {
  return page.evaluate<number[]>(`new Promise(resolve => {
    const first = document.querySelector('.messages .bubble');
    const dock = document.querySelector('.dock');
    const seen = [];
    let opened = false;
    const look = () => {
      seen.push(first.getBoundingClientRect().top);
      opened = opened || dock.getBoundingClientRect().height > 0;

      if (opened && dock.getBoundingClientRect().height === 0 && document.querySelector('.ask') === null) {
        resolve(seen);
      } else {
        requestAnimationFrame(look);
      }
    };

    look();
  })`);
}

/** The model asks to set Mira's tone, against the fingerprint her settings hand out now. */
async function asksForTone(wire: Wire, tone: string): Promise<Answer> {
  const view = (await wire.configView(mira)) as {
    readonly fingerprint: string;
  };

  return calling([
    'runtime_plugin_config_update',
    {
      pluginId: 'reply-style',
      fieldName: 'tone',
      operation: 'set',
      value: tone,
      expectedFingerprint: view.fingerprint,
    },
  ]);
}

test("page.chat-drafts-and-second-tab: the printed address opens the page and the one character opens herself; a sent line is the person's bubble, the reply is drafted ahead of its commit and replaced whole by it, and a second tab shows the same thread", async ({
  context,
  page,
}) => {
  const {model, daemon} = await miraHome();
  const driven = model.stream();
  // The arguments cut after "The".
  const [head, tail] = visibleReply('The sea is wide.', 12);

  await page.goto(daemon.url);
  await expect(page.getByRole('button', {name: /^Mira\b/u})).toContainText(
    'ready',
  );
  await send(page, 'Tell me about the sea.');
  await expect(composerFor(page)).toHaveValue('');
  await expect(page.locator('.bubble-own .bubble-text')).toHaveText(
    'Tell me about the sea.',
  );
  await driven.arrived();
  driven.write([head]);
  await expect(page.locator('[data-draft] .bubble-text')).toHaveText('The');
  driven.write([tail, finish('tool_calls')]);
  driven.end();
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'The sea is wide.',
  ]);
  await expect(page.locator('[data-draft]')).toHaveCount(0);
  await expect(page.locator('[data-pending]')).toHaveCount(0);

  const second = await context.newPage();

  await second.goto(daemon.url);
  await expect(second.locator('.bubble-text')).toHaveText([
    'Tell me about the sea.',
    'The sea is wide.',
  ]);
});

test("page.own-turn: a moment of hers in which she says nothing shows nothing, one whose model fails raises no notice, and her message in a moment of her own appears in the open thread with no 'is writing' line before her first draft", async ({
  context,
  page,
}) => {
  // Her heartbeat a quarter of an hour, at a minute of a tenth of a second.
  const {model, daemon} = await miraHome(
    {
      'character-data': {
        mira: {'config.json': configJson({project02: {heartbeat: '15m'}})},
      },
    },
    {PROJECT02_TEST_DURATIONS: 'minute=100'},
  );
  const events = await openEvents(daemon);
  const ownEnd = (status: string) =>
    events.next(
      frame =>
        frameOf('turn_completed', {status})(frame) &&
        !(frame.data ?? '').includes('"clientMessageId"'),
    );
  const texts = page.locator('.bubble-text');
  // The arguments cut after "The".
  const [head, tail] = visibleReply('The sea is calm today.', 12);

  model.answer(reply('Tea first.'), reply('I hope the tea was good.'));
  await page.goto(daemon.url);
  await send(page, 'Morning.');
  await expect(texts).toHaveText(['Morning.', 'Tea first.']);
  // A thought of hers, then a moment the model server has no answer for.
  await ownEnd('completed');
  await ownEnd('rejected');

  const driven = model.stream();

  await driven.arrived();

  // A tab opened while her moment runs, before she drafts, installs it.
  const second = await context.newPage();

  await second.goto(daemon.url);
  await expect(second.locator('.bubble-text')).toHaveText([
    'Morning.',
    'Tea first.',
  ]);
  await expect(second.locator('.typing')).toHaveCount(0);
  driven.write([head]);

  for (const tab of [page, second]) {
    await expect(tab.locator('[data-draft] .bubble-text')).toHaveText('The');
  }

  driven.write([tail, finish('tool_calls')]);
  driven.end();
  await expect(texts).toHaveText([
    'Morning.',
    'Tea first.',
    'The sea is calm today.',
  ]);
  await expect(page.locator('[data-draft]')).toHaveCount(0);
  await expect(page.locator('.typing')).toHaveCount(0);
  await expect(page.locator('main > .notice')).toHaveCount(0);
});

test("page.unseen-dot: with two characters, a message one writes while the other's chat is on screen puts a dot beside her name, and opening her chat takes it away", async ({
  page,
}) => {
  // Mira's heartbeat a quarter of an hour, at a minute of a tenth of a
  // second; Nova's off, so only Mira writes first.
  const {model, daemon} = await miraHome(
    {
      characters: {
        nova: {'project02.character.json': characterJson('nova', 'Nova')},
      },
      'character-data': {
        mira: {'config.json': configJson({project02: {heartbeat: '15m'}})},
        nova: {'config.json': configJson({project02: {heartbeat: 'off'}})},
      },
    },
    {PROJECT02_TEST_DURATIONS: 'minute=100'},
  );
  const roster = page.getByRole('complementary', {name: 'Characters'});
  const chatWith = (name: string) =>
    roster.getByRole('button', {name: new RegExp(`^${name}\\b`, 'u')});
  const dotOf = (name: string) =>
    roster
      .getByRole('listitem')
      .filter({hasText: name})
      .getByRole('img', {name: 'New message'});
  const moment = model.hold();

  await page.goto(daemon.url);
  // Opening her chat makes her thread, and her heartbeat starts.
  await chatWith('Mira').click();
  await expect(composerFor(page)).toBeVisible();
  await chatWith('Nova').click();
  await expect(page.getByRole('textbox', {name: 'Message Nova'})).toBeVisible();
  await moment.arrived();
  moment.release({
    chunks: [...visibleReply('Thinking of you.'), finish('tool_calls')],
  });
  await expect(dotOf('Mira')).toBeVisible();
  await expect(dotOf('Nova')).toHaveCount(0);

  await chatWith('Mira').click();
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Thinking of you.',
  ]);
  await expect(dotOf('Mira')).toHaveCount(0);
});

test('page.reconnect-same-address: once the daemon stops the page says Connecting… and keeps the thread; once another starts on the home it is back on the same address by itself, and the next line is answered without a click', async ({
  page,
}) => {
  // Nova beside her, off: with two characters no thread opens itself, so
  // a restart cannot hide behind one.
  const {model, home, daemon} = await miraHome({
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {
      nova: {'config.json': configJson({project02: {enabled: false}})},
    },
  });
  const replies = page.locator('.bubble-theirs .bubble-text');

  model.answer(reply('Hello to you.'), reply('Again, hello.'));
  await page.goto(daemon.url);
  await page.getByRole('button', {name: /^Mira\b/u}).click();
  await send(page, 'Hello.');
  await expect(replies).toHaveText(['Hello to you.']);

  daemon.signal('SIGINT');
  expect(await daemon.exit()).toBe(0);
  await expect(page.getByText('Connecting…')).toBeVisible();
  await expect(replies).toHaveText(['Hello to you.']);

  const restarted = await startDaemon(home);

  expect(restarted.url).toBe(daemon.url);
  await expect(page.getByText('Connecting…')).toHaveCount(0);
  await expect(replies).toHaveText(['Hello to you.']);
  await send(page, 'Again.');
  await expect(replies).toHaveText(['Hello to you.', 'Again, hello.']);
});

test("page.confirmation-card: her ask to change one of her settings waits on a card above the message box that says it in her settings page's words; Allow lets her turn finish, and one her stop cancels goes and is said once, naming her", async ({
  page,
}) => {
  const {model, daemon, wire} = await miraHome();
  const card = page.getByRole('group', {
    name: 'Mira wants to change her Reply Style',
  });
  const replies = page.locator('.bubble-theirs .bubble-text');

  await page.goto(daemon.url);
  model.answer(await asksForTone(wire, 'warm'), reply('Warmly, then.'));
  await send(page, 'Be warm.');
  await expect(card).toHaveAccessibleDescription('Tone: not set → Warm.');
  await allowOn(card);
  await expect(replies).toHaveText(['Warmly, then.']);
  await expect(card).toHaveCount(0);

  // Switched off while a card waits: the card goes, and the turn finishes
  // on the model's word that nothing was changed.
  model.answer(await asksForTone(wire, 'formal'), reply('As you were.'));
  await send(page, 'Be formal.');
  await expect(card).toHaveAccessibleDescription('Tone: Warm → Formal.');
  await saveConfig(wire, mira, {
    kind: 'set',
    path: 'project02.enabled',
    value: false,
  });
  await expect(card).toHaveCount(0);
  await expect(replies).toHaveText(['Warmly, then.', 'As you were.']);
  await expect(page.locator('main > .notice')).toHaveText([
    'Mira: A confirmation was cancelled when the character stopped.',
  ]);
});

test("page.pairing-card: someone new asking on a connector waits on a card that says who, where they wrote and the code; an approval the home cannot take keeps it and says why, Allow says Allowed and puts the account in the home's pairedUsers, and one nobody answers says Expired and is said once", async ({
  page,
}) => {
  // Long enough for a person to answer one, short enough to wait out.
  const {home, daemon, wire} = await miraHome(
    {},
    {PROJECT02_TEST_DURATIONS: 'pairing=5000'},
  );
  const cardOf = (label: string) =>
    page.getByRole('group', {name: `${label} wants to pair on Telegram`});
  const notices = page.locator('main > .notice');

  await page.goto(daemon.url);
  // Her thread opens itself, which writes into the home: it is open before
  // the home refuses the approval's write.
  await expect(composerFor(page)).toBeVisible();

  const forAlice = (await wire.pairingRequest('telegram', {
    subject: alice,
    source: 'telegram:mira_bot',
  })) as Asked;
  const card = cardOf(alice.label);

  await expect(card).toHaveAccessibleDescription(
    `Wrote to @mira_bot. Code ${forAlice.request.code}.`,
  );
  chmod(home, 0o500);

  try {
    await allowOn(card);
    await expect(notices).toContainText(join(home, 'config.json'));
  } finally {
    chmod(home, 0o700);
  }

  await allowOn(card);
  await expect(card).toContainText('Allowed');
  await expect(notices).toHaveCount(0);
  expect(await wire.connectorConfig('telegram')).toMatchObject({
    home: {values: {pairedUsers: {[alice.id]: alice.label}}},
  });

  // Asked while the answer to the first still shows, it takes the spot.
  const forBob = (await wire.pairingRequest('telegram', {
    subject: bob,
    source: 'telegram:mira_bot',
  })) as Asked;

  await expect(cardOf(bob.label)).toBeVisible();
  await expect(cardOf(bob.label)).toContainText('Expired');
  await expect(notices).toHaveText([
    `A pairing request expired before it was answered: ${bob.label}, code ${forBob.request.code}.`,
  ]);
  await expect(cardOf(bob.label)).toHaveCount(0);
});

test('page.ask-place: what she asks waits on a card under her last line and above the message box, whole inside the window, its answer under its words in a narrow one; her row among the characters says she is asking until it is answered', async ({
  page,
}) => {
  const {model, daemon, wire} = await miraHome();
  const card = page.getByRole('group', {
    name: 'Mira wants to change her Reply Style',
  });
  const herRow = page
    .getByRole('complementary', {name: 'Characters'})
    .getByRole('listitem')
    .filter({hasText: 'Mira'});
  const inPlace = {
    belowHerLine: true,
    aboveTheBox: true,
    whole: true,
    inTheWindow: true,
  };

  model.answer(reply('Hello to you.'));
  await page.goto(daemon.url);
  await send(page, 'Hello.');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Hello to you.',
  ]);
  model.answer(await asksForTone(wire, 'warm'), reply('Warmly, then.'));
  await send(page, 'Be warm.');
  await expect(card).toBeVisible();
  await expect(herRow).toContainText('Asking you…');
  await expect
    .poll(() => placeOf(page))
    .toEqual({...inPlace, answerUnderWords: false});

  await page.setViewportSize({width: 420, height: 760});
  await expect
    .poll(() => placeOf(page))
    .toEqual({...inPlace, answerUnderWords: true});

  await allowOn(card);
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Hello to you.',
    'Warmly, then.',
  ]);
  await expect(herRow).not.toContainText('Asking you…');
});

test('page.asks-one-spot: what waits is answered one at a time in one spot above the message box, another behind it as an edge; once the first is answered it says Allowed, and the next takes its place', async ({
  page,
}) => {
  const {model, daemon, wire} = await miraHome();
  const dock = page.locator('.dock');
  const hers = page.getByRole('group', {
    name: 'Mira wants to change her Reply Style',
  });
  const alices = `${alice.label} wants to pair on Telegram`;

  await page.goto(daemon.url);
  model.answer(await asksForTone(wire, 'warm'), reply('Warmly, then.'));
  await send(page, 'Be warm.');
  await expect(hers).toBeVisible();
  await wire.pairingRequest('telegram', {
    subject: alice,
    source: 'telegram:mira_bot',
  });
  await expect(dock).toHaveAttribute('data-edges', '1');
  await expect(page.getByRole('group', {name: /wants to/u})).toHaveCount(1);

  const said = saidUntil(page, alices);

  await allowOn(hers);
  expect(await said).toEqual(['Allowed']);
  await expect(page.getByRole('group', {name: alices})).toBeVisible();
  await expect(dock).toHaveAttribute('data-edges', '0');
  await expect(page.locator('.bubble-theirs .bubble-text')).toHaveText([
    'Warmly, then.',
  ]);
});

test('page.ask-while-reading: in a chat scrolled up to read, the line at the top stays where it is while a card opens above the message box and while it closes as her reply arrives', async ({
  page,
}) => {
  const {model, daemon, wire} = await miraHome();
  const say = await converse(wire, 'mira');
  const messages = page.locator('.messages');
  const card = page.getByRole('group', {
    name: 'Mira wants to change her Reply Style',
  });

  for (const at of Array.from({length: 15}, (_, line) => String(line + 1))) {
    model.answer(reply(`Reply ${at}.`));
    await say(`Line ${at}.`, `line-${at}`);
  }

  await page.goto(daemon.url);
  await expect(page.locator('.bubble-text')).toHaveCount(30);
  // Scrolled up as a person scrolls: the wheel, over the chat.
  await messages.hover();
  await page.mouse.wheel(0, -10_000);
  await expect
    .poll(() =>
      page.evaluate<number>("document.querySelector('.messages').scrollTop"),
    )
    .toBe(0);

  const firstLine = firstLineWhileTheDockMoves(page);

  model.answer(await asksForTone(wire, 'warm'), reply('Warmly, then.'));
  await send(page, 'Be warm.');
  await allowOn(card);

  const [where, ...since] = await firstLine;

  expect(since.filter(top => top !== where)).toEqual([]);
  await expect(page.locator('.bubble-theirs .bubble-text').last()).toHaveText(
    'Warmly, then.',
  );
});

test('page.rejected-line-kept: a line whose turn the daemon rejected stays on the thread with a notice saying why, and the composer is empty', async ({
  page,
}) => {
  const {model, daemon} = await miraHome();
  const events = await openEvents(daemon);

  model.answer(...undecided());
  await page.goto(daemon.url);
  await send(page, 'Say something.');

  const rejected = JSON.parse(
    (await events.next(frameOf('turn_completed', {status: 'rejected'}))).data ??
      '',
  ) as {readonly message: string};

  await expect(page.locator('.bubble-text')).toHaveText(['Say something.']);
  await expect(page.locator('main > .notice')).toHaveText([
    `Mira: ${rejected.message}`,
  ]);
  await expect(page.locator('[data-pending]')).toHaveCount(0);
  await expect(composerFor(page)).toHaveValue('');
});

test('page.refused-line-handback: a line the daemon refuses before any turn, longer than it takes, goes back to the composer with its reason as a notice', async ({
  page,
}) => {
  const {daemon} = await miraHome();
  // As long as a paste can be: the daemon refuses it before any turn
  // runs, so the line is the person's again.
  const tooLong = 'x'.repeat(17 * 1024);

  await page.goto(daemon.url);
  await send(page, tooLong);
  await expect(page.locator('main > .notice')).toContainText(
    'Mira: The message: a line is at most',
  );
  await expect(composerFor(page)).toHaveValue(tooLong);
  await expect(page.locator('[data-pending]')).toHaveCount(0);
});

test('page.history-pages: the newest page of the history is the thread, and an earlier page goes in front of it once, keeping what arrived live', async ({
  page,
}) => {
  const {model, daemon, wire} = await miraHome();
  const say = await converse(wire, 'mira');
  // A page holds a hundred messages: fifty-one turns are a page and two more.
  const turns = Array.from(
    {length: 51},
    (_, at) => [`Line ${String(at + 1)}.`, `Reply ${String(at + 1)}.`] as const,
  );
  const texts = page.locator('.bubble-text');
  const earlier = page.getByRole('button', {name: 'Load earlier'});

  for (const [at, [line, answer]] of turns.entries()) {
    model.answer(reply(answer));
    await say(line, `line-${String(at + 1)}`);
  }

  await page.goto(daemon.url);
  await expect(texts).toHaveText(turns.flat().slice(2));
  model.answer(reply('Reply 52.'));
  await send(page, 'Line 52.');
  await expect(texts).toHaveText([
    ...turns.flat().slice(2),
    'Line 52.',
    'Reply 52.',
  ]);
  await earlier.click();
  await expect(texts).toHaveText([...turns.flat(), 'Line 52.', 'Reply 52.']);
  await expect(earlier).toHaveCount(0);
});

test("page.notices: another surface's turn that failed, a page of the thread that could not be read and an address the daemon refuses are each said without erasing what the page shows, and the person's next act spends a notice", async ({
  page,
}) => {
  const {model, home, daemon, wire} = await miraHome();
  const texts = page.locator('.bubble-text');
  const notices = page.locator('main > .notice');

  await page.goto(daemon.url);
  model.answer(reply('Hi.'));
  await send(page, 'Hello.');
  await expect(texts).toHaveText(['Hello.', 'Hi.']);

  const {conversationId} = await conversationOf(wire, 'mira');
  const fromThePhone = await sender(wire);

  model.answer(...undecided());

  const elsewhere = (await fromThePhone({
    conversationId,
    text: 'From the phone.',
    source: 'telegram',
    clientMessageId: 'phone',
  })) as {readonly message: string};

  await expect(notices).toHaveText([`Mira: ${elsewhere.message}`]);
  await expect(texts).toHaveText(['Hello.', 'Hi.', 'From the phone.']);

  // Opening her again is the person's act, and the page it asks for fails.
  await page.route('**/api/conversations/*/messages*', route => route.abort());
  await page.getByRole('button', {name: /^Mira\b/u}).click();
  await expect(page.locator('.thread .notice')).toContainText(
    'could not be reached',
  );
  await expect(notices).toHaveCount(0);
  await expect(texts).toHaveText(['Hello.', 'Hi.', 'From the phone.']);
  await page.unroute('**/api/conversations/*/messages*');

  // The daemon comes back on the address under another token.
  await composerFor(page).fill('Not sent yet.');
  daemon.signal('SIGINT');
  expect(await daemon.exit()).toBe(0);

  const record = join(home, 'daemon.json');

  writeFileSync(
    record,
    JSON.stringify({
      ...(JSON.parse(readFileSync(record, 'utf8')) as object),
      token: 'another-token',
    }),
  );
  await startDaemon(home);
  await expect(page.getByRole('alert')).toContainText(
    'This address does not work: open the one project02 serve printed, or open the app again.',
  );
  await expect(texts).toHaveText(['Hello.', 'Hi.', 'From the phone.']);
  await expect(composerFor(page)).toHaveValue('Not sent yet.');
});
