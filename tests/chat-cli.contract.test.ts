import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { runChatCli as runChatCliInProcess } from '../src/chat-cli.ts';
import {
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  defaultNvidiaRoleModelName,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  type CharacterAgent,
  type RuntimeLogStore
} from '../src/index.ts';

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type TraceSummary = {
  readonly eventId: string;
  readonly traceId: string;
  readonly status: 'completed' | 'rejected';
  readonly steps: readonly string[];
  readonly provider?: {
    readonly name: string;
    readonly model?: string;
    readonly responseStatus?: number;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  };
  readonly toolCalls?: readonly string[];
  readonly characterStatePatch?: {
    readonly status: string;
    readonly appliedChangeCount?: number;
    readonly rejectionReason?: string;
  };
  readonly error?: string;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempStoreRoots: string[] = [];
let tempSessionCounter = 0;

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

const unexpectedFailureTraceSteps = [
  'runtime_event_received',
  'runtime_event_normalized',
  'runtime_turn_started',
  'raw_event_log_appended',
  'runtime_turn_rejected'
] as const;

describe('node src/chat-cli.ts', () => {
  afterEach(async () => {
    await Promise.all(
      tempStoreRoots.splice(0).map(async (root) => {
        await rm(root, { recursive: true, force: true });
      })
    );
  });

  it('runs a two-turn local character session', async () => {
    const result = await runFreshChatCli('hello\nstill there?\n/exit\n');

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        'Mira is ready.\n' +
        "You: Mira: I'm here. Tell me what you need.\n" +
        'You: Mira: I remember you said "hello" Stay with me for a minute.\n' +
        'You: ',
      stderr: ''
    });
  });

  it('fails clearly when the NVIDIA provider is selected without an API key', async () => {
    const storeRoot = await createTempStoreRoot();
    const result = await runCommand(
      'node',
      [
        'src/chat-cli.ts',
        '--store',
        storeRoot,
        '--new-session',
        createTempSessionId(),
        '--provider',
        'nvidia'
      ],
      'hello\n',
      {
        NVIDIA_API_KEY: '',
        PROJECT02_ROLE_MODEL_PROVIDER: ''
      }
    );

    expect(result).toEqual({
      exitCode: 1,
      stdout: 'Mira is ready.\nYou: ',
      stderr: 'Error: NVIDIA provider requires NVIDIA_API_KEY.\n'
    });
  });

  it('emits provider error status in trace mode when NVIDIA configuration is missing', async () => {
    const storeRoot = await createTempStoreRoot();
    const result = await runCommand(
      'node',
      [
        'src/chat-cli.ts',
        '--store',
        storeRoot,
        '--new-session',
        createTempSessionId(),
        '--trace',
        '--provider',
        'nvidia'
      ],
      'hello\n',
      {
        NVIDIA_API_KEY: '',
        PROJECT02_ROLE_MODEL_PROVIDER: ''
      }
    );
    const traceSummaries = parseTraceSummaries(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('Mira is ready.\nYou: ');
    expect(traceSummaries).toEqual([
      expect.objectContaining({
        status: 'rejected',
        provider: {
          name: 'nvidia',
          model: defaultNvidiaRoleModelName,
          errorCode: 'missing_api_key',
          errorMessage: 'NVIDIA provider requires NVIDIA_API_KEY.'
        },
        characterStatePatch: {
          status: 'not_requested'
        },
        error: 'NVIDIA provider requires NVIDIA_API_KEY.'
      })
    ]);
  });

  it('uses the provider environment default but lets the CLI flag choose local', async () => {
    const envSelected = await runCommand(
      'node',
      ['src/chat-cli.ts', '--store', await createTempStoreRoot()],
      'hello\n',
      {
        NVIDIA_API_KEY: '',
        PROJECT02_ROLE_MODEL_PROVIDER: 'nvidia'
      }
    );
    const cliSelected = await runCommand(
      'node',
      [
        'src/chat-cli.ts',
        '--store',
        await createTempStoreRoot(),
        '--provider',
        'local'
      ],
      'hello\n/exit\n',
      {
        NVIDIA_API_KEY: '',
        PROJECT02_ROLE_MODEL_PROVIDER: 'nvidia'
      }
    );

    expect(envSelected.stderr).toBe(
      'Error: NVIDIA provider requires NVIDIA_API_KEY.\n'
    );
    expect(cliSelected).toEqual({
      exitCode: 0,
      stdout:
        'Mira is ready.\n' +
        "You: Mira: I'm here. Tell me what you need.\n" +
        'You: ',
      stderr: ''
    });
  });

  it('exits cleanly when /exit is the first input', async () => {
    const result = await runFreshChatCli('/exit\n');

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'Mira is ready.\nYou: ',
      stderr: ''
    });
  });

  it('reports invalid input, keeps the session open, and does not emit a character reply for the invalid turn', async () => {
    const result = await runFreshChatCli('\nhello\n/exit\n');

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        'Mira is ready.\n' +
        "You: You: Mira: I'm here. Tell me what you need.\n" +
        'You: ',
      stderr: 'Error: Provide exactly one non-empty message.\n'
    });
  });

  it('emits trace JSONL to stderr without changing normal chat stdout', async () => {
    const result = await runFreshChatCli('hello\nstill there?\n/exit\n', [
      '--trace'
    ]);
    const traceSummaries = parseTraceSummaries(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Mira is ready.\n' +
      "You: Mira: I'm here. Tell me what you need.\n" +
      'You: Mira: I remember you said "hello" Stay with me for a minute.\n' +
      'You: '
    );
    expect(traceSummaries).toHaveLength(2);
    expect(traceSummaries).toEqual([
      expect.objectContaining({
        status: 'completed',
        steps: successfulTraceSteps,
        toolCalls: ['visible_reply'],
        characterStatePatch: {
          status: 'not_requested'
        }
      }),
      expect.objectContaining({
        status: 'completed',
        steps: successfulTraceSteps,
        toolCalls: ['visible_reply'],
        characterStatePatch: {
          status: 'not_requested'
        }
      })
    ]);
    expect(traceSummaries[0]?.eventId).toMatch(/^evt_/u);
    expect(traceSummaries[0]?.traceId).toMatch(/^trace_/u);
    expect(traceSummaries[0]?.eventId).not.toBe(traceSummaries[0]?.traceId);
    expect(traceSummaries[1]?.eventId).toMatch(/^evt_/u);
    expect(traceSummaries[1]?.traceId).toMatch(/^trace_/u);
    expect(traceSummaries[0]?.eventId).not.toBe(traceSummaries[1]?.eventId);
    expect(traceSummaries[0]?.traceId).not.toBe(traceSummaries[1]?.traceId);
  });

  it('emits rejected trace JSONL for invalid input and keeps the session open', async () => {
    const result = await runFreshChatCli('\nhello\n/exit\n', ['--trace']);
    const traceSummaries = parseTraceSummaries(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Mira is ready.\n' +
      "You: You: Mira: I'm here. Tell me what you need.\n" +
      'You: '
    );
    expect(traceSummaries).toEqual([
      expect.objectContaining({
        status: 'rejected',
        steps: rejectedInputTraceSteps,
        error: 'Provide exactly one non-empty message.'
      }),
      expect.objectContaining({
        status: 'completed',
        steps: successfulTraceSteps,
        toolCalls: ['visible_reply'],
        characterStatePatch: {
          status: 'not_requested'
        }
      })
    ]);
  });

  it('emits rejected trace JSONL before exiting when runtime handling fails unexpectedly', async () => {
    const stdout = new CapturingWritable();
    const stderr = new CapturingWritable();
    const throwingAgent: CharacterAgent = {
      reply() {
        throw new Error('agent transport unavailable');
      }
    };

    const exitCode = await runChatCliInProcess({
      stdin: Readable.from(['hello\n']),
      stdout,
      stderr,
      traceMode: true,
      agent: throwingAgent
    });
    const traceSummaries = parseTraceSummaries(stderr.contents());

    expect(exitCode).toBe(1);
    expect(stdout.contents()).toBe('Mira is ready.\nYou: ');
    expect(traceSummaries).toEqual([
      expect.objectContaining({
        status: 'rejected',
        steps: unexpectedFailureTraceSteps,
        error: 'Chat failed before producing a reply.'
      })
    ]);
  });

  it('reports storage failures during a turn without masking them as reply failures', async () => {
    const stdout = new CapturingWritable();
    const stderr = new CapturingWritable();

    const exitCode = await runChatCliInProcess({
      stdin: Readable.from(['hello\n']),
      stdout,
      stderr,
      logStore: createWriteFailingLogStore()
    });

    expect(exitCode).toBe(1);
    expect(stdout.contents()).toBe('Mira is ready.\nYou: ');
    expect(stderr.contents()).toBe(
      'Error: Local runtime store could not be written.\n'
    );
  });

  it('does not emit a trace summary for /exit', async () => {
    const result = await runFreshChatCli('/exit\n', ['--trace']);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'Mira is ready.\nYou: ',
      stderr: ''
    });
  });

  it('creates a durable session and resumes persisted visible context by session ID', async () => {
    const storeRoot = await createTempStoreRoot();
    const first = await runChatCli('hello\n/exit\n', [
      '--store',
      storeRoot,
      '--new-session',
      'mira-local'
    ]);
    const second = await runChatCli('still there?\n/exit\n', [
      '--store',
      storeRoot,
      '--session',
      'mira-local'
    ]);

    expect(first).toEqual({
      exitCode: 0,
      stdout:
        'Mira is ready.\n' +
        "You: Mira: I'm here. Tell me what you need.\n" +
        'You: ',
      stderr: ''
    });
    expect(second).toEqual({
      exitCode: 0,
      stdout:
        'Mira is ready.\n' +
        'You: Mira: I remember you said "hello" Stay with me for a minute.\n' +
        'You: ',
      stderr: ''
    });
  });

  it('creates and resumes the default session in a selected durable store', async () => {
    const storeRoot = await createTempStoreRoot();
    const first = await runChatCli('hello\n/exit\n', ['--store', storeRoot]);
    const second = await runChatCli('still there?\n/exit\n', [
      '--store',
      storeRoot
    ]);

    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe('');
    expect(second).toEqual({
      exitCode: 0,
      stdout:
        'Mira is ready.\n' +
        'You: Mira: I remember you said "hello" Stay with me for a minute.\n' +
        'You: ',
      stderr: ''
    });
  });

  it('does not append selection metadata when selected-session validation fails', async () => {
    const storeRoot = await createTempStoreRoot();
    const layout = createLocalRuntimeStorageLayout({
      storeRoot
    });
    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    await expect(
      runChatCli('hello\n/exit\n', [
        '--store',
        storeRoot,
        '--new-session',
        'mira-local'
      ])
    ).resolves.toMatchObject({
      exitCode: 0
    });

    const catalogBefore = await readFile(layout.sessionCatalogPath, 'utf8');

    await writeFile(paths.conversationPath, '{"eventId":"evt_partial"}', 'utf8');

    const result = await runChatCli('/exit\n', [
      '--store',
      storeRoot,
      '--session',
      'mira-local'
    ]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Local runtime store write did not complete.\n'
    });
    await expect(readFile(layout.sessionCatalogPath, 'utf8')).resolves.toBe(
      catalogBefore
    );
  });

  it('fails loudly instead of repairing a partial default store with a missing schema marker', async () => {
    const storeRoot = await createTempStoreRoot();
    const paths = createLocalRuntimeSessionPaths({
      storeRoot
    });

    await mkdir(paths.sessionRoot, { recursive: true });
    await writeFile(paths.conversationPath, '{"orphan":true}\n', 'utf8');

    const result = await runChatCli('/exit\n', ['--store', storeRoot]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Local runtime store is missing required files.\n'
    });
  });

  it('fails loudly instead of treating a missing session catalog as empty when session logs exist', async () => {
    const storeRoot = await createTempStoreRoot();
    const layout = createLocalRuntimeStorageLayout({
      storeRoot
    });
    const paths = createLocalRuntimeSessionPaths({
      storeRoot
    });

    await mkdir(paths.sessionRoot, { recursive: true });
    await writeFile(
      layout.schemaPath,
      `${encodeStorageSchemaMarker(
        createLocalRuntimeStorageSchemaMarker({
          createdAt: '2026-06-04T00:00:00.000Z'
        })
      )}\n`,
      'utf8'
    );
    await writeFile(paths.conversationPath, '{"orphan":true}\n', 'utf8');

    const result = await runChatCli('/exit\n', ['--store', storeRoot]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Local runtime store is missing required files.\n'
    });
  });

  it('rejects --new-session when that session already exists', async () => {
    const storeRoot = await createTempStoreRoot();

    await expect(
      runChatCli('/exit\n', ['--store', storeRoot, '--new-session', 'fresh'])
    ).resolves.toMatchObject({
      exitCode: 0
    });

    const result = await runChatCli('/exit\n', [
      '--store',
      storeRoot,
      '--new-session',
      'fresh'
    ]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Local runtime session "fresh" already exists.\n'
    });
  });

  it('rejects --session when the selected session does not exist', async () => {
    const storeRoot = await createTempStoreRoot();

    await expect(
      runChatCli('/exit\n', ['--store', storeRoot, '--new-session', 'existing'])
    ).resolves.toMatchObject({
      exitCode: 0
    });

    const result = await runChatCli('/exit\n', [
      '--store',
      storeRoot,
      '--session',
      'missing'
    ]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Local runtime session "missing" does not exist.\n'
    });
  });

  it('rejects unsafe --session values through the CT-01 session ID validator', async () => {
    const result = await runChatCli('/exit\n', ['--session', 'a/b']);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr:
        'Error: Local runtime session ID must use only letters, numbers, dots, underscores, or hyphens.\n'
    });
  });

  it('rejects empty --store values through the CT-01 store-root validator', async () => {
    const result = await runChatCli('/exit\n', ['--store', '']);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Local runtime store root must be non-empty.\n'
    });
  });

  it('rejects ambiguous durable session creation and resume flags', async () => {
    const result = await runChatCli('/exit\n', [
      '--session',
      'existing',
      '--new-session',
      'fresh'
    ]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Use either --session or --new-session, not both.\n'
    });
  });

  it('rejects missing durable flag values before starting the chat loop', async () => {
    const result = await runChatCli('/exit\n', ['--store']);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: --store requires a value.\n'
    });
  });
});

