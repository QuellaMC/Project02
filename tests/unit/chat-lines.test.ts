import {PassThrough} from 'node:stream';

import {describe, expect, it} from 'vitest';

import {createLineDispatcher} from '../../src/cli/chat/lines.ts';

describe('chat line dispatcher', () => {
  it('hands a line to the prompt ahead of the REPL, then the next one to the REPL', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);
    const repl = lines.replLine();
    const prompt = lines.promptLine();

    stdin.write('yes\nhello\n');

    await expect(prompt).resolves.toBe('yes');
    await expect(repl).resolves.toBe('hello');
    lines.close();
  });

  it('withdraws a prompt on abort and keeps a line read for it for the next reader', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);
    const withdrawn = new AbortController();
    const prompt = lines.promptLine(withdrawn.signal);

    withdrawn.abort();
    await expect(prompt).resolves.toBeUndefined();

    // The read the prompt started still completes; nothing typed is lost.
    stdin.write('hello\n');
    await new Promise(resolve => setImmediate(resolve));
    await expect(lines.replLine()).resolves.toBe('hello');
    await expect(
      lines.promptLine(AbortSignal.abort()),
    ).resolves.toBeUndefined();
    lines.close();
  });

  it('settles every waiter once the input ends', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);
    const repl = lines.replLine();
    const prompt = lines.promptLine();

    stdin.end();

    await expect(prompt).resolves.toBeUndefined();
    await expect(repl).resolves.toBeUndefined();
    await expect(lines.replLine()).resolves.toBeUndefined();
  });
});
