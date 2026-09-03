import {describe, expect, it, vi} from 'vitest';

import {createTranscript} from '../../src/cli/chat/transcript.ts';
import type {HistoryMessage, HistoryOutcome} from '../../src/gateway/index.ts';
import type {LocalRuntimeTurnProgressEvent} from '../../src/runtime/index.ts';
import {collect} from '../support/streams.ts';

function message(
  id: number,
  text: string,
  source?: string,
): HistoryMessage & {readonly kind: 'user_message'} {
  return {
    kind: 'user_message',
    messageId: `conv.1:message-${String(id)}`,
    role: source === undefined ? 'character' : 'user',
    speakerId: source === undefined ? 'mira' : 'local-user',
    speakerName: source === undefined ? 'Mira' : 'You',
    text,
    committedAt: '2026-09-02T00:00:00.000Z',
    ...(source === undefined ? {} : {source}),
  };
}

/**
 * A conversation of `thread`, paged like the daemon pages it: newest page
 * first, `earlier` cursors walking back. The newest page can be held until
 * the test releases it.
 */
function createHarness(
  initial: readonly HistoryMessage[],
  options: {readonly pageSize?: number; readonly hold?: boolean} = {},
) {
  const thread = [...initial];
  let printed = '';
  let pagesRead = 0;
  let release: () => void = () => undefined;
  const pageSize = options.pageSize ?? 100;
  const pageAt = (end: number): HistoryOutcome => {
    const start = Math.max(0, end - pageSize);

    return {
      status: 'ok',
      conversationId: 'conv',
      characterId: 'mira',
      messages: thread.slice(start, end),
      ...(start === 0 ? {} : {earlier: `v1:${String(start)}`}),
    };
  };
  const client = {
    history: (
      _id: string,
      page?: {limit?: string | number; before?: string},
    ) => {
      if (page?.limit !== undefined && page.limit !== 100) {
        return Promise.resolve<HistoryOutcome>({
          status: 'ok',
          conversationId: 'conv',
          characterId: 'mira',
          messages: thread.slice(-Number(page.limit)),
        });
      }

      const end =
        page?.before === undefined
          ? thread.length
          : Number(page.before.slice('v1:'.length));

      pagesRead += 1;

      if (options.hold !== true || page?.before !== undefined) {
        return Promise.resolve(pageAt(end));
      }

      return new Promise<HistoryOutcome>(resolve => {
        release = () => {
          resolve(pageAt(end));
        };
      });
    },
  };

  return {
    client,
    printed: () => printed,
    stdout: collect(chunk => {
      printed += chunk;
    }),
    release: () => {
      release();
    },
    append: (next: HistoryMessage) => {
      thread.push(next);
    },
    pagesRead: () => pagesRead,
  };
}

