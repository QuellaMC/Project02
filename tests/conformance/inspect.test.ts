import {readdirSync} from 'node:fs';
import {join} from 'node:path';

import {expect, it} from 'vitest';

import {inspect, startDaemon, type Run} from './harness/daemon.ts';
import {
  characterJson,
  configJson,
  createHome,
  sessionLog,
  sessionRecords,
  snapshot,
} from './harness/home.ts';
import {
  finish,
  startModelServer,
  toolCall,
  visibleReply,
} from './harness/model-server.ts';
import {conversationOf, converse, wireOf} from './harness/wire.ts';

type Measure = {readonly chars: number; readonly estimatedTokens: number};

type Round = {
  readonly round: number;
  readonly roleModelEvidence: {
    readonly input: {readonly contextSummary?: string};
    readonly promptSize: {
      readonly frames: readonly (Measure & {
        readonly kind: string;
        readonly count: number;
      })[];
      readonly tools: Measure;
      readonly total: Measure;
    };
    readonly output: {
      readonly providerExchange: {
        readonly renderedMessages: readonly unknown[];
        readonly renderedTools: readonly unknown[];
        readonly requestBody: unknown;
      };
    };
  };
};

type SessionReport = {
  readonly counts: {readonly traceEntries: number; readonly rawEvents: number};
  readonly continuation?: {readonly summary: string};
  readonly turns: readonly {readonly modelRounds: readonly Round[]}[];
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

/** An inspect that exits 1, once it has. */
async function refused(run: Run): Promise<Run> {
  expect(await run.exit(), run.stdout()).toBe(1);
  expect(run.stdout()).toBe('');

  return run;
}

it("inspect.session-report: inspect --session prints the session as JSON: its evidence scopes, its counts, and each turn's model rounds with the decision, the prompt's size by frame kind, the provider exchange as sent with its messages, tools and request body, and the runtime notes, then its tool events, the plugins' evidence and the commit's validation", async () => {
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
  const rounds = report.turns[0]?.modelRounds ?? [];

  expect(report.counts.traceEntries).toBeGreaterThan(0);
  expect(report).toMatchObject({
    evidenceScopes: {
      runtimeConfig: 'current_at_inspection',
      activation: 'current_at_inspection',
      storedSessionEvidence: 'stored_history',
      traceEvidence: 'derived_from_event_log',
    },
    counts: {
      traceEntries: expect.any(Number) as number,
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
    rounds.map(round =>
      round.roleModelEvidence.promptSize.frames.map(frame => frame.kind),
    ),
  ).toEqual([
    [
      'system_protocol',
      'developer_protocol',
      'model_only_runtime_context',
      'current_user_message',
    ],
    [
      'system_protocol',
      'developer_protocol',
      'model_only_runtime_context',
      'current_user_message',
      'tool_round_assistant_message',
      'tool_round_result_message',
    ],
  ]);

  for (const [index, round] of rounds.entries()) {
    const {promptSize, output} = round.roleModelEvidence;
    const exchange = output.providerExchange;
    const body = model.requests[index]?.body as {
      readonly messages: readonly unknown[];
      readonly tools: readonly unknown[];
    };
    const wire = (value: unknown) => JSON.stringify(value).length;
    const frameChars = promptSize.frames.reduce(
      (sum, frame) => sum + frame.chars,
      0,
    );
    const measures = [...promptSize.frames, promptSize.tools, promptSize.total];

    expect(exchange.requestBody).toEqual(body);
    expect(exchange.renderedMessages).toEqual(body.messages);
    expect(exchange.renderedTools).toEqual(body.tools);
    // The frames are the wire messages, counted and measured as serialized;
    // the tools weigh their serialization; the whole is their sum; and a
    // token is four characters, rounded up.
    expect(promptSize.frames.reduce((sum, frame) => sum + frame.count, 0)).toBe(
      body.messages.length,
    );
    expect(frameChars).toBe(
      body.messages.map(wire).reduce((sum, chars) => sum + chars, 0),
    );
    expect(promptSize.tools.chars).toBe(wire(body.tools));
    expect(promptSize.total.chars).toBe(frameChars + promptSize.tools.chars);
    expect(measures.map(measure => measure.estimatedTokens)).toEqual(
      measures.map(measure => Math.ceil(measure.chars / 4)),
    );
  }
});

it('inspect.continued-session-report: inspect --session on a segment that continues another shows the segment it continued from, how the summary was made, the summary, and the same summary in what its rounds were shown', async () => {
  const home = createHome({'config.json': rotatingEveryTurn});
  const wire = wireOf(await startDaemon(home, fixedReplies));
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  await say('One.', 'one');
  await say('Two.', 'two');

  const report = (await reportOn(home, [
    '--session',
    `${conversationId}.2`,
  ])) as SessionReport;

  const stored = sessionRecords(home, 'mira', 'session_continued')
    .map(
      record =>
        record['sessionContinuation'] as {
          readonly sessionId: string;
          readonly summary: string;
        },
    )
    .find(continuation => continuation.sessionId === `${conversationId}.2`);

  expect(stored?.summary).toBeTruthy();
  expect(report).toMatchObject({
    continuation: {
      continuedFrom: {sessionId: `${conversationId}.1`},
      summarizer: {status: 'fallback'},
      summary: stored?.summary,
    },
  });
  expect(
    report.turns[0]?.modelRounds[0]?.roleModelEvidence.input.contextSummary,
  ).toBe(report.continuation?.summary);
});

it("inspect.sessions-report: inspect --sessions lists a character's sessions, none while her data directory holds only control state, and --session on a session she does not have exits 1 naming it", async () => {
  const home = createHome();
  const wire = wireOf(await startDaemon(home, fixedReplies));

  await wire.start('mira');
  expect(await reportOn(home, ['--sessions'])).toMatchObject({sessions: []});

  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');

  await say('Hello.', 'hello');
  expect(await reportOn(home, ['--sessions'])).toMatchObject({
    sessions: [{sessionId: `${conversationId}.1`}],
  });

  const missing = await refused(
    inspect(['--store', home, '--session', 'conv_missing.1']),
  );

  expect(missing.stderr()).toContain('"conv_missing.1"');
});

it('inspect.conversations-report: inspect --conversations lists the conversations with their participants, --conversation shows one with its segments in numeric order, an absent one exits 1 saying it does not exist, and two modes at once exit 1 asking for exactly one', async () => {
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

  const absent = await refused(
    inspect(['--store', home, '--conversation', 'conv_absent']),
  );
  const twoModes = await refused(
    inspect(['--store', home, '--conversations', '--sessions']),
  );

  expect(absent.stderr()).toContain('does not exist');
  expect(twoModes.stderr()).toContain('exactly one of');
});

it("inspect.config-report: inspect shows where the config came from, each plugin's activation with the access it asked for and was granted and the activation's diagnostics, and each connector with its switch, activation, values by where they came from and diagnostics, its secrets only as [redacted]", async () => {
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
    readonly plugins: readonly {readonly pluginId: string}[];
  };

  const fileStore = {
    character_file_store: 'write',
    model_input: 'write',
    trusted_context: 'write',
  };
  const sessionHistory = {
    session_history: 'read',
    plugin_database: 'write',
    turn_context: 'read',
    model_input: 'write',
    trusted_context: 'write',
  };
  const active = (pluginId: string, access: Record<string, string>) => ({
    pluginId,
    kind: 'first_party',
    enabled: true,
    requestedAccess: access,
    grantedAccess: access,
    activationStatus: 'active',
    diagnostics: [],
  });
  const off = (
    pluginId: string,
    kind: string,
    access: Record<string, string>,
  ) => ({
    pluginId,
    kind,
    enabled: false,
    requestedAccess: access,
    grantedAccess: {},
    activationStatus: 'disabled',
    diagnostics: [],
  });

  expect(
    [...shown.plugins].sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
  ).toMatchObject([
    active('character-memory', fileStore),
    active('character-state', fileStore),
    off('demo-config', 'context_provider', {
      model_input: 'write',
      trusted_context: 'write',
    }),
    off('mem0', 'memory_provider', {
      turn_context: 'read',
      model_input: 'write',
    }),
    active('runtime.plugin', {model_input: 'write'}),
    active('session-history', sessionHistory),
  ]);
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

it('inspect.package-warnings: inspect warns on stderr of a broken character package, invalid_descriptor, while stdout stays the JSON for the character it reports on and it exits 0', async () => {
  const run = inspect([
    '--store',
    createHome({
      characters: {broken: {'project02.character.json': '{not json'}},
    }),
    '--sessions',
  ]);

  expect(await run.exit()).toBe(0);
  expect(run.stderr()).toMatch(/^Warning: .*invalid_descriptor/u);
  expect(JSON.parse(run.stdout())).toMatchObject({
    runtimeConfig: {project02: {character: 'mira'}},
    sessions: [],
  });
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

it('inspect.damaged-store: inspect exits 1 with an error, never an empty list, on a character data directory that lost its marker but holds sessions or a foreign entry, on a directory that is not a home, and on a --store that is a file', async () => {
  const file = join(createHome({'store.txt': 'not a directory'}), 'store.txt');
  const damaged = [
    createHome({
      'config.json': configJson({}),
      'character-data': {
        mira: {sessions: {'lost-session': {'raw-events.jsonl': ''}}},
      },
    }),
    createHome({
      'config.json': configJson({}),
      'character-data': {mira: {'notes.txt': 'foreign'}},
    }),
    createHome({'notes.txt': 'mine'}),
  ].map(home => inspect(['--store', home, '--sessions']));
  const unreadable = inspect(['--store', file, '--sessions']);

  for (const run of damaged) {
    expect((await refused(run)).stderr()).toMatch(/^Error: /u);
  }

  expect((await refused(unreadable)).stderr()).toBe(
    'Error: Local runtime store could not be read.\n',
  );
});

it('inspect.usage-errors: inspect refuses --init with exit 1, saying it does not apply, and creates nothing', async () => {
  const home = createHome();
  const run = await refused(inspect(['--store', home, '--sessions', '--init']));

  expect(run.stderr()).toContain('--init does not apply');
  expect(readdirSync(home)).toEqual([]);
});

it('inspect.character-selection: without --character inspect reports on the one character switched on and refuses when none is or several are, naming them; an explicit --character wins even for a character switched off', async () => {
  const zeta = {
    zeta: {'project02.character.json': characterJson('zeta', 'Zeta')},
  };
  const miraOff = {
    mira: {'config.json': configJson({project02: {enabled: false}})},
  };
  const allOff = createHome({
    'config.json': configJson({project02: {enabled: false}}),
  });

  expect(
    await reportOn(createHome({characters: zeta, 'character-data': miraOff}), [
      '--sessions',
    ]),
  ).toMatchObject({runtimeConfig: {project02: {character: 'zeta'}}});
  expect(
    (
      await refused(
        inspect(['--store', createHome({characters: zeta}), '--sessions']),
      )
    ).stderr(),
  ).toContain('Several characters are enabled: mira, zeta.');
  expect(
    (await refused(inspect(['--store', allOff, '--sessions']))).stderr(),
  ).toContain('No enabled character.');
  expect(
    await reportOn(allOff, ['--character', 'mira', '--sessions']),
  ).toMatchObject({runtimeConfig: {project02: {character: 'mira'}}});
});
