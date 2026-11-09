import {readdirSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {inspect, startDaemon} from './harness/daemon.ts';
import {
  characterJson,
  configJson,
  createHome,
  sessionLog,
  snapshot,
} from './harness/home.ts';
import {
  finish,
  startModelServer,
  toolCall,
  visibleReply,
} from './harness/model-server.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

type SessionReport = {
  readonly turns: readonly {
    readonly modelRounds: readonly {
      readonly roleModelEvidence: {
        readonly output: {
          readonly providerExchange: {readonly requestBody: unknown};
        };
      };
    }[];
  }[];
};

const fixedReplies = {PROJECT02_TEST_PROVIDER: 'deterministic'};
// A window this small rotates the segment after every turn.
const rotatingEveryTurn = configJson({project02: {contextWindowTokens: 1}});

/** What inspect printed on the home, once it exited 0. */
async function reportOn(
  home: string,
  args: readonly string[],
): Promise<unknown> {
  const run = inspect(['--store', home, ...args]);

  expect(await run.exit(), run.stderr()).toBe(0);

  return JSON.parse(run.stdout()) as unknown;
}

it("inspect.session-report: inspect --session prints the session as JSON: its counts, each turn's model rounds with their decisions and the request each sent the provider as it got it, then the turn's tool events, the plugins' evidence and the commit's validation", async () => {
  const model = await startModelServer();
  const home = createHome({
    'config.json': configJson({project02: model.settings}),
  });
  const wire = wireOf(await startDaemon(home));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  model.answer(
    {
      chunks: [
        ...toolCall({
          index: 0,
          id: 'call_search',
          name: 'sessions_search',
          arguments: JSON.stringify({query: 'tea'}),
        }),
        finish('tool_calls'),
      ],
    },
    {chunks: [...visibleReply('Nothing about tea yet.'), finish('tool_calls')]},
  );
  await say('Did we talk about tea?', 'tea');

  const report = (await reportOn(home, [
    '--session',
    `${conversationId}.1`,
  ])) as SessionReport;

  expect(report).toMatchObject({
    counts: {
      rawEvents: sessionLog(home, 'mira', `${conversationId}.1`).length,
      conversationMessages: 2,
    },
    turns: [
      {
        modelRounds: [
          {
            round: 1,
            roleModelEvidence: {
              parsedDecision: {status: 'accepted'},
              input: {
                runtimeNotes: expect.arrayContaining([
                  expect.objectContaining({pluginId: 'character-state'}),
                ]) as unknown[],
              },
            },
          },
          {round: 2, roleModelEvidence: {parsedDecision: {status: 'accepted'}}},
        ],
        toolEvents: [
          {
            round: 1,
            toolName: 'sessions.search',
            pluginId: 'session-history',
            input: {query: 'tea'},
          },
          {
            round: 1,
            toolName: 'sessions.search',
            pluginId: 'session-history',
            result: {status: 'accepted'},
          },
        ],
        pluginEvidence: {
          evidence: expect.arrayContaining([
            expect.objectContaining({
              pluginId: 'session-history',
              evidenceKind: 'tool_invocation',
              status: 'accepted',
            }),
          ]) as unknown[],
        },
        commitValidation: {
          round: 2,
          status: 'accepted',
          acceptedVisibleReplyText: 'Nothing about tea yet.',
        },
      },
    ],
  });
  expect(
    report.turns[0]?.modelRounds.map(
      round => round.roleModelEvidence.output.providerExchange.requestBody,
    ),
  ).toEqual(model.requests.map(request => request.body));
});

it('inspect.sessions-report: inspect --sessions lists the sessions of the one character switched on, or of the one --character names whether she is on or not, none while she holds only control state', async () => {
  const home = createHome({
    characters: {
      zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
    },
    'character-data': {
      zeta: {'config.json': configJson({project02: {enabled: false}})},
    },
  });
  const wire = wireOf(await startDaemon(home, fixedReplies));

  await wire.start('mira');
  expect(await reportOn(home, ['--sessions'])).toMatchObject({
    runtimeConfig: {project02: {character: 'mira'}},
    sessions: [],
  });

  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  await say('Hello.', 'hello');
  expect(await reportOn(home, ['--sessions'])).toMatchObject({
    sessions: [{sessionId: `${conversationId}.1`}],
  });
  expect(
    await reportOn(home, ['--character', 'zeta', '--sessions']),
  ).toMatchObject({
    runtimeConfig: {project02: {character: 'zeta'}},
    sessions: [],
  });
});

it('inspect.conversations-report: inspect --conversations lists the conversations with their participants, and --conversation shows one with its segments in numeric order', async () => {
  const home = createHome({'config.json': rotatingEveryTurn});
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  // Each turn rotates the segment: nine turns leave ten.
  for (let turn = 1; turn <= 9; turn += 1) {
    await say(`Line ${String(turn)}.`, `line-${String(turn)}`);
  }

  expect(await reportOn(home, ['--conversations'])).toMatchObject({
    conversations: [
      {
        id: conversationId,
        participants: [
          {kind: 'character', id: 'mira'},
          {kind: 'user', id: 'local-user'},
        ],
      },
    ],
  });

  const thread = (await reportOn(home, ['--conversation', conversationId])) as {
    readonly conversation: {readonly id: string};
    readonly sessions: readonly {readonly sessionId: string}[];
  };

  expect(thread.conversation.id).toBe(conversationId);
  expect(thread.sessions.map(session => session.sessionId)).toEqual(
    Array.from(
      {length: 10},
      (_, index) => `${conversationId}.${String(index + 1)}`,
    ),
  );
});

it("inspect.config-report: inspect shows where the config came from, each plugin's activation and the activation's diagnostics, and each connector with its values by where they came from, its secrets only as [redacted]", async () => {
  const home = createHome({
    'config.json': configJson({
      plugins: {'ghost-plugin': {enabled: true}},
      connectors: {
        telegram: {
          config: {
            managementBotToken: '123456:home',
            botToken: '654321:misplaced',
            pairedUsers: {'381940562': 'Alice (@alice)'},
          },
        },
      },
    }),
  });
  const run = inspect(['--store', home, '--sessions']);

  expect(await run.exit()).toBe(0);

  const shown = JSON.parse(run.stdout()) as {
    readonly plugins: readonly {
      readonly pluginId: string;
      readonly activationStatus: string;
    }[];
  };

  expect(
    Object.fromEntries(
      shown.plugins.map(plugin => [plugin.pluginId, plugin.activationStatus]),
    ),
  ).toEqual({
    'character-memory': 'active',
    'character-state': 'active',
    'demo-config': 'disabled',
    mem0: 'disabled',
    'runtime.plugin': 'active',
    'session-history': 'active',
  });
  expect(shown).toMatchObject({
    runtimeConfig: {source: 'path', path: join(home, 'config.json')},
    activationDiagnostics: [
      {code: 'runtime_config_unknown_plugin', path: 'plugins.ghost-plugin'},
    ],
    connectors: [
      {
        id: 'telegram',
        enabled: true,
        activation: {status: 'active'},
        diagnostics: [
          {
            code: 'runtime_config_authored_outside_scope',
            path: 'connectors.telegram.config.botToken',
          },
        ],
        config: {
          botToken: {source: 'missing'},
          managementBotToken: {source: 'config', value: '[redacted]'},
          mirror: {source: 'default', value: true},
          pairedUsers: {
            source: 'config',
            value: {'381940562': 'Alice (@alice)'},
          },
        },
      },
    ],
  });
  expect(run.stdout()).not.toMatch(/123456:home|654321:misplaced/u);
});

it('inspect.read-only: inspect writes nothing: on a directory with no store it reports nothing with exit 0 and leaves it empty, and it writes no overlay, marker or schema.json for a character that never started or for one whose overlay needs repair', async () => {
  const empty = createHome();

  expect(await reportOn(empty, ['--sessions'])).toMatchObject({sessions: []});
  expect(readdirSync(empty)).toEqual([]);

  const overlay = configJson({project02: {userDisplayName: 42}});
  const home = createHome({
    'config.json': configJson({}),
    characters: {
      nova: {'project02.character.json': characterJson('nova', 'Nova')},
    },
    'character-data': {mira: {'config.json': overlay}},
  });
  const before = snapshot(home);

  await reportOn(home, ['--character', 'nova', '--sessions']);
  await inspect(['--store', home, '--character', 'mira', '--sessions']).exit();
  expect(snapshot(home)).toEqual(before);
});
