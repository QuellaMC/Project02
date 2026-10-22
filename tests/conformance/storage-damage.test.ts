import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {serve, startDaemon, type Daemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {configJson, createHome, sessionLog, snapshot} from './harness/home.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
} from './harness/model-server.ts';
import {conversationOf, converse, wireOf, type Wire} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};
// A window this small rotates the segment after every turn.
const rotatingEveryTurn = configJson({project02: {contextWindowTokens: 1}});
// A committed record no reader can take: whole JSON, but no record.
const damagedRecord = '{"eventId": "evt_torn"}\n';

/**
 * A stopped home where Mira's conversation took two lines, one per
 * segment, and goes on in a third that holds only its continuation
 * record; later runs no longer rotate.
 */
async function threeSegments(): Promise<{
  readonly home: string;
  readonly conversationId: string;
  readonly segment: (n: number) => string;
}> {
  const home = createHome({'config.json': rotatingEveryTurn});
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  await say('One.', 'one');
  await say('Two.', 'two');
  daemon.signal('SIGINT');
  await daemon.exit();
  writeFileSync(join(home, 'config.json'), configJson({}));

  return {
    home,
    conversationId,
    segment: n =>
      join(
        home,
        'character-data',
        'mira',
        'sessions',
        `${conversationId}.${String(n)}`,
      ),
  };
}

/** A turn of the local user on the conversation. */
function lineOn(
  wire: Wire,
  conversationId: string,
  text: string,
  clientMessageId: string,
) {
  return wire.turn({
    conversationId,
    senderId: 'local-user',
    text,
    source: 'web',
    clientMessageId,
  });
}

it("storage.torn-final-record: a log whose last line a crash cut short reads back without it and the next turn completes, and a plugin's store drops a torn or blank tail the same way", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const patch = async (mood: string) => {
    const daemon = await startDaemon(home);
    const wire = wireOf(daemon);
    const say = await converse(wire, 'mira');
    const {conversationId} = await conversationOf(wire, 'mira');

    model.answer(calling(['character_state_patch', {mood}]), reply(`${mood}.`));

    const outcome = await say(`Feeling ${mood}?`, mood);
    const history = await wire.history(conversationId);

    daemon.signal('SIGINT');
    await daemon.exit();

    return {conversationId, outcome, history};
  };
  const {conversationId} = await patch('curious');
  const events = join(
    home,
    'character-data',
    'mira',
    'plugin-data',
    'character-state',
    'events.jsonl',
  );

  appendFileSync(
    join(
      home,
      'character-data',
      'mira',
      'sessions',
      `${conversationId}.1`,
      'raw-events.jsonl',
    ),
    '{"eventId":"evt_torn","kin',
  );
  appendFileSync(events, '{"type":"character_state.pat');
  expect(await patch('playful')).toMatchObject({
    outcome: {status: 'completed'},
    history: {
      messages: [
        {text: 'Feeling curious?'},
        {text: 'curious.'},
        {text: 'Feeling playful?'},
        {text: 'playful.'},
      ],
    },
  });
  appendFileSync(events, '   ');
  expect(await patch('tired')).toMatchObject({
    outcome: {status: 'completed'},
    history: {messages: [{}, {}, {}, {}, {}, {text: 'tired.'}]},
  });
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    output: {appliedChanges: [{before: 'playful', after: 'tired'}]},
  });
  expect(
    readFileSync(events, 'utf8')
      .trimEnd()
      .split('\n')
      .map(
        line =>
          (JSON.parse(line) as {readonly input: {readonly mood: string}}).input
            .mood,
      ),
  ).toEqual(['curious', 'playful', 'tired']);
});

