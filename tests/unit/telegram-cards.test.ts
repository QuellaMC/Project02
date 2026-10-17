import {describe, expect, it, vi} from 'vitest';

import {createCards} from '../../src/frontends/telegram/cards.ts';
import type {Outbox} from '../../src/frontends/telegram/outbox.ts';

describe('Telegram cards', () => {
  it("sends a card past Telegram's longest message cut to fit, and keeps how it ended whole", async () => {
    const sent: string[] = [];
    const revised: string[] = [];
    const outbox: Outbox = {
      paired: () => [1],
      heardFrom: () => undefined,
      say: () => undefined,
      card: (_chatId, text) => {
        sent.push(text);

        return Promise.resolve(sent.length);
      },
      revise: (_chatId, _messageId, text) => {
        revised.push(text);
      },
      answer: () => undefined,
      typing: () => undefined,
      draft: () => undefined,
      commit: () => undefined,
      withdraw: () => undefined,
      withdrawAll: () => undefined,
    };
    const cards = createCards(outbox, 'confirmation');
    // 4094 units, a pair at the cut, and more past Telegram's 4096.
    const text = `${'x'.repeat(4094)}😀 and more`;

    cards.post('id', text, [1]);
    cards.end('id', 'approved');
    await vi.waitFor(() => {
      expect(revised).toHaveLength(1);
    });

    // The pair at the cut goes whole, the ellipsis in its place.
    expect(sent).toEqual([`${'x'.repeat(4094)}…`]);
    expect(revised).toEqual([`${'x'.repeat(4084)}… · approved`]);
    expect(revised[0]).toHaveLength(4096);
  });
});
