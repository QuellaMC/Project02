import {createHash, randomUUID} from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {basename, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

import {expect, it, onTestFinished} from 'vitest';

import {serve, startDaemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {
  characterJson,
  chmod,
  configJson,
  createHome,
  sessionLog,
  snapshot,
} from './harness/home.ts';
import {
  calling,
  content,
  finish,
  reply,
  startModelServer,
  toolCall,
  toolResults,
  undecided,
  usage,
} from './harness/model-server.ts';
import {conversationOf, converse, saveConfig, wireOf} from './harness/wire.ts';

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};
// A window this small rotates the segment after every turn.
const rotatingEveryTurn = configJson({project02: {contextWindowTokens: 1}});

/** The resources a lock directory's stamps name: each held lock's holder, and after a crash the dead holder's. */
function stampsOf(locks: string): string[] {
  return readdirSync(locks)
    .filter(name => name.endsWith('.owner.json'))
    .map(
      name =>
        (
          JSON.parse(readFileSync(join(locks, name), 'utf8')) as {
            readonly resourceKey: string;
          }
        ).resourceKey,
    )
    .sort();
}

/** A resource's lock file in a lock directory, and the stamp beside it. */
function lockOf(
  locks: string,
  resource: string,
): {readonly file: string; readonly stamp: string} {
  const name = createHash('sha256').update(resource).digest('hex');

  return {
    file: join(locks, `${name}.lock`),
    stamp: join(locks, `${name}.owner.json`),
  };
}

/** A file's text, or the names a directory holds. */
function contentsOf(path: string): string | string[] {
  return statSync(path).isDirectory()
    ? readdirSync(path)
    : readFileSync(path, 'utf8');
}

/**
 * The session ids a character's catalog names, by segment: the catalog
 * orders its rows by when each was made, which the wall clock decides, and
 * a clock that steps back reorders them.
 */
function catalogOf(home: string, characterId: string): string[] {
  return readFileSync(
    join(home, 'character-data', characterId, 'sessions.jsonl'),
    'utf8',
  )
    .trimEnd()
    .split('\n')
    .map(row => (JSON.parse(row) as {readonly sessionId: string}).sessionId)
    .sort((left, right) => left.localeCompare(right, 'en', {numeric: true}));
}

it("storage.layout: a character's history lives under character-data/<id>: the sessions catalog, a directory per segment <conversationId>.N holding its raw events, the taken-lines record and the locks; the conversation lives at conversations/<id>/conversation.json", async () => {
  const home = createHome({'config.json': rotatingEveryTurn});
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const data = join(home, 'character-data', 'mira');
  const segments = [`${conversationId}.1`, `${conversationId}.2`];

  await say('Hello.', 'hello');
  expect(readdirSync(data)).toEqual(
    expect.arrayContaining([
      'sessions.jsonl',
      'sessions',
      'taken-lines',
      '.locks',
    ]),
  );
  expect(catalogOf(home, 'mira')).toEqual(segments);
  expect(readdirSync(join(data, 'sessions')).sort()).toEqual(segments);

  for (const segment of segments) {
    expect(readdirSync(join(data, 'sessions', segment)), segment).toEqual([
      'raw-events.jsonl',
    ]);
  }

  expect(readdirSync(join(data, 'taken-lines'))).toEqual([
    `${conversationId}.json`,
  ]);
  expect(readdirSync(join(home, 'conversations'))).toEqual([conversationId]);
  expect(
    JSON.parse(
      readFileSync(
        join(home, 'conversations', conversationId, 'conversation.json'),
        'utf8',
      ),
    ),
  ).toMatchObject({id: conversationId});
});

it("storage.per-character-isolation: each character's segments and their writers' locks live in her own data directory, a lock file each with its holder's stamp beside it; after a clean stop the lock files stay where they are, no stamp is left, and the home's lock directory holds no session writer's lock", async () => {
  const home = createHome({
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
    },
  });
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);
  const writers: string[] = [];

  for (const characterId of ['mira', 'zeta']) {
    const say = await converse(wire, characterId);
    const {conversationId} = await conversationOf(wire, characterId);
    const data = join(home, 'character-data', characterId);
    const writer = `session-writer:${conversationId}.1`;

    await say('Hello.', characterId);
    expect(readdirSync(join(data, 'sessions')), characterId).toEqual([
      `${conversationId}.1`,
    ]);
    expect(stampsOf(join(data, '.locks')), characterId).toEqual([writer]);
    writers.push(lockOf(join(data, '.locks'), writer).file);
  }

  daemon.signal('SIGINT');
  await daemon.exit();

  for (const characterId of ['mira', 'zeta']) {
    expect(
      stampsOf(join(home, 'character-data', characterId, '.locks')),
      characterId,
    ).toEqual([]);
  }

  expect(writers.filter(file => existsSync(file))).toEqual(writers);
  expect(
    readdirSync(join(home, '.locks')).filter(name =>
      writers.some(file => basename(file) === name),
    ),
  ).toEqual([]);
});

