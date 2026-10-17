import {
  foldRunningTurns,
  turnCommittedTheLine,
  type GatewayEvent,
  type GatewayReady,
  type OpenOutcome,
  type PendingConfirmation,
  type RunningTurn,
  type RunningTurns,
  type TurnOutcome,
} from '../../gateway/api/index.ts';
import {
  backoffMs,
  pause,
  type TelegramMessage,
  type TelegramUpdate,
} from './bot-api.ts';
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
import {createGate, type Gate} from './gate.ts';
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
  /** The hand-offs to her, begun in the order the lines came: the next once the one before is on its way. */
  handing: Promise<void>;
  /** Every running turn, folded by the contract's one rule; her DM's is the one shown. */
  turns: RunningTurns;
  /** Her turn frames from before her DM was known, folded and shown in order once it is. */
  readonly held: TurnFrame[];
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
      handing: Promise.resolve(),
      turns: new Map(),
      held: [],
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
    outbox.sayToPaired(chatId, sentences.textOnly);
  } else if (text.split(/\s/u, 1)[0] === '/start') {
    outbox.sayToPaired(chatId, sentences.hello(nameOf(chat)));
  } else {
    outbox.typing(chatId);
    void carry(chat, chatId, lineId(chat, message), text);
  }
}

/** A line handed to her: the turn's outcome on its way, or why her DM could not be opened for it. */
type Handoff =
  {readonly delivery: Promise<TurnOutcome>} | {readonly refusal: string};

/**
 * Carries a line to her, waiting as long as the bot runs: one that stops
 * gives up the wait, and the turn runs on. Lines are handed off in the
 * order they came, each once the one before is on its way, since the
 * daemon takes them as they arrive. How a turn that ran ended is the
 * stream's to tell, before this answer arrives or after it, and for a
 * line from before a restart too; a refusal comes before any turn, and
 * only its answer says so — but for a line the daemon took already under
 * this id, which Telegram hands on again after a restart: that one is in.
 */
async function carry(
  chat: Chat,
  chatId: number,
  clientMessageId: string,
  text: string,
): Promise<void> {
  const {outbox} = chat;
  const handoff: Promise<Handoff> = chat.handing.then(async () => {
    const thread = chat.thread ?? (await open(chat));

    return thread.status === 'opened'
      ? {
          delivery: chat.bot.client().deliver(
            {
              conversationId: thread.conversationId,
              senderId: thread.userParticipantId,
              text,
              source: chat.source,
              clientMessageId,
            },
            {signal: chat.bot.signal},
          ),
        }
      : {refusal: thread.message};
  });

  chat.handing = handoff.then(
    () => undefined,
    () => undefined,
  );

  try {
    const handed = await handoff;

    if ('refusal' in handed) {
      outbox.sayToPaired(
        chatId,
        sentences.unavailable(nameOf(chat), handed.refusal),
      );

      return;
    }

    const outcome = await handed.delivery;

    if (outcome.status === 'refused' && !turnCommittedTheLine(outcome)) {
      outbox.sayToPaired(
        chatId,
        sentences.unavailable(nameOf(chat), outcome.message),
      );
    }
  } catch (error: unknown) {
    rethrowUnlessTransport(error);
    outbox.sayToPaired(chatId, daemonDown);
  }
}

/**
 * Opens her DM and keeps it, then shows what came before it was known: the
 * drafts the snapshot gave it, and her frames held meanwhile, in order;
 * throws when the daemon cannot be reached.
 */
async function open(chat: Chat): Promise<OpenOutcome> {
  const outcome = await chat.bot
    .client()
    .openDirectConversation(chat.characterId, {signal: chat.bot.signal});

  if (outcome.status === 'opened') {
    chat.thread = outcome;
    showDrafts(chat);

    for (const frame of chat.held.splice(0)) {
      followEvent(chat, frame);
    }
  }

  return outcome;
}

/**
 * Opens her DM before any line, so other surfaces' turns can be shown,
 * asking again with a backoff while the daemon cannot be reached; one she
 * cannot take yet is opened once she is ready, or by the next line, which
 * tells its chat why when it cannot.
 */
