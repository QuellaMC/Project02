import type {
  GatewayEvent,
  GatewayReady,
  PairingDecision,
  PairingRequest,
  PendingConfirmation,
} from '../../gateway/api/index.ts';
import type {TelegramUpdate} from './bot-api.ts';
import {
  daemonDown,
  minutesLeft,
  rethrowUnlessTransport,
  type BotContext,
  type BotRules,
} from './bot.ts';
import {
  answered,
  confirmationEnding,
  confirmationText,
  createCards,
  readPress,
  type Cards,
} from './cards.ts';
import {createGate, type Gate} from './gate.ts';
import {createOutbox, type Outbox} from './outbox.ts';

/** What the management bot says in a chat, but for the gate's words and a confirmation's card. */
const sentences = {
  help:
    "This is the home's management bot. /status says who is on; /pending " +
    'shows what waits for you; /approve <code> and /deny <code> answer a ' +
    'pairing request.',
  noCharacters: 'No characters are installed.',
  nothingWaits: 'Nothing waits for you.',
  notWaiting: 'That code is not waiting.',
  pairing: (request: PairingRequest, ended: boolean): string =>
    `${request.subject.label} wants to pair · code ${request.code}` +
    (ended ? '' : ` · expires in ${minutesLeft(request.expiresAt)}`),
};

type Chat = {
  readonly bot: BotContext;
  readonly outbox: Outbox;
  readonly gate: Gate;
  /** A card for each confirmation of the home, by its id. */
  readonly confirmations: Cards;
  /** A card for each pairing request, by its code. */
  readonly pairings: Cards;
};

/**
 * The home's management bot, roster-shaped as the web page is: the same
 * pairing gate as a character's bot; for a paired account, who is on, what
 * waits, and an answer to a pairing request; and every confirmation and
 * pairing request of the home shown in every paired chat as a card with
 * Approve and Deny, naming the surface a confirmation was raised on.
 */
export function managementChat(): (bot: BotContext) => BotRules {
  return bot => {
    const outbox = createOutbox(bot);
    const chat: Chat = {
      bot,
      outbox,
      gate: createGate(bot, outbox, () => 'The management bot'),
      confirmations: createCards(outbox, 'confirmation'),
      pairings: createCards(outbox, 'pairing'),
    };

    return {
      onUpdate: update => readUpdate(chat, update),
      dispatch: event => {
        followEvent(chat, event);
      },
      snapshot: ready => {
        installSnapshot(chat, ready);
      },
    };
  };
}

async function readUpdate(chat: Chat, update: TelegramUpdate): Promise<void> {
  const {message, callbackQuery} = update;

  if (callbackQuery !== undefined) {
    await readPress(chat, callbackQuery, (code, decision) =>
      settle(chat.bot, code, decision, answered.unknown),
    );

    return;
  }

  if (message?.chatType !== 'private' || message.from === undefined) {
    return;
  }

  const {chatId, from} = message;

  chat.outbox.heardFrom(chatId);

  if (await chat.gate.admit(chatId, from)) {
    await command(chat, chatId, message.text ?? '');
  }
}

/** A paired account's command, by the first word of its text; any other text is answered with help. The answer goes by the audience as it is when its turn comes. */
async function command(
  chat: Chat,
  chatId: number,
  text: string,
): Promise<void> {
  const [word, code] = text.trim().split(/\s+/u);

  switch (word) {
    case '/status':
      chat.outbox.sayToPaired(chatId, await status(chat.bot));
      break;
    case '/pending':
      showPending(chat, chatId);
      break;
    case '/approve':
    case '/deny':
      chat.outbox.sayToPaired(
        chatId,
        code === undefined
          ? sentences.help
          : await settle(
              chat.bot,
              code,
              word === '/approve' ? 'approved' : 'denied',
              sentences.notWaiting,
            ),
      );
      break;
    default:
      chat.outbox.sayToPaired(chatId, sentences.help);
      break;
  }
}