describe('pnpm --silent chat', () => {
  afterEach(async () => {
    await Promise.all(
      tempStoreRoots.splice(0).map(async (root) => {
        await rm(root, { recursive: true, force: true });
      })
    );
  });

  it('runs the chat package script without package-manager output', async () => {
    const storeRoot = await createTempStoreRoot();
    const result = await runCommand(
      'pnpm',
      ['--silent', 'chat', '--', '--store', storeRoot],
      '/exit\n'
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'Mira is ready.\nYou: ',
      stderr: ''
    });
  });

  it('passes trace mode arguments through the chat package script', async () => {
    const storeRoot = await createTempStoreRoot();
    const result = await runCommand(
      'pnpm',
      [
        '--silent',
        'chat',
        '--',
        '--store',
        storeRoot,
        '--new-session',
        'package-trace',
        '--trace'
      ],
      'hello\n/exit\n'
    );
    const traceSummaries = parseTraceSummaries(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Mira is ready.\n' +
      "You: Mira: I'm here. Tell me what you need.\n" +
      'You: '
    );
    expect(traceSummaries).toEqual([
      expect.objectContaining({
        status: 'completed',
        steps: successfulTraceSteps
      })
    ]);
  });
});

describe('MVP-001 relay compatibility', () => {
  it('keeps the relay package script contract intact', async () => {
    const result = await runCommand('pnpm', ['--silent', 'relay', '--', 'hello'], '');

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'relay: hello\n',
      stderr: ''
    });
  });
});

