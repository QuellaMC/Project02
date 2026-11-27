import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {
  calling,
  completion,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
  type Answer,
  type ModelRequest,
  type ModelServer,
} from './harness/model-server.ts';
import {converse, wireOf, type Wire} from './harness/wire.ts';

/** How her note ends, naming what she goes, makes and uses with. */
const how =
  'To go, world.go; to make something where you are, world.make; to use something that is here, world.use.';

/** Where else her note says she can go from the flat of Mira's world. */
const fromTheFlat =
  'From here you can go to The Studio ("studio") or The Bakery ("bakery"), or somewhere else.';

/** What is in the flat of Mira's world before anyone changes it, as her note says it. */
const inTheFlat = 'Kitchen table; Tin of pencils; Teapot; Bed; Bike';

/** A world as a client reads it, as far as these tests look into it. */
type Seen = {
  readonly name: Words;
  readonly places: readonly {
    readonly id: string;
    readonly name: Words;
    readonly things: readonly {
      readonly id: string;
      readonly name: Words;
      readonly seen: readonly string[];
    }[];
  }[];
  readonly journal: readonly unknown[];
};

/** A name or a note of a world as a client reads it: as the world has it, and the person's form beside it. */
type Words = {
  readonly text: string;
  readonly written?: string;
  readonly translation?: string;
};

/** The world a character lives in, Mira unless another is named, as a client reads it. */
async function worldOf(wire: Wire, characterId = 'mira'): Promise<Seen> {
  return (await wire.world(characterId)) as Seen;
}

/** What a place of a world holds, as a client reads it. */
function thingsIn(
  world: Seen,
  place: string,
): Seen['places'][number]['things'] {
  return world.places.find(held => held.id === place)?.things ?? [];
}

/** A fresh home where Mira answers through `model`. */
function miraHome(model: ModelServer): string {
  return createHome({
    'config.json': configJson({project02: model.settings}),
  });
}

/** The world Juno's package brings: a kitchen with a kettle in it, and a garden. */
const yard = {
  id: 'the-yard',
  name: 'The Yard',
  places: [
    {id: 'kitchen', name: 'The Kitchen', things: [{name: 'Kettle'}]},
    {
      id: 'garden',
      name: 'The Garden',
      icon: 'leaf',
      tint: 'mint',
      things: [
        {name: 'Bench', icon: 'bench', tint: 'brown'},
        {name: 'Apple tree'},
      ],
    },
  ],
};

async function stop(daemon: Daemon): Promise<void> {
  daemon.signal('SIGINT');
  await daemon.exit();
}

/** A home where its characters answer through `model`, Juno among them, whose package brings the yard, and Zeta, whose package brings no world. */
function yardHome(model: ModelServer): string {
  return createHome({
    'config.json': configJson({project02: model.settings}),
    characters: {
      juno: {
        'project02.character.json': characterJson('juno', 'Juno', {
          world: yard,
        }),
      },
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
    },
  });
}

/** The lines of the system messages the model was shown. */
function systemLines(request: ModelRequest | undefined): readonly string[] {
  return messagesOf(request)
    .filter(message => message.role === 'system')
    .flatMap(message => String(message.content).split('\n'));
}

/** The note on where she is that a request showed her, none when it showed none. */
function whereShe(request: ModelRequest | undefined): string | undefined {
  return systemLines(request).find(line => line.startsWith('- You are in '));
}

function toolNames(request: ModelRequest | undefined): readonly string[] {
  return (
    request?.body as {
      readonly tools: readonly {readonly function: {readonly name: string}}[];
    }
  ).tools.map(tool => tool.function.name);
}

/** A document of the world `world` keeps in the home. */
function worldFile(home: string, world: string, path: string): unknown {
  return JSON.parse(
    readFileSync(join(home, 'world-data', world, path), 'utf8'),
  ) as unknown;
}

