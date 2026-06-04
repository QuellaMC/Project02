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

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

async function runChatCli(stdin: string): Promise<CommandResult> {
  return await runCommand('node', ['src/chat-cli.ts'], stdin);
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
