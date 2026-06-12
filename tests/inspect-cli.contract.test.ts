import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  agentCapabilityContractVersion,
  createConversationSession,
  createAgentCapabilityTurnEvidenceSnapshot,
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
import type {
  AgentCapabilityEvidenceSnapshot,
  AgentCapabilityTurnEvidenceSnapshot,
  RuntimeEventIdentity
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
    readonly capabilityEvidence?: {
      readonly contractVersion?: string;
      readonly capabilities: readonly {
        readonly capabilityId: string;
        readonly displayName: string;
        readonly enabled: boolean;
        readonly availableForTurn: boolean;
        readonly configFingerprint?: string;
        readonly healthStatus?: string;
        readonly providedTools: readonly {
          readonly name: string;
        }[];
      }[];
      readonly contextItems: readonly {
        readonly capabilityId: string;
        readonly text: string;
        readonly sourceReferences: readonly {
          readonly kind: string;
          readonly id: string;
          readonly uri?: string;
        }[];
      }[];
      readonly evidence: readonly {
        readonly capabilityId: string;
        readonly evidenceKind: string;
        readonly status: string;
        readonly summary: string;
        readonly policyOutcome?: string;
      }[];
      readonly policyOutcomes: readonly string[];
      readonly health: readonly {
        readonly capabilityId: string;
        readonly status: string;
        readonly summary: string;
      }[];
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

  it('prints stored capability evidence and listing state without running hooks', async () => {
    const storeRoot = await createTempStoreRoot();

    await seedCapabilityEvidenceSession(storeRoot, 'mira-local');

    const before = await readDurableFiles(storeRoot, 'mira-local');
    const result = await runInspectCli([
      '--store',
      storeRoot,
      '--session',
      'mira-local'
    ]);
    const output = parseJson(result.stdout) as InspectSessionOutput;
    const turn = output.turns[0];

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: ''
    });
    expect(output.counts).toEqual({
      traceEntries: 4,
      rawEvents: 3,
      conversationMessages: 0
    });
    expect(turn?.capabilityEvidence).toMatchObject({
      contractVersion: agentCapabilityContractVersion,
      capabilities: [
        {
          capabilityId: 'memory.fixture',
          displayName: 'Fixture memory',
          enabled: true,
          availableForTurn: false,
          configFingerprint: 'gateway_api_key=[redacted]',
          healthStatus: 'degraded',
          providedTools: [
            {
              name: 'memory.search'
            }
          ]
        }
      ],
      contextItems: [
        {
          capabilityId: 'memory.fixture',
          text: 'memory api_key=[redacted]',
          sourceReferences: [
            {
              kind: 'memory',
              id: 'mem_1',
              uri: 'https://[redacted]@memory.local/item?token=[redacted]'
            }
          ]
        }
      ],
      policyOutcomes: [
        'required_rejected',
        'optional_degraded',
        'disallowed_tool_call',
        'handler_rejected',
        'timeout',
        'health_degraded',
        'after_commit_failed'
      ],
      health: [
        {
          capabilityId: 'memory.fixture',
          status: 'degraded',
          summary: 'health token=[redacted]'
        }
      ]
    });
    expect(turn?.capabilityEvidence?.evidence).toHaveLength(7);
    expect(JSON.stringify(turn?.capabilityEvidence)).not.toContain('secret-token');
    await expect(readDurableFiles(storeRoot, 'mira-local')).resolves.toEqual(before);
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

async function seedCapabilityEvidenceSession(
  storeRoot: string,
  sessionId: string
): Promise<void> {
  const sessionStore = createLocalRuntimeSessionStore({
    storeRoot,
    now: () => '2026-06-12T00:00:00.000Z'
  });
  await sessionStore.createSession({
    sessionId,
    createdAt: '2026-06-12T00:00:00.000Z'
  });

  const logStore = createFileRuntimeLogStore({
    storeRoot,
    sessionId
  });
  const identity = createRuntimeEventIdentity({
    eventId: 'evt_capability_required_rejected',
    traceId: 'trace_capability_required_rejected',
    createdAt: '2026-06-12T00:00:00.000Z'
  });
  const payloadSummary = {
    rawInput: 'remember this',
    normalizedCurrentUserMessage: 'remember this'
  };

  logStore.appendTrace({
    ...identity,
    step: 'runtime_event_received'
  });
  logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE',
    payloadSummary
  });
  logStore.appendTrace({
    ...identity,
    step: 'capability_before_role_model_call_rejected'
  });
  logStore.appendRawEvent({
    ...identity,
    kind: 'capability_before_role_model_call_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: 'required capability failed',
    payloadSummary,
    ...createInspectCapabilityDualStorageEvidence(identity)
  });
  logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_turn_rejected',
    eventType: 'USER_MESSAGE',
    status: 'rejected',
    reason: 'required capability failed',
    payloadSummary,
    ...createInspectCapabilityDualStorageEvidence(identity)
  });
  logStore.appendTrace({
    ...identity,
    step: 'raw_event_log_appended'
  });
  logStore.appendTrace({
    ...identity,
    step: 'runtime_turn_rejected'
  });
}

