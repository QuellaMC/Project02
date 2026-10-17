import {
  foldRunningTurns,
  type GatewayEvent,
  type GatewayReady,
  type OpenOutcome,
  type PendingConfirmation,
  type RunningTurn,
  type RunningTurns,
} from '../../gateway/api/index.ts';
import type {TelegramMessage, TelegramUpdate} from './bot-api.ts';
import {
  botNames,
  daemonDown,
  rethrowUnlessTransport,
  type BotContext,
  type BotRules,
} from './bot.ts';
import {
  confirmationEnding,
  confirmationText,
  createCards,
  readPress,
  type Cards,
} from './cards.ts';
import {createGate, paired, type Gate} from './gate.ts';
import {createOutbox, type Outbox} from './outbox.ts';

/** What a character's bot says in a chat, but for the gate's words. */
const sentences = {
  hello: (name: string): string => `Hi, I'm ${name}. Write to me here.`,
  textOnly: 'I can only read text here for now.',
  unavailable: (name: string, message: string): string =>
    `${name} is not available right now: ${message}`,
  unanswered: (name: string, message: string, committed: boolean): string =>
    `${name} could not answer: ${message}` +
    (committed ? '' : '\nYour message was not taken; send it again.'),
  mirrored: (source: string, text: string): string =>
    `You (${source}): ${text}`,
};

type TurnFrame = Extract<
  GatewayEvent,
  {readonly kind: 'turn_progress' | 'turn_completed'}
>;

type Chat = {
  readonly bot: BotContext;
  readonly outbox: Outbox;
  readonly gate: Gate;
  /** A card for each confirmation of hers this bot shows, by its id. */
  readonly cards: Cards;
  readonly characterId: string;
  /** The stamp on every line this bot carries. */
  readonly source: string;
  thread: Extract<OpenOutcome, {readonly status: 'opened'}> | undefined;
  /** Every running turn, folded by the contract's one rule; her DM's is the one shown. */
  turns: RunningTurns;
};

/**
 * A character's bot: her DM, opened once the bot knows its name; the
 * pairing gate on every message and press; a paired account's line
 * carried to her; her conversation shown in every paired chat as the
 * stream tells it; and a card with Approve and Deny for each confirmation
 * a turn of this bot's line raises. Nothing is read from history.
 */
export function characterChat(
  characterId: string,
): (bot: BotContext) => BotRules {
  return bot => {
    const outbox = createOutbox(bot);
    const chat: Chat = {
      bot,
      outbox,
      gate: createGate(bot, outbox, () => botNames(bot.settings()).owner),
      cards: createCards(outbox, 'confirmation'),
      characterId,
      source: `telegram:${bot.username}`,
      thread: undefined,
      turns: new Map(),
    };

    openAhead(chat);

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
    await readPress(chat, callbackQuery);

    return;
  }

  if (message?.chatType !== 'private' || message.from === undefined) {
    return;
  }

  const {chatId, from, text} = message;
  const {outbox} = chat;

  outbox.heardFrom(chatId);

  if (!(await chat.gate.admit(chatId, from))) {
    return;
  }

  if (text === undefined) {
    outbox.say(chatId, sentences.textOnly);
  } else if (text.split(/\s/u, 1)[0] === '/start') {
    outbox.say(chatId, sentences.hello(nameOf(chat)));
  } else {
    outbox.typing(chatId);
    void carry(chat, chatId, lineId(message), text);
  }
}

/**
 * Carries a line to her, waiting as long as the bot runs: one that stops
 * gives up the wait, and the turn runs on. How a turn that ran ended is
 * the stream's to tell, before this answer arrives or after it, and for a
 * line from before a restart too; a refusal comes before any turn, and
 * only its answer says so.
 */
async function carry(
  chat: Chat,
  chatId: number,
  clientMessageId: string,
  text: string,
): Promise<void> {
  const {outbox} = chat;

  try {
    const thread = chat.thread ?? (await open(chat));

    if (thread.status !== 'opened') {
      outbox.say(chatId, sentences.unavailable(nameOf(chat), thread.message));

      return;
    }

    const outcome = await chat.bot.client().deliver(
      {
        conversationId: thread.conversationId,
        senderId: thread.userParticipantId,
        text,
        source: chat.source,
        clientMessageId,
      },
      {signal: chat.bot.signal},
    );

    if (outcome.status === 'refused') {
      outbox.say(chatId, sentences.unavailable(nameOf(chat), outcome.message));
    }
  } catch (error: unknown) {
    rethrowUnlessTransport(error);
    outbox.say(chatId, daemonDown);
  }
}

/** Opens her DM and keeps it; throws when the daemon cannot be reached. */
async function open(chat: Chat): Promise<OpenOutcome> {
  const outcome = await chat.bot
    .client()
    .openDirectConversation(chat.characterId);

  if (outcome.status === 'opened') {
    chat.thread = outcome;
  }

  return outcome;
}

/**
 * Opens her DM before any line, so other surfaces' turns can be shown;
 * one she cannot take yet is opened once she is ready, or by the next
 * line, which tells its chat why when it cannot.
 */