async function runChatCli(
  stdin: string,
  args: readonly string[] = []
): Promise<CommandResult> {
  return await runCommand('node', ['src/chat-cli.ts', ...args], stdin);
}

async function runFreshChatCli(
  stdin: string,
  args: readonly string[] = []
): Promise<CommandResult> {
  const storeRoot = await createTempStoreRoot();
  const sessionId = createTempSessionId();

  return await runChatCli(stdin, [
    '--store',
    storeRoot,
    '--new-session',
    sessionId,
    ...args
  ]);
}

async function createTempStoreRoot(): Promise<string> {
  const storeRoot = await mkdtemp(join(tmpdir(), 'project02-chat-cli-'));

  tempStoreRoots.push(storeRoot);
  return storeRoot;
}

function createTempSessionId(): string {
  tempSessionCounter += 1;
  return `test-session-${String(tempSessionCounter)}`;
}

async function runCommand(
  command: string,
  args: readonly string[],
  stdin: string,
  env: NodeJS.ProcessEnv = {}
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env
    },
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

async function collectStream(stream: Readable): Promise<string> {
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

function parseTraceSummaries(stderr: string): readonly TraceSummary[] {
  if (stderr === '') {
    return [];
  }

  return stderr
    .trimEnd()
    .split('\n')
    .map((line) => {
      const parsed = JSON.parse(line) as unknown;

      if (!isTraceSummary(parsed)) {
        throw new Error(`Expected trace JSON line, received: ${line}`);
      }

      return parsed;
    });
}

function isTraceSummary(value: unknown): value is TraceSummary {
  if (!isRecord(value)) {
    return false;
  }

  const error = value['error'];

  return (
    typeof value['eventId'] === 'string' &&
    typeof value['traceId'] === 'string' &&
    (value['status'] === 'completed' || value['status'] === 'rejected') &&
    isStringArray(value['steps']) &&
    (error === undefined || typeof error === 'string')
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createWriteFailingLogStore(): RuntimeLogStore {
  return {
    appendTrace() {
      throw new LocalRuntimeStorageContractError(
        'write_failed',
        'Injected write failure.'
      );
    },
    appendRawEvent() {
      throw new LocalRuntimeStorageContractError(
        'write_failed',
        'Injected write failure.'
      );
    },
    appendConversationMessage() {
      throw new LocalRuntimeStorageContractError(
        'write_failed',
        'Injected write failure.'
      );
    },
    traceEntries() {
      return [];
    },
    rawEvents() {
      return [];
    },
    conversationMessages() {
      return [];
    }
  } satisfies RuntimeLogStore;
}

class CapturingWritable extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(
      typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk)
    );
    callback();
  }

  contents(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