it("storage.conversation-record: a conversation's record names its participants, the character before the person, and the next open finds it again whatever order they were written in", async () => {
  const home = createHome();
  const first = await startDaemon(home, fixedReplies);
  const firstWire = wireOf(first);

  await firstWire.start('mira');

  const {conversationId} = await conversationOf(firstWire, 'mira');
  const record = join(
    home,
    'conversations',
    conversationId,
    'conversation.json',
  );
  const written = JSON.parse(readFileSync(record, 'utf8')) as {
    readonly participants: readonly {
      readonly kind: string;
      readonly id: string;
    }[];
  };

  expect(written.participants.map(({kind, id}) => [kind, id])).toEqual([
    ['character', 'mira'],
    ['user', 'local-user'],
  ]);
  first.signal('SIGINT');
  await first.exit();
  writeFileSync(
    record,
    JSON.stringify({
      ...written,
      participants: [...written.participants].reverse(),
    }),
  );

  const wire = wireOf(await startDaemon(home, fixedReplies));

  await wire.start('mira');
  await expect(wire.open('mira')).resolves.toMatchObject({
    status: 'opened',
    conversationId,
  });
  expect(readdirSync(join(home, 'conversations'))).toEqual([conversationId]);
});

it('storage.session-segments: a conversation is segments .1, .2, ... made in order and only the newest goes on, and its first segment is never made again over the records it holds', async () => {
  const home = createHome({'config.json': rotatingEveryTurn});
  const first = await startDaemon(home, fixedReplies);
  const firstWire = wireOf(first);
  const say = await converse(firstWire, 'mira');
  const {conversationId} = await conversationOf(firstWire, 'mira');
  const segmentLog = (segment: number) =>
    join(
      home,
      'character-data',
      'mira',
      'sessions',
      `${conversationId}.${String(segment)}`,
      'raw-events.jsonl',
    );

  await say('One.', 'one');

  const closed = readFileSync(segmentLog(1), 'utf8');

  expect(await say('Two.', 'two')).toMatchObject({
    messages: [{messageId: `${conversationId}.2:message-1`}, {}],
  });
  expect(readFileSync(segmentLog(1), 'utf8')).toBe(closed);
  expect(catalogOf(home, 'mira')).toEqual(
    [1, 2, 3].map(segment => `${conversationId}.${String(segment)}`),
  );
  first.signal('SIGINT');
  await first.exit();

  const catalog = join(home, 'character-data', 'mira', 'sessions.jsonl');

  rmSync(catalog);

  const wire = wireOf(await startDaemon(home, fixedReplies));

  await wire.start('mira');
  await expect(wire.open('mira')).resolves.toMatchObject({
    status: 'failed',
    code: 'missing_file',
  });
  expect(readFileSync(segmentLog(1), 'utf8')).toBe(closed);
  expect(existsSync(catalog)).toBe(false);
});

