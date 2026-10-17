import type {BotApiOutcome, TelegramMessage} from './bot-api.ts';
import {botNames, type BotContext} from './bot.ts';

/** Telegram's longest message, in the UTF-16 units a string's length counts. */
const maxMessageLength = 4096;
const draftEditMs = 1_500;

/**
 * What a bot writes in its chats. Its calls to Telegram go one at a time in
 * the order they were decided, so no edit overtakes a commit nor a reply
 * the line shown before it, and none once the bot has stopped. A chat that
 * answers 403 never opened this bot, and is skipped until it writes.
 */
export type Outbox = {
  /** Each paired account's chat, a private chat's id being its account's, but one skipped for a 403. */
  paired(): readonly number[];
  /** A message from the chat arrived, so it is written to again. */
  heardFrom(chatId: number): void;
  say(chatId: number, text: string): void;
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
  withdrawAll(): void;
};

/** A reply as the chats show it while it is written. */
type Draft = {
  /** Chat id → the draft's message in that chat. */
  readonly messages: Map<number, number>;
  /** The text so far, for the next edit. */
  text: string;
  shown: string;
  edit: NodeJS.Timeout | undefined;
};

export function createOutbox(bot: BotContext): Outbox {
  const {api} = bot;
  const silent = new Set<number>();
  const drafts = new Map<string, Draft>();
  let output = Promise.resolve();
  const queue = (call: () => Promise<void>): void => {
    output = output.then(() => (bot.signal.aborted ? undefined : call()));
  };
  const heard = <T>(
    chatId: number,
    outcome: BotApiOutcome<T>,
  ): T | undefined => {
    if (outcome.ok) {
      return outcome.result;
    }

    if (outcome.code === 403) {
      silent.add(chatId);
    } else {
      bot.report(
        `${botNames(bot.settings()).bot} could not write to chat ${String(chatId)}: ${outcome.description}`,
      );
    }

    return undefined;
  };
  const send = async (
    chatId: number,
    text: string,
  ): Promise<TelegramMessage | undefined> =>
    heard(chatId, await api.sendMessage({chatId, text}));
  const paired = (): readonly number[] =>
    Object.keys(bot.settings().pairedUsers)
      .map(Number)
      .filter(chatId => Number.isSafeInteger(chatId) && !silent.has(chatId));
  /**
   * Brings the draft's message in every chat to the text: sent where it
   * has none, edited where it shows other words. A draft shows what fits
   * one message; its commit sends the rest after.
   */
  const render = async (
    draft: Draft,
    text: string,
    commit: boolean,
  ): Promise<void> => {
    const [first = '', ...rest] = pieces(text);

    for (const chatId of new Set([...draft.messages.keys(), ...paired()])) {
      const messageId = draft.messages.get(chatId);

      if (messageId === undefined) {
        const sent = await send(chatId, first);

        if (sent !== undefined) {
          draft.messages.set(chatId, sent.messageId);
        }
      } else if (first !== draft.shown) {
        const outcome = await api.editMessageText({
          chatId,
          messageId,
          text: first,
        });

        if (!notModified(outcome)) {
          heard(chatId, outcome);
        }
      }

      for (const piece of commit ? rest : []) {
        await send(chatId, piece);
      }
    }

    draft.shown = first;
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
      queue(async () => {
        for (const [chatId, messageId] of draft.messages) {
          heard(chatId, await api.deleteMessage({chatId, messageId}));
        }
      });
    }
  };

  return {
    paired,
    heardFrom(chatId) {
      silent.delete(chatId);
    },
    say(chatId, text) {
      queue(async () => {
        await send(chatId, text);
      });
    },
    typing(chatId) {
      queue(async () => {
        heard(chatId, await api.sendChatAction({chatId}));
      });
    },
    draft(draftId, text, post) {
      const posted = drafts.get(draftId);

      if (posted !== undefined) {
        posted.text = text;
        posted.edit ??= setTimeout(() => {
          posted.edit = undefined;
          queue(() => render(posted, posted.text, false));
        }, draftEditMs).unref();
      } else if (post && text.trim() !== '') {
        const draft = newDraft(text);

        drafts.set(draftId, draft);
        queue(() => render(draft, text, false));
      }
    },
    commit(draftId, text, post) {
      const draft = forget(draftId) ?? (post ? newDraft(text) : undefined);

      if (draft !== undefined) {
        queue(() => render(draft, text, true));
      }
    },
    withdraw,
    withdrawAll() {
      for (const draftId of drafts.keys()) {
        withdraw(draftId);
      }
    },
  };
}

function newDraft(text: string): Draft {
  return {messages: new Map(), text, shown: '', edit: undefined};
}

function notModified(outcome: BotApiOutcome<unknown>): boolean {
  return (
    !outcome.ok &&
    outcome.code === 400 &&
    outcome.description.startsWith('Bad Request: message is not modified')
  );
}

/** Messages Telegram takes, never cut between the halves of a surrogate pair. */
function pieces(text: string): readonly string[] {
  const cut: string[] = [];

  for (let start = 0; start < text.length;) {
    const end = Math.min(start + maxMessageLength, text.length);
    const last = text.charCodeAt(end - 1);
    const next =
      end < text.length && last >= 0xd800 && last <= 0xdbff ? end - 1 : end;

    cut.push(text.slice(start, next));
    start = next;
  }

  return cut;
}