it('storage.crash-open-turn-readable: a log a crash left in the middle of a turn, the line committed and no ending, reads back and the next turn completes after it; one left in the middle of a tool call reads back too', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({
      project02: model.settings,
      plugins: {'demo-config': {enabled: true}},
    }),
  });
  const run = async () => {
    const daemon = await startDaemon(home);
    const wire = wireOf(daemon);
    const say = await converse(wire, 'mira');
    const {conversationId} = await conversationOf(wire, 'mira');
    const events = await openEvents(daemon);

    return {daemon, wire, say, conversationId, events};
  };
  const kill = async (daemon: Daemon, turn: Promise<unknown>) => {
    const broken = expect(turn).rejects.toThrow();

    daemon.signal('SIGKILL');
    await daemon.exit();
    await broken;
  };
  const first = await run();
  const log = () => sessionLog(home, 'mira', `${first.conversationId}.1`);
  const held = model.hold();
  const anyone = first.say('Anyone?', 'anyone');

  await held.arrived();
  await first.events.next(
    frameOf('turn_progress', {progress: {kind: 'user_message'}}),
  );
  await kill(first.daemon, anyone);
  expect(log().at(-1)).toMatchObject({
    kind: 'visible_message_committed',
    visibleMessage: {text: 'Anyone?'},
  });

  const second = await run();
  const {fingerprint} = (await second.wire.configView({
    scope: 'character',
    characterId: 'mira',
  })) as {readonly fingerprint: string};

  model.answer(
    reply('Here.'),
    calling([
      'runtime_plugin_config_update',
      {
        pluginId: 'demo-config',
        fieldName: 'tone',
        operation: 'set',
        value: 'warm',
        expectedFingerprint: fingerprint,
      },
    ]),
  );
  expect(await second.say('Hello again.', 'again')).toMatchObject({
    status: 'completed',
  });

  const warm = second.say('Be warm.', 'warm');

  await second.events.next(frameOf('confirmation_requested'));
  await kill(second.daemon, warm);
  expect(log().at(-1)).toMatchObject({kind: 'tool_call_started'});

  const third = await run();

  model.answer(reply('Still here.'));
  expect(await third.say('Still there?', 'still')).toMatchObject({
    status: 'completed',
  });
  await expect(third.wire.history(first.conversationId)).resolves.toMatchObject(
    {
      messages: [
        {text: 'Anyone?'},
        {text: 'Hello again.'},
        {text: 'Here.'},
        {text: 'Be warm.'},
        {text: 'Still there?'},
        {text: 'Still here.'},
      ],
    },
  );
  expect(
    log().filter(record => record['kind'] === 'runtime_turn_completed'),
  ).toHaveLength(2);
});

it('storage.catalog-torn-tail: a sessions catalog a crash cut off in its last row still names every session before the cut, and a last row without its newline is not read', async () => {
  const {home, conversationId, segment} = await threeSegments();
  const catalog = join(home, 'character-data', 'mira', 'sessions.jsonl');
  const [one = '', two = '', three = ''] = readFileSync(catalog, 'utf8')
    .trimEnd()
    .split('\n');

  // The crash came before the third segment's first record.
  rmSync(join(segment(3), 'raw-events.jsonl'));

  for (const [tail, id] of [
    [three.slice(0, three.length / 2), 'cut'],
    [three, 'unterminated'],
  ] as const) {
    writeFileSync(catalog, `${one}\n${two}\n${tail}`);

    const daemon = await startDaemon(home, fixedReplies);
    const wire = wireOf(daemon);

    await wire.start('mira');
    await expect(wire.open('mira'), id).resolves.toMatchObject({
      status: 'opened',
      conversationId,
    });
    await expect(wire.history(conversationId), id).resolves.toMatchObject({
      messages: [
        {text: 'One.'},
        {role: 'character'},
        {text: 'Two.'},
        {role: 'character'},
        ...(id === 'unterminated' ? [{text: 'Cut.'}, {role: 'character'}] : []),
      ],
    });
    await expect(
      lineOn(wire, conversationId, id === 'cut' ? 'Cut.' : 'Unterminated.', id),
      id,
    ).resolves.toMatchObject({
      status: 'completed',
      messages: [
        {messageId: expect.stringMatching(/\.2:message-/u) as string},
        {},
      ],
    });
    daemon.signal('SIGINT');
    await daemon.exit();
  }
});