it("storage.continuation: once its history outgrows the window the conversation goes on silently in the next segment: the catalog names both, the new one opens with a continuation record, and the old one's writer lease is released", async () => {
  const home = createHome({'config.json': rotatingEveryTurn});
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const events = await openEvents(daemon);

  await say('Hello.', 'hello');
  expect(catalogOf(home, 'mira')).toEqual([
    `${conversationId}.1`,
    `${conversationId}.2`,
  ]);
  expect(sessionLog(home, 'mira', `${conversationId}.2`)).toMatchObject([
    {
      kind: 'session_continued',
      sessionContinuation: {continuedFrom: {sessionId: `${conversationId}.1`}},
    },
  ]);
  expect(stampsOf(join(home, 'character-data', 'mira', '.locks'))).toEqual([
    `session-writer:${conversationId}.2`,
  ]);
  await say('Still there?', 'still');
  await events.next(frameOf('turn_completed', {clientMessageId: 'still'}));
  expect(new Set(events.frames.map(frame => frame.event))).toEqual(
    new Set(['ready', 'turn_progress', 'turn_completed']),
  );
});

it('storage.continuation-writer-failure: a rotation whose new segment cannot be given its writer leaves nothing of that segment behind, neither its row nor its directory, so the thread stays where it was and the next completed turn rotates from there without a restart', async () => {
  const home = createHome({'config.json': rotatingEveryTurn});
  const daemon = await startDaemon(home, fixedReplies);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const locks = join(home, 'character-data', 'mira', '.locks');
  const segments = (...numbers: number[]) =>
    numbers.map(segment => `${conversationId}.${String(segment)}`);
  let failure: string | undefined;

  // The first rotation makes the lock file of every lock the next one
  // takes but its new segment's writer's, which the locks directory,
  // taking no new file, then refuses.
  await say('One.', 'one');

  const events = await openEvents(daemon);

  chmod(locks, 0o555);

  try {
    expect(await say('Two.', 'two')).toMatchObject({status: 'completed'});
    failure = (
      await events.next(frameOf('maintenance_failed', {characterId: 'mira'}))
    ).data;
  } finally {
    chmod(locks, 0o755);
  }

  expect(failure).toContain(
    basename(lockOf(locks, `session-writer:${conversationId}.3`).file),
  );
  expect(catalogOf(home, 'mira')).toEqual(segments(1, 2));
  expect(
    readdirSync(join(home, 'character-data', 'mira', 'sessions')).sort(),
  ).toEqual(segments(1, 2));
  expect(await say('Three.', 'three')).toMatchObject({status: 'completed'});
  expect(catalogOf(home, 'mira')).toEqual(segments(1, 2, 3));
  expect(sessionLog(home, 'mira', `${conversationId}.3`)).toMatchObject([
    {
      kind: 'session_continued',
      sessionContinuation: {continuedFrom: {sessionId: `${conversationId}.2`}},
    },
  ]);
});

