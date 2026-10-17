import {maxSpeakerDisplayNameLength} from '../../core/index.ts';
import {
  foldRunningTurns,
  type GatewayEvent,
  type GatewayReady,
  type OpenOutcome,
  type PairingDecision,
  type PairingRequestOutcome,
  type RunningTurn,
  type RunningTurns,
} from '../../gateway/api/index.ts';
import {GatewayClientError} from '../../gateway/client/index.ts';
import type {TelegramMessage, TelegramUpdate, TelegramUser} from './bot-api.ts';
import {botNames, connectorId, type BotContext, type BotRules} from './bot.ts';
import {createOutbox, type Outbox} from './outbox.ts';

/** Everything a character's bot says in a chat. */
const sentences = {
  pairingCode: (code: string): string =>
    `This bot is private. Your pairing code is ${code}, good for an hour. ` +
    'Approve it on the web page, or send it to the management bot.',
  settled: (decision: PairingDecision | 'expired', name: string): string =>
    ({
      approved: `Paired. ${name} is listening.`,
      denied: 'The owner declined.',
      expired: 'Your pairing code expired; write again for a new one.',
    })[decision],
  hello: (name: string): string => `Hi, I'm ${name}. Write to me here.`,
  textOnly: 'I can only read text here for now.',
  unavailable: (name: string, message: string): string =>
    `${name} is not available right now: ${message}`,
  unanswered: (name: string, message: string, committed: boolean): string =>
    `${name} could not answer: ${message}` +
    (committed ? '' : '\nYour message was not taken; send it again.'),
  daemonDown:
    'The daemon is not running right now; send that again in a moment.',
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
  readonly characterId: string;
  /** The stamp on every line this bot carries. */
  readonly source: string;
  thread: Extract<OpenOutcome, {readonly status: 'opened'}> | undefined;
  /** Her conversation's running turn, folded by the contract's one rule. */
  turns: RunningTurns;
  /** Accounts this bot gave a pairing code, told how their request ends. */
  readonly strangers: Set<string>;
};

/**
 * A character's bot: her DM, opened once the bot knows its name; the
 * pairing gate on every message; a paired account's line carried to her;
 * and her conversation shown in every paired chat as the stream tells it.
 * Nothing is read from history.
 */
export function characterChat(
  characterId: string,
): (bot: BotContext) => BotRules {
  return bot => {
    const chat: Chat = {
      bot,
      outbox: createOutbox(bot),
      characterId,
      source: `telegram:${bot.username}`,
      thread: undefined,
      turns: new Map(),
      strangers: new Set(),
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
  const {message} = update;

  if (message?.chatType !== 'private' || message.from === undefined) {
    return;
  }

  const {chatId, from, text} = message;
  const {outbox} = chat;

  outbox.heardFrom(chatId);

  if (!paired(chat, String(from.id)) && !(await admitted(chat, chatId, from))) {
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
 * Asks the owner to let in an account the settings do not hold, and tells
 * it its code. The daemon's allowlist is the gate and the settings this
 * bot's read of it, so an account the daemon holds already is let in
 * before the next read lands.
 */
async function admitted(
  chat: Chat,
  chatId: number,
  from: TelegramUser,
): Promise<boolean> {
  const subject = {id: String(from.id), label: labelOf(from)};
  let outcome: PairingRequestOutcome;

  try {
    outcome = await chat.bot.client().requestPairing(connectorId, subject);
  } catch (error: unknown) {
    rethrowUnlessTransport(error);
    chat.outbox.say(chatId, sentences.daemonDown);

    return false;
  }

  if (outcome.status === 'pending') {
    chat.strangers.add(subject.id);
    chat.outbox.say(chatId, sentences.pairingCode(outcome.request.code));
  } else if (outcome.status === 'refused') {
    chat.bot.report(
      `${botNames(chat.bot.settings()).bot} could not ask to pair ${subject.label}: ${outcome.message}`,
    );
  }

  return outcome.status === 'paired';
}

/**
 * Carries a line to her. How a turn that ran ended is the stream's to
 * tell, before this answer arrives or after it, and for a line from before
 * a restart too; a refusal comes before any turn, and only its answer says
 * so.
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

    const outcome = await chat.bot.client().deliver({
      conversationId: thread.conversationId,
      senderId: thread.userParticipantId,
      text,
      source: chat.source,
      clientMessageId,
    });

    if (outcome.status === 'refused') {
      outbox.say(chatId, sentences.unavailable(nameOf(chat), outcome.message));
    }
  } catch (error: unknown) {
    rethrowUnlessTransport(error);
    outbox.say(chatId, sentences.daemonDown);
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
    case 'pairing_settled':
      if (
        event.connectorId === connectorId &&
        chat.strangers.delete(event.subject.id)
      ) {
        chat.outbox.say(
          Number(event.subject.id),
          sentences.settled(event.decision, nameOf(chat)),
        );
      }
      break;
    default:
      break;
  }
}

/**
 * A turn is shown here when this bot carried its line, or with Mirror on.
 * Its line, when another surface's, is shown as the person's; its reply
 * as it is written, then as committed.
 */
function followTurn(chat: Chat, event: TurnFrame): void {
  chat.turns = foldRunningTurns(chat.turns, event);

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
    paired(chat, account)
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
 * On a stream the daemon could not resume, her running turn is the
 * snapshot's, and the end of every draft shown here was missed: each is
 * withdrawn, as a page drops a bubble the snapshot does not carry, and one
 * still being written is posted again by its next words.
 */
function installSnapshot(chat: Chat, ready: GatewayReady): void {
  const turn = ready.turns.find(
    running => running.conversationId === chat.thread?.conversationId,
  );

  chat.turns = new Map(turn === undefined ? [] : [[turn.conversationId, turn]]);
  chat.outbox.withdrawAll();
}

function draftText(
  turn: RunningTurn | undefined,
  draftId: string,
): string | undefined {
  return turn?.drafts.find(draft => draft.draftId === draftId)?.text;
}

function paired(chat: Chat, account: string): boolean {
  return Object.hasOwn(chat.bot.settings().pairedUsers, account);
}

function nameOf(chat: Chat): string {
  return botNames(chat.bot.settings()).owner;
}

/** The client's own error is a daemon out of reach or answering with an error; anything else is a bug. */
function rethrowUnlessTransport(error: unknown): void {
  if (!(error instanceof GatewayClientError)) {
    throw error;
  }
}

/** A line's id names its chat and message, so a resend after a lost answer joins its turn. */
function lineId(message: TelegramMessage): string {
  return `${String(message.chatId)}.${String(message.messageId)}`;
}

/** The account whose chat a line of this bot's came from. */
function chatOfLine(clientMessageId: string): string {
  return clientMessageId.split('.', 1)[0] ?? '';
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
