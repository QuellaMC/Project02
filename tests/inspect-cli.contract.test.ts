import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createConversationSession,
  createFileCharacterStateStore,
  createFileRuntimeLogStore,
  createLocalRuntimeSessionPaths,
  createLocalRuntimeSessionStore,
  createLocalRuntimeStorageLayout,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  roleModelDecisionContractVersion,
  roleModelMalformedOutputRejectionReason,
  roleModelVisibleReplyActionName,
  runLocalUserMessageEvent
} from '../src/index.ts';
import type { RoleModelAdapter } from '../src/role-model-loop.ts';

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type InspectSessionListOutput = {
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
};

type InspectSessionOutput = {
  readonly session: {
    readonly sessionId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly counts: {
    readonly traceEntries: number;
    readonly rawEvents: number;
    readonly conversationMessages: number;
  };
  readonly turns: readonly {
    readonly eventId: string;
    readonly traceId: string;
    readonly status: 'completed' | 'rejected';
    readonly steps: readonly string[];
    readonly visibleMessages: readonly {
      readonly id: string;
      readonly role: 'user' | 'character';
      readonly speakerName: string;
      readonly text: string;
    }[];
    readonly roleModelEvidence?: InspectRoleModelEvidence;
    readonly characterStatePatchEvidence?: {
      readonly status: 'accepted' | 'rejected';
      readonly patch?: unknown;
      readonly before: unknown;
      readonly after?: unknown;
      readonly appliedChanges?: unknown;
      readonly rejection?: unknown;
    };
    readonly reason?: string;
  }[];
};

type InspectRoleModelEvidence = {
  readonly input?: {
    readonly sessionId: string;
    readonly allowedTools: readonly string[];
    readonly outputContractVersion: string;
    readonly currentUserMessage: string;
    readonly recentVisibleMessages: readonly {
      readonly id: string;
      readonly role: 'user' | 'character';
      readonly speakerName: string;
      readonly text: string;
    }[];
    readonly runtimeNotes: readonly string[];
  };
  readonly output?: {
    readonly rawOutputText: string;
  };
  readonly parsedDecision?:
    | {
        readonly status: 'accepted';
        readonly toolCalls: readonly {
          readonly name: string;
          readonly input: Readonly<Record<string, unknown>>;
        }[];
      }
    | {
        readonly status: 'rejected';
        readonly rejectionReason: string;
        readonly rejectionDetails?: string;
      };
  readonly commitValidation?:
    | {
        readonly status: 'accepted';
        readonly acceptedVisibleReplyText: string;
      }
    | {
        readonly status: 'rejected';
        readonly rejectionReason: string;
        readonly rejectionDetails?: string;
      };
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempStoreRoots: string[] = [];
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T/u;

const successfulTraceSteps = [
  'runtime_event_received',
  'runtime_event_normalized',
  'runtime_turn_started',
  'visible_reply_committed',
  'raw_event_log_appended',
  'runtime_turn_completed'
] as const;

const rejectedInputTraceSteps = [
  'runtime_event_received',
  'input_validation_rejected',
  'raw_event_log_appended',
  'runtime_turn_rejected'
] as const;

describe('node src/inspect-cli.ts', () => {
  afterEach(async () => {
    await Promise.all(
      tempStoreRoots.splice(0).map(async (root) => {
        await rm(root, { recursive: true, force: true });
      })
    );
  });

  it('lists durable sessions after the chat process exits', async () => {
    const storeRoot = await createTempStoreRoot();

    await expect(seedChatSession(storeRoot, 'mira-local', 'hello\n/exit\n')).resolves.toMatchObject({
      exitCode: 0
    });

    const result = await runInspectCli(['--store', storeRoot, '--sessions']);
    const output = parseJson(result.stdout) as InspectSessionListOutput;

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: ''
    });
    expect(output.sessions).toHaveLength(1);
    expect(output.sessions[0]).toMatchObject({
      sessionId: 'mira-local'
    });
    expect(output.sessions[0]?.createdAt).toMatch(isoDatePattern);
    expect(output.sessions[0]?.updatedAt).toMatch(isoDatePattern);
  });

  it('prints selected-session turn evidence after the chat process exits', async () => {
    const storeRoot = await createTempStoreRoot();

    await expect(seedChatSession(storeRoot, 'mira-local', 'hello\n/exit\n')).resolves.toMatchObject({
      exitCode: 0
    });

    const result = await runInspectCli([
      '--store',
      storeRoot,
      '--session',
      'mira-local'
    ]);
    const output = parseJson(result.stdout) as InspectSessionOutput;

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: ''
    });
    expect(output.session.sessionId).toBe('mira-local');
    expect(output.counts).toEqual({
      traceEntries: 6,
      rawEvents: 4,
      conversationMessages: 2
    });
    expect(output.turns).toHaveLength(1);

    const turn = output.turns[0];

    if (turn === undefined) {
      throw new Error('Expected one inspected turn.');
    }

    expect(turn.eventId).toMatch(/^evt_/u);
    expect(turn.traceId).toMatch(/^trace_/u);
    expect(turn).toEqual(
      {
        eventId: turn.eventId,
        traceId: turn.traceId,
        status: 'completed',
        steps: successfulTraceSteps,
        visibleMessages: [
          {
            id: 'mira-local:message-1',
            role: 'user',
            speakerName: 'You',
            text: 'hello'
          },
          {
            id: 'mira-local:message-2',
            role: 'character',
            speakerName: 'Mira',
            text: "I'm here. Tell me what you need."
          }
        ],
        roleModelEvidence: {
          input: {
            sessionId: 'mira-local',
            allowedTools: [
              roleModelVisibleReplyActionName,
              'character_state.patch'
            ],
            outputContractVersion: 'mvp-006.tool_calls.v1',
            currentUserMessage: 'hello',
            recentVisibleMessages: [],
            runtimeNotes: []
          },
          output: {
            rawOutputText: JSON.stringify({
              version: 'mvp-006.tool_calls.v1',
              toolCalls: [
                {
                  name: roleModelVisibleReplyActionName,
                  input: {
                    text: "I'm here. Tell me what you need."
                  }
                }
              ]
            })
          },
          parsedDecision: {
            status: 'accepted',
            toolCalls: [
              {
                name: roleModelVisibleReplyActionName,
                input: {
                  text: "I'm here. Tell me what you need."
                }
              }
            ]
          },
          commitValidation: {
            status: 'accepted',
            acceptedVisibleReplyText: "I'm here. Tell me what you need."
          }
        }
      }
    );
  });

  it('prints persisted character state patch evidence without replaying a turn', async () => {
    const storeRoot = await createTempStoreRoot();
    const sessionStore = createLocalRuntimeSessionStore({ storeRoot });

    await sessionStore.createSession({ sessionId: 'mira-local' });

    const session = createConversationSession({ id: 'mira-local' });
    const logStore = createFileRuntimeLogStore({
      storeRoot,
      sessionId: 'mira-local'
    });
    const characterStateStore = createFileCharacterStateStore({
      storeRoot,
      sessionId: 'mira-local'
    });

    await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent('hello', {
        eventId: 'evt_inspect_state',
        traceId: 'trace_inspect_state',
        createdAt: '2026-06-10T00:00:00.000Z'
      }),
      session,
      logStore,
      characterStateStore,
      roleModelAdapter: createRawOutputAdapter(
        JSON.stringify({
          version: roleModelDecisionContractVersion,
          toolCalls: [
            {
              name: roleModelVisibleReplyActionName,
              input: {
                text: 'state reply'
              }
            },
            {
              name: 'character_state.patch',
              input: {
                mood: 'curious'
              }
            }
          ]
        })
      )
    });

    const inspectResult = await runInspectCli([
      '--store',
      storeRoot,
      '--session',
      'mira-local'
    ]);
    const parsed = parseJson(inspectResult.stdout) as InspectSessionOutput;
    const turn = parsed.turns[0];

    expect(inspectResult.exitCode).toBe(0);
    expect(turn?.characterStatePatchEvidence).toMatchObject({
      status: 'accepted',
      patch: {
        mood: 'curious'
      },
      before: {
        current: {
          mood: 'steady'
        }
      },
      after: {
        current: {
          mood: 'curious'
        }
      },
      appliedChanges: [
        {
          field: 'mood',
          before: 'steady',
          after: 'curious'
        }
      ]
    });
  });

  it('prints rejected-turn evidence without fake visible messages after the chat process exits', async () => {
    const storeRoot = await createTempStoreRoot();

    await expect(seedChatSession(storeRoot, 'mira-local', '\n/exit\n')).resolves.toMatchObject({
      exitCode: 0,
      stderr: 'Error: Provide exactly one non-empty message.\n'
    });

    const result = await runInspectCli([
      '--store',
      storeRoot,
      '--session',
      'mira-local'
    ]);
    const output = parseJson(result.stdout) as InspectSessionOutput;

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: ''
    });
    expect(output.counts).toEqual({
      traceEntries: 4,
      rawEvents: 3,
      conversationMessages: 0
    });
    expect(output.turns).toHaveLength(1);

    const turn = output.turns[0];

    if (turn === undefined) {
      throw new Error('Expected one inspected rejected turn.');
    }

    expect(turn.eventId).toMatch(/^evt_/u);
    expect(turn.traceId).toMatch(/^trace_/u);
    expect(turn).toEqual({
      eventId: turn.eventId,
      traceId: turn.traceId,
      status: 'rejected',
      steps: rejectedInputTraceSteps,
      visibleMessages: [],
      reason: 'Provide exactly one non-empty message.'
    });
  });

  it('prints rejected role-model evidence without fake visible messages after process restart', async () => {
    const storeRoot = await createTempStoreRoot();

    await seedRejectedRoleModelSession(storeRoot, 'mira-local');

    const result = await runInspectCli([
      '--store',
      storeRoot,
      '--session',
      'mira-local'
    ]);
    const output = parseJson(result.stdout) as InspectSessionOutput;

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: ''
    });
    expect(output.counts).toEqual({
      traceEntries: 6,
      rawEvents: 4,
      conversationMessages: 0
    });
    expect(output.turns).toHaveLength(1);

    const turn = output.turns[0];

    if (turn === undefined) {
      throw new Error('Expected one inspected role-model rejected turn.');
    }

    expect(turn).toEqual({
      eventId: 'evt_rejected_role_model',
      traceId: 'trace_rejected_role_model',
      status: 'rejected',
      steps: [
        'runtime_event_received',
        'runtime_event_normalized',
        'runtime_turn_started',
        'commit_validation_rejected',
        'raw_event_log_appended',
        'runtime_turn_rejected'
      ],
      visibleMessages: [],
      roleModelEvidence: {
        input: {
          sessionId: 'mira-local',
          allowedTools: [
            roleModelVisibleReplyActionName,
            'character_state.patch'
          ],
          outputContractVersion: 'mvp-006.tool_calls.v1',
          currentUserMessage: 'hello',
          recentVisibleMessages: [],
          runtimeNotes: []
        },
        output: {
          rawOutputText: 'not json'
        },
        parsedDecision: {
          status: 'rejected',
          rejectionReason: roleModelMalformedOutputRejectionReason,
          rejectionDetails: 'Adapter output must be valid JSON.'
        },
        commitValidation: {
          status: 'rejected',
          rejectionReason: roleModelMalformedOutputRejectionReason,
          rejectionDetails: 'Adapter output must be valid JSON.'
        }
      },
      reason: roleModelMalformedOutputRejectionReason
    });
  });

  it('does not mutate session metadata or runtime logs while inspecting', async () => {
    const storeRoot = await createTempStoreRoot();

    await expect(seedChatSession(storeRoot, 'mira-local', 'hello\n/exit\n')).resolves.toMatchObject({
      exitCode: 0
    });

    const before = await readDurableFiles(storeRoot, 'mira-local');

    await expect(
      runInspectCli(['--store', storeRoot, '--sessions'])
    ).resolves.toMatchObject({
      exitCode: 0
    });
    const inspectResult = await runInspectCli([
      '--store',
      storeRoot,
      '--session',
      'mira-local'
    ]);
    const output = parseJson(inspectResult.stdout) as InspectSessionOutput;

    expect(inspectResult).toMatchObject({
      exitCode: 0
    });
    expect(output.turns[0]?.roleModelEvidence).toMatchObject({
      parsedDecision: {
        status: 'accepted'
      },
      commitValidation: {
        status: 'accepted',
        acceptedVisibleReplyText: "I'm here. Tell me what you need."
      }
    });

    await expect(readDurableFiles(storeRoot, 'mira-local')).resolves.toEqual(before);
  });

  it('fails clearly when the selected session does not exist', async () => {
    const storeRoot = await createTempStoreRoot();

    await expect(seedChatSession(storeRoot, 'existing', '/exit\n')).resolves.toMatchObject({
      exitCode: 0
    });

    const result = await runInspectCli(['--store', storeRoot, '--session', 'missing']);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Local runtime session "missing" does not exist.\n'
    });
  });

  it('rejects ambiguous inspect modes before reading storage', async () => {
    const result = await runInspectCli([
      '--sessions',
      '--session',
      'mira-local'
    ]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Use either --sessions or --session, not both.\n'
    });
  });

  it('fails clearly when terminal raw turn evidence is missing status', async () => {
    const storeRoot = await createTempStoreRoot();

    await expect(seedChatSession(storeRoot, 'mira-local', 'hello\n/exit\n')).resolves.toMatchObject({
      exitCode: 0
    });

    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    await writeFile(
      paths.rawEventsPath,
      `${JSON.stringify({
        eventId: 'evt_missing_status',
        traceId: 'trace_missing_status',
        createdAt: '2026-06-05T00:00:00.000Z',
        kind: 'runtime_turn_completed',
        eventType: 'USER_MESSAGE',
        visibleMessageIds: ['mira-local:message-1', 'mira-local:message-2']
      })}\n`,
      'utf8'
    );

    await expect(
      runInspectCli(['--store', storeRoot, '--session', 'mira-local'])
    ).resolves.toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Stored local runtime field "status" is malformed.\n'
    });
  });
});