it('storage.round-records: each model round is its own role_model_round record of what the model wrote, how its answer ended, the tokens it took and the verdict on it, and never the prompt, named by number by its tool calls and by the terminal record, which carries the commit validation; the same tool in two turns gets two call ids, and a later refusal keeps the accepted call and its evidence', async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const wire = wireOf(await startDaemon(home));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  model.answer(
    calling(['character_state_patch', {mood: 'curious'}]),
    {
      chunks: [
        ...content('Curious now.'),
        finish('stop'),
        usage({prompt_tokens: 1200, completion_tokens: 3}),
      ],
    },
    calling(['character_state_patch', {mood: 'playful'}]),
    ...undecided(99),
  );
  await say('How do you feel?', 'feel');
  await say('And now?', 'now');

  const records = sessionLog(home, 'mira', `${conversationId}.1`);
  const [completed, refused] = [
    ...new Set(records.map(record => record['eventId'])),
  ].map(eventId => records.filter(record => record['eventId'] === eventId));
  const ofKind = (turn: typeof records | undefined, kind: string) =>
    (turn ?? []).filter(record => record['kind'] === kind);
  const [firstCall] = ofKind(completed, 'tool_call_started');
  const [secondCall] = ofKind(refused, 'tool_call_started');
  const turn = {
    eventId: completed?.[0]?.['eventId'],
    traceId: completed?.[0]?.['traceId'],
    createdAt: completed?.[0]?.['createdAt'],
    kind: 'role_model_round',
  };
  const patch = {name: 'character_state.patch', input: {mood: 'curious'}};

  expect(ofKind(completed, 'role_model_round')).toEqual([
    {
      ...turn,
      round: 1,
      output: {toolCalls: [patch]},
      finishReason: 'tool_calls',
      parsedRoleModelDecisionSnapshot: {
        result: {status: 'accepted', decision: {toolCalls: [patch]}},
      },
    },
    {
      ...turn,
      round: 2,
      output: {toolCalls: [], text: 'Curious now.'},
      finishReason: 'stop',
      usage: {promptTokens: 1200, completionTokens: 3},
      parsedRoleModelDecisionSnapshot: {
        result: {
          status: 'accepted',
          decision: {
            toolCalls: [{name: 'visible_reply', input: {text: 'Curious now.'}}],
          },
        },
      },
    },
  ]);
  expect(firstCall).toMatchObject({
    round: 1,
    toolName: 'character_state.patch',
    toolPluginId: 'character-state',
  });
  expect(ofKind(completed, 'tool_call_finished')).toMatchObject([
    {round: 1, toolCallId: firstCall?.['toolCallId']},
  ]);
  expect(ofKind(completed, 'runtime_turn_completed')).toMatchObject([
    {
      round: 2,
      toolCallIds: [firstCall?.['toolCallId']],
      commitValidation: {
        result: {status: 'accepted', acceptedVisibleReplyText: 'Curious now.'},
      },
    },
  ]);
  expect(secondCall?.['toolCallId']).not.toBe(firstCall?.['toolCallId']);
  expect(ofKind(refused, 'runtime_turn_rejected')).toMatchObject([
    {
      reason: 'malformed_output',
      toolCallIds: [secondCall?.['toolCallId']],
      runtimePluginEvidence: expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'character-state',
          evidenceKind: 'tool_invocation',
          status: 'accepted',
        }),
      ]) as unknown[],
    },
  ]);
});

it('storage.taken-lines: after a restart a line from any earlier segment is refused duplicate_submission; without the taken-lines record the open rebuilds what it knew without writing it, and the next rotation writes it again', async () => {
  const home = createHome({'config.json': rotatingEveryTurn});
  const earlier = await startDaemon(home, fixedReplies);
  const earlierWire = wireOf(earlier);
  const sayEarlier = await converse(earlierWire, 'mira');
  const {conversationId} = await conversationOf(earlierWire, 'mira');
  const record = join(
    home,
    'character-data',
    'mira',
    'taken-lines',
    `${conversationId}.json`,
  );

  await sayEarlier('One.', 'one');
  await sayEarlier('Two.', 'two');
  earlier.signal('SIGINT');
  await earlier.exit();
  rmSync(record);

  const wire = wireOf(await startDaemon(home, fixedReplies));
  const say = await converse(wire, 'mira');

  expect(existsSync(record)).toBe(false);

  for (const [text, id] of [
    ['One.', 'one'],
    ['Two.', 'two'],
  ] as const) {
    expect(await say(text, id), id).toMatchObject({
      status: 'refused',
      reason: 'duplicate_submission',
    });
  }

  expect(existsSync(record)).toBe(false);
  await say('Three.', 'three');
  expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({
    segments: {
      1: {one: `${conversationId}.1:message-1`},
      2: {two: `${conversationId}.2:message-1`},
      3: {three: `${conversationId}.3:message-1`},
    },
  });
});

