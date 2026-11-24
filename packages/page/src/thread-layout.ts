/**
 * The one conversation as a messaging app draws it: a time stands where
 * time has passed, with the app's name above it where the app changes; the
 * holder's own bubbles are in their app's colour; and one sender's
 * messages in a row sit close together. The chat draws it in Messages as
 * the person holds it, theirs at the end of the line, and a line of theirs
 * not yet committed as theirs sent now in Messages; her phone draws what
 * went through one app as she holds it, the mirror of the chat. Nothing
 * here touches the DOM or reads a clock: the viewer's clock comes in, so
 * the rules are tested in Node.
 */
import type {VisibleMessageRole} from '@project02/wire/contract';
import type {Message, PendingLine} from './store.ts';

/** The viewer's clock: the moment now, and the language and zone their system writes a time in. */
export type Clock = {
  readonly now: number;
  readonly locale: string;
  readonly timeZone: string;
};

/** A line of the person's not yet committed, under the id it was sent with. */
export type Pending = readonly [string, PendingLine];

/**
 * What the thread shows, in order: its messages; then her drafts and the
 * line about what she is doing, which are no messages, while `between`
 * says either stands there; then the person's lines not yet committed.
 */
export type Shown = {
  readonly messages: readonly Message[];
  readonly between: boolean;
  readonly pending: readonly Pending[];
};

/** What stands above a message where time has passed or the app changed. */
export type Divider = {
  /** The app's name, where the app changes. */
  readonly app?: string;
  /** The day, as `Today` or `Mon, Nov 16`. */
  readonly day: string;
  /** The time, as the viewer's system writes one. */
  readonly time: string;
  /** When the message was sent, as the daemon writes a moment. */
  readonly at: string;
};

/**
 * Whose screen a thread is drawn on, and in which app: the app it is
 * drawn in, which the first message follows, so that an app's name stands
 * only where the conversation moved away from it; and whose messages are
 * the holder's own.
 */
export type Holder = {
  readonly app: string;
  readonly own: VisibleMessageRole;
};

/** Where a message stands and how its bubble looks. */
export type Placement = {
  /** What stands above it, where anything does. */
  readonly divider?: Divider;
  /** Whether it sits close under the message directly above it, the same sender's. */
  readonly joined: boolean;
  /** When it was sent, as a divider writes it: what its bubble says on hover. */
  readonly when: string;
  /** Whether it is the holder's own, at the end of the line. */
  readonly own: boolean;
  /** The holder's own bubble's colour, its app's; the other's keep their own. */
  readonly colour?: string;
};

/** A message, or a line not yet committed, as its thread is drawn. */
export type Laid<T> = Placement & {readonly message: T};

/** What the rules read of a message: who sent it, when, and in which app. */
type Sent = Pick<Message, 'role' | 'sentAt' | 'app'>;

type App = {readonly name: string; readonly colour: string};

/** A day where the viewer is: its year, and the day counted from 1970. */
type CalendarDay = {readonly year: number; readonly day: number};

/** The app's own chat, which every line of the page's is sent in. */
export const messagesApp = 'messages';

/** The page's own blue: the holder's own bubbles in Messages, and in any app the page does not know. */
const pageBlue = 'var(--link)';

/** Each app the page knows, by its id: its name, and the colour of the holder's own bubbles in it. */
const apps: ReadonlyMap<string, App> = new Map([
  [messagesApp, {name: 'Messages', colour: pageBlue}],
  ['telegram', {name: 'Telegram', colour: 'var(--telegram)'}],
]);

/** Longer than this after the message before it, a message has its time above it. */
const pause = 15 * 60_000;

const dayLength = 24 * 60 * 60_000;

/** The person's chat: Messages, which shows what went through every app, theirs at the end of the line. */
export const chat: Holder = {app: messagesApp, own: 'user'};

/** Her phone, in the app `app`, which shows what went through it alone: hers at the end of the line. */
export function onHerPhone(app: string): Holder {
  return {app, own: 'character'};
}

/** What the head of her phone's thread in `app` says under the person's name: the app's name, but in Messages, the phone's own, nothing. */
export function labelOf(app: string): string | undefined {
  return app === messagesApp ? undefined : appOf(app).name;
}