describe('chat transcript', () => {
  it('holds live events while a catch-up page is read, so the thread stays in order', async () => {
    const harness = createHarness(
      [message(1, 'earlier', 'web'), message(2, 'earlier reply')],
      {hold: true},
    );
    const transcript = await createTranscript({
      client: harness.client,
      conversationId: 'conv',
      source: 'chat-shim:1',
      stdout: harness.stdout,
    });

    // A was committed while the stream was down; B is live, right after.
    harness.append(message(3, 'A, missed', 'web'));
    harness.append(message(4, 'B, live'));

    // The thread so far is on the screen from the start.
    const joined = 'You: earlier\nMira: earlier reply\n';

    expect(harness.printed()).toBe(joined);

    const catchingUp = transcript.catchUp();
    const live: LocalRuntimeTurnProgressEvent = message(4, 'B, live');

    transcript.showProgress(live);
    expect(harness.printed()).toBe(joined);
    harness.release();
    await catchingUp;

    expect(harness.printed()).toBe(`${joined}You: A, missed\nMira: B, live\n`);

    // Nothing twice.
    transcript.showProgress(live);
    expect(harness.printed()).toBe(`${joined}You: A, missed\nMira: B, live\n`);
  });

  it('keeps a turn ending behind the page it arrived during, so it cannot overtake the line', async () => {
    const harness = createHarness([], {hold: true});
    const transcript = await createTranscript({
      client: harness.client,
      conversationId: 'conv',
      source: 'chat-shim:1',
      stdout: harness.stdout,
    });
    const own = (id: number, text: string, clientMessageId: string) => ({
      ...message(id, text, 'chat-shim:1'),
      clientMessageId,
    });

    // The answer was lost; the line, its record, and its turn's end all
    // arrive while the page is being read.
    transcript.expectLanding('c1', 'mine');
    harness.append(own(1, 'mine', 'c1'));
    const catchingUp = transcript.catchUp();

    transcript.showProgress(own(1, 'mine', 'c1'));
    transcript.turnEnded('c1', 'rejected');
    expect(harness.printed()).toBe('');
    harness.release();
    await catchingUp;

    // Landed first, in order; and, as its own turn, how it ended.
    expect(harness.printed()).toBe(
      'Your line "mine" did land.\nYour line "mine": its turn was rejected.\n',
    );
  });

  it('walks earlier pages until the anchor when more was missed than one page holds', async () => {
    const thread = [
      message(1, 'anchor'),
      ...[2, 3, 4, 5, 6].map(id => message(id, `missed ${String(id)}`)),
    ];
    const harness = createHarness(thread.slice(0, 1), {pageSize: 2});
    const transcript = await createTranscript({
      client: harness.client,
      conversationId: 'conv',
      source: 'chat-shim:1',
      stdout: harness.stdout,
    });

    for (const next of thread.slice(1)) {
      harness.append(next);
    }
    await transcript.catchUp();

    expect(harness.printed()).toBe(
      ['anchor', ...[2, 3, 4, 5, 6].map(id => `missed ${String(id)}`)]
        .map(text => `Mira: ${text}\n`)
        .join(''),
    );
    expect(harness.pagesRead()).toBe(3);

    // The anchor moved up: the next catch-up reads one page, not the session.
    harness.append(message(7, 'missed 7'));
    await transcript.catchUp();
    expect(harness.pagesRead()).toBe(4);
    expect(harness.printed()).toContain('Mira: missed 7\n');
  });

  it('reports a turn shown once its own messages are on the screen, own lines included', async () => {
    const harness = createHarness([]);
    const transcript = await createTranscript({
      client: harness.client,
      conversationId: 'conv',
      source: 'chat-shim:1',
      stdout: harness.stdout,
    });
    let shown = false;
    const waiting = transcript.whenShown([
      'conv.1:message-1',
      'conv.1:message-2',
    ]);

    void waiting.then(() => {
      shown = true;
    });
    // Another client's turn on the thread does not count for this one.
    transcript.showProgress(message(3, 'someone else'));
    transcript.showProgress(message(1, 'mine', 'chat-shim:1'));
    await new Promise(resolve => setImmediate(resolve));
    expect(shown).toBe(false);

    transcript.showProgress(message(2, 'reply'));
    await waiting;
    await expect(
      transcript.whenShown(['conv.1:message-2']),
    ).resolves.toBeUndefined();
  });

  it('settles a line whose answer was lost: landed when the thread shows it, or not at all', async () => {
    const harness = createHarness([]);
    const transcript = await createTranscript({
      client: harness.client,
      conversationId: 'conv',
      source: 'chat-shim:1',
      stdout: harness.stdout,
    });
    const own = (id: number, text: string, clientMessageId: string) => ({
      ...message(id, text, 'chat-shim:1'),
      clientMessageId,
    });

    // Already on the thread when the answer was lost: said at once.
    transcript.showProgress(own(1, 'first', 'c1'));
    transcript.expectLanding('c1', 'first');
    expect(harness.printed()).toBe('Your line "first" did land.\n');

    // Not yet: said the moment a catch-up shows it.
    transcript.expectLanding('c2', 'second');
    harness.append(own(1, 'first', 'c1'));
    harness.append(own(2, 'second', 'c2'));
    await transcript.catchUp();
    expect(harness.printed()).toBe(
      'Your line "first" did land.\nYour line "second" did land.\n',
    );

    // Not yet on the thread: said once, without a verdict — the turn may
    // still be queued — and the line stays open until the thread has it.
    transcript.expectLanding('c3', 'third');
    await transcript.catchUp();
    await transcript.catchUp();
    expect(
      harness.printed().match(/Your line "third" is not on the thread yet/gu),
    ).toHaveLength(1);
    transcript.showProgress(own(3, 'third', 'c3'));
    expect(harness.printed()).toContain('Your line "third" did land.');

    // Or until the daemon says how its turn ended — in either order, since
    // the stream can carry the turn's end before the answer fails. The
    // line's own record decides whether it reached the thread at all.
    transcript.showProgress(own(4, 'fourth', 'c4'));
    transcript.turnEnded('c4', 'rejected', 'the reply was not usable');
    transcript.expectLanding('c4', 'fourth');
    transcript.turnEnded('c5', 'failed');
    transcript.expectLanding('c5', 'fifth');
    expect(harness.printed()).toContain(
      'Your line "fourth" did reach the character; its turn was rejected: the reply was not usable.',
    );
    expect(harness.printed()).toContain(
      'Your line "fifth" was failed before it reached the thread; send it again',
    );

    // Landed first, ended later: the ending is still said, since this
    // terminal's own turns are not warned about from the stream.
    transcript.expectLanding('c6', 'sixth');
    transcript.showProgress(own(6, 'sixth', 'c6'));
    expect(harness.printed()).toContain('Your line "sixth" did land.');
    transcript.turnEnded('c6', 'rejected', 'no reply came');
    expect(harness.printed()).toContain(
      'Your line "sixth": its turn was rejected: no reply came.',
    );
    transcript.expectLanding('c7', 'seventh');
    transcript.showProgress(own(7, 'seventh', 'c7'));
    transcript.turnEnded('c7', 'completed');
    expect(harness.printed()).not.toContain('"seventh": its turn');
  });

  it('leaves no timer behind when a read-back settles before the grace period', async () => {
    vi.useFakeTimers();

    try {
      const harness = createHarness([], {hold: true});
      const transcript = await createTranscript({
        client: harness.client,
        conversationId: 'conv',
        source: 'chat-shim:1',
        stdout: harness.stdout,
      });
      const catchingUp = transcript.catchUp();
      const settled = transcript.settled();

      expect(vi.getTimerCount()).toBe(1);
      harness.release();
      await catchingUp;
      await settled;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps this terminal's own lines off its screen while counting them as shown", async () => {
    const harness = createHarness([]);
    const transcript = await createTranscript({
      client: harness.client,
      conversationId: 'conv',
      source: 'chat-shim:1',
      stdout: harness.stdout,
    });

    transcript.showProgress(message(1, 'mine', 'chat-shim:1'));
    transcript.showProgress(message(2, 'reply'));
    harness.append(message(1, 'mine', 'chat-shim:1'));
    harness.append(message(2, 'reply'));
    await transcript.catchUp();
    expect(harness.printed()).toBe('Mira: reply\n');
  });
});