it("storage.schema-marker: the home and each character's data directory carry a version 15 schema.json naming its scope, the character's her id and package version too; one an older build wrote, the TypeScript daemon's 14 among them, is read as it is, and one a newer build wrote, or one malformed or no regular file, is refused and left as it was", async () => {
  const home = createHome();
  const first = await startDaemon(home, fixedReplies);

  await wireOf(first).start('mira');
  first.signal('SIGINT');
  await first.exit();

  const homeMarker = join(home, 'schema.json');
  const miraMarker = join(home, 'character-data', 'mira', 'schema.json');
  const readMarker = (path: string): unknown =>
    JSON.parse(readFileSync(path, 'utf8'));
  const markers = {home: readMarker(homeMarker), mira: readMarker(miraMarker)};

  expect(markers).toEqual({
    home: {
      schemaVersion: 15,
      scope: 'home',
      createdAt: expect.any(String) as string,
    },
    mira: {
      schemaVersion: 15,
      scope: 'character-data',
      characterId: 'mira',
      materializedCharacterPackageVersion: '1.1.0',
      createdAt: expect.any(String) as string,
    },
  });

  // What the refusal says of each damage, and the bytes put in the marker's
  // place: none for a directory.
  const damages = (marker: unknown): [string, string | undefined][] => [
    [
      'written by a newer Project02',
      JSON.stringify({...(marker as object), schemaVersion: 99}),
    ],
    ['not valid JSON', '{"schemaVersion":'],
    ['must be a regular file', undefined],
  ];
  const plant = (path: string, bytes: string | undefined): void => {
    rmSync(path, {recursive: true});

    if (bytes === undefined) {
      mkdirSync(path);
    } else {
      writeFileSync(path, bytes);
    }
  };

  for (const [path, marker] of [
    [miraMarker, markers.mira],
    [homeMarker, markers.home],
  ] as const) {
    const older = JSON.stringify({...(marker as object), schemaVersion: 14});

    plant(path, older);

    const daemon = await startDaemon(home, fixedReplies);

    expect(await wireOf(daemon).start('mira'), path).toMatchObject({
      character: {state: 'ready'},
    });
    daemon.signal('SIGINT');
    await daemon.exit();
    expect(contentsOf(path), path).toBe(older);
    plant(path, JSON.stringify(marker));
  }

  for (const [says, bytes] of damages(markers.mira)) {
    plant(miraMarker, bytes);

    const daemon = await startDaemon(home, fixedReplies);

    expect(await wireOf(daemon).start('mira'), says).toMatchObject({
      character: {
        state: 'failed',
        diagnostic: expect.stringContaining(says) as string,
      },
    });
    daemon.signal('SIGINT');
    await daemon.exit();
    expect(contentsOf(miraMarker), says).toEqual(bytes ?? []);
  }

  plant(miraMarker, JSON.stringify(markers.mira));

  for (const [says, bytes] of damages(markers.home)) {
    plant(homeMarker, bytes);

    const refused = serve(['--store', home], fixedReplies);

    expect(await refused.exit(), says).toBe(1);
    expect(refused.stderr(), says).toContain(says);
    expect(contentsOf(homeMarker), says).toEqual(bytes ?? []);
  }
});

it('storage.data-marker-mismatch: a data directory copied from another character is refused for every read and write, naming the character it holds history for, and its files stay as they were', async () => {
  const home = createHome({
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
    },
  });
  const first = await startDaemon(home, fixedReplies);
  const firstWire = wireOf(first);

  for (const characterId of ['mira', 'zeta']) {
    const say = await converse(firstWire, characterId);

    await say('Hello.', characterId);
  }

  const {conversationId} = await conversationOf(firstWire, 'zeta');

  first.signal('SIGINT');
  await first.exit();

  const zetaData = join(home, 'character-data', 'zeta');

  rmSync(zetaData, {recursive: true});
  cpSync(join(home, 'character-data', 'mira'), zetaData, {recursive: true});

  const copied = snapshot(zetaData);
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const holdsMira = expect.stringContaining(
    'holds history for character "mira"',
  ) as string;

  expect(await wire.start('zeta')).toMatchObject({
    character: {state: 'failed', diagnostic: holdsMira},
  });
  await expect(wire.open('zeta')).resolves.toMatchObject({
    status: 'refused',
    message: holdsMira,
  });
  await expect(wire.history(conversationId)).resolves.toMatchObject({
    status: 'failed',
    message: holdsMira,
  });
  expect(snapshot(zetaData)).toEqual(copied);
});

