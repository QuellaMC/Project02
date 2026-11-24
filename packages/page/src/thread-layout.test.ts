import {describe, expect, it} from 'vitest';

import type {LineState, Message} from './store.ts';
import {
  labelOf,
  laidOut,
  onHerPhone,
  type Clock,
  type Holder,
  type Pending,
  type Shown,
} from './thread-layout.ts';

/** The moment the tests call now: Tuesday, November 24, 2026, at 6:50 PM in New York. */
const now = Date.parse('2026-11-24T23:50:00.000Z');
const newYork: Clock = {now, locale: 'en-US', timeZone: 'America/New_York'};

/** A moment in New York, as `2026-11-24T14:10`, the way the daemon writes one. */
function nyc(local: string): string {
  return new Date(`${local}:00-05:00`).toISOString();
}

/** A message of the person's, sent at `sentAt` in `app`. */
function mine(sentAt: string, app = 'messages'): Message {
  return {
    messageId: `user ${sentAt}`,
    role: 'user',
    speakerName: 'Sam',
    text: 'Hi.',
    sentAt,
    app,
  };
}

/** A message of hers, sent at `sentAt` in `app`. */
function hers(sentAt: string, app = 'messages'): Message {
  return {
    messageId: `character ${sentAt}`,
    role: 'character',
    speakerName: 'Mira',
    text: 'Hello.',
    sentAt,
    app,
  };
}

/** A line of the person's not yet committed, as far as it got. */
function line(clientMessageId: string, state: LineState = 'sending'): Pending {
  return [
    clientMessageId,
    {
      conversationId: 'conv-1',
      characterId: 'mira',
      text: 'Still there?',
      state,
    },
  ];
}

/** A thread showing `messages` and nothing else. */
function thread(...messages: readonly Message[]): Shown {
  return {messages, between: false, pending: []};
}

