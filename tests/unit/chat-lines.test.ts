import {PassThrough} from 'node:stream';

import {describe, expect, it} from 'vitest';

import {createLineDispatcher} from '../../src/cli/chat/lines.ts';

describe('chat line dispatcher', () => {
  it('gives a prompt only a line typed after it appeared, and the REPL the rest in order', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);

    // Typed while a turn was running, before any prompt.
    stdin.write('yes I will\n');
    await new Promise(resolve => setImmediate(resolve));

    const prompt = lines.promptLine();
    let answered = false;

    void prompt.then(() => {
      answered = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(answered).toBe(false);

    stdin.write('n\nhello\n');
    await expect(prompt).resolves.toBe('n');
    await expect(lines.replLine()).resolves.toBe('yes I will');
    await expect(lines.replLine()).resolves.toBe('hello');
    lines.close();
  });

  it('withdraws a prompt on abort, leaving the next line to the REPL', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);
    const withdrawn = new AbortController();
    const prompt = lines.promptLine(withdrawn.signal);

    withdrawn.abort();
    await expect(prompt).resolves.toBeUndefined();
    stdin.write('hello\n');
    await expect(lines.replLine()).resolves.toBe('hello');
    await expect(
      lines.promptLine(AbortSignal.abort()),
    ).resolves.toBeUndefined();
    lines.close();
  });

  it('serves what a piped input left queued, then answers nothing; a late prompt gets nothing', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);

    stdin.write('a chat line\n');
    stdin.end();
    await new Promise(resolve => setImmediate(resolve));

    // Silence is no: the prompt wants a newer line, and none can come.
    await expect(lines.promptLine()).resolves.toBeUndefined();
    await expect(lines.replLine()).resolves.toBe('a chat line');
    await expect(lines.replLine()).resolves.toBeUndefined();
  });

  it('rejects pending reads when the input fails, and drops the queue when the terminal closes', async () => {
    const failing = new PassThrough();
    const failed = createLineDispatcher(failing);
    const read = failed.replLine();
    const prompt = failed.promptLine();

    failing.destroy(new Error('the pipe broke'));
    await expect(prompt).rejects.toThrow('the pipe broke');
    await expect(read).rejects.toThrow('the pipe broke');

    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);

    stdin.write('first\nsecond\n');
    await expect(lines.replLine()).resolves.toBe('first');
    lines.close();
    await expect(lines.replLine()).resolves.toBeUndefined();
  });
});
