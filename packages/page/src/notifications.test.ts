import {describe, expect, it} from 'vitest';

import type {GatewayEvent} from '@project02/wire/contract';
import {notificationFor} from './notifications.ts';

const conversationId = 'conv-1';
/** When every message of these tests was sent, and the person's read: the rule reads neither. */
const sentAt = '2026-11-24T10:00:00.000Z';

/** A message of Mira's committed in `app`, as the stream says it. */
function hers(messageId: string, text: string, app = 'messages'): GatewayEvent {
  return {
    kind: 'turn_progress',
    characterId: 'mira',
    conversationId,
    progress: {
      kind: 'visible_reply',
      messageId,
      speakerId: 'mira',
      speakerName: 'Mira',
      text,
      sentAt,
      app,
    },
  };
}

describe('when the desktop app shows a notification', () => {
  it('shows one for a message of hers committed in Messages while the window does not have the focus, with her name and her words whole, and only once', () => {
    const words = Array.from(
      {length: 12},
      (_, at) => `Line ${String(at + 1)} of what I wanted to tell you.`,
    ).join(' ');
    const first = notificationFor(new Set(), hers('m1', words), false);
    const notified = first?.notified ?? new Set();

    expect(first?.notification).toEqual({title: 'Mira', body: words});
    expect(notificationFor(notified, hers('m1', words), false)).toBeUndefined();
    expect(
      notificationFor(notified, hers('m2', 'Still up?'), false)?.notification,
    ).toEqual({title: 'Mira', body: 'Still up?'});
  });

  it("shows none for her message while the window has the focus, nor for one she sent in Telegram, the person's own line, her writing, or how her turn ended", () => {
    const quiet: readonly (readonly [GatewayEvent, boolean])[] = [
      [hers('m1', 'Hello.'), true],
      [hers('m2', 'Hello on Telegram.', 'telegram'), false],
      [
        {
          kind: 'turn_progress',
          characterId: 'mira',
          conversationId,
          progress: {
            kind: 'user_message',
            messageId: 'm3',
            speakerId: 'local-user',
            speakerName: 'Sam',
            text: 'Hi.',
            sentAt,
            readAt: sentAt,
            app: 'messages',
            source: 'web',
            clientMessageId: 'line-1',
          },
        },
        false,
      ],
      [
        {
          kind: 'turn_running',
          characterId: 'mira',
          conversationId,
          source: 'web',
          clientMessageId: 'line-1',
          writing: true,
        },
        false,
      ],
      [
        {
          kind: 'turn_completed',
          characterId: 'mira',
          conversationId,
          source: 'web',
          clientMessageId: 'line-1',
          status: 'completed',
          committed: true,
        },
        false,
      ],
    ];

    for (const [event, focused] of quiet) {
      expect(notificationFor(new Set(), event, focused)).toBeUndefined();
    }
  });
});
