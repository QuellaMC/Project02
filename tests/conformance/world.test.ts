import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {startDaemon, type Daemon} from './harness/daemon.ts';
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
import {converse, wireOf} from './harness/wire.ts';

/** How her note ends, naming what she goes, makes and uses with. */
const how =
  'To go, world.go; to make something where you are, world.make; to use something that is here, world.use.';

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
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const say = await converse(wireOf(await startDaemon(home)), 'mira');

  model.answer(reply('hi.'));
  await say('Hello?', 'hello');

  expect(whereShe(model.requests[0])).toBe(
    `- You are in The Flat. Here: Kitchen table; Tin of pencils; Teapot; Bed; Bike. From here you can go to The Studio ("studio") or The Bakery ("bakery"), or somewhere else. ${how}`,
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