describe('pnpm --silent inspect', () => {
  afterEach(async () => {
    await Promise.all(
      tempStoreRoots.splice(0).map(async (root) => {
        await rm(root, { recursive: true, force: true });
      })
    );
  });

  it('runs the inspect package script without package-manager output', async () => {
    const storeRoot = await createTempStoreRoot();

    await expect(seedChatSession(storeRoot, 'mira-local', '/exit\n')).resolves.toMatchObject({
      exitCode: 0
    });

    const result = await runCommand(
      'pnpm',
      ['--silent', 'inspect', '--', '--store', storeRoot, '--sessions'],
      ''
    );
    const output = parseJson(result.stdout) as InspectSessionListOutput;

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: ''
    });
    expect(output.sessions.map((session) => session.sessionId)).toEqual([
      'mira-local'
    ]);
  });
});

async function seedChatSession(
  storeRoot: string,
  sessionId: string,
  stdin: string
): Promise<CommandResult> {
  return await runCommand(
    'node',
    [
      'src/chat-cli.ts',
      '--store',
      storeRoot,
      '--new-session',
      sessionId
    ],
    stdin
  );
}

async function seedRejectedRoleModelSession(
  storeRoot: string,
  sessionId: string
): Promise<void> {
  const sessionStore = createLocalRuntimeSessionStore({
    storeRoot,
    now: () => '2026-06-09T00:00:00.000Z'
  });
  await sessionStore.createSession({
    sessionId,
    createdAt: '2026-06-09T00:00:00.000Z'
  });

  const session = createConversationSession({
    id: sessionId
  });
  const logStore = createFileRuntimeLogStore({
    storeRoot,
    sessionId
  });
  const event = createUserMessageRuntimeEvent(
    'hello',
    createRuntimeEventIdentity({
      eventId: 'evt_rejected_role_model',
      traceId: 'trace_rejected_role_model',
      createdAt: '2026-06-09T00:00:00.000Z'
    })
  );
  const result = await runLocalUserMessageEvent({
    event,
    session,
    logStore,
    roleModelAdapter: createRawOutputAdapter('not json')
  });

  expect(result.status).toBe('rejected');
}