/**
 * The thread as `holder` draws it, the person's chat unless another is
 * named: each message, then each line not yet committed, with where it
 * stands and how its bubble looks.
 */
export function laidOut(
  shown: Shown,
  clock: Clock,
  holder: Holder = chat,
): {
  readonly messages: readonly Laid<Message>[];
  readonly pending: readonly Laid<Pending>[];
} {
  const lay = layer(clock, holder);
  const messages = shown.messages.map(message => lay.next(message, message));

  if (shown.between) {
    lay.apart();
  }

  const sentNow: Sent = {
    role: 'user',
    sentAt: new Date(clock.now).toISOString(),
    app: messagesApp,
  };

  return {
    messages,
    pending: shown.pending.map(line => lay.next(line, sentNow)),
  };
}

/** An app by its id; one the page does not know goes by its id, in the page's blue. */
function appOf(id: string): App {
  return apps.get(id) ?? {name: id, colour: pageBlue};
}

/**
 * Lays messages out one after another, as `holder` draws the thread. A
 * divider stands before a message that is the first, or was sent
 * on another day, more than 15 minutes after, or in another app than the
 * message before it, whoever wrote that; the first counts as following the
 * app the thread is drawn in, so an app's name stands only where the
 * conversation moved to it. A message sits close under the one directly
 * above it when the same sender wrote both and no divider stands between.
 */
function layer(
  clock: Clock,
  holder: Holder,
): {
  readonly next: <T>(message: T, sent: Sent) => Laid<T>;
  /** Something that is no message stands here: the next message is under it. */
  readonly apart: () => void;
} {
  const write = writer(clock);
  let before:
    | {readonly at: number; readonly day: number; readonly app: string}
    | undefined;
  let above: VisibleMessageRole | undefined;

  return {
    next: (message, sent) => {
      const at = Date.parse(sent.sentAt);
      const {day, words, time} = write(at);
      const named = sent.app !== (before?.app ?? holder.app);
      const divided =
        before === undefined ||
        named ||
        day !== before.day ||
        at - before.at > pause;
      const joined = !divided && above === sent.role;
      const app = appOf(sent.app);
      const own = sent.role === holder.own;

      before = {at, day, app: sent.app};
      above = sent.role;

      return {
        message,
        ...(divided
          ? {
              divider: {
                ...(named ? {app: app.name} : {}),
                day: words,
                time,
                at: sent.sentAt,
              },
            }
          : {}),
        joined,
        when: `${words} ${time}`,
        own,
        ...(own ? {colour: app.colour} : {}),
      };
    },
    apart: () => {
      above = undefined;
    },
  };
}

/**
 * How the viewer's clock writes a moment: the day it falls on where they
 * are, counted from 1970; that day in the page's words — `Today`,
 * `Yesterday`, the weekday within the five days before that, so that a
 * weekday never names today's a week ago, the date in this year, and the
 * date with its year in another — and the time, hour and minute, as their
 * system writes one.
 */
function writer({now, locale, timeZone}: Clock): (at: number) => {
  readonly day: number;
  readonly words: string;
  readonly time: string;
} {
  const calendar = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const weekday = new Intl.DateTimeFormat('en-US', {timeZone, weekday: 'long'});
  const thisYear = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const anotherYear = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const dayOf = (at: number): CalendarDay => {
    const parts = calendar.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find(found => found.type === type)?.value);
    const year = part('year');

    return {
      year,
      day: Date.UTC(year, part('month') - 1, part('day')) / dayLength,
    };
  };
  const today = dayOf(now);
  const wordsOf = (at: number, {year, day}: CalendarDay): string => {
    const daysAgo = today.day - day;

    if (daysAgo === 0) {
      return 'Today';
    }

    if (daysAgo === 1) {
      return 'Yesterday';
    }

    if (daysAgo >= 2 && daysAgo <= 6) {
      return weekday.format(at);
    }

    return (year === today.year ? thisYear : anotherYear).format(at);
  };

  return at => {
    const date = dayOf(at);

    return {day: date.day, words: wordsOf(at, date), time: time.format(at)};
  };
}