/** What the journal of the world `world` says happened, in order. */
function journal(home: string, world: string): unknown[] {
  return readFileSync(join(home, 'world-data', world, 'journal.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as unknown);
}

it('world.told: in a fresh home, Mira is told from her first turn where she is in the world her package brings, what is there and where else she can go, and the home keeps that world, apart from her data', async () => {
  const model = await startModelServer();
  const home = miraHome(model);
  const say = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(reply('hi.'));
  await say('Hello?', 'hello');

  expect(whereShe(model.requests[0])).toBe(
    `- You are in The Flat. Here: ${inTheFlat}. ${fromTheFlat} ${how}`,
  );
  expect(worldFile(home, 'the-port', 'world.json')).toMatchObject({
    name: 'The Port',
    places: [
      {id: 'flat', name: 'The Flat', icon: 'bed', tint: 'indigo'},
      {id: 'studio', name: 'The Studio', icon: 'printer', tint: 'graphite'},
      {id: 'bakery', name: 'The Bakery', icon: 'bread', tint: 'orange'},
    ],
    characters: {mira: {place: 'flat', since: expect.any(String) as string}},
  });
  expect(worldFile(home, 'the-port', 'places/studio.json')).toMatchObject({
    things: [
      {name: 'Printing machines', icon: 'printer', from: 'world'},
      {name: 'Proofs', icon: 'doc', tint: 'gray', from: 'world'},
    ],
  });
  expect(
    existsSync(join(home, 'character-data', 'mira', 'plugin-data', 'world')),
  ).toBe(false);
});

it("world.go: she goes to a place of her world's by its name in any case, and to somewhere new, which her world then holds; each answer says where she is and what is there, and her next turn's note says she is there", async () => {
  const model = await startModelServer();
  const home = yardHome(model);
  const say = await converse(wireOf(await startDaemon(home)), 'juno');
  const went = (place: object, here: readonly object[]) => ({
    status: 'accepted',
    pluginId: 'world',
    toolName: 'world.go',
    output: {place, here},
  });

  model.answer(
    calling(['world_go', {place: 'the garden'}]),
    calling(['world_go', {place: 'The Shed'}]),
    reply('Out in the shed.'),
    reply('Still here.'),
  );
  await say('Where are you?', 'where');
  await say('And now?', 'now');

  expect(toolResults(model.requests[2])).toEqual([
    went({id: 'garden', name: 'The Garden'}, [
      {name: 'Bench'},
      {name: 'Apple tree'},
    ]),
    went({id: 'the-shed', name: 'The Shed'}, []),
  ]);
  expect(whereShe(model.requests[3])).toBe(
    `- You are in The Shed. From here you can go to The Kitchen ("kitchen") or The Garden ("garden"), or somewhere else. ${how}`,
  );
  expect(worldFile(home, 'the-yard', 'world.json')).toMatchObject({
    places: [
      {id: 'kitchen'},
      {id: 'garden', icon: 'leaf', tint: 'mint'},
      {id: 'the-shed', name: 'The Shed', icon: 'grid', tint: 'gray'},
    ],
    characters: {juno: {place: 'the-shed'}},
  });
  expect(journal(home, 'the-yard')).toEqual([
    {
      when: expect.any(String) as string,
      who: {character: 'juno'},
      what: 'went',
      place: {id: 'garden', name: 'The Garden'},
    },
    {
      when: expect.any(String) as string,
      who: {character: 'juno'},
      what: 'went',
      place: {id: 'the-shed', name: 'The Shed'},
    },
  ]);
});

it('world.make-and-use: she makes a thing of a kind where she is, which stays there, and uses it by its name in any case; what is not there she cannot use, and she reads a sentence saying what is', async () => {
  const model = await startModelServer();
  const home = yardHome(model);
  const say = await converse(wireOf(await startDaemon(home)), 'juno');

  model.answer(
    calling(['world_make', {name: 'Pancakes', kind: 'food'}]),
    calling(
      ['world_use', {thing: 'pancakes'}],
      ['world_use', {thing: 'Spoon'}],
    ),
    reply('Breakfast.'),
  );
  await say('Hungry?', 'hungry');

  const [made, used, refused] = toolResults(model.requests[2]);

  expect([made, used, refused]).toEqual([
    {
      status: 'accepted',
      pluginId: 'world',
      toolName: 'world.make',
      output: {
        made: {name: 'Pancakes', kind: 'food'},
        place: {id: 'kitchen', name: 'The Kitchen'},
      },
    },
    {
      status: 'accepted',
      pluginId: 'world',
      toolName: 'world.use',
      output: {used: {name: 'Pancakes'}},
    },
    {
      status: 'rejected',
      pluginId: 'world',
      toolName: 'world.use',
      reason: 'thing_not_found',
      message: 'There is no "Spoon" here. Here: Kettle; Pancakes.',
    },
  ]);
  expect(worldFile(home, 'the-yard', 'places/kitchen.json')).toEqual({
    things: [
      {
        id: expect.any(String) as string,
        name: 'Kettle',
        icon: 'grid',
        tint: 'gray',
        from: 'world',
        came: expect.any(String) as string,
      },
      {
        id: expect.any(String) as string,
        name: 'Pancakes',
        icon: 'fork',
        tint: 'orange',
        from: {character: 'juno'},
        came: expect.any(String) as string,
      },
    ],
  });
  expect(journal(home, 'the-yard')).toMatchObject([
    {what: 'made', place: {id: 'kitchen'}, thing: {name: 'Pancakes'}},
    {what: 'used', place: {id: 'kitchen'}, thing: {name: 'Pancakes'}},
  ]);
});

it('world.restart: her world is as she left it after the daemon restarts: where she went, and what she made there', async () => {
  const model = await startModelServer();
  const home = yardHome(model);
  const first = await startDaemon(home);
  const sayFirst = await converse(wireOf(first), 'juno');

  model.answer(
    calling(['world_go', {place: 'The Shed'}]),
    calling(['world_make', {name: 'Birdhouse'}]),
    reply('Made you something.'),
  );
  await sayFirst('What are you doing?', 'doing');
  await stop(first);

  const say = await converse(wireOf(await startDaemon(home)), 'juno');

  model.answer(reply('Still in the shed.'));
  await say('Where are you now?', 'after');

  expect(whereShe(model.requests.at(-1))).toBe(
    `- You are in The Shed. Here: Birdhouse. From here you can go to The Kitchen ("kitchen") or The Garden ("garden"), or somewhere else. ${how}`,
  );
});

it('world.none: a character whose package brings no world is told nothing of one and offered none of its tools', async () => {
  const model = await startModelServer();
  const home = yardHome(model);
  const say = await converse(wireOf(await startDaemon(home)), 'zeta');

  model.answer(reply('Hello.'));
  await say('Hello?', 'hello');

  const offered = toolNames(model.requests[0]);

  expect(whereShe(model.requests[0])).toBeUndefined();
  expect(offered).toContain('send_message');

  for (const tool of ['world_go', 'world_make', 'world_use']) {
    expect(offered).not.toContain(tool);
  }
});

it("world.view: in a fresh home a client reads Mira's world as it stands: its places in their order, each with the things her package brings in theirs, from the world itself and seen by nobody, Mira at its first place, an empty journal, and the kinds a thing can be left as; with no translator between her and the person, each name is as her package wrote it and no model is asked", async () => {
  const model = await startModelServer();
  const wire = wireOf(await startDaemon(miraHome(model)));
  const fromTheWorld = (name: string, icon: string, tint: string) => ({
    id: expect.any(String) as string,
    name: {text: name},
    icon,
    tint,
    from: {kind: 'world'},
    came: expect.any(String) as string,
    seen: [],
  });

  expect(await wire.world('mira')).toEqual({
    status: 'ok',
    id: 'the-port',
    name: {text: 'The Port'},
    places: [
      {
        id: 'flat',
        name: {text: 'The Flat'},
        icon: 'bed',
        tint: 'indigo',
        things: [
          fromTheWorld('Kitchen table', 'table', 'brown'),
          fromTheWorld('Tin of pencils', 'pencil', 'orange'),
          fromTheWorld('Teapot', 'cup', 'brown'),
          fromTheWorld('Bed', 'bed', 'indigo'),
          fromTheWorld('Bike', 'bike', 'teal'),
        ],
      },
      {
        id: 'studio',
        name: {text: 'The Studio'},
        icon: 'printer',
        tint: 'graphite',
        things: [
          fromTheWorld('Printing machines', 'printer', 'graphite'),
          fromTheWorld('Proofs', 'doc', 'gray'),
        ],
      },
      {
        id: 'bakery',
        name: {text: 'The Bakery'},
        icon: 'bread',
        tint: 'orange',
        things: [
          fromTheWorld('Counter', 'bag', 'brown'),
          fromTheWorld("Yesterday's bread", 'bread', 'orange'),
        ],
      },
    ],
    characters: [
      {
        id: 'mira',
        displayName: 'Mira',
        place: 'flat',
        since: expect.any(String) as string,
      },
    ],
    journal: [],
    kinds: [
      {id: 'gift', name: 'Gift', icon: 'gift', tint: 'pink'},
      {id: 'food', name: 'Food', icon: 'fork', tint: 'orange'},
      {id: 'drink', name: 'Drink', icon: 'cup', tint: 'brown'},
      {id: 'flower', name: 'Flower', icon: 'flower', tint: 'mint'},
      {id: 'book', name: 'Book', icon: 'book', tint: 'indigo'},
      {id: 'clothing', name: 'Clothing', icon: 'shirt', tint: 'blue'},
      {id: 'letter', name: 'Letter', icon: 'envelope', tint: 'teal'},
      {id: 'other', name: 'Other', icon: 'grid', tint: 'gray'},
    ],
  });
  expect(model.requests).toEqual([]);
});

it('world.left: the person leaves Mira a thing with a note, which is in the view from the person and seen by nobody, and nothing tells her: no moment of hers begins and nothing is sent to her; her next turn in the flat her note says it once, as not there before, with the note, and the view then says she has seen it; the turn after, her note says it by its name alone', async () => {
  const model = await startModelServer();
  const wire = wireOf(await startDaemon(miraHome(model)));
  const say = await converse(wire, 'mira');
  const honey = {
    id: expect.any(String) as string,
    name: {text: 'A jar of honey'},
    icon: 'fork',
    tint: 'orange',
    from: {kind: 'person'},
    came: expect.any(String) as string,
    note: {text: 'For your toast.'},
  };
  const left = await wire.leaveThing('mira', {
    name: 'A jar of honey',
    kind: 'food',
    place: 'flat',
    note: 'For your toast.',
  });
  const unseen = await worldOf(wire);

  expect(left).toEqual({status: 'ok', thing: {...honey, seen: []}});
  expect(thingsIn(unseen, 'flat').at(-1)).toEqual({...honey, seen: []});
  expect(unseen.journal).toEqual([
    {
      when: expect.any(String) as string,
      who: {kind: 'person'},
      what: 'left',
      place: {id: 'flat', name: {text: 'The Flat'}},
      thing: {
        id: thingsIn(unseen, 'flat').at(-1)?.id,
        name: {text: 'A jar of honey'},
      },
    },
  ]);

  model.answer(reply('Honey!'), reply('Not yet.'));
  await say('Look on the table.', 'look');

  expect(model.requests).toHaveLength(1);
  expect(whereShe(model.requests[0])).toBe(
    `- You are in The Flat. Here: ${inTheFlat}; A jar of honey, which was not here before, with a note: "For your toast.". ${fromTheFlat} ${how}`,
  );
  expect(thingsIn(await worldOf(wire), 'flat').at(-1)).toEqual({
    ...honey,
    seen: ['mira'],
  });

  await say('Did you try it?', 'try');

  expect(whereShe(model.requests[1])).toBe(
    `- You are in The Flat. Here: ${inTheFlat}; A jar of honey. ${fromTheFlat} ${how}`,
  );
});

it('world.found: a thing the person left where she is not is nothing her note says; going there, the answer of her going says it is new and gives its note, which using it gives again, and the view says she has seen it', async () => {
  const model = await startModelServer();
  const wire = wireOf(await startDaemon(miraHome(model)));
  const say = await converse(wire, 'mira');

  await wire.leaveThing('mira', {
    name: 'Tulips',
    kind: 'flower',
    place: 'studio',
    note: 'For the window.',
  });
  model.answer(
    calling(['world_go', {place: 'studio'}]),
    calling(['world_use', {thing: 'tulips'}]),
    reply('Tulips!'),
  );
  await say('Off to work?', 'work');

  expect(whereShe(model.requests[0])).toBe(
    `- You are in The Flat. Here: ${inTheFlat}. ${fromTheFlat} ${how}`,
  );
  expect(toolResults(model.requests[2])).toEqual([
    {
      status: 'accepted',
      pluginId: 'world',
      toolName: 'world.go',
      output: {
        place: {id: 'studio', name: 'The Studio'},
        here: [
          {name: 'Printing machines'},
          {name: 'Proofs'},
          {name: 'Tulips', new: true, note: 'For the window.'},
        ],
      },
    },
    {
      status: 'accepted',
      pluginId: 'world',
      toolName: 'world.use',
      output: {used: {name: 'Tulips', note: 'For the window.'}},
    },
  ]);
  expect(thingsIn(await worldOf(wire), 'studio').at(-1)?.seen).toEqual([
    'mira',
  ]);
});

it("world.removed: the person removes a thing of the world's own by its id: it is gone from the view and from what she is told, and the journal says the person removed it", async () => {
  const model = await startModelServer();
  const wire = wireOf(await startDaemon(miraHome(model)));
  const say = await converse(wire, 'mira');
  const teapot = thingsIn(await worldOf(wire), 'flat').find(
    thing => thing.name.text === 'Teapot',
  );

  expect(await wire.removeThing('mira', teapot?.id ?? '')).toEqual({
    status: 'ok',
  });

  const after = await worldOf(wire);

  expect(thingsIn(after, 'flat').map(thing => thing.name.text)).toEqual([
    'Kitchen table',
    'Tin of pencils',
    'Bed',
    'Bike',
  ]);
  expect(after.journal).toEqual([
    {
      when: expect.any(String) as string,
      who: {kind: 'person'},
      what: 'removed',
      place: {id: 'flat', name: {text: 'The Flat'}},
      thing: {id: teapot?.id, name: {text: 'Teapot'}},
    },
  ]);

  model.answer(reply('Where did the teapot go?'));
  await say('Tea?', 'tea');

  expect(whereShe(model.requests[0])).toBe(
    `- You are in The Flat. Here: Kitchen table; Tin of pencils; Bed; Bike. ${fromTheFlat} ${how}`,
  );
});

it("world.changed: the stream says the world is to be read again, naming it, after each call of hers to its tools that came back accepted and each change of the person's, and after none that was refused", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(miraHome(model));
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);
  const say = await converse(wire, 'mira');
  const changed = frameOf('world_changed', {world: 'the-port'});

  expect(
    await wire.leaveThing('mira', {name: 'Jam', kind: 'jar', place: 'flat'}),
  ).toEqual({
    status: 'refused',
    reason: 'unknown_kind',
    message: 'There is no kind of thing "jar".',
  });

  model.answer(
    calling(['world_go', {place: 'bakery'}], ['world_use', {thing: 'Spoon'}]),
    calling(['world_make', {name: 'Toast', kind: 'food'}]),
    reply('Breakfast.'),
  );
  await say('Hungry?', 'hungry');

  const ended = await events.next(
    frameOf('turn_completed', {clientMessageId: 'hungry'}),
  );

  expect(
    events.frames.slice(0, events.frames.indexOf(ended)).filter(changed),
  ).toHaveLength(2);

  const jam = (await wire.leaveThing('mira', {
    name: 'Jam',
    kind: 'food',
    place: 'bakery',
  })) as {readonly thing: {readonly id: string}};

  await events.next(changed);
  expect(await wire.removeThing('mira', jam.thing.id)).toEqual({status: 'ok'});
  await events.next(changed);
});