function openAhead(chat: Chat): void {
  void open(chat).catch(rethrowUnlessTransport);
}

function followEvent(chat: Chat, event: GatewayEvent): void {
  switch (event.kind) {
    case 'turn_progress':
    case 'turn_completed':
      chat.turns = foldRunningTurns(chat.turns, event);

      if (event.conversationId === chat.thread?.conversationId) {
        followTurn(chat, event);
      }
      break;
    case 'state_changed':
      if (
        event.characterId === chat.characterId &&
        event.state === 'ready' &&
        chat.thread === undefined
      ) {
        openAhead(chat);
      }
      break;
    case 'confirmation_requested':
      raiseCard(chat, event);
      break;
    case 'confirmation_settled':
      chat.cards.end(event.id, confirmationEnding(event));
      break;
    case 'pairing_settled':
      chat.gate.settled(event);
      break;
    default:
      break;
  }
}

/**
 * A confirmation of hers that a turn of this bot's line raised is shown in
 * the chat the line came from; one raised with no turn, or whose line's
 * chat is paired no longer, in every paired chat. Another surface's turn
 * leaves it to that surface.
 */
function raiseCard(chat: Chat, pending: PendingConfirmation): void {
  const {turn} = pending;

  if (
    pending.characterId !== chat.characterId ||
    (turn !== undefined && turn.source !== chat.source)
  ) {
    return;
  }

  const account =
    turn === undefined ? undefined : chatOfLine(turn.clientMessageId);

  chat.cards.post(
    pending.id,
    confirmationText(pending, nameOf(chat)),
    account !== undefined && paired(chat.bot, account)
      ? [Number(account)]
      : chat.outbox.paired(),
  );
}

/**
 * A turn is shown here when this bot carried its line, or with Mirror on.
 * Its line, when another surface's, is shown as the person's; its reply
 * as it is written, then as committed.
 */
function followTurn(chat: Chat, event: TurnFrame): void {
  if (event.kind === 'turn_completed') {
    ended(chat, event);

    return;
  }

  const {outbox} = chat;
  const {progress} = event;
  const turn = chat.turns.get(event.conversationId);
  const settings = chat.bot.settings();
  const shown =
    turn !== undefined &&
    (turn.source === chat.source ||
      (settings.kind === 'character' && settings.mirror));

  switch (progress.kind) {
    case 'user_message':
      if (shown && turn.clientMessageId === progress.clientMessageId) {
        started(chat, turn, progress.text);
      }
      break;
    case 'reply_delta':
      outbox.draft(
        progress.draftId,
        draftText(turn, progress.draftId) ?? '',
        shown,
      );
      break;
    case 'visible_reply':
      outbox.commit(progress.draftId, progress.text, shown);
      break;
    case 'reply_withdrawn':
      outbox.withdraw(progress.draftId);
      break;
    default:
      break;
  }
}

function started(chat: Chat, turn: RunningTurn, text: string): void {
  for (const chatId of chat.outbox.paired()) {
    if (turn.source !== chat.source) {
      chat.outbox.say(chatId, sentences.mirrored(turn.source, text));
    }

    chat.outbox.typing(chatId);
  }
}

/** A turn of this bot's line that ran and did not complete, told in the chat the line came from. */
function ended(
  chat: Chat,
  event: Extract<TurnFrame, {readonly kind: 'turn_completed'}>,
): void {
  const account = chatOfLine(event.clientMessageId);

  if (
    event.source === chat.source &&
    (event.status === 'rejected' || event.status === 'failed') &&
    paired(chat.bot, account)
  ) {
    chat.outbox.say(
      Number(account),
      sentences.unanswered(
        nameOf(chat),
        event.message ?? event.status,
        event.committed,
      ),
    );
  }
}

/**
 * On a stream the daemon could not resume, the running turns are the
 * snapshot's — every one, as the fold has them; her DM is not open yet
 * when a bot starts — and the end of every draft shown here was missed:
 * each is withdrawn, as a page drops a bubble the snapshot does not carry,
 * and one still being written is posted again by its next words. A
 * confirmation still waiting that has no card here yet gets one.
 */
function installSnapshot(chat: Chat, ready: GatewayReady): void {
  chat.turns = new Map(ready.turns.map(turn => [turn.conversationId, turn]));
  chat.outbox.withdrawAll();

  for (const pending of ready.confirmations) {
    if (!chat.cards.has(pending.id)) {
      raiseCard(chat, pending);
    }
  }
}

function draftText(
  turn: RunningTurn | undefined,
  draftId: string,
): string | undefined {
  return turn?.drafts.find(draft => draft.draftId === draftId)?.text;
}

function nameOf(chat: Chat): string {
  return botNames(chat.bot.settings()).owner;
}

/** A line's id names its chat and message, so a resend after a lost answer joins its turn. */
function lineId(message: TelegramMessage): string {
  return `${String(message.chatId)}.${String(message.messageId)}`;
}

/** The account whose chat a line of this bot's came from. */
function chatOfLine(clientMessageId: string): string {
  return clientMessageId.split('.', 1)[0] ?? '';
}