it('storage.crash-residue-tolerated: residue an interrupted operation left is passed over: a session directory nothing names, a conversation directory without its record, a cataloged continuation that holds no record, which is let go so that the segment before it takes the next line, and an uncataloged segment holding only a torn line, which the next rotation takes with the torn bytes gone', async () => {
  const {home, conversationId, segment} = await threeSegments();
  const catalog = join(home, 'character-data', 'mira', 'sessions.jsonl');

  mkdirSync(join(home, 'character-data', 'mira', 'sessions', 'conv_orphan.1'));
  mkdirSync(join(home, 'conversations', 'conv_unfinished'));
  // The rotation into the third segment was cut off before its first record.
  rmSync(join(segment(3), 'raw-events.jsonl'));

  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);

  await wire.start('mira');
  await expect(wire.open('mira')).resolves.toMatchObject({
    status: 'opened',
    conversationId,
  });
  await expect(wire.history('conv_unfinished')).resolves.toMatchObject({
    status: 'refused',
    reason: 'unknown_conversation',
  });
  await expect(
    lineOn(wire, conversationId, 'Three.', 'three'),
  ).resolves.toMatchObject({
    status: 'completed',
    messages: [{messageId: `${conversationId}.2:message-3`}, {}],
  });
  expect(readFileSync(catalog, 'utf8')).not.toContain(`${conversationId}.3`);
  daemon.signal('SIGINT');
  await daemon.exit();
  writeFileSync(join(home, 'config.json'), rotatingEveryTurn);
  mkdirSync(segment(3));
  writeFileSync(
    join(segment(3), 'raw-events.jsonl'),
    '{"eventId":"evt_torn","kin',
  );

  const rotating = wireOf(await startDaemon(home, fixedReplies));

  await rotating.start('mira');
  await expect(
    lineOn(rotating, conversationId, 'Four.', 'four'),
  ).resolves.toMatchObject({status: 'completed'});
  expect(sessionLog(home, 'mira', `${conversationId}.3`)).toMatchObject([
    {kind: 'session_continued'},
  ]);
  expect(readFileSync(catalog, 'utf8')).toContain(`${conversationId}.3`);
});

it('storage.damaged-record: damage is reported, never read as a shorter history: a segment the catalog names that the disk lacks, or a catalog gone or empty while segment directories hold records, fails the open, history and turns missing_file, and a committed catalog row that is no session row fails them malformed_record naming its line, the catalog left as it was', async () => {
  const {home: stopped, conversationId} = await threeSegments();
  const data = join('character-data', 'mira');
  const catalog = join(data, 'sessions.jsonl');
  const [one = '', two = '', three = ''] = readFileSync(
    join(stopped, catalog),
    'utf8',
  )
    .trimEnd()
    .split('\n');
  const damages = [
    [
      'missing_file',
      'is missing',
      (home: string) => {
        rmSync(join(home, data, 'sessions', `${conversationId}.1`), {
          recursive: true,
        });
      },
    ],
    [
      'missing_file',
      'is missing or empty',
      (home: string) => {
        rmSync(join(home, catalog));
      },
    ],
    [
      'missing_file',
      'is missing or empty',
      (home: string) => {
        writeFileSync(join(home, catalog), '');
      },
    ],
    [
      'malformed_record',
      'Line 2 of sessions catalog',
      (home: string) => {
        writeFileSync(
          join(home, catalog),
          `${one}\n{"session": "lost"}\n${two}\n${three}\n`,
        );
      },
    ],
  ] as const;

  for (const [code, said, damage] of damages) {
    const home = createHome();

    cpSync(stopped, home, {recursive: true});
    damage(home);

    const catalogOf = () =>
      existsSync(join(home, catalog))
        ? readFileSync(join(home, catalog), 'utf8')
        : undefined;
    const left = catalogOf();
    const daemon = await startDaemon(home, fixedReplies);
    const wire = wireOf(daemon);
    const failed = {
      status: 'failed',
      code,
      message: expect.stringContaining(said) as string,
    };

    await wire.start('mira');
    await expect(wire.open('mira'), said).resolves.toMatchObject(failed);
    await expect(wire.history(conversationId), said).resolves.toMatchObject(
      failed,
    );
    await expect(
      lineOn(wire, conversationId, 'Three.', `three-${code}`),
      said,
    ).resolves.toMatchObject({
      status: 'failed',
      committed: false,
      message: expect.stringContaining(said) as string,
    });
    daemon.signal('SIGINT');
    await daemon.exit();
    expect(catalogOf(), said).toBe(left);
  }
});

