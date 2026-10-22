import {expect, it} from 'vitest';

import {normalize, type Recording} from './normalize.ts';

/** What a run of the scenario makes its own, and what the daemon writes. */
type Run = {
  readonly home: string;
  readonly modelServerPort: string;
  readonly memoryServerPort: string;
  readonly conversation: string;
  readonly event: string;
  readonly confirmation: string;
  readonly fingerprint: string;
  readonly moment: string;
  readonly day: string;
  readonly deadline: number;
  readonly streamRun: string;
  readonly pinged: boolean;
  readonly line: string;
  readonly toolInput: string;
  readonly toolResult: string;
  readonly unusableReply: string;
  readonly rejection: string;
  readonly measured: number;
  /** The request body as the daemon spells it on the wire. */
  readonly spelled: (body: string) => string;
  /** A session as its store keeps it, and inspect reports it. */
  readonly stored: Stored;
};

/** What a store keeps of a session, which plan D1 lets each keep its own way. */
type Stored = {
  readonly steps: readonly string[];
  readonly traceEntries: number;
  readonly rawEvents: number;
  readonly messages: number;
  readonly continuationKind: boolean;
  readonly reasoning: 'nested' | 'flat';
  readonly reasoningBudget: number;
  readonly turnSnapshot: boolean;
  readonly evidence: readonly Readonly<Record<string, unknown>>[];
};

/** The TypeScript store's: its trace's own steps, a snapshot of the turn's plugins, each step's fingerprint and references. */
const typescriptStore: Stored = {
  steps: [
    'runtime_event_received',
    'runtime_event_normalized',
    'runtime_turn_started',
    'visible_message_committed',
    'role_model_round',
    'tool_call_started',
    'tool_call_finished',
    'raw_event_log_appended',
    'runtime_turn_completed',
  ],
  traceEntries: 9,
  rawEvents: 8,
  messages: 2,
  continuationKind: true,
  reasoning: 'nested',
  reasoningBudget: 16384,
  turnSnapshot: true,
  evidence: [
    {
      pluginId: 'runtime.plugin',
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      summary: 'Applied approved plugin "demo-config" config field "tone".',
      redactionLabels: [],
      sourceReferences: [{kind: 'runtime', id: 'call-1'}],
      configFingerprint: 'sha256:cccc',
    },
    {
      pluginId: 'runtime.plugin',
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      summary: 'Live-applied plugin "demo-config" config field "tone".',
      redactionLabels: [],
    },
    {
      pluginId: 'runtime.plugin',
      evidenceKind: 'policy',
      status: 'accepted',
      summary: 'User approved one prepared config effect.',
      redactionLabels: [],
      policyOutcome: 'user_approved',
    },
  ],
};

/** The Rust store's: its records' own kinds, and the steps worded and labelled anew. */
const rustStore: Stored = {
  steps: [
    'runtime_event_received',
    'visible_message_committed',
    'role_model_round',
    'tool_call_started',
    'tool_call_finished',
    'runtime_turn_completed',
  ],
  traceEntries: 6,
  rawEvents: 7,
  messages: 2,
  continuationKind: false,
  reasoning: 'flat',
  reasoningBudget: 16384,
  turnSnapshot: false,
  evidence: [
    {
      pluginId: 'runtime.plugin',
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      summary: 'Changed plugin "demo-config" field "tone".',
      redactionLabels: ['memory'],
    },
    {
      pluginId: 'runtime.plugin',
      evidenceKind: 'policy',
      status: 'accepted',
      summary: 'User approved plugin "runtime.plugin".',
      redactionLabels: [],
      policyOutcome: 'user_approved',
    },
  ],
};

const reference: Run = {
  home: '/tmp/project02-home-AAAAAA',
  modelServerPort: '41001',
  memoryServerPort: '41002',
  conversation: '11111111-1111-4111-8111-111111111111',
  event: '22222222-2222-4222-8222-222222222222',
  confirmation: '33333333-3333-4333-8333-333333333333',
  fingerprint: 'sha256:aaaa',
  moment: '2026-10-20T19:00:00.000Z',
  day: 'Tuesday, October 20, 2026',
  deadline: 1_792_522_908_505,
  streamRun: '0123456789abcdef',
  pinged: false,
  line: 'Did we talk about tea?',
  toolInput: '{"1":"first","query":"tea","limit":5}',
  toolResult: '{"status":"accepted","output":{"items":[],"score":1}}',
  unusableReply: 'Your last reply could not be used. The runtime said: ',
  rejection: 'visible_reply input includes unsupported fields: tone.',
  measured: 1152,
  spelled: body => body,
  stored: typescriptStore,
};

