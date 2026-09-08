import {describe, expect, it, vi} from 'vitest';

import {createTranscript} from '../../src/cli/chat/transcript.ts';
import type {
  HistoryMessage,
  HistoryOutcome,
} from '../../src/gateway/api/index.ts';
import type {LocalRuntimeTurnProgressEvent} from '../../src/runtime/index.ts';
import {collect} from '../support/streams.ts';

function message(
  id: number,
  text: string,
  source?: string,
): HistoryMessage & LocalRuntimeTurnProgressEvent {
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

function createHarness(thread: HistoryMessage[]) {
  let printed = '';
  let pagesRead = 0;
  const transcript = createTranscript({
    client: {
      history: () => {
        pagesRead += 1;

        return Promise.resolve<HistoryOutcome>({
          status: 'ok',
          conversationId: 'conv',
          characterId: 'mira',
          messages: thread.slice(-50),
        });
      },
    },
    conversationId: 'conv',
    source: 'chat-shim:1',
    stdout: collect(chunk => {
      printed += chunk;
    }),
  });

  return {
    transcript,
    thread,
    printed: () => printed,
    pagesRead: () => pagesRead,
  };
}

describe('chat transcript', () => {
  it('shows the thread once, from the stream or a read-back, and never its own lines', async () => {
    const harness = createHarness([
      message(1, 'earlier', 'web'),
      message(2, 'earlier reply'),
    ]);

    // Joining: the tail is read back.
    await harness.transcript.catchUp();
    expect(harness.printed()).toBe('You: earlier\nMira: earlier reply\n');

    // Live: shown as it comes; this terminal's own line is not.
    harness.transcript.showProgress(message(3, 'mine', 'chat-shim:1'));
    harness.transcript.showProgress(message(4, 'reply'));
    expect(harness.printed()).toBe(
      'You: earlier\nMira: earlier reply\nMira: reply\n',
    );

    // A read-back after the stream was down shows only what is new.
    harness.thread.push(message(3, 'mine', 'chat-shim:1'), message(4, 'reply'));
    harness.thread.push(
      message(5, 'missed', 'web'),
      message(6, 'missed reply'),
    );
    await harness.transcript.catchUp();
    expect(harness.printed()).toBe(
      'You: earlier\nMira: earlier reply\nMira: reply\nYou: missed\nMira: missed reply\n',
    );
  });

  it('says so when the thread moved on by more than a page while it was away', async () => {
    const harness = createHarness([message(1, 'earlier', 'web')]);

    await harness.transcript.catchUp();

    for (let index = 2; index <= 61; index += 1) {
      harness.thread.push(message(index, `line ${String(index)}`, 'web'));
    }

    await harness.transcript.catchUp();
    expect(harness.printed()).toContain('moved on by more than a page');
    expect(harness.printed()).toContain('You: line 61\n');
    expect(harness.printed()).not.toContain('You: line 2\n');
  });

  it('reports a turn shown once its own messages are on the screen, own lines included', async () => {
    const harness = createHarness([]);
    let shown = false;
    const waiting = harness.transcript.whenShown([
      'conv.1:message-1',
      'conv.1:message-2',
    ]);

    void waiting.then(() => {
      shown = true;
    });
    harness.transcript.showProgress(message(9, 'someone else'));
    harness.transcript.showProgress(message(1, 'mine', 'chat-shim:1'));
    await new Promise(resolve => setImmediate(resolve));
    expect(shown).toBe(false);

    harness.transcript.showProgress(message(2, 'reply'));
    await waiting;
  });

  it('gives up on a turn the stream never shows once the grace is up, and keeps no timer past any wait', async () => {
    vi.useFakeTimers();

    try {
      const harness = createHarness([]);
      let shown = false;

      void harness.transcript.whenShown(['conv.1:message-1']).then(() => {
        shown = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(shown).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(shown).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const answered = harness.transcript.whenShown(['conv.1:message-2']);

      harness.transcript.showProgress(message(2, 'reply'));
      await answered;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
