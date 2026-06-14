import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  roleModelDecisionContractVersion,
  type RoleModelAdapter
} from '../src/index.ts';
import { runChatCli } from '../src/chat-cli.ts';

describe('chat CLI folded top-level model text', () => {
  it('hides top-level model text by default', async () => {
    let stdout = '';
    const exitCode = await runChatCli({
      stdin: Readable.from(['hello\n/exit\n']),
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect(() => {}),
      roleModelAdapter: createTextOnlyAdapter()
    });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('folded model note');
  });
});

function createTextOnlyAdapter(): RoleModelAdapter {
  return {
    invoke() {
      return {
        rawOutputText: JSON.stringify({
          version: roleModelDecisionContractVersion,
          text: 'folded model note',
          toolCalls: []
        })
      };
    }
  };
}

function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk));
      callback();
    }
  });
}