function createRawOutputAdapter(rawOutputText: string): RoleModelAdapter {
  return Object.freeze({
    invoke() {
      return Object.freeze({
        rawOutputText
      });
    }
  } satisfies RoleModelAdapter);
}

async function runInspectCli(args: readonly string[]): Promise<CommandResult> {
  return await runCommand('node', ['src/inspect-cli.ts', ...args], '');
}

async function createTempStoreRoot(): Promise<string> {
  const storeRoot = await mkdtemp(join(tmpdir(), 'project02-inspect-cli-'));

  tempStoreRoots.push(storeRoot);
  return storeRoot;
}

async function readDurableFiles(
  storeRoot: string,
  sessionId: string
): Promise<readonly string[]> {
  const layout = createLocalRuntimeStorageLayout({ storeRoot });
  const paths = createLocalRuntimeSessionPaths({ storeRoot, sessionId });

  return await Promise.all(
    [
      layout.schemaPath,
      layout.sessionCatalogPath,
      paths.tracePath,
      paths.rawEventsPath,
      paths.conversationPath
    ].map(async (filePath) => await readFile(filePath, 'utf8'))
  );
}

async function runCommand(
  command: string,
  args: readonly string[],
  stdin: string
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stdin.end(stdin);

  const [stdout, stderr, exitCode] = await Promise.all([
    collectStream(child.stdout),
    collectStream(child.stderr),
    waitForExit(child)
  ]);

  return {
    exitCode,
    stdout,
    stderr
  };
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];

  return await new Promise((resolvePromise, rejectPromise) => {
    stream.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
        return;
      }

      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      }
    });
    stream.on('end', () => {
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', rejectPromise);
  });
}

async function waitForExit(child: ChildProcess): Promise<number> {
  return await new Promise((resolvePromise, rejectPromise) => {
    child.on('close', (code) => {
      resolvePromise(code ?? 1);
    });
    child.on('error', rejectPromise);
  });
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