it('world.refused: what is not done in a world is refused in a sentence: a character the daemon does not know, one whose package brings no world, a place or a thing the world does not hold, and a name that is not one line', async () => {
  const wire = wireOf(
    await startDaemon(
      createHome({
        characters: {
          juno: {
            'project02.character.json': characterJson('juno', 'Juno', {
              world: yard,
            }),
          },
          zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
        },
      }),
    ),
  );
  const kite = {name: 'Kite', kind: 'gift', place: 'garden'};
  const noWorld = {
    status: 'refused',
    reason: 'no_world',
    message: 'Zeta has no world.',
  };

  expect(await wire.world('nova')).toEqual({
    status: 'refused',
    reason: 'unknown_character',
    message:
      'Character "nova" was not found; the characters are juno, mira, zeta.',
  });
  expect(await wire.world('zeta')).toEqual(noWorld);
  expect(await wire.leaveThing('zeta', kite)).toEqual(noWorld);
  expect(await wire.removeThing('zeta', 'kite')).toEqual(noWorld);
  expect(await wire.leaveThing('juno', {...kite, place: 'attic'})).toEqual({
    status: 'refused',
    reason: 'unknown_place',
    message: 'There is no place "attic" in The Yard.',
  });
  expect(
    await wire.leaveThing('juno', {...kite, name: 'A kite\nand string'}),
  ).toEqual({
    status: 'refused',
    reason: 'invalid_name',
    message: 'A name is one line of 1 to 128 characters.',
  });
  expect(await wire.removeThing('juno', 'kite')).toEqual({
    status: 'refused',
    reason: 'unknown_thing',
    message: 'There is no thing "kite" in The Yard.',
  });
});