it('storage.damaged-segment-tolerance: a damaged line in an older segment lets the character start and chat while the history page reaching it fails malformed_record, and without the taken-lines record a damaged line in the segment before the current one fails the open', async () => {
  const {home, conversationId, segment} = await threeSegments();
  const takenLines = join(
    home,
    'character-data',
    'mira',
    'taken-lines',
    `${conversationId}.json`,
  );
  const log = (n: number) => join(segment(n), 'raw-events.jsonl');
  const [first, second] = [
    readFileSync(log(1), 'utf8'),
    readFileSync(log(2), 'utf8'),
  ];

  rmSync(takenLines);
  writeFileSync(log(1), first + damagedRecord);

  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);

  expect(await wire.start('mira')).toMatchObject({character: {state: 'ready'}});
  await expect(wire.open('mira')).resolves.toMatchObject({status: 'opened'});
  await expect(
    lineOn(wire, conversationId, 'Three.', 'three'),
  ).resolves.toMatchObject({status: 'completed'});
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    status: 'failed',
    code: 'malformed_record',
  });
  daemon.signal('SIGINT');
  await daemon.exit();
  writeFileSync(log(1), first);
  writeFileSync(log(2), second + damagedRecord);

  const damaged = wireOf(await startDaemon(home, fixedReplies));

  await damaged.start('mira');
  await expect(damaged.open('mira')).resolves.toMatchObject({
    status: 'failed',
    code: 'malformed_record',
  });
});

it("storage.plugin-store-damage: a plugin's damaged state fails it closed, never read as empty or folded around: a line of character-state's log that is no patch it wrote, met as the log is folded once its checkpoint is gone, an event whose states disagree with its patch, or a checkpoint value out of range rejects the turn before the model is asked and writes nothing, and a memory document that is no document leaves the curated memory out of the prompt while memory.update is refused and the document stays as it was", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const plugins = join(home, 'character-data', 'mira', 'plugin-data');
  const state = join(plugins, 'character-state');
  const events = join(state, 'events.jsonl');
  const checkpoint = join(state, 'checkpoint.json');
  const memory = join(plugins, 'character-memory', 'memory.json');
  const run = async (line: string, id: string) => {
    const daemon = await startDaemon(home);
    const say = await converse(wireOf(daemon), 'mira');
    const outcome = await say(line, id);

    daemon.signal('SIGINT');
    await daemon.exit();

    return outcome;
  };

  model.answer(
    calling(['character_state_patch', {mood: 'curious'}]),
    calling(['character_state_patch', {energy: 'high'}]),
    calling([
      'memory_update',
      {operations: [{action: 'add', target: 'notes', text: 'Likes tea.'}]},
    ]),
    reply('Noted.'),
  );
  await run('Remember tea.', 'setup');

  const [first = '', second = ''] = readFileSync(events, 'utf8')
    .trimEnd()
    .split('\n');
  const kept = readFileSync(checkpoint, 'utf8');
  const disagreeing = JSON.parse(first) as {
    readonly after: Record<string, string>;
  };
  const outOfRange = JSON.parse(kept) as {
    readonly current: {readonly current: Record<string, string>};
  };
  const damages = [
    [
      'a line that is no patch',
      `${first}\n{"note": "hand-written"}\n${second}\n`,
      undefined,
    ],
    [
      'states that disagree with the patch',
      `${JSON.stringify({...disagreeing, after: {...disagreeing.after, mood: 'tired'}})}\n${second}\n`,
      undefined,
    ],
    [
      'a checkpoint value out of range',
      `${first}\n${second}\n`,
      JSON.stringify({
        ...outOfRange,
        current: {current: {...outOfRange.current.current, mood: 'angry'}},
      }),
    ],
  ] as const;

  for (const [index, [damage, log, damagedCheckpoint]] of damages.entries()) {
    writeFileSync(events, log);
    rmSync(checkpoint, {force: true});

    if (damagedCheckpoint !== undefined) {
      writeFileSync(checkpoint, damagedCheckpoint);
    }

    const asked = model.requests.length;
    const left = snapshot(state);

    expect(
      await run('How are you?', `damaged-${String(index)}`),
      damage,
    ).toMatchObject({
      status: 'rejected',
      reason: 'plugin_before_role_model_call_rejected',
    });
    expect(model.requests, damage).toHaveLength(asked);
    expect(snapshot(state), damage).toEqual(left);
  }

  writeFileSync(events, `${first}\n${second}\n`);
  writeFileSync(checkpoint, kept);
  writeFileSync(memory, '{"notes": [');
  model.answer(
    calling([
      'memory_update',
      {operations: [{action: 'add', target: 'notes', text: 'Likes coffee.'}]},
    ]),
    reply('Hm.'),
  );
  expect(await run('Remember coffee.', 'coffee')).toMatchObject({
    status: 'completed',
  });
  expect(
    messagesOf(model.requests.at(-2)).filter(
      message =>
        message.role === 'system' &&
        message.content?.includes('Likes tea.') === true,
    ),
  ).toEqual([]);
  expect(toolResults(model.requests.at(-1)).at(-1)).toMatchObject({
    status: 'rejected',
    reason: 'handler_failed',
  });
  expect(readFileSync(memory, 'utf8')).toBe('{"notes": [');
});