/** One run's recording: a turn with a replayed turn before it, a tool round and a refused round, and what the run left besides. */
function recordingOf(run: Run, replayed = true): Recording {
  const {stored} = run;
  const conversation = `conv_${run.conversation}`;
  const callId = `evt_${run.event}.round-1.1.sessions.search`;
  const body = {
    model: 'conformance-model',
    messages: [
      {role: 'system', content: 'You are Mira.'},
      {role: 'system', content: `Right now:\n- Today is ${run.day}.`},
      ...(replayed
        ? [
            {role: 'user', content: 'Hello.'},
            {role: 'assistant', content: 'Hi.'},
          ]
        : []),
      {role: 'user', content: run.line},
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: {name: 'sessions_search', arguments: run.toolInput},
          },
        ],
      },
      {role: 'tool', tool_call_id: callId, content: run.toolResult},
      {
        role: 'system',
        content: `${run.unusableReply}${JSON.stringify(run.rejection)}`,
      },
    ],
    temperature: 1,
  };
  const frame = (seq: number, event: string, data: object) => ({
    id: `${run.streamRun}-${String(seq)}`,
    event,
    data: JSON.stringify(data),
  });

  return {
    places: {
      home: run.home,
      modelServerPort: run.modelServerPort,
      memoryServerPort: run.memoryServerPort,
    },
    modelRequests: [
      {
        path: '/v1/chat/completions',
        authorization: 'Bearer model-server-key',
        text: run.spelled(JSON.stringify(body)),
      },
    ],
    memoryRequests: [
      {
        method: 'POST',
        path: '/memories',
        text: JSON.stringify({
          run_id: `${conversation}.1`,
          metadata: {project02_sources: [`evt_${run.event}`]},
        }),
      },
    ],
    frames: [
      frame(0, 'ready', {health: {homeRoot: run.home}}),
      ...(run.pinged ? [{comment: 'ping'}] : []),
      frame(1, 'confirmation_requested', {
        id: run.confirmation,
        request: {preview: {expectedFingerprint: run.fingerprint}},
        deadlineAt: run.deadline,
        turn: {conversationId: conversation},
      }),
    ],
    historyPages: [
      JSON.stringify({
        messages: [
          {
            messageId: `${conversation}.1:message-1`,
            text: 'Hello.',
            committedAt: run.moment,
          },
        ],
      }),
    ],
    reports: [
      {
        args: ['--session', `${conversation}.1`],
        exitCode: 0,
        stdout: `${JSON.stringify(
          {
            runtimeConfig: {
              path: `${run.home}/config.json`,
              nvidiaBaseUrl: `http://127.0.0.1:${run.modelServerPort}/v1`,
              mem0BaseUrl: `http://127.0.0.1:${run.memoryServerPort}`,
            },
            continuation: {
              eventId: `evt_${run.event}`,
              ...(stored.continuationKind
                ? {kind: 'session_continuation_snapshot'}
                : {}),
              summary: 'They keep a journal.',
            },
            counts: {
              traceEntries: stored.traceEntries,
              rawEvents: stored.rawEvents,
              conversationMessages: stored.messages,
            },
            turns: [
              {
                steps: stored.steps,
                runtimeNotes: [{id: 'today', text: `Today is ${run.day}.`}],
                summaryDay: run.moment.slice(0, 10),
                promptSize: {total: {chars: run.measured}},
                rawOutputText: JSON.stringify({
                  input: {expectedFingerprint: run.fingerprint},
                }),
                providerExchange: {
                  provider: {name: 'nvidia'},
                  ...(stored.reasoning === 'nested'
                    ? {
                        reasoning: {
                          mode: 'enabled',
                          params: {reasoning_budget: stored.reasoningBudget},
                        },
                      }
                    : {
                        reasoningParams: {
                          reasoning_budget: stored.reasoningBudget,
                        },
                      }),
                  requestBody: {model: 'conformance-model'},
                },
                parsedDecision: {rejectionDetails: run.rejection},
                toolEvents: [
                  {result: {status: 'accepted', evidence: stored.evidence}},
                ],
                pluginEvidence: {
                  ...(stored.turnSnapshot
                    ? {
                        contractVersion: 'mvp-008.runtime_plugin.v2',
                        plugins: [{pluginId: 'runtime.plugin'}],
                        contextItems: [],
                        toolInvocations: [],
                      }
                    : {}),
                  evidence: stored.evidence,
                  policyOutcomes: ['user_approved'],
                  health: [],
                },
              },
            ],
          },
          null,
          2,
        )}\n`,
        stderr: '',
      },
    ],
  };
}

it.each<[string, Partial<Run>]>([
  [
    'a run in another home, against servers on other ports',
    {
      home: '/tmp/project02-home-BBBBBB',
      modelServerPort: '4100',
      memoryServerPort: '41003',
    },
  ],
  [
    'a run whose ids came out otherwise',
    {
      conversation: 'aaaaaaaa-1111-4111-8111-111111111111',
      event: 'bbbbbbbb-2222-4222-8222-222222222222',
      confirmation: 'cccccccc-3333-4333-8333-333333333333',
    },
  ],
  [
    'a daemon that spells its fingerprints its own way',
    {fingerprint: 'blake3:zzzz'},
  ],
  [
    'a run on another day and another clock',
    {
      moment: '2026-10-21T08:30:00.250Z',
      day: 'Wednesday, October 21, 2026',
      deadline: 1_792_600_000_000,
    },
  ],
  [
    'a stream numbered under another run id, with a ping between its frames',
    {streamRun: 'fedcba9876543210', pinged: true},
  ],
  [
    'tool payloads in another JSON spelling: an integer-like key in insertion order, a number written 1.0 (row 18)',
    {
      toolInput: '{"query":"tea","limit":5,"1":"first"}',
      toolResult: '{"status":"accepted","output":{"items":[],"score":1.0}}',
    },
  ],
  [
    'the details of a refused round worded anew (row 14)',
    {
      rejection:
        'The visible_reply input carries a field it does not take: tone.',
    },
  ],
  ['prompt measures counted otherwise', {measured: 1153}],
  [
    "a session as the other store keeps it (plan D1): its trace's steps and counts, its continuation, its exchange's reasoning parameters, and its plugins' evidence",
    {stored: rustStore},
  ],
])('%s reads the same as the reference', (_, differences) => {
  expect(normalize(recordingOf({...reference, ...differences}))).toBe(
    normalize(recordingOf(reference)),
  );
});

it.each<[string, Partial<Run>]>([
  ['a word the model is shown', {line: 'Did we talk about coffee?'}],
  [
    'a request spelled otherwise on the wire',
    {spelled: body => body.replace('"temperature":1', '"temperature":1.0')},
  ],
  ['a moment in another format', {moment: '2026-10-20T19:00:00Z'}],
  [
    'the named keys of a tool payload in another order',
    {toolInput: '{"1":"first","limit":5,"query":"tea"}'},
  ],
  [
    'the sentence that carries what the runtime said of a refused round',
    {unusableReply: 'That reply could not be used. The runtime said: '},
  ],
  [
    'a step a turn took that the other did not',
    {
      stored: {
        ...typescriptStore,
        steps: [...typescriptStore.steps, 'role_model_round'],
      },
    },
  ],
  ['messages counted otherwise', {stored: {...typescriptStore, messages: 3}}],
  [
    'a reasoning parameter sent otherwise',
    {stored: {...rustStore, reasoningBudget: 8192}},
  ],
  [
    "a plugin's step that ended otherwise",
    {
      stored: {
        ...rustStore,
        evidence: rustStore.evidence.map(entry => ({
          ...entry,
          status: 'failed',
        })),
      },
    },
  ],
])('%s shows', (_, differences) => {
  expect(normalize(recordingOf({...reference, ...differences}))).not.toBe(
    normalize(recordingOf(reference)),
  );
});

it('a window that holds one turn less shows as that turn, the rest of the request alike (row 17)', () => {
  const requestOf = (replayed: boolean) => {
    const request = normalize({
      ...recordingOf(reference, replayed),
      memoryRequests: [],
      frames: [],
      historyPages: [],
      reports: [],
    });

    return JSON.parse(request.slice(request.indexOf('\n') + 1)) as {
      readonly messages: {
        readonly frames: unknown[];
        readonly turns: unknown[][];
      };
    };
  };
  const whole = requestOf(true);
  const shorter = requestOf(false);

  expect(shorter.messages.turns).toEqual(whole.messages.turns.slice(1));
  expect({...shorter, messages: {...shorter.messages, turns: []}}).toEqual({
    ...whole,
    messages: {...whole.messages, turns: []},
  });
});