/** The world Kana's package brings, in her language: a room with a bed and tofu in it, and a café. */
const minato = {
  id: 'minato',
  name: '港町',
  places: [
    {
      id: 'heya',
      name: '部屋',
      icon: 'bed',
      tint: 'indigo',
      things: [{name: 'ベッド', icon: 'bed', tint: 'indigo'}, {name: 'Tofu'}],
    },
    {id: 'kissa', name: '喫茶店', icon: 'cup', tint: 'brown'},
  ],
};

/** The names of Kana's world in English, in the order a request lists the Japanese: the world's, then each place's and its things'. */
const inEnglish = completion(
  JSON.stringify(['The Harbour Town', 'The Room', 'Bed', 'Tofu', 'The Café']),
);

/** What the person leaves Kana, as they wrote it. */
const honey = {
  name: 'A jar of honey',
  kind: 'food',
  place: 'heya',
  note: 'For your toast.',
};

/** A request the translator's service refuses. */
const refused: Answer = {
  status: 400,
  body: {error: {message: 'No translations today.'}},
};

/** A home where Kana, whose package says she speaks Japanese, brings Minato and notes how one word of hers is put, answers through `model`, the person going by Sam and choosing no language of theirs. */
function kanaHome(model: ModelServer): string {
  return createHome({
    'config.json': configJson({
      project02: {...model.settings, userDisplayName: 'Sam'},
    }),
    characters: {
      kana: {
        'project02.character.json': characterJson('kana', 'Kana', {
          identity: {id: 'kana', displayName: 'Kana', language: 'ja'},
          translation: {words: [{hers: '喫茶店', shown: 'Café'}]},
          world: minato,
        }),
      },
    },
  });
}

