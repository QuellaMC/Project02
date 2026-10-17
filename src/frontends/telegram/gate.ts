import {maxSpeakerDisplayNameLength} from '../../core/index.ts';
import type {
  GatewayEvent,
  PairingDecision,
  PairingRequestOutcome,
} from '../../gateway/api/index.ts';
import type {TelegramUser} from './bot-api.ts';
import {
  botNames,
  connectorId,
  daemonDown,
  minutesLeft,
  rethrowUnlessTransport,
  type BotContext,
  type BotSettings,
} from './bot.ts';
import type {Outbox} from './outbox.ts';

/** What the gate says to an account the home does not let in. */
const sentences = {
  refused:
    'This bot is private, and cannot take a pairing request right now; ' +
    'try again later.',
  pairingCode: (
    code: string,
    left: string,
    kind: BotSettings['kind'],
  ): string =>
    `This bot is private. Your pairing code is ${code}, good for ${left}. ` +
    (kind === 'management'
      ? 'Approve it on the web page.'
      : 'Approve it on the web page, or send it to the management bot.'),
  settled: (decision: PairingDecision | 'expired', name: string): string =>
    ({
      approved: `Paired. ${name} is listening.`,
      denied: 'The owner declined.',
      expired: 'Your pairing code expired; write again for a new one.',
    })[decision],
};

/** The pairing gate a bot keeps on everything an account sends it. */
export type Gate = {
  /**
   * Whether the account is let in. One the settings do not hold is asked
   * for, and told its code; the daemon's allowlist is the gate and the
   * settings this bot's read of it, so an account the daemon holds
   * already is let in before the next read lands.
   */
  admit(chatId: number, from: TelegramUser): Promise<boolean>;
  /** Tells an account this bot gave a code how that request ended; an earlier code's ending is not this one's. */
  settled(
    event: Extract<GatewayEvent, {readonly kind: 'pairing_settled'}>,
  ): void;
};

/** `name` is how the bot speaks of itself to an account it lets in. */
export function createGate(
  bot: BotContext,
  outbox: Outbox,
  name: () => string,
): Gate {
  /** Account id → the code this bot gave it, until that request is settled. */
  const strangers = new Map<string, string>();

  return {
    async admit(chatId, from) {
      if (paired(bot, String(from.id))) {
        return true;
      }

      const subject = {id: String(from.id), label: labelOf(from)};
      let outcome: PairingRequestOutcome;

      try {
        outcome = await bot
          .client()
          .requestPairing(connectorId, subject, {signal: bot.signal});
      } catch (error: unknown) {
        rethrowUnlessTransport(error);
        outbox.say(chatId, daemonDown);

        return false;
      }

      if (outcome.status === 'pending') {
        const {code, expiresAt} = outcome.request;

        strangers.set(subject.id, code);
        outbox.say(
          chatId,
          sentences.pairingCode(
            code,
            minutesLeft(expiresAt),
            bot.settings().kind,
          ),
        );
      } else if (outcome.status === 'paired') {
        outbox.admitted(chatId);
      } else {
        outbox.say(chatId, sentences.refused);
        bot.report(
          `${botNames(bot.settings()).bot} could not ask to pair ${subject.label}: ${outcome.message}`,
        );
      }

      return outcome.status === 'paired';
    },
    settled(event) {
      if (
        event.connectorId === connectorId &&
        strangers.get(event.subject.id) === event.code
      ) {
        strangers.delete(event.subject.id);
        outbox.say(
          Number(event.subject.id),
          sentences.settled(event.decision, name()),
        );
      }
    },
  };
}

/** Whether the home lets the account in, by this bot's read of the settings. */
function paired(bot: BotContext, account: string): boolean {
  return Object.hasOwn(bot.settings().pairedUsers, account);
}

/** The name the owner sees: one line, no longer than the daemon takes. */
function labelOf(user: TelegramUser): string {
  const name = [
    user.firstName,
    user.lastName,
    user.username === undefined ? undefined : `(@${user.username})`,
  ]
    .filter(part => part !== undefined)
    .join(' ');

  return Array.from(name.replace(/\s+/gu, ' ').trim())
    .slice(0, maxSpeakerDisplayNameLength)
    .join('')
    .trim();
}