it("storage.marker-less-history: a character data directory holding history or a foreign file but no marker is never adopted: the character fails, and nothing is written, not even the home's schema.json", async () => {
  for (const [name, bytes] of [
    ['sessions.jsonl', ''],
    ['notes.txt', 'Mine.'],
  ] as const) {
    const home = createHome({
      'character-data': {mira: {[name]: bytes}},
    });
    const daemon = await startDaemon(home, fixedReplies);

    expect(await wireOf(daemon).start('mira'), name).toMatchObject({
      character: {
        state: 'failed',
        diagnostic: expect.stringContaining(
          `holds "${name}" without a data marker`,
        ) as string,
      },
    });
    daemon.signal('SIGINT');
    await daemon.exit();
    expect(readdirSync(join(home, 'character-data', 'mira')), name).toEqual([
      name,
    ]);
    expect(readdirSync(home), name).not.toContain('schema.json');
  }
});

it("storage.no-secrets-in-logs: a credential under a credential-shaped key the model provider sends back, in a call's input or beside the token counts, is redacted in the session log, which never holds its value", async () => {
  const credential = 'provider-echoed-credential';
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const wire = wireOf(await startDaemon(home));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  const input = (secret: string) => ({
    mood: 'curious',
    api_key: secret,
    nested: {access_token: secret, kept: 'as is'},
  });

  model.answer(
    {
      chunks: [
        ...toolCall({
          index: 0,
          id: 'call_patch',
          name: 'character_state_patch',
          arguments: JSON.stringify(input(credential)),
        }),
        finish('tool_calls'),
        {
          choices: [],
          usage: {prompt_tokens: 1, completion_tokens: 1, api_key: credential},
        },
      ],
    },
    reply('Hello.'),
  );
  await say('Hello?', 'hello');

  const records = sessionLog(home, 'mira', `${conversationId}.1`);
  const kept = input('[redacted]');

  expect(JSON.stringify(records)).not.toContain(credential);
  expect(
    records.find(record => record['kind'] === 'role_model_round'),
  ).toMatchObject({
    output: {toolCalls: [{name: 'character_state.patch', input: kept}]},
    usage: {promptTokens: 1, completionTokens: 1},
    parsedRoleModelDecisionSnapshot: {
      result: {decision: {toolCalls: [{input: kept}]}},
    },
  });
});

it("storage.temp-residue-cleanup: the temp file a writer that is gone left beside a file the store replaces whole, the home's config.json or a plugin's state, is removed by the next write there, and unrelated files are kept", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const first = await startDaemon(home);
  const sayFirst = await converse(wireOf(first), 'mira');

  model.answer(
    calling(['character_state_patch', {mood: 'curious'}]),
    reply('Curious.'),
  );
  await sayFirst('How are you?', 'one');
  first.signal('SIGINT');
  await first.exit();

  const state = join(
    home,
    'character-data',
    'mira',
    'plugin-data',
    'character-state',
  );
  const temp = (directory: string, name: string) =>
    join(directory, `${name}.${randomUUID()}.tmp`);
  const abandoned = [
    temp(home, '.config.json'),
    temp(state, '.checkpoint.json'),
  ];
  const kept = [temp(home, '.unrelated'), temp(state, 'notes')];

  for (const path of [...abandoned, ...kept]) {
    writeFileSync(path, 'residue');
  }

  const wire = wireOf(await startDaemon(home));
  const say = await converse(wire, 'mira');

  model.answer(
    calling(['character_state_patch', {mood: 'playful'}]),
    reply('Playful.'),
  );
  await say('And now?', 'two');
  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.userDisplayName', value: 'Sam'},
  );
  expect(abandoned.filter(path => existsSync(path))).toEqual([]);
  expect(kept.filter(path => !existsSync(path))).toEqual([]);
});