/** What Kana's translator is told when it puts words of her world into another language as `into` says, with `notes` on how some of her words are put. */
function wordsInstructions(into: string, notes: string): string {
  return [
    "You translate words of the world Kana lives in: names of places and of the things in them, and notes left with things. Sam and Kana write in different languages, and each reads the other's words through you. Neither of them sees you.",
    into,
    "Translate each of them whole and nothing else: add nothing, leave nothing out, explain nothing. Keep a note's line breaks, its emoji and its tone.",
    notes,
    'They come as a JSON array of strings. Answer with a JSON array of strings alone, the translation of each in the same order. If one is already in that language, give it back unchanged.',
  ].join('\n\n');
}

/** What the translator reads: the words, as a JSON array a line each. */
function wordsInput(words: readonly string[]): string {
  return `The words to translate:\n\n${JSON.stringify(words, null, 2)}`;
}

/** Whether a request was one of hers, which offers her tools, and not her translator's. */
function isHers(request: ModelRequest): boolean {
  return (request.body as {readonly tools?: unknown}).tools !== undefined;
}

it("world.translated-names: for a character who speaks another language than the person, a read gives each name her package wrote with the person's words for it, made in one request of her translator that lists them, each once, and kept with her world; a name that is the same in both has her words alone, and the next read asks nothing", async () => {
  const model = await startModelServer();
  const home = kanaHome(model);
  const wire = wireOf(await startDaemon(home));

  model.answer(inEnglish);

  const first = await worldOf(wire, 'kana');
  const second = await worldOf(wire, 'kana');

  expect(model.requests).toHaveLength(1);
  expect(messagesOf(model.requests[0])).toEqual([
    {
      role: 'system',
      content: wordsInstructions(
        'Put each of them into English.',
        'How some of her words are to be put. On the left what she writes, on the right how Sam is to read it, or what it means:\n- 喫茶店 → Café',
      ),
    },
    {
      role: 'user',
      content: wordsInput(['港町', '部屋', 'ベッド', 'Tofu', '喫茶店']),
    },
  ]);
  expect(first).toMatchObject({
    name: {text: '港町', translation: 'The Harbour Town'},
    places: [
      {
        id: 'heya',
        name: {text: '部屋', translation: 'The Room'},
        things: [
          {name: {text: 'ベッド', translation: 'Bed'}},
          {name: {text: 'Tofu'}},
        ],
      },
      {id: 'kissa', name: {text: '喫茶店', translation: 'The Café'}},
    ],
  });
  expect(thingsIn(first, 'heya')[1]?.name).toEqual({text: 'Tofu'});
  expect(second).toEqual(first);
  expect(worldFile(home, 'minato', 'world.json')).toMatchObject({
    translation: 'The Harbour Town',
    places: [{translation: 'The Room'}, {translation: 'The Café'}],
  });
});

