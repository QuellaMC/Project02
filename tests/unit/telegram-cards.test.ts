import {describe, expect, it, vi} from 'vitest';

import {createCards} from '../../src/frontends/telegram/cards.ts';
import type {Outbox} from '../../src/frontends/telegram/outbox.ts';

/** An outbox that records what the cards send and revise; a card lands with its ordinal as its message id. */
function recordingOutbox(
  land: (chatId: number, ordinal: number) => number | undefined = (
    _chatId,
    ordinal,
  ) => ordinal,
) {
  const sent: {readonly chatId: number; readonly text: string}[] = [];
  const revised: {readonly chatId: number; readonly text: string}[] = [];
  const outbox: Outbox = {
    paired: () => [],
    admitted: () => undefined,
    heardFrom: () => undefined,
    say: () => undefined,
    sayToPaired: () => undefined,
    card: (chatId, text) => {
      sent.push({chatId, text});

      return Promise.resolve(land(chatId, sent.length));
    },
    revise: (chatId, _messageId, text) => {
      revised.push({chatId, text});
    },
    answer: () => undefined,
    typing: () => undefined,
    draft: () => undefined,
    commit: () => undefined,
    withdraw: () => undefined,
    withdrawExcept: () => undefined,
  };

  return {outbox, sent, revised};
}

describe('Telegram cards', () => {
  it("sends a card past Telegram's longest message cut to fit, and keeps how it ended whole", async () => {
    const {outbox, sent, revised} = recordingOutbox();
    const cards = createCards(outbox, 'confirmation');
    const text = 'x'.repeat(4100);

    cards.post('id', () => text, [1]);
    cards.end('id', 'approved');
    await vi.waitFor(() => {
      expect(revised).toHaveLength(1);
    });

    expect(sent.map(call => call.text)).toEqual([`${'x'.repeat(4095)}…`]);
    expect(revised.map(call => call.text)).toEqual([
      `${'x'.repeat(4084)}… · approved`,
    ]);
    expect(revised[0]?.text).toHaveLength(4096);
  });

  it('sends a card to a chat once, tries again where the send failed with the words of that moment, and revises each message it reached', async () => {
    let failed = false;
    const {outbox, sent, revised} = recordingOutbox((chatId, ordinal) => {
      if (chatId === 2 && !failed) {
        failed = true;

        return undefined;
      }

      return ordinal;
    });
    const cards = createCards(outbox, 'pairing');
    let left = 60;
    const text = () => `Bob wants to pair · expires in ${String(left)} minutes`;

    cards.post('123456', text, [1, 2]);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    left = 59;
    cards.post('123456', text, [1, 2]);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(3);
    });
    expect(sent.map(call => call.chatId)).toEqual([1, 2, 2]);
    expect(sent.map(call => call.text)).toEqual([
      'Bob wants to pair · expires in 60 minutes',
      'Bob wants to pair · expires in 60 minutes',
      'Bob wants to pair · expires in 59 minutes',
    ]);

    cards.end('123456', 'approved');
    await vi.waitFor(() => {
      expect(revised.map(call => call.chatId).sort()).toEqual([1, 2]);
    });
    expect(revised.every(call => call.text.endsWith(' · approved'))).toBe(true);
  });
});