it('storage.symlink-guards: storage behind a symbolic link is refused, never followed: the character-data, conversations, character data, sessions and taken-lines directories, a segment or conversation directory, the catalog, the overlay and a plugin store, nothing written where the link points', async () => {
  const {home: stopped, conversationId} = await threeSegments();
  const data = join('character-data', 'mira');
  const linked = [
    join('character-data'),
    join('conversations'),
    data,
    join(data, 'sessions'),
    join(data, 'taken-lines'),
    join(data, 'sessions', `${conversationId}.1`),
    join('conversations', conversationId),
    join(data, 'sessions.jsonl'),
    join(data, 'config.json'),
    join(data, 'plugin-data', 'character-state'),
  ];

  for (const path of linked) {
    const home = createHome();
    const elsewhere = createHome();

    cpSync(stopped, home, {recursive: true});
    renameSync(join(home, path), join(elsewhere, 'moved'));
    symlinkSync(join(elsewhere, 'moved'), join(home, path));

    const moved = snapshot(elsewhere);
    const run = serve(['--store', home, '--init'], fixedReplies);

    if (path === 'character-data' || path === 'conversations') {
      expect(await run.exit(), path).toBe(1);
    } else {
      const daemon = {...run, ...(await run.address())};
      const wire = wireOf(daemon);

      await wire.start('mira');
      await expect(
        lineOn(wire, conversationId, 'Through the link?', 'link'),
        path,
      ).resolves.not.toMatchObject({status: 'completed'});
      daemon.signal('SIGINT');
      await daemon.exit();
    }

    expect(snapshot(elsewhere), path).toEqual(moved);
  }
});

it('storage.finder-metadata: Finder metadata in the sessions directory, or alone in a session directory a crash interrupted, breaks neither reading a conversation nor starting a fresh one', async () => {
  const {home, conversationId} = await threeSegments();
  const sessions = join(home, 'character-data', 'mira', 'sessions');

  writeFileSync(join(sessions, '.DS_Store'), 'Finder');

  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);

  await wire.start('mira');
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    status: 'ok',
  });
  await expect(
    lineOn(wire, conversationId, 'Three.', 'three'),
  ).resolves.toMatchObject({status: 'completed'});
  daemon.signal('SIGINT');
  await daemon.exit();

  const fresh = createHome();
  const first = await startDaemon(fresh, fixedReplies);

  await wireOf(first).start('mira');
  first.signal('SIGINT');
  await first.exit();

  const interrupted = join(
    fresh,
    'character-data',
    'mira',
    'sessions',
    'conv_interrupted.1',
  );

  mkdirSync(interrupted, {recursive: true});
  writeFileSync(join(interrupted, '.DS_Store'), 'Finder');

  const say = await converse(
    wireOf(await startDaemon(fresh, fixedReplies)),
    'mira',
  );

  expect(await say('Hello.', 'hello')).toMatchObject({status: 'completed'});
});