it("storage.stale-lock-reclaim: a lease a killed daemon held is the next run's at once, since the kernel let its lock go: the next run takes the session's writer lock and stamps it its own, whatever stamp the dead holder left beside it, a torn one included", async () => {
  const home = createHome();
  const killed = await startDaemon(home, fixedReplies);
  const killedWire = wireOf(killed);
  const sayKilled = await converse(killedWire, 'mira');
  const {conversationId} = await conversationOf(killedWire, 'mira');
  const locks = join(home, 'character-data', 'mira', '.locks');
  const writer = `session-writer:${conversationId}.1`;
  const {stamp} = lockOf(locks, writer);

  await sayKilled('Hello.', 'hello');
  killed.signal('SIGKILL');
  await killed.exit();
  expect(stampsOf(locks)).toEqual([writer]);
  // A stamp is written as a note, never replaced whole: a crash can cut it short.
  writeFileSync(stamp, '{"resourceKey":');

  const next = await startDaemon(home, fixedReplies);
  const say = await converse(wireOf(next), 'mira');

  expect(await say('Still there?', 'still')).toMatchObject({
    status: 'completed',
  });
  expect(JSON.parse(readFileSync(stamp, 'utf8'))).toMatchObject({
    resourceKey: writer,
    pid: next.pid,
  });
});

it('storage.sqlite-views: a SQLite view another program holds locked is reported and kept as it is, and one that is no database is rebuilt', async () => {
  const model = await startModelServer();
  const stopped = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const first = await startDaemon(stopped);

  const say = await converse(wireOf(first), 'mira');

  model.answer(reply('Tea, always.'));
  await say('Tea or coffee?', 'tea');
  first.signal('SIGINT');
  await first.exit();

  /** A copy of the stopped home, its session index the one the test puts there. */
  const withIndex = (bytes: string): {home: string; index: string} => {
    const home = createHome();
    const index = join(
      home,
      'character-data',
      'mira',
      'plugin-data',
      'session-history',
      'session-index.sqlite',
    );

    cpSync(stopped, home, {recursive: true});
    writeFileSync(index, bytes);

    return {home, index};
  };
  const searched = async (home: string): Promise<unknown> => {
    const daemon = await startDaemon(home);
    const say = await converse(wireOf(daemon), 'mira');

    model.answer(calling(['sessions_search', {query: 'tea'}]), reply('Found.'));
    expect(await say('Did we talk about tea?', 'search')).toMatchObject({
      status: 'completed',
    });
    daemon.signal('SIGINT');
    await daemon.exit();

    return toolResults(model.requests.at(-1)).at(-1);
  };
  const locked = withIndex('');
  // Another program's database in its place, which it holds locked.
  const holder = new DatabaseSync(locked.index);

  onTestFinished(() => {
    holder.close();
  });
  holder.exec(
    'CREATE TABLE keepsake (id INTEGER PRIMARY KEY); INSERT INTO keepsake (id) VALUES (7); BEGIN EXCLUSIVE',
  );
  expect(await searched(locked.home)).toMatchObject({
    status: 'rejected',
    reason: 'session_history_read_failed',
  });
  holder.exec('ROLLBACK');

  // Through the path, not the handle: the file there is still the holder's.
  const stillThere = new DatabaseSync(locked.index);

  try {
    expect(stillThere.prepare('SELECT id FROM keepsake').all()).toEqual([
      {id: 7},
    ]);
  } finally {
    stillThere.close();
  }

  const corrupt = withIndex('This is no database.');

  expect(await searched(corrupt.home)).toMatchObject({status: 'accepted'});
  expect(readFileSync(corrupt.index).subarray(0, 16).toString('latin1')).toBe(
    'SQLite format 3\0',
  );
});