describe('thread layout', () => {
  it('stands a divider before the first message shown, and before one sent on another day, more than 15 minutes after, or in another app than the message before it, whoever wrote that; before no other', () => {
    const {messages} = laidOut(
      thread(
        mine(nyc('2026-11-23T23:50')),
        hers(nyc('2026-11-23T23:55')),
        // Another day, seven minutes on.
        hers(nyc('2026-11-24T00:02')),
        // More than 15 minutes on.
        mine(nyc('2026-11-24T00:18')),
        // 15 minutes on, and no more.
        hers(nyc('2026-11-24T00:33')),
        // Another app.
        mine(nyc('2026-11-24T00:34'), 'telegram'),
        hers(nyc('2026-11-24T00:35'), 'telegram'),
      ),
      newYork,
    );

    expect(messages.map(({divider}) => divider !== undefined)).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
      false,
    ]);
  });

  it("says the day in the page's words and the time as the viewer's system writes one, where they are, and a bubble says its own time the same way", () => {
    const today = nyc('2026-11-24T14:10');
    const {messages} = laidOut(
      thread(
        mine(nyc('2025-11-16T21:12')),
        mine(nyc('2026-11-16T21:12')),
        mine(nyc('2026-11-17T21:12')),
        mine(nyc('2026-11-18T21:12')),
        mine(nyc('2026-11-22T21:12')),
        mine(nyc('2026-11-23T21:12')),
        mine(today),
        hers(nyc('2026-11-24T14:11')),
      ),
      newYork,
    );

    expect(messages.map(({divider}) => divider)).toEqual([
      {day: 'Nov 16, 2025', time: '9:12 PM', at: nyc('2025-11-16T21:12')},
      {day: 'Mon, Nov 16', time: '9:12 PM', at: nyc('2026-11-16T21:12')},
      // Seven days ago, a Tuesday as today is: its date, not its weekday.
      {day: 'Tue, Nov 17', time: '9:12 PM', at: nyc('2026-11-17T21:12')},
      // Six days ago, the last of the five before yesterday.
      {day: 'Wednesday', time: '9:12 PM', at: nyc('2026-11-18T21:12')},
      {day: 'Sunday', time: '9:12 PM', at: nyc('2026-11-22T21:12')},
      {day: 'Yesterday', time: '9:12 PM', at: nyc('2026-11-23T21:12')},
      {day: 'Today', time: '2:10 PM', at: today},
      undefined,
    ]);
    expect(messages.map(({when}) => when).slice(-2)).toEqual([
      'Today 2:10 PM',
      'Today 2:11 PM',
    ]);

    const yesterday = thread(mine(nyc('2026-11-23T21:12')));

    // The same moment is early today in London; and a system that writes a
    // time on a 24-hour clock has it so, the day still in the page's words.
    expect(
      laidOut(yesterday, {...newYork, timeZone: 'Europe/London'}).messages[0]
        ?.when,
    ).toBe('Today 2:12 AM');
    expect(
      laidOut(yesterday, {...newYork, locale: 'en-GB'}).messages[0]?.when,
    ).toBe('Yesterday 21:12');
  });

  it("names the app above the time only where the app changes, the first message shown following Messages, by the name the chat knows it by or else its id, and colours the person's bubbles by their app, hers by none", () => {
    const inMessages = laidOut(
      thread(
        mine(nyc('2026-11-24T09:00')),
        hers(nyc('2026-11-24T09:01')),
        mine(nyc('2026-11-24T14:10')),
      ),
      newYork,
    );
    const moving = laidOut(
      thread(
        mine(nyc('2026-11-24T09:00'), 'telegram'),
        hers(nyc('2026-11-24T09:01'), 'telegram'),
        mine(nyc('2026-11-24T14:10'), 'telegram'),
        hers(nyc('2026-11-24T14:11')),
        mine(nyc('2026-11-24T14:12'), 'whatsapp'),
      ),
      newYork,
    );

    expect(inMessages.messages.map(({divider}) => divider?.app)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(moving.messages.map(({divider}) => divider?.app)).toEqual([
      'Telegram',
      undefined,
      undefined,
      'Messages',
      'whatsapp',
    ]);
    expect(moving.messages.map(({colour}) => colour)).toEqual([
      'var(--telegram)',
      undefined,
      'var(--telegram)',
      undefined,
      'var(--link)',
    ]);
    expect(inMessages.messages[0]?.colour).toBe('var(--link)');
  });

  it('joins a message to the one directly above it when the same sender wrote both and no divider stands between, and never to what stands under her drafts or what she is doing', () => {
    const messages = [
      mine(nyc('2026-11-24T09:00')),
      mine(nyc('2026-11-24T09:01')),
      hers(nyc('2026-11-24T09:02')),
      hers(nyc('2026-11-24T09:03')),
      // More than 15 minutes on.
      hers(nyc('2026-11-24T09:30')),
      mine(nyc('2026-11-24T09:31')),
      // Another app.
      mine(nyc('2026-11-24T09:32'), 'telegram'),
      mine(nyc('2026-11-24T09:33'), 'telegram'),
      mine(nyc('2026-11-24T18:49')),
    ];
    const joinedOf = (shown: Shown) => {
      const laid = laidOut(shown, newYork);

      return [...laid.messages, ...laid.pending].map(({joined}) => joined);
    };
    const pending = [line('line-1'), line('line-2')];

    expect(joinedOf(thread(...messages))).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(joinedOf({messages, between: false, pending}).slice(-2)).toEqual([
      true,
      true,
    ]);
    expect(joinedOf({messages, between: true, pending}).slice(-2)).toEqual([
      false,
      true,
    ]);
  });

  it("draws a line of the person's not yet committed as theirs sent now in Messages", () => {
    const {pending} = laidOut(
      {
        messages: [mine(nyc('2026-11-24T18:49'), 'telegram')],
        between: false,
        pending: [line('line-1')],
      },
      newYork,
    );

    expect(pending).toEqual([
      {
        message: line('line-1'),
        divider: {
          app: 'Messages',
          day: 'Today',
          time: '6:50 PM',
          at: new Date(now).toISOString(),
        },
        joined: false,
        when: 'Today 6:50 PM',
        own: true,
        colour: 'var(--link)',
        status: {word: 'Sending…'},
      },
    ]);
  });

  it("stands one line under the person's newest message, the last line still on its way when there is one, saying how far it got; under a message of theirs, Read and the time on the day she read it, else the day, whatever app it was in; under every line that did not reach her, that it did not; under none of hers, and none on her phone", () => {
    const statuses = (shown: Shown, holder?: Holder) => {
      const laid = laidOut(shown, newYork, holder);

      return [...laid.messages, ...laid.pending].map(({status}) => status);
    };
    const readAt = (message: Message, at: string): Message => ({
      ...message,
      readAt: at,
    });
    const said = [
      readAt(mine(nyc('2026-11-01T09:00')), nyc('2026-11-01T09:00')),
      hers(nyc('2026-11-01T09:01')),
    ];

    for (const [state, word] of [
      ['sending', 'Sending…'],
      ['delivered', 'Delivered'],
    ] as const) {
      expect(
        statuses({
          messages: said,
          between: true,
          pending: [line('line-1', 'delivered'), line('line-2', state)],
        }),
      ).toEqual([undefined, undefined, undefined, {word}]);
    }

    // A line that did not reach her says so, and the newest still on its
    // way keeps its own line above it.
    expect(
      statuses({
        messages: said,
        between: true,
        pending: [
          line('line-1', 'not_delivered'),
          line('line-2', 'delivered'),
          line('line-3', 'not_delivered'),
        ],
      }),
    ).toEqual([
      undefined,
      undefined,
      {word: 'Not Delivered'},
      {word: 'Delivered'},
      {word: 'Not Delivered'},
    ]);
    // With none on its way, the newest she read keeps its line.
    expect(
      statuses({
        messages: said,
        between: false,
        pending: [line('line-1', 'not_delivered')],
      }),
    ).toEqual([
      {word: 'Read', read: {when: 'Sun, Nov 1', at: nyc('2026-11-01T09:00')}},
      undefined,
      {word: 'Not Delivered'},
    ]);

    for (const [read, when] of [
      [nyc('2026-11-24T18:42'), '6:42 PM'],
      [nyc('2026-11-23T21:12'), 'Yesterday'],
      [nyc('2026-11-22T21:12'), 'Sunday'],
      [nyc('2026-11-16T21:12'), 'Mon, Nov 16'],
    ] as const) {
      const messages = [
        ...said,
        readAt(mine(read, 'telegram'), read),
        hers(nyc('2026-11-24T18:45')),
      ];

      expect(statuses(thread(...messages))).toEqual([
        undefined,
        undefined,
        {word: 'Read', read: {when, at: read}},
        undefined,
      ]);
      expect(
        statuses(thread(...messages), onHerPhone('messages')).filter(
          status => status !== undefined,
        ),
      ).toEqual([]);
    }

    expect(statuses(thread(hers(nyc('2026-11-24T18:45'))))).toEqual([
      undefined,
    ]);
  });

  it("draws her phone's thread as the mirror of the chat: hers at the end of the line in the app's colour, the person's at its start, a time where time has passed and no app's name, one app being on screen; and its head names the app but Messages", () => {
    const inTelegram = [
      mine(nyc('2026-11-24T14:10'), 'telegram'),
      hers(nyc('2026-11-24T14:11'), 'telegram'),
      // More than 15 minutes on.
      hers(nyc('2026-11-24T14:30'), 'telegram'),
    ];
    const {messages} = laidOut(
      thread(...inTelegram),
      newYork,
      onHerPhone('telegram'),
    );

    expect(
      messages.map(({own, colour, divider}) => ({
        own,
        colour,
        app: divider?.app,
        time: divider?.time,
      })),
    ).toEqual([
      {own: false, colour: undefined, app: undefined, time: '2:10 PM'},
      {own: true, colour: 'var(--telegram)', app: undefined, time: undefined},
      {own: true, colour: 'var(--telegram)', app: undefined, time: '2:30 PM'},
    ]);
    expect(
      laidOut(
        thread(hers(nyc('2026-11-24T14:11'))),
        newYork,
        onHerPhone('messages'),
      ).messages[0]?.colour,
    ).toBe('var(--link)');
    expect([labelOf('telegram'), labelOf('messages')]).toEqual([
      'Telegram',
      undefined,
    ]);
  });
});
