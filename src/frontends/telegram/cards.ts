import type {
  ConfirmationSettlement,
  GatewayConfirmationDecision,
  PairingDecision,
  PendingConfirmation,
} from '../../gateway/api/index.ts';
import type {InlineKeyboard, TelegramCallbackQuery} from './bot-api.ts';
import {daemonDown, rethrowUnlessTransport, type BotContext} from './bot.ts';
import type {Gate} from './gate.ts';
import type {Outbox} from './outbox.ts';

/**
 * What a card asks about, by the letter its buttons carry before the
 * confirmation's id or the pairing request's code. Telegram takes 1 to 64
 * bytes of `callback_data`: `c:<uuid>:a` is 40.
 */
const letters = {confirmation: 'c', pairing: 'p'} as const;

type CardKind = keyof typeof letters;

/** A press of a card's button: what the card asks about, and the answer. */
type Press = {
  readonly kind: CardKind;
  readonly key: string;
  readonly decision: GatewayConfirmationDecision;
};

/** How an answer went, as a toast or a reply says it. */
export const answered = {
  approved: 'Approved.',
  denied: 'Denied.',
  expired: 'Too late: it expired.',
  unknown: 'Already answered.',
} as const;

/** A card's text, and its message in each chat it went to. */
type Card = {
  readonly text: string;
  readonly messages: (readonly [chatId: number, messageId: number])[];
  /** Its text once it ended, for a message whose id arrives after that. */
  ended: string | undefined;
};

/**
 * Messages with Approve and Deny that end: once what a card asks is
 * settled, each of its messages is revised to its text and how it ended,
 * its buttons gone.
 */
export type Cards = {
  /** Whether the card went to a chat and has not ended. */
  has(key: string): boolean;
  /** Sends the card to each chat; a card already held keeps its text. */
  post(key: string, text: string, chatIds: readonly number[]): void;
  /** Revises the card to how it ended, and forgets it. */
  end(key: string, ending: string): void;
};

export function createCards(outbox: Outbox, kind: CardKind): Cards {
  const cards = new Map<string, Card>();

  return {
    has: key => cards.has(key),
    post(key, text, chatIds) {
      if (chatIds.length === 0) {
        return;
      }

      const card = cards.get(key) ?? {text, messages: [], ended: undefined};
      const keyboard = keyboardOf(kind, key);

      cards.set(key, card);

      for (const chatId of chatIds) {
        void outbox.card(chatId, card.text, keyboard).then(messageId => {
          if (messageId === undefined) {
            return;
          }

          if (card.ended === undefined) {
            card.messages.push([chatId, messageId]);
          } else {
            outbox.revise(chatId, messageId, card.ended);
          }
        });
      }
    },
    end(key, ending) {
      const card = cards.get(key);

      if (card === undefined) {
        return;
      }

      cards.delete(key);
      card.ended = `${card.text} · ${ending}`;

      for (const [chatId, messageId] of card.messages) {
        outbox.revise(chatId, messageId, card.ended);
      }
    },
  };
}

/**
 * A confirmation as a card says it: who wants to do what, and where it was
 * raised when the card names that; the preview when it has one; and when
 * it expires.
 */
export function confirmationText(
  pending: PendingConfirmation,
  name: string,
  raisedOn?: string,
): string {
  const {summary, preview} = pending.request;

  return [
    `${name} wants to: ${summary}` +
      (raisedOn === undefined ? '' : ` · raised on ${raisedOn}`),
    ...(Object.keys(preview).length === 0
      ? []
      : [JSON.stringify(preview, null, 2)]),
    `Expires at ${clockTime(pending.deadlineAt)}`,
  ].join('\n');
}

/** How a confirmation ended, as its card's last words say it. */
export function confirmationEnding(settlement: ConfirmationSettlement): string {
  if (settlement.decision !== 'cancelled') {
    return settlement.decision;
  }

  return settlement.reason === 'expired'
    ? 'expired'
    : 'cancelled when the character stopped';
}

/** A moment as the web page shows one: its hour and minute, in local time. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * A button press. A paired account's is acted on, and answered with the
 * toast that says how it went: a confirmation's here, a pairing request's
 * by `settlePairing` when the bot shows those. Any other account meets the
 * gate, and a button no card carries is answered with nothing.
 */
export async function readPress(
  chat: {
    readonly bot: BotContext;
    readonly gate: Gate;
    readonly outbox: Outbox;
  },
  query: TelegramCallbackQuery,
  settlePairing?: (code: string, decision: PairingDecision) => Promise<string>,
): Promise<void> {
  const {from} = query;
  const press = pressOf(query.data);
  let toast: string | undefined;

  chat.outbox.heardFrom(from.id);

  if (press !== undefined && (await chat.gate.admit(from.id, from))) {
    toast =
      press.kind === 'confirmation'
        ? await confirm(chat.bot, press.key, press.decision)
        : await settlePairing?.(press.key, press.decision);
  }

  chat.outbox.answer(query, toast);
}

async function confirm(
  bot: BotContext,
  id: string,
  decision: GatewayConfirmationDecision,
): Promise<string> {
  try {
    const {status} = await bot.client().answerConfirmation(id, decision);

    return status === 'answered' ? answered[decision] : answered[status];
  } catch (error: unknown) {
    rethrowUnlessTransport(error);

    return daemonDown;
  }
}

function keyboardOf(kind: CardKind, key: string): InlineKeyboard {
  const data = (answer: 'a' | 'd'): string =>
    `${letters[kind]}:${key}:${answer}`;

  return [
    [
      {text: 'Approve', callbackData: data('a')},
      {text: 'Deny', callbackData: data('d')},
    ],
  ];
}

/**
 * The press a button's data names; none for data no card carries. A key
 * is a confirmation's UUID or a pairing code, and the daemon gets it in a
 * URL path, so nothing else is let through.
 */
function pressOf(data: string | undefined): Press | undefined {
  const match = /^([cp]):([0-9a-f-]{1,36}):([ad])$/u.exec(data ?? '');

  if (match === null) {
    return undefined;
  }

  const [, letter, key = '', answer] = match;

  return {
    kind: letter === letters.confirmation ? 'confirmation' : 'pairing',
    key,
    decision: answer === 'a' ? 'approved' : 'denied',
  };
}
