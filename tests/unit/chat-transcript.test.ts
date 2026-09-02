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

function createHarness(existing: readonly HistoryMessage[]) {
  let printed = '';
  let release: (page: readonly HistoryMessage[]) => void = () => undefined;
  const pages: Promise<HistoryOutcome>[] = [];
  const client = {
    history: (_id: string, page?: {limit?: string | number}) => {
      if (page?.limit === 1) {
        return Promise.resolve<HistoryOutcome>({
          status: 'ok',
          conversationId: 'conv',
          characterId: 'mira',
          messages: existing.slice(-1),
        });
      }

      const next = new Promise<HistoryOutcome>(resolve => {
        release = messages => {
          resolve({
            status: 'ok',
            conversationId: 'conv',
            characterId: 'mira',
            messages,
          });
        };
      });

      pages.push(next);

      return next;
    },
  };

  return {
    client,
    printed: () => printed,
    stdout: collect(chunk => {
      printed += chunk;
    }),
    release: (messages: readonly HistoryMessage[]) => {
      release(messages);
    },
  };
}

describe('chat transcript', () => {
  it('holds live events while a catch-up page is read, so the thread stays in order', async () => {
    const before = [message(1, 'earlier', 'web'), message(2, 'earlier reply')];
    const harness = createHarness(before);
    const transcript = await createTranscript({
      client: harness.client,
      conversationId: 'conv',
      source: 'chat-shim:1',
      stdout: harness.stdout,
    });
    const catchingUp = transcript.catchUp();
    const live: LocalRuntimeTurnProgressEvent = message(4, 'B, live');

    // B arrives while the page holding the missed A is still in flight.
    transcript.showProgress(live);
    expect(harness.printed()).toBe('');
    harness.release([
      ...before,
      message(3, 'A, missed', 'web'),
      message(4, 'B, live'),
    ]);
    await catchingUp;

    expect(harness.printed()).toBe('You: A, missed\nMira: B, live\n');

    // Nothing from before this terminal joined, and nothing twice.
    transcript.showProgress(live);
    expect(harness.printed()).toBe('You: A, missed\nMira: B, live\n');
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

    const catchingUp = transcript.catchUp();

    harness.release([message(1, 'mine', 'chat-shim:1'), message(2, 'reply')]);
    await catchingUp;
    expect(harness.printed()).toBe('Mira: reply\n');
  });
});