function openAhead(chat: Chat): void {
  const {signal} = chat.bot;

  void (async () => {
    for (
      let failures = 0;
      !signal.aborted && chat.thread === undefined;
      failures += 1
    ) {
      try {
        await open(chat);

        return;
      } catch (error: unknown) {
        rethrowUnlessTransport(error);
      }

      await pause(backoffMs(failures), signal);
    }
  })();
}

function followEvent(chat: Chat, event: GatewayEvent): void {
  switch (event.kind) {
    case 'turn_progress':
    case 'turn_completed':
      if (chat.thread === undefined) {
        if (event.characterId === chat.characterId) {
          chat.held.push(event);
        }
      } else {
        chat.turns = foldRunningTurns(chat.turns, event);

        if (event.conversationId === chat.thread.conversationId) {
          followTurn(chat, event);
        }
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
    ended => confirmationText(pending, nameOf(chat), {ended}),
    account !== undefined && inAudience(chat, account)
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
  const shown = turn !== undefined && isShown(chat, turn);

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
      chat.outbox.sayToPaired(chatId, sentences.mirrored(turn.source, text));
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
    inAudience(chat, account)
  ) {
    chat.outbox.sayToPaired(
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
 * snapshot's — every one, as the fold has them — and what was held for a
 * DM not yet known is superseded; a DM not open yet is opened, the daemon
 * being there to ask. A draft shown here that the snapshot still carries
 * keeps its message and is brought to the snapshot's words; one it does
 * not is withdrawn, as a page drops a bubble the snapshot does not carry.
 * A card whose confirmation the snapshot no longer holds is ended, and a
 * confirmation still waiting has its card in every chat it should.
 */
function installSnapshot(chat: Chat, ready: GatewayReady): void {
  chat.turns = new Map(ready.turns.map(turn => [turn.conversationId, turn]));
  chat.held.splice(0);
  chat.outbox.withdrawExcept(
    new Set(herTurn(chat)?.drafts.map(draft => draft.draftId)),
  );

  if (chat.thread === undefined) {
    openAhead(chat);
  } else {
    showDrafts(chat);
  }
  chat.cards.keep(new Set(ready.confirmations.map(pending => pending.id)));

  for (const pending of ready.confirmations) {
    raiseCard(chat, pending);
  }
}

/** A turn is shown here when this bot carried its line, or with Mirror on. */
function isShown(chat: Chat, turn: RunningTurn): boolean {
  const settings = chat.bot.settings();

  return (
    turn.source === chat.source ||
    (settings.kind === 'character' && settings.mirror)
  );
}

/** Her DM's running turn, as the fold has it. */
function herTurn(chat: Chat): RunningTurn | undefined {
  return chat.thread === undefined
    ? undefined
    : chat.turns.get(chat.thread.conversationId);
}

/**
 * Her DM's drafts as the fold has them, brought to their words in the
 * chats: posted where none is, edited where one shows other words.
 */
function showDrafts(chat: Chat): void {
  const turn = herTurn(chat);

  if (turn === undefined) {
    return;
  }

  for (const draft of turn.drafts) {
    chat.outbox.draft(draft.draftId, draft.text, isShown(chat, turn));
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

/** Whether the account's chat is one this bot writes to, by the outbox's word: its read of the settings, and whom the daemon let in since. */
function inAudience(chat: Chat, account: string): boolean {
  return chat.outbox.paired().includes(Number(account));
}

/**
 * A line's id names the bot, its chat and the message, so a resend after
 * a lost answer joins its turn; the bot, because Telegram numbers
 * messages within a chat, and a bot that replaces this one on her token
 * opens a chat of its own with the same account, numbered from one again.
 */
function lineId(chat: Chat, message: TelegramMessage): string {
  return `${String(chat.bot.id)}.${String(message.chatId)}.${String(message.messageId)}`;
}

/** The account whose chat a line of this bot's came from. */
function chatOfLine(clientMessageId: string): string {
  return clientMessageId.split('.')[1] ?? '';
}
