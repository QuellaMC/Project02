import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Readable } from 'node:stream';

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('node src/relay-cli.ts', () => {
  it('prints exactly one deterministic reply line for a valid message', async () => {
    const result = await runRelay(['hello']);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'relay: hello\n',
      stderr: ''
    });
  });

  it('rejects missing input with stderr and no stdout reply', async () => {
    const result = await runRelay([]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Error: Provide exactly one non-empty message.\n');
  });

  it('rejects blank input with stderr and no stdout reply', async () => {
    const result = await runRelay(['   ']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Error: Provide exactly one non-empty message.\n');
  });

  it('rejects multiline input with stderr and no stdout reply', async () => {
    const result = await runRelay(['hello\nthere']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Error: Provide exactly one non-empty single-line message.\n'
    );
  });
});

async function runRelay(args: readonly string[]): Promise<CommandResult> {
  const child = spawn('node', ['src/relay-cli.ts', '--', ...args], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });

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
