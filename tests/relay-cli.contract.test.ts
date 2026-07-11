import { describe, expect, it } from 'vitest';

import type { CharacterAgent } from '../src/core/conversation.ts';
import { runRelayCli } from '../src/cli/relay.ts';
import { collect } from './support/runtime-config.ts';

describe('relay CLI compatibility wrapper', () => {
  it('prints exactly one non-interactive reply line', async () => {
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
    expect(stdout).toBe("Mira: I'm here. Tell me what you need.\n");
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
    expect(stdout).toBe("Mira: I'm here. Tell me what you need.\n");
  });

  it.each(['/exit', '/model-text'] as const)(
    'treats %s as relay message content',
    async (message) => {
      let stdout = '';
      let stderr = '';
      const observedMessages: string[] = [];

      const exitCode = await runRelayCli([message], {
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        agent: createEchoAgent(observedMessages)
      });

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toBe(`Mira: heard ${message}\n`);
      expect(observedMessages).toEqual([message]);
    }
  );

  it('rejects missing input with the existing one-line message error', async () => {
    let stdout = '';
    let stderr = '';

    const exitCode = await runRelayCli([], {
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect((chunk) => {
        stderr += chunk;
      })
    });

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe('');
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

function createEchoAgent(observedMessages: string[]): CharacterAgent {
  return {
    reply(input) {
      observedMessages.push(input.message);

      return {
        text: `heard ${input.message}`
      };
    }
  };
}