function createInspectCapabilityDualStorageEvidence(
  identity: RuntimeEventIdentity
): {
  readonly agentCapabilityEvidence: readonly AgentCapabilityEvidenceSnapshot[];
  readonly agentCapabilityTurnEvidence: AgentCapabilityTurnEvidenceSnapshot;
} {
  const turnEvidence = createInspectCapabilityEvidence(identity);

  return Object.freeze({
    agentCapabilityEvidence: turnEvidence.evidence,
    agentCapabilityTurnEvidence: turnEvidence
  });
}

function createInspectCapabilityEvidence(
  identity: RuntimeEventIdentity
): AgentCapabilityTurnEvidenceSnapshot {
  return createAgentCapabilityTurnEvidenceSnapshot({
    ...identity,
    kind: 'agent_capability_turn_evidence_snapshot',
    contractVersion: agentCapabilityContractVersion,
    capabilities: [
      {
        capabilityId: 'memory.fixture',
        manifest: {
          id: 'memory.fixture',
          displayName: 'Fixture memory',
          version: '1.0.0',
          kind: 'memory_provider',
          description: 'Fixture memory provider.',
          contractVersion: agentCapabilityContractVersion,
          compatibility: {
            hostContractVersions: [agentCapabilityContractVersion],
            sourceSystem: 'project02'
          },
          declaredCapabilities: [
            'context_provider',
            'before_role_model_call',
            'tool_provider',
            'handle_tool_call',
            'after_turn_committed',
            'health'
          ],
          config: {
            fields: [
              {
                name: 'gateway_api_key',
                description: 'Gateway API key.',
                required: true,
                secret: true,
                redactionLabels: ['secret']
              }
            ],
            fingerprint: 'gateway_api_key=secret-token'
          },
          localTrustLevel: 'test_fixture',
          runtimePolicy: {
            requiredForTurn: true,
            sideEffectLevel: 'local_memory_write',
            confirmation: 'not_required',
            timeoutMs: 1000,
            sourceReferencesRequired: true,
            redactionLabels: ['secret'],
            failureBehavior: {
              beforeRoleModelCall: 'reject_turn',
              handleToolCall: 'degrade',
              afterTurnCommitted: 'log_failure',
              health: 'degrade'
            }
          },
          activation: {
            defaultEnabled: true,
            reasons: ['inspect_test']
          }
        },
        providedTools: [
          {
            name: 'memory.search',
            description: 'Search memory.',
            requiredForUserTurn: false,
            maxCallsPerUserTurn: 1,
            inputContract: {
              type: 'object',
              additionalFields: false,
              fields: [
                {
                  name: 'query',
                  description: 'Search query.',
                  required: true
                }
              ]
            },
            validationOwner: 'capability_host',
            sideEffectLevel: 'runtime_read',
            requiresConfirmation: false,
            sourceReferencesRequired: true
          }
        ],
        registeredLifecycleHooks: [
          'before_role_model_call',
          'handle_tool_call',
          'after_turn_committed',
          'health'
        ],
        installed: true,
        registered: true,
        enabled: true,
        availableForTurn: false,
        redactionLabels: ['secret'],
        configFingerprint: 'gateway_api_key=secret-token',
        healthStatus: 'degraded'
      }
    ],
    contextItems: [
      {
        capabilityId: 'memory.fixture',
        id: 'memory.item_1',
        kind: 'memory',
        text: 'memory api_key=secret-token',
        budget: {
          estimatedTokens: 6,
          priority: 1
        },
        sourceReferences: [
          {
            kind: 'memory',
            id: 'mem_1',
            uri: 'https://user:secret-token@memory.local/item?token=secret-token'
          }
        ],
        redactionLabels: ['secret']
      }
    ],
    evidence: inspectCapabilityEvidenceSnapshots(identity),
    health: [
      {
        capabilityId: 'memory.fixture',
        status: 'degraded',
        checkedAt: identity.createdAt,
        summary: 'health token=secret-token',
        redactionLabels: ['secret']
      }
    ]
  });
}

