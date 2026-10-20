/**
 * The scenario the differential run drives through each build: one home,
 * one model server, one mem0 server, the same steps in the same order,
 * each step waiting on what the daemon shows before the next, so that two
 * runs of one build leave the same recording but for what the normalizer
 * names.
 */
import {
  inspect,
  startDaemon,
  type Command,
} from '../conformance/harness/daemon.ts';
import {frameOf, openEvents} from '../conformance/harness/events.ts';
import {configJson, createHome} from '../conformance/harness/home.ts';
import {bearer, exchange} from '../conformance/harness/http.ts';
import {startMem0Server} from '../conformance/harness/mem0-server.ts';
import {
  calling,
  completion,
  finish,
  reply,
  startModelServer,
  toolCall,
  visibleReply,
  type Answer,
} from '../conformance/harness/model-server.ts';
import {
  conversationOf,
  converse,
  saveConfig,
  wireOf,
} from '../conformance/harness/wire.ts';
import type {Recording, Report} from './normalize.ts';

/** A build of the daemon, by the commands that start its `serve` and its `inspect`. */
export type Build = {readonly serve: Command; readonly inspect: Command};

/**
 * The first line alone outgrows half of this window, so the session
 * continues once, behind the first turn, and carries none of it; the later
 * turns fit together in the new segment, where the search reaches back
 * into the first. Each margin is some seventy tokens.
 */
const contextWindowTokens = 1500;
const journal = `I keep a journal at the lighthouse, and today I wrote the longest entry yet.${' The fog came in over the water, and then it went out again.'.repeat(52)}`;

/** The model speaking through `visible_reply`, its words cut where given. */
function spoken(words: string, ...cuts: number[]): Answer {
  return {chunks: [...visibleReply(words, ...cuts), finish('tool_calls')]};
}

export async function record(build: Build): Promise<Recording> {
  const model = await startModelServer();
  const memory = await startMem0Server();
  const home = createHome({
    'config.json': configJson({
      project02: {...model.settings, contextWindowTokens},
      plugins: {
        'demo-config': {enabled: true},
        mem0: {
          enabled: true,
          config: {backend: 'server', baseUrl: memory.baseUrl},
        },
      },
    }),
  });
  const daemon = await startDaemon(home, {}, build.serve);
  const wire = wireOf(daemon);
  const say = await converse(wire, 'mira');
  const {conversationId} = await conversationOf(wire, 'mira');
  // Opened once she is ready, so the stream begins at the same point in every run.
  const events = await openEvents(daemon);
  let captures = 0;
  /**
   * A turn, with what the person does while it runs, then mem0's capture
   * of it, which follows the answer: the next turn waits for the capture,
   * so the server sees each turn's requests in order.
   */
  const turn = async (
    line: string,
    clientMessageId: string,
    meanwhile?: () => Promise<void>,
  ): Promise<void> => {
    const capture = memory.hold('/memories');
    const answered = say(line, clientMessageId);

    await meanwhile?.();
    await answered;
    await capture.arrived();
    captures += 1;
    capture.release({
      status: 200,
      body: {results: [{id: `mem-${String(captures)}`, event: 'ADD'}]},
    });
  };

  // A recall rides the line, the reply arrives in pieces, and the line
  // outgrows the window: the session continues behind the turn.
  memory.answer('/search', {
    status: 200,
    body: {results: [{id: 'mem-0', memory: 'Keeps a journal.', score: 0.82}]},
  });
  model.answer(
    spoken('A lighthouse journal sounds lovely.', 7, 20),
    completion(
      'They keep a journal at the lighthouse and wrote a long entry today.',
    ),
  );
  await turn(journal, 'journal');

  // A round the parser refuses, which the next round is told about.
  model.answer(
    {
      chunks: [
        ...toolCall({
          index: 0,
          id: 'call_reply',
          name: 'visible_reply',
          arguments: JSON.stringify({text: 'Lighthouse.', tone: 'quiet'}),
        }),
        finish('tool_calls'),
      ],
    },
    reply('Lighthouse.'),
  );
  await turn('Say it in one word.', 'one-word');

  // A change the model asks for, which the person approves.
  const {fingerprint} = (await wire.configView({
    scope: 'character',
    characterId: 'mira',
  })) as {readonly fingerprint: string};

  model.answer(
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
    spoken('Of course.'),
  );
  await turn('Could you be warmer with me?', 'warmer', async () => {
    const {data = ''} = await events.next(frameOf('confirmation_requested'));

    await wire.answer(
      (JSON.parse(data) as {readonly id: string}).id,
      'approved',
    );
  });

  // A change the person makes on the settings page: she reloads with it.
  await saveConfig(
    wire,
    {scope: 'global'},
    {kind: 'set', path: 'project02.userDisplayName', value: 'Sam'},
  );
  await events.next(
    frameOf('state_changed', {characterId: 'mira', state: 'ready'}),
  );

  // A search that reaches back into the first segment.
  model.answer(
    calling(['sessions_search', {query: 'journal'}]),
    spoken('You keep a journal there, Sam.'),
  );
  await turn('What did I tell you about the lighthouse?', 'recall');

  const historyPages: string[] = [];
  let before: string | undefined;

  do {
    const page = new URLSearchParams({
      limit: '4',
      ...(before === undefined ? {} : {before}),
    });
    const text = await (
      await exchange(daemon, {
        path: `/api/conversations/${encodeURIComponent(conversationId)}/messages?${page.toString()}`,
        headers: bearer(daemon),
      })
    ).whole();

    historyPages.push(text);
    before = (JSON.parse(text) as {readonly earlier?: string}).earlier;
  } while (before !== undefined);

  daemon.signal('SIGINT');
  await daemon.exit();
  await events.ended();

  const reports: Report[] = [];

  for (const args of [
    ['--conversations'],
    ['--conversation', conversationId],
    ['--session', `${conversationId}.1`],
    ['--session', `${conversationId}.2`],
  ]) {
    const run = inspect(['--store', home, ...args], {}, build.inspect);
    const exitCode = await run.exit();

    reports.push({args, exitCode, stdout: run.stdout(), stderr: run.stderr()});
  }

  return {
    places: {
      home,
      modelServerPort: new URL(model.settings.nvidiaBaseUrl).port,
      memoryServerPort: new URL(memory.baseUrl).port,
    },
    modelRequests: model.requests,
    memoryRequests: memory.requests,
    frames: events.frames,
    historyPages,
    reports,
  };
}
