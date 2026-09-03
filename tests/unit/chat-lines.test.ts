import {PassThrough} from 'node:stream';

import {describe, expect, it} from 'vitest';

import {
  createLineDispatcher,
  createReadAhead,
} from '../../src/cli/chat/lines.ts';

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

  it('leaves a line typed before the prompt appeared to the REPL, and takes only a later one', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);

    // Typed while a turn was running, before anyone read.
    stdin.write('yes I will\n');
    await new Promise(resolve => setImmediate(resolve));

    const prompt = lines.promptLine();
    let answered = false;

    void prompt.then(() => {
      answered = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(answered).toBe(false);

    stdin.write('n\n');
    await expect(prompt).resolves.toBe('n');
    await expect(lines.replLine()).resolves.toBe('yes I will');
    lines.close();
  });

  it('withdraws a prompt on abort and keeps a line read for it for the next reader', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);
    const withdrawn = new AbortController();
    const prompt = lines.promptLine(withdrawn.signal);

    withdrawn.abort();
    await expect(prompt).resolves.toBeUndefined();

    // Nothing typed is lost: the next line is the REPL's.
    stdin.write('hello\n');
    await new Promise(resolve => setImmediate(resolve));
    await expect(lines.replLine()).resolves.toBe('hello');
    await expect(
      lines.promptLine(AbortSignal.abort()),
    ).resolves.toBeUndefined();
    lines.close();
  });

  it('drops what was typed and not yet read when the terminal closes it', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);

    stdin.write('first\nsecond\n');
    await expect(lines.replLine()).resolves.toBe('first');
    lines.close();
    await expect(lines.replLine()).resolves.toBeUndefined();
    await expect(lines.promptLine()).resolves.toBeUndefined();
  });

  it('answers a prompt nothing when the input ended before it appeared, leaving older lines to the REPL', async () => {
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

  it('rejects a pending read when the input fails, instead of crashing', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);
    const read = lines.replLine();
    const prompt = lines.promptLine();

    stdin.destroy(new Error('the pipe broke'));

    // A failed input is a failure for a prompt too, never a quiet no.
    await expect(prompt).rejects.toThrow('the pipe broke');
    await expect(read).rejects.toThrow('the pipe broke');
    await expect(lines.replLine()).resolves.toBeUndefined();
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

describe('chat read-ahead', () => {
  it('lets an exit end a wait, keeps other lines in order, and never drops a pending read', async () => {
    const stdin = new PassThrough();
    const lines = createLineDispatcher(stdin);
    const later = createReadAhead(lines);
    let release: () => void = () => undefined;
    const waited = new Promise<string>(resolve => {
      release = () => {
        resolve('back');
      };
    });
    const holding = later.holdUntil(waited);

    // Typed while waiting: queued behind the wait, in order.
    stdin.write('first\n');
    await new Promise(resolve => setImmediate(resolve));
    release();
    await expect(holding).resolves.toEqual({kind: 'done', value: 'back'});

    // The read kept ahead is still pending; a line served from the queue
    // must not discard it.
    await expect(later.next()).resolves.toBe('first');
    stdin.write('second\n');
    await expect(later.next()).resolves.toBe('second');

    // An exit typed during a wait ends it.
    const forever = later.holdUntil(new Promise<never>(() => undefined));

    stdin.write('/exit\n');
    await expect(forever).resolves.toEqual({kind: 'exit'});
    lines.close();
  });
});