/**
 * Who is on, as the daemon says it now: each character and her state, or
 * off when she is switched off. Read afresh, since a character's state
 * moves on frames of its own and health carries it only as of its read.
 */
async function status(bot: BotContext): Promise<string> {
  try {
    const {characters} = await bot.client().health({signal: bot.signal});

    return characters.length === 0
      ? sentences.noCharacters
      : characters
          .map(
            character =>
              `${character.displayName}: ${
                character.enabled ? character.state.replaceAll('_', ' ') : 'off'
              }`,
          )
          .join('\n');
  } catch (error: unknown) {
    rethrowUnlessTransport(error);

    return daemonDown;
  }
}

/**
 * What waits, as the stream has told this bot: a card for each in the
 * chat that asked, where it has none yet. The bot's own cards are the
 * source, not a read of the daemon's lists, so a settlement that lands
 * meanwhile cannot bring a card back.
 */
function showPending(chat: Chat, chatId: number): void {
  const held =
    chat.confirmations.postAll(chatId) + chat.pairings.postAll(chatId);

  if (held === 0) {
    chat.outbox.sayToPaired(chatId, sentences.nothingWaits);
  }
}

/** Settles a pairing request by its code; how it went in words, `unknown` saying a code nothing waits under. */
async function settle(
  bot: BotContext,
  code: string,
  decision: PairingDecision,
  unknown: string,
): Promise<string> {
  // The code goes into the daemon's URL path, which the client does not encode.
  if (!/^\d{6}$/u.test(code)) {
    return unknown;
  }

  try {
    const outcome = await bot
      .client()
      .settlePairing(code, decision, {signal: bot.signal});

    switch (outcome.status) {
      case 'settled':
        return answered[outcome.decision];
      case 'expired':
        return answered.expired;
      case 'unknown':
        return unknown;
      case 'failed':
        return outcome.message;
    }
  } catch (error: unknown) {
    rethrowUnlessTransport(error);

    return daemonDown;
  }
}

function followEvent(chat: Chat, event: GatewayEvent): void {
  switch (event.kind) {
    case 'confirmation_requested':
      postConfirmation(chat, event, chat.outbox.paired());
      break;
    case 'confirmation_settled':
      chat.confirmations.end(event.id, confirmationEnding(event));
      break;
    case 'pairing_requested':
      // Announced again after a failed approval: a chat that holds its card keeps it.
      postPairing(chat, event, chat.outbox.paired());
      break;
    case 'pairing_settled':
      chat.gate.settled(event);
      chat.pairings.end(event.code, event.decision);
      break;
    default:
      break;
  }
}

/**
 * On a stream the daemon could not resume, a card for what the snapshot
 * no longer carries is ended, and what still waits has its card in every
 * paired chat.
 */
function installSnapshot(chat: Chat, ready: GatewayReady): void {
  chat.confirmations.keep(
    new Set(ready.confirmations.map(pending => pending.id)),
  );
  chat.pairings.keep(new Set(ready.pairings.map(request => request.code)));

  for (const pending of ready.confirmations) {
    postConfirmation(chat, pending, chat.outbox.paired());
  }

  for (const request of ready.pairings) {
    postPairing(chat, request, chat.outbox.paired());
  }
}

function postConfirmation(
  chat: Chat,
  pending: PendingConfirmation,
  chatIds: readonly number[],
): void {
  const settings = chat.bot.settings();
  const name =
    settings.kind === 'management'
      ? settings.names.get(pending.characterId)
      : undefined;

  chat.confirmations.post(
    pending.id,
    ended =>
      confirmationText(pending, name ?? pending.characterId, {
        raisedOn: pending.turn?.source,
        ended,
      }),
    chatIds,
  );
}

function postPairing(
  chat: Chat,
  request: PairingRequest,
  chatIds: readonly number[],
): void {
  chat.pairings.post(
    request.code,
    ended => sentences.pairing(request, ended),
    chatIds,
  );
}