function inspectCapabilityEvidenceSnapshots(
  identity: RuntimeEventIdentity
): AgentCapabilityTurnEvidenceSnapshot['evidence'] {
  return [
    {
      ...identity,
      kind: 'agent_capability_evidence_snapshot',
      capabilityId: 'memory.fixture',
      evidenceKind: 'before_role_model_call',
      status: 'rejected',
      summary: 'required failed',
      policyOutcome: 'required_rejected',
      redactionLabels: ['secret']
    },
    {
      ...identity,
      kind: 'agent_capability_evidence_snapshot',
      capabilityId: 'memory.fixture',
      evidenceKind: 'before_role_model_call',
      status: 'degraded',
      summary: 'optional degraded',
      policyOutcome: 'optional_degraded',
      redactionLabels: ['secret']
    },
    {
      ...identity,
      kind: 'agent_capability_evidence_snapshot',
      capabilityId: 'memory.fixture',
      evidenceKind: 'tool_invocation',
      status: 'rejected',
      summary: 'tool disallowed',
      policyOutcome: 'disallowed_tool_call',
      redactionLabels: []
    },
    {
      ...identity,
      kind: 'agent_capability_evidence_snapshot',
      capabilityId: 'memory.fixture',
      evidenceKind: 'tool_invocation',
      status: 'rejected',
      summary: 'handler rejected',
      policyOutcome: 'handler_rejected',
      redactionLabels: []
    },
    {
      ...identity,
      kind: 'agent_capability_evidence_snapshot',
      capabilityId: 'memory.fixture',
      evidenceKind: 'tool_invocation',
      status: 'failed',
      summary: 'timed out',
      policyOutcome: 'timeout',
      redactionLabels: []
    },
    {
      ...identity,
      kind: 'agent_capability_evidence_snapshot',
      capabilityId: 'memory.fixture',
      evidenceKind: 'health',
      status: 'degraded',
      summary: 'health degraded',
      policyOutcome: 'health_degraded',
      redactionLabels: []
    },
    {
      ...identity,
      kind: 'agent_capability_evidence_snapshot',
      capabilityId: 'memory.fixture',
      evidenceKind: 'after_turn_committed',
      status: 'failed',
      summary: 'capture failed',
      policyOutcome: 'after_commit_failed',
      redactionLabels: []
    }
  ];
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
    ].map(readFileIfPresent)
  );
}

async function readFileIfPresent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (
      isNodeErrorWithCode(error) &&
      error.code === 'ENOENT'
    ) {
      return '';
    }

    throw error;
  }
}

function isNodeErrorWithCode(error: unknown): error is { readonly code: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
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
