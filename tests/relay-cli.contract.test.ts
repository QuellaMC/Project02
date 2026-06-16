import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runRelayCli } from '../src/cli/relay.ts';

describe('relay CLI compatibility wrapper', () => {
  it('routes a single relay message through the current chat CLI', async () => {
    let stdout = '';
    let stderr = '';

    const exitCode = await runRelayCli(['hello'], {
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect((chunk) => {
        stderr += chunk;
      })
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Mira is ready.\n');
    expect(stdout).toContain("Mira: I'm here. Tell me what you need.\n");
  });

  it('keeps the old pnpm separator form working', async () => {
    let stdout = '';

    const exitCode = await runRelayCli(['--', 'hello'], {
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect(() => {})
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Mira: I'm here. Tell me what you need.\n");
  });

  it('rejects missing input with the existing one-line message error', async () => {
    let stderr = '';

    const exitCode = await runRelayCli([], {
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      })
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toBe('Error: Provide exactly one non-empty message.\n');
  });

  it('rejects multiline input with the existing one-line message error', async () => {
    let stderr = '';

    const exitCode = await runRelayCli(['hello\nthere'], {
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      })
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toBe(
      'Error: Provide exactly one non-empty single-line message.\n'
    );
  });
});

function collect(onWrite: (chunk: string) => void): Writable {
  return new Writable({
    write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ) {
      onWrite(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
      callback();
    }
  });
}
