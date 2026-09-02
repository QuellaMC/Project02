import {describe, expect, it} from 'vitest';

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
      if (page?.limit === 1) {
        return Promise.resolve<HistoryOutcome>({
          status: 'ok',
          conversationId: 'conv',
          characterId: 'mira',
          messages: thread.slice(-1),
        });
      }

      const end =
        page?.before === undefined
          ? thread.length
          : Number(page.before.slice('v1:'.length));

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

    const catchingUp = transcript.catchUp();
    const live: LocalRuntimeTurnProgressEvent = message(4, 'B, live');

    transcript.showProgress(live);
    expect(harness.printed()).toBe('');
    harness.release();
    await catchingUp;

    expect(harness.printed()).toBe('You: A, missed\nMira: B, live\n');

    // Nothing from before this terminal joined, and nothing twice.
    transcript.showProgress(live);
    expect(harness.printed()).toBe('You: A, missed\nMira: B, live\n');
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
      [2, 3, 4, 5, 6].map(id => `Mira: missed ${String(id)}\n`).join(''),
    );
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
