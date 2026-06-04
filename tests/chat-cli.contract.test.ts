import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
  readonly error?: string;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

describe('node src/chat-cli.ts', () => {
  it('runs a two-turn local character session', async () => {
    const result = await runChatCli('hello\nstill there?\n/exit\n');

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

  it('exits cleanly when /exit is the first input', async () => {
    const result = await runChatCli('/exit\n');

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'Mira is ready.\nYou: ',
      stderr: ''
    });
  });

  it('reports invalid input, keeps the session open, and does not emit a character reply for the invalid turn', async () => {
    const result = await runChatCli('\nhello\n/exit\n');

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
    const result = await runChatCli('hello\nstill there?\n/exit\n', ['--trace']);
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
        steps: successfulTraceSteps
      }),
      expect.objectContaining({
        status: 'completed',
        steps: successfulTraceSteps
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
    const result = await runChatCli('\nhello\n/exit\n', ['--trace']);
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
        steps: successfulTraceSteps
      })
    ]);
  });

  it('does not emit a trace summary for /exit', async () => {
    const result = await runChatCli('/exit\n', ['--trace']);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'Mira is ready.\nYou: ',
      stderr: ''
    });
  });
});

describe('pnpm --silent chat', () => {
  it('runs the chat package script without package-manager output', async () => {
    const result = await runCommand('pnpm', ['--silent', 'chat'], '/exit\n');

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'Mira is ready.\nYou: ',
      stderr: ''
    });
  });

  it('passes trace mode arguments through the chat package script', async () => {
    const result = await runCommand(
      'pnpm',
      ['--silent', 'chat', '--', '--trace'],
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
