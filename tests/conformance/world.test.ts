import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
import {frameOf, openEvents} from './harness/events.ts';
import {characterJson, configJson, createHome} from './harness/home.ts';
import {
  calling,
  messagesOf,
  reply,
  startModelServer,
  toolResults,
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
  readonly places: readonly {
    readonly id: string;
    readonly things: readonly {
      readonly id: string;
      readonly name: string;
      readonly seen: readonly string[];
    }[];
  }[];
  readonly journal: readonly unknown[];
};

/** Mira's world as a client reads it. */
async function worldOf(wire: Wire): Promise<Seen> {
  return (await wire.world('mira')) as Seen;
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

it("world.view: in a fresh home a client reads Mira's world as it stands: its places in their order, each with the things her package brings in theirs, from the world itself and seen by nobody, Mira at its first place, an empty journal, and the kinds a thing can be left as", async () => {
  const wire = wireOf(await startDaemon(createHome()));
  const fromTheWorld = (name: string, icon: string, tint: string) => ({
    id: expect.any(String) as string,
    name,
    icon,
    tint,
    from: {kind: 'world'},
    came: expect.any(String) as string,
    seen: [],
  });

  expect(await wire.world('mira')).toEqual({
    status: 'ok',
    id: 'the-port',
    name: 'The Port',
    places: [
      {
        id: 'flat',
        name: 'The Flat',
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
        name: 'The Studio',
        icon: 'printer',
        tint: 'graphite',
        things: [
          fromTheWorld('Printing machines', 'printer', 'graphite'),
          fromTheWorld('Proofs', 'doc', 'gray'),
        ],
      },
      {
        id: 'bakery',
        name: 'The Bakery',
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
});

it('world.left: the person leaves Mira a thing with a note, which is in the view from the person and seen by nobody, and nothing tells her: no moment of hers begins and nothing is sent to her; her next turn in the flat her note says it once, as not there before, with the note, and the view then says she has seen it; the turn after, her note says it by its name alone', async () => {
  const model = await startModelServer();
  const wire = wireOf(await startDaemon(miraHome(model)));
  const say = await converse(wire, 'mira');
  const honey = {
    id: expect.any(String) as string,
    name: 'A jar of honey',
    icon: 'fork',
    tint: 'orange',
    from: {kind: 'person'},
    came: expect.any(String) as string,
    note: 'For your toast.',
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
      place: {id: 'flat', name: 'The Flat'},
      thing: {id: thingsIn(unseen, 'flat').at(-1)?.id, name: 'A jar of honey'},
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
    thing => thing.name === 'Teapot',
  );

  expect(await wire.removeThing('mira', teapot?.id ?? '')).toEqual({
    status: 'ok',
  });

  const after = await worldOf(wire);

  expect(thingsIn(after, 'flat').map(thing => thing.name)).toEqual([
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
      place: {id: 'flat', name: 'The Flat'},
      thing: {id: teapot?.id, name: 'Teapot'},
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