it("world.translated-unread: a read whose names cannot be put into the person's language answers her world as her package wrote it, her maintenance note says why, and the next read asks again", async () => {
  const model = await startModelServer();
  const daemon = await startDaemon(kanaHome(model));
  const wire = wireOf(daemon);
  const events = await openEvents(daemon);

  model.answer(refused);

  const unread = await worldOf(wire, 'kana');

  expect(unread.name).toEqual({text: '港町'});
  expect(unread.places.map(place => place.name)).toEqual([
    {text: '部屋'},
    {text: '喫茶店'},
  ]);
  await events.next(
    frameOf('maintenance_failed', {
      characterId: 'kana',
      message:
        "Names in Kana's world were not translated: NVIDIA provider error: No translations today.",
    }),
  );

  model.answer(inEnglish);
  expect((await worldOf(wire, 'kana')).name).toEqual({
    text: '港町',
    translation: 'The Harbour Town',
  });
  expect(model.requests).toHaveLength(2);
});

it("world.translated-left: what the person leaves her is put into her language in one request of her translator before it is left, and her world keeps what they wrote beside it, which the view gives as both forms, as do the lines of the journal about it, even once it is removed; she is told of it in her words alone, and nothing she is sent names a translator or holds the person's words", async () => {
  const model = await startModelServer();
  const wire = wireOf(await startDaemon(kanaHome(model)));
  const say = await converse(wire, 'kana');
  const both = {
    name: {text: 'ハチミツの瓶', written: 'A jar of honey'},
    note: {text: 'トーストにどうぞ。', written: 'For your toast.'},
  };

  model.answer(
    completion(JSON.stringify(['ハチミツの瓶', 'トーストにどうぞ。'])),
  );
  expect(await wire.leaveThing('kana', honey)).toEqual({
    status: 'ok',
    thing: {
      id: expect.any(String) as string,
      ...both,
      icon: 'fork',
      tint: 'orange',
      from: {kind: 'person'},
      came: expect.any(String) as string,
      seen: [],
    },
  });
  expect(messagesOf(model.requests[0])).toEqual([
    {
      role: 'system',
      content: wordsInstructions(
        'Put each of them into Kana\'s language, the one with the language tag "ja".',
        'Words Kana uses, and how each is put for Sam. Where what Sam wrote means one of them, write her word:\n- 喫茶店 → Café',
      ),
    },
    {role: 'user', content: wordsInput(['A jar of honey', 'For your toast.'])},
  ]);

  model.answer(
    completion('テーブルを見て。'),
    reply('ありがとう。'),
    completion('Thank you.'),
  );
  await say('Look on the table.', 'look');

  const hers = model.requests.filter(isHers);

  expect(hers).toHaveLength(1);
  expect(whereShe(hers[0])).toBe(
    `- You are in 部屋. Here: ベッド; Tofu; ハチミツの瓶, which was not here before, with a note: "トーストにどうぞ。". From here you can go to 喫茶店 ("kissa"), or somewhere else. ${how}`,
  );

  for (const request of hers) {
    expect(request.text).not.toMatch(/translat/iu);

    for (const written of [
      'Look on the table.',
      'A jar of honey',
      'For your toast.',
    ]) {
      expect(request.text).not.toContain(written);
    }
  }

  model.answer(inEnglish);

  const seen = await worldOf(wire, 'kana');

  expect(thingsIn(seen, 'heya').at(-1)).toMatchObject({
    ...both,
    seen: ['kana'],
  });

  const left = thingsIn(seen, 'heya').at(-1)?.id ?? '';
  const line = (what: string) => ({
    when: expect.any(String) as string,
    who: {kind: 'person'},
    what,
    place: {id: 'heya', name: {text: '部屋', translation: 'The Room'}},
    thing: {id: left, name: both.name},
  });

  expect(seen.journal).toEqual([line('left')]);
  expect(await wire.removeThing('kana', left)).toEqual({status: 'ok'});
  expect((await worldOf(wire, 'kana')).journal).toEqual([
    line('removed'),
    line('left'),
  ]);
  expect(model.requests.filter(request => !isHers(request))).toHaveLength(4);
});

it('world.not-translated: what the person leaves that cannot be put into her language is not left, and the person is told why in a sentence', async () => {
  const model = await startModelServer();
  const wire = wireOf(await startDaemon(kanaHome(model)));

  model.answer(refused);
  expect(await wire.leaveThing('kana', honey)).toEqual({
    status: 'refused',
    reason: 'not_translated',
    message:
      'It was not left, because it could not be put into her language: NVIDIA provider error: No translations today.',
  });

  model.answer(inEnglish);

  const world = await worldOf(wire, 'kana');

  expect(thingsIn(world, 'heya').map(thing => thing.name.text)).toEqual([
    'ベッド',
    'Tofu',
  ]);
  expect(world.journal).toEqual([]);
});
