import {
  pause,
  type BotApiOutcome,
  type InlineKeyboard,
  type TelegramCallbackQuery,
  type TelegramMessage,
} from './bot-api.ts';
import {botNames, type BotContext} from './bot.ts';

/** Telegram's longest message, in the UTF-16 units a string's length counts. */
const maxMessageLength = 4096;
/** Telegram's longest answer to a button press. */
const maxToastLength = 200;
const draftEditMs = 1_500;

/**
 * What a bot writes in its chats. Its calls to Telegram go one at a time in
 * the order they were decided, so no edit overtakes a commit nor a reply
 * the line shown before it, and none once the bot has stopped; one
 * Telegram asks to wait on is made again after the pause. A chat that
 * answers 403 never opened this bot, and is skipped until it writes.
 */
export type Outbox = {
  /** Each paired account's chat — by this bot's read of the settings, and the accounts the daemon let in since — a private chat's id being its account's, but one skipped for a 403. */
  paired(): readonly number[];
  /** The daemon let the account in before this bot's next read of the settings, which supersedes it. */
  admitted(chatId: number): void;
  /** A message from the chat arrived, so it is written to again. */
  heardFrom(chatId: number): void;
  /** Says the text in the chat, in as many messages as it takes, stopping at one that could not be sent. */
  say(chatId: number, text: string): void;
  /** Says the text in a paired account's chat, unless the account is paired no longer when the saying's turn comes. */
  sayToPaired(chatId: number, text: string): void;
  /** Sends a message with buttons to a paired account's chat, and gives its id once sent; none when it could not be, or the account was paired no longer when its turn came. */
  card(
    chatId: number,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<number | undefined>;
  /** Edits a card to the text it ends with, its buttons gone. */
  revise(chatId: number, messageId: number, text: string): void;
  /** Answers a button press, with a toast when there is one. */
  answer(press: TelegramCallbackQuery, toast?: string): void;
  typing(chatId: number): void;
  /**
   * A draft's text so far: a new one is posted in every paired chat when
   * `post` and it has words, and one already posted is edited at most once
   * an interval.
   */
  draft(draftId: string, text: string, post: boolean): void;
  /** The committed text replaces its draft; with none posted, `post` sends it whole. */
  commit(draftId: string, text: string, post: boolean): void;
  withdraw(draftId: string): void;
  /** Withdraws every draft but those named: what a snapshot still carries keeps its message, and `draft` brings it to its text. */
  withdrawExcept(kept: ReadonlySet<string>): void;
};

/** A reply as the chats show it while it is written. */
type Draft = {
  /** Chat id → the draft's message in that chat, and the words it shows. */
  readonly messages: Map<number, {readonly messageId: number; shown: string}>;
  /** The text so far, for the next edit. */
  text: string;
  edit: NodeJS.Timeout | undefined;
};

export function createOutbox(bot: BotContext): Outbox {
  const {api} = bot;
  const audience = createAudience(bot);
  const drafts = new Map<string, Draft>();
  let output: Promise<unknown> = Promise.resolve();
  /** What the call gave, once every call decided before it has run; none once the bot has stopped. */
  const queue = <T>(call: () => Promise<T>): Promise<T | undefined> => {
    const ran = output.then(() => (bot.signal.aborted ? undefined : call()));

    output = ran;

    return ran;
  };
  const call = <T>(
    request: () => Promise<BotApiOutcome<T>>,
  ): Promise<BotApiOutcome<T>> => patiently(bot.signal, request);
  const heard = <T>(
    chatId: number,
    outcome: BotApiOutcome<T>,
  ): T | undefined => {
    if (outcome.ok) {
      return outcome.result;
    }

    if (outcome.code === 403) {
      audience.silence(chatId);
    } else if (!bot.signal.aborted) {
      bot.report(
        `${botNames(bot.settings()).bot} could not write to chat ${String(chatId)}: ${outcome.description}`,
      );
    }

    return undefined;
  };
  const send = async (
    chatId: number,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<TelegramMessage | undefined> =>
    heard(
      chatId,
      await call(() =>
        api.sendMessage({
          chatId,
          text,
          ...(keyboard === undefined ? {} : {keyboard}),
          signal: bot.signal,
        }),
      ),
    );
  /** Edits a message to the text, without buttons: whether it shows the text now, one showing it already as good as edited. */
  const edit = async (
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<boolean> => {
    const outcome = await call(() =>
      api.editMessageText({chatId, messageId, text, signal: bot.signal}),
    );

    return notModified(outcome) || heard(chatId, outcome) !== undefined;
  };
  const paired = (): readonly number[] => audience.chats();
  /**
   * Brings the draft's message in every paired chat to the text: sent
   * where it has none, edited where it shows other words, an edit that
   * failed leaving the words for the next to try again; a chat paired no
   * longer gets no more of it. A draft shows what fits one message; its
   * commit sends the rest after, and only after.
   */
  const render = async (
    draft: Draft,
    text: string,
    commit: boolean,
  ): Promise<void> => {
    const [first = '', ...rest] = pieces(text);

    for (const chatId of paired()) {
      const message = draft.messages.get(chatId);
      const sent =
        message === undefined ? await send(chatId, first) : undefined;

      if (sent !== undefined) {
        draft.messages.set(chatId, {messageId: sent.messageId, shown: first});
      } else if (
        message !== undefined &&
        first !== message.shown &&
        (await edit(chatId, message.messageId, first))
      ) {
        message.shown = first;
      }

      if (commit && draft.messages.get(chatId)?.shown === first) {
        for (const piece of rest) {
          if ((await send(chatId, piece)) === undefined) {
            break;
          }
        }
      }
    }
  };
  const forget = (draftId: string): Draft | undefined => {
    const draft = drafts.get(draftId);

    clearTimeout(draft?.edit);
    drafts.delete(draftId);

    return draft;
  };
  const withdraw = (draftId: string): void => {
    const draft = forget(draftId);

    if (draft !== undefined) {
      void queue(async () => {
        for (const [chatId, {messageId}] of draft.messages) {
          heard(
            chatId,
            await call(() =>
              api.deleteMessage({chatId, messageId, signal: bot.signal}),
            ),
          );
        }
      });
    }
  };

  /** Says the text in the chat, piece by piece, stopping at one that could not be sent. */
  const tell = async (chatId: number, text: string): Promise<void> => {
    for (const piece of pieces(text)) {
      if ((await send(chatId, piece)) === undefined) {
        break;
      }
    }
  };
  const stillPaired = (chatId: number): boolean => paired().includes(chatId);

  return {
    paired,
    admitted(chatId) {
      audience.admitted(chatId);
    },
    heardFrom(chatId) {
      audience.heardFrom(chatId);
    },
    say(chatId, text) {
      void queue(() => tell(chatId, text));
    },
    sayToPaired(chatId, text) {
      void queue(() =>
        stillPaired(chatId) ? tell(chatId, text) : Promise.resolve(),
      );
    },
    card: async (chatId, text, keyboard) =>
      (
        await queue(() =>
          stillPaired(chatId)
            ? send(chatId, text, keyboard)
            : Promise.resolve(undefined),
        )
      )?.messageId,
    revise(chatId, messageId, text) {
      void queue(() => edit(chatId, messageId, text));
    },
    answer(press, toast) {
      void queue(async () => {
        heard(
          press.from.id,
          await call(() =>
            api.answerCallbackQuery({
              callbackQueryId: press.id,
              ...(toast === undefined
                ? {}
                : {text: cut(toast, maxToastLength)}),
              signal: bot.signal,
            }),
          ),
        );
      });
    },
    typing(chatId) {
      void queue(async () => {
        heard(
          chatId,
          await call(() => api.sendChatAction({chatId, signal: bot.signal})),
        );
      });
    },
    draft(draftId, text, post) {
      const posted = drafts.get(draftId);

      if (posted !== undefined) {
        posted.text = text;
        posted.edit ??= setTimeout(() => {
          posted.edit = undefined;
          void queue(() => render(posted, posted.text, false));
        }, draftEditMs).unref();
      } else if (post && text.trim() !== '') {
        const draft = newDraft(text);

        drafts.set(draftId, draft);
        void queue(() => render(draft, text, false));
      }
    },
    commit(draftId, text, post) {
      const draft = forget(draftId) ?? (post ? newDraft(text) : undefined);

      if (draft !== undefined) {
        void queue(() => render(draft, text, true));
      }
    },
    withdraw,
    withdrawExcept(kept) {
      for (const draftId of drafts.keys()) {
        if (!kept.has(draftId)) {
          withdraw(draftId);
        }
      }
    },
  };
}

/** One call to Telegram; one it asks to wait on is made once more after the pause, the queue waiting with it. */
async function patiently<T>(
  signal: AbortSignal,
  request: () => Promise<BotApiOutcome<T>>,
): Promise<BotApiOutcome<T>> {
  const outcome = await request();

  if (outcome.ok || outcome.retryAfterMs === undefined) {
    return outcome;
  }

  await pause(outcome.retryAfterMs, signal);

  return signal.aborted ? outcome : request();
}

/**
 * Whom a bot writes to: each paired account's chat by this bot's read of
 * the settings, and the accounts the daemon let in since (a read
 * supersedes them), but none that answered 403 until it writes again. A
 * private chat's id is its account's, a positive integer as Telegram
 * gives one; a key shaped otherwise names no chat of ours, since a
 * negative one would name a group.
 */
function createAudience(bot: BotContext): {
  chats(): readonly number[];
  admitted(chatId: number): void;
  heardFrom(chatId: number): void;
  silence(chatId: number): void;
} {
  const silent = new Set<number>();
  const letIn = new Set<number>();
  let readSettings = bot.settings();

  return {
    chats() {
      const settings = bot.settings();

      if (settings !== readSettings) {
        readSettings = settings;
        letIn.clear();
      }

      return [
        ...new Set([
          ...Object.keys(settings.pairedUsers)
            .filter(key => /^[1-9]\d*$/u.test(key))
            .map(Number),
          ...letIn,
        ]),
      ].filter(chatId => Number.isSafeInteger(chatId) && !silent.has(chatId));
    },
    admitted(chatId) {
      letIn.add(chatId);
    },
    heardFrom(chatId) {
      silent.delete(chatId);
    },
    silence(chatId) {
      silent.add(chatId);
    },
  };
}

function newDraft(text: string): Draft {
  return {messages: new Map(), text, edit: undefined};
}

function notModified(outcome: BotApiOutcome<unknown>): boolean {
  return (
    !outcome.ok &&
    outcome.code === 400 &&
    outcome.description.startsWith('Bad Request: message is not modified')
  );
}

/** Messages Telegram takes, never cut between the halves of a surrogate pair. */
function pieces(text: string, size = maxMessageLength): readonly string[] {
  const cut: string[] = [];

  for (let start = 0; start < text.length;) {
    const end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    const next =
      end < text.length && last >= 0xd800 && last <= 0xdbff ? end - 1 : end;

    cut.push(text.slice(start, next));
    start = next;
  }

  return cut;
}

/**
 * The text as one message with `ending` whole, as a card with buttons must
 * be: a text past Telegram's longest is cut to make room.
 */
export function oneMessage(text: string, ending = ''): string {
  return cut(text, maxMessageLength - ending.length) + ending;
}

/** The text within the limit, an ellipsis marking a cut, never between the halves of a surrogate pair. */
function cut(text: string, limit: number): string {
  const [first = '', ...rest] = pieces(text, limit);

  return rest.length === 0
    ? first
    : `${Array.from(first).slice(0, -1).join('')}…`;
}
