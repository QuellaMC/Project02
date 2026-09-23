/**
 * Everything a tab shows, as one value, and every change to it as a pure
 * function of the previous value and one input: the daemon's snapshot, an
 * event, a history page, a send, a line's end. The session applies them
 * and React reads the value; a reducer that changes nothing returns the
 * value it was given. Nothing here touches the DOM, so the rules a page
 * follows are tested in Node with the rest of the suite.
 */
import type {
  CharacterSummary,
  ConfigTarget,
  ConfigView,
  ConfirmationAnswerStatus,
  ConfirmationCancelReason,
  GatewayEvent,
  GatewayHealth,
  GatewayReady,
  HistoryOutcome,
  HistoryPage,
  OpenOutcome,
  PendingConfirmation,
  TurnOutcome,
} from '../../gateway/api/index.ts';

export type Connection =
  | {readonly status: 'connecting'}
  | {readonly status: 'live'}
  /** The address will never work: a dead token, a wrong protocol, no token. */
  | {readonly status: 'refused'; readonly message: string};

/** A committed message as the page shows it; a person's own is told by its speaker. */
export type Message = {
  readonly messageId: string;
  readonly speakerId: string;
  readonly speakerName: string;
  readonly text: string;
  readonly clientMessageId?: string;
};

/**
 * A line this tab sent that the log has not yet shown, whichever thread
 * it went to: the submission itself, so it can be sent again under its
 * own id without a thread being open, and outlive the tab's memory.
 */
export type PendingLine = {
  readonly conversationId: string;
  readonly characterId: string;
  readonly senderId: string;
  readonly text: string;
};

/** The one open DM as its log shows it. */
export type Thread = {
  readonly characterId: string;
  readonly conversationId: string;
  readonly userParticipantId: string;
  /**
   * What was shown before the newest page this thread is waiting for:
   * still on screen, stitched to nothing that comes, until that page
   * replaces it. Its presence — empty or not — is what says a page is
   * replacing the thread, so what `messages` holds arrived after it was
   * asked for. Absent, the thread is simply what it has read.
   */
  readonly stale?: readonly Message[] | undefined;
  /** Chronological, unique by message id. */
  readonly messages: readonly Message[];
  /** The cursor while older messages exist. */
  readonly earlier?: string | undefined;
  /** Why the thread's last page could not be read; gone once one can be. */
  readonly unread?: string | undefined;
};

/**
 * A turn in progress, for every conversation and not only the one on
 * screen, because only the stream says it and no page read gives it
 * back: the typing indicator until the first delta or the end, and each
 * draft's text so far.
 */
export type TurnState = {
  readonly busy: boolean;
  /** Draft id → the reply's text so far. */
  readonly drafts: ReadonlyMap<string, string>;
};

/** The settings screen's state; its rules live in settings.ts. */
export type SettingsPage = {
  readonly target: ConfigTarget;
  /** The first run's heading, shown until the person leaves the screen. */
  readonly setup: boolean;
  /** Absent while the first read is on its way; a refused view shows its message, never blank fields. */
  readonly view?: ConfigView;
  /** Field key → what is typed there and not saved; survives a re-read. */
  readonly edits: ReadonlyMap<string, string>;
  /** Field key → the daemon's refusal of the last change there. */
  readonly problems: ReadonlyMap<string, string>;
  /** The one field whose change is on its way. */
  readonly saving?: string;
  /** The field whose last change landed, until the person's next edit. */
  readonly saved?: string;
};

export type WebState = {
  readonly connection: Connection;
  readonly health?: GatewayHealth;
  /** Every confirmation still waiting, whatever surface raised it. */
  readonly confirmations: readonly PendingConfirmation[];
  /** The one open DM. */
  readonly thread?: Thread;
  /** The settings screen, when one is open in front of the thread. */
  readonly settings?: SettingsPage;
  /** Client message id → a pending line; kept across a switch of threads. */
  readonly pending: ReadonlyMap<string, PendingLine>;
  /**
   * Conversation id → what a person has typed there and not sent. Kept
   * per conversation, so looking at another character loses nothing and a
   * line the daemon did not take comes back where it was written.
   */
  readonly composers: ReadonlyMap<string, string>;
  /** Conversation id → the turn running there; absent when none is. */
  readonly turns: ReadonlyMap<string, TurnState>;
  /**
   * What the page has to say that belongs to no thread: how a turn did
   * not complete, a confirmation that expired, a verb the daemon refused.
   * A person who sees the whole roster is told about the whole roster, so
   * a notice about a character names it, and a failure after a failure
   * is a second notice — nothing the daemon said is overwritten by the
   * next thing it says. The same sentence twice is one notice, since the
   * answer and the stream both report a turn's end. The person's next act
   * spends them all.
   */
  readonly notices: readonly string[];
};

/** How a line's turn ended, from the answer or the stream. */
export type LineEnding = {
  readonly status: TurnOutcome['status'];
  /** Whether the turn put the line in the log; the daemon says, and only it knows. */
  readonly committed: boolean;
  readonly message?: string;
};

export type Opened = Extract<OpenOutcome, {status: 'opened'}>;

const noTurn: TurnState = {busy: false, drafts: new Map()};

export const initialState: WebState = {
  connection: {status: 'connecting'},
  confirmations: [],
  pending: new Map(),
  composers: new Map(),
  turns: new Map(),
  notices: [],
};

/** A character as the person sees it named, wherever the page speaks of one. */
export function characterName(state: WebState, characterId: string): string {
  return (
    state.health?.characters.find(character => character.id === characterId)
      ?.displayName ?? characterId
  );
}

/** What the person has typed in the thread on screen. */
export function composerText(state: WebState): string {
  return state.thread === undefined
    ? ''
    : (state.composers.get(state.thread.conversationId) ?? '');
}

/**
 * Every `ready` is the truth: the roster and the waiting confirmations
 * replace, every turn in progress drops — how a turn ended is still news
 * — and what the thread shows is set aside for the newest page the
 * session reads next, kept on screen and stitched to nothing that comes.
 */
export function installSnapshot(
  state: WebState,
  snapshot: GatewayReady,
): WebState {
  const waiting = new Set(snapshot.confirmations.map(pending => pending.id));
  let next: WebState = {
    ...state,
    connection: {status: 'live'},
    health: snapshot.health,
    confirmations: snapshot.confirmations,
    turns: new Map(),
    ...(state.thread === undefined ? {} : {thread: setAside(state.thread)}),
  };

  // A card the snapshot does not carry ended while the tab was away, and
  // the frame that said how is not replayed: the person hears that their
  // chance to answer passed, which is all this tab can know.
  for (const card of state.confirmations) {
    if (!waiting.has(card.id)) {
      next = noticed(
        next,
        `${characterName(state, card.characterId)}: A confirmation ended while this page was away.`,
      );
    }
  }

  return next;
}

/**
 * The thread set aside for the newest page read next: still on screen,
 * stitched to nothing that comes, and past every cursor it held.
 */
function setAside(thread: Thread): Thread {
  return {
    ...thread,
    stale: [...(thread.stale ?? []), ...thread.messages],
    messages: [],
    earlier: undefined,
    unread: undefined,
  };
}

/**
 * The stream is down until the next `ready`, so the page says it is
 * connecting again: what it shows is from before, and a line sent now
 * waits for that `ready` to go.
 */
export function streamLost(state: WebState): WebState {
  return state.connection.status === 'live'
    ? {...state, connection: {status: 'connecting'}}
    : state;
}

/**
 * The address will never work again: the page stops taking new lines,
 * and every confirmation waiting and every turn in progress goes, since
 * an answer would never reach the daemon and a draft would never be
 * finished. A line already sent stays as it is, with the id it was sent
 * under — a token dies when a daemon restarts, and a line it committed
 * just before is one the log can still be asked about. Turning it back
 * into ordinary text would lose the only name it can be recognised by.
 */
export function connectionRefused(state: WebState, message: string): WebState {
  return {
    ...state,
    connection: {status: 'refused', message},
    confirmations: [],
    turns: new Map(),
  };
}

/**
 * The roster as the health verb reports it, read by a tab that changed
 * config: whether a character is on is config, which no event carries,
 * and the states that follow arrive as events.
 */
export function healthRead(state: WebState, health: GatewayHealth): WebState {
  return {...state, health};
}

/** Said once: the same news twice — a frame seen again — is the same notice. */
export function noticed(state: WebState, notice: string): WebState {
  return state.notices.includes(notice)
    ? state
    : {...state, notices: [...state.notices, notice]};
}

/** The person's next act — a send, an open, an answer, a start — spends them. */
export function noticeSpent(state: WebState): WebState {
  return state.notices.length === 0 ? state : {...state, notices: []};
}

/**
 * A thread whose page could not be read says so on itself, not in the
 * page's notice: a turn that failed and a page that would not load are
 * different news, and neither may erase the other. Said only for the
 * conversation on screen — a read of another is no news about the thread
 * in front of the person. Which read is still worth applying is the
 * session's to judge, since it holds the ones in flight.
 */
export function pageUnread(
  state: WebState,
  conversationId: string,
  message: string,
): WebState {
  return withThread(state, thread =>
    thread.conversationId === conversationId && thread.unread !== message
      ? {...thread, unread: message}
      : thread,
  );
}

/**
 * The thread opens for its newest page, with what its last turn left to
 * say. Opening the thread already on screen — a person clicking the
 * character they are reading — sets it aside rather than emptying it, as
 * a reconnect does, so a page that cannot be read leaves the
 * conversation in front of them.
 */
export function threadOpened(state: WebState, opened: Opened): WebState {
  const {conversationId} = opened;
  const {thread} = state;

  return {
    ...state,
    thread:
      thread?.conversationId === conversationId
        ? setAside(thread)
        : {
            characterId: opened.characterId,
            conversationId,
            userParticipantId: opened.userParticipantId,
            stale: [],
            messages: [],
          },
  };
}

export function composerChanged(state: WebState, text: string): WebState {
  return state.thread === undefined || composerText(state) === text
    ? state
    : composing(state, state.thread.conversationId, text);
}

/**
 * A page of the log, and the log's word on every line this tab is
 * waiting for: a page that carries a line proves the daemon took it, and
 * the line stops waiting. A page says nothing by lacking one — it holds
 * a hundred messages, and a busy turn can put more than that between a
 * line and now — so no line is ever returned on a page's silence.
 *
 * The newest page is the thread. What was shown before its first message
 * — earlier pages — stays before it, and what arrived live after its last
 * message stays after it; a page that meets nothing shown is the whole
 * thread, and what was shown came live after it. What a reconnect set
 * aside is replaced. An earlier page goes in front and moves the cursor
 * on. A message the thread already shows is shown once, from a page or
 * from a frame, so reading the same page twice changes nothing.
 */
export function historyPageRead(
  state: WebState,
  conversationId: string,
  request: HistoryPage,
  outcome: HistoryOutcome,
): WebState {
  const {thread} = state;

  if (thread?.conversationId !== conversationId) {
    return state;
  }

  if (outcome.status !== 'ok') {
    return pageUnread(state, conversationId, outcome.message);
  }

  const messages = outcome.messages.map(messageOf);
  // A page in front of the person answers whatever the thread last said
  // about being read.
  const read: Thread = {...thread, unread: undefined};

  return {
    ...state,
    thread:
      request.before === undefined
        ? newestPage(read, messages, outcome.earlier)
        : earlierPage(read, messages, outcome.earlier),
  };
}

/**
 * Every line of this tab's that a page carries: the daemon took it, and
 * the line stops waiting. The log's word on a line is not the same job
 * as showing a thread — a page read for a conversation nobody is looking
 * at still says whose lines it holds.
 */
export function linesTaken(state: WebState, outcome: HistoryOutcome): WebState {
  if (outcome.status !== 'ok') {
    return state;
  }

  let next = state;

  for (const {clientMessageId} of outcome.messages) {
    if (clientMessageId !== undefined && next.pending.has(clientMessageId)) {
      next = settled(next, clientMessageId);
    }
  }

  return next;
}

/** In front of the thread, once; the cursor moves on to what precedes it. */
function earlierPage(
  thread: Thread,
  messages: readonly Message[],
  earlier: string | undefined,
): Thread {
  const shown = new Set(thread.messages.map(message => message.messageId));

  return {
    ...thread,
    messages: [
      ...messages.filter(message => !shown.has(message.messageId)),
      ...thread.messages,
    ],
    earlier,
  };
}

/** The thread itself, with the earlier pages before it and what came live after. */
function newestPage(
  thread: Thread,
  messages: readonly Message[],
  earlier: string | undefined,
): Thread {
  const onPage = new Set(messages.map(message => message.messageId));
  const first = thread.messages.findIndex(message =>
    onPage.has(message.messageId),
  );

  // Nothing shown is on the page. What the thread shows came after this
  // page was asked for when the thread was set aside for it, and belongs
  // after it; otherwise it is history this tab read before falling more
  // than a page behind, which cannot be placed against the page at all —
  // so the page is the thread, and Load earlier asks for the rest.
  if (first === -1) {
    return {
      ...thread,
      stale: undefined,
      messages:
        thread.stale === undefined
          ? messages
          : [...messages, ...thread.messages],
      earlier,
    };
  }

  const last = thread.messages.findLastIndex(message =>
    onPage.has(message.messageId),
  );
  const before = thread.messages.slice(0, first);
  const after = thread.messages
    .slice(last + 1)
    .filter(message => !onPage.has(message.messageId));

  return {
    ...thread,
    stale: undefined,
    messages: [...before, ...messages, ...after],
    // Earlier pages already shown keep their cursor; the page's is for a thread that starts at it.
    earlier: before.length === 0 ? earlier : thread.earlier,
  };
}

/** The composer's line becomes pending under its id, for the open thread. */
export function lineSent(state: WebState, clientMessageId: string): WebState {
  const {thread} = state;
  const text = composerText(state).trim();

  if (thread === undefined || text.length === 0) {
    return state;
  }

  const pending = new Map(state.pending);

  pending.set(clientMessageId, {
    conversationId: thread.conversationId,
    characterId: thread.characterId,
    senderId: thread.userParticipantId,
    text,
  });

  return {
    ...noticeSpent(composing(state, thread.conversationId, '')),
    pending,
  };
}

/**
 * A turn's end, however it reaches the tab — the answer to a send, or the
 * stream — said at once, naming its character, this tab's turn or
 * another surface's. The end says whether the turn put the line in the
 * log: one it did not is the person's to write again and goes back to
 * the thread it was written in, open or not; one it did is the thread's,
 * settled here, and the page or the frame shows it where it landed —
 * which may be far back, for a line the daemon took in an earlier run.
 * The page works none of this out — an answer can beat the frame that
 * would show the line, a stream is ordered only within one connection,
 * and a page of the log is a hundred messages, not the whole of it — the
 * daemon says. `completed` says only that.
 */
export function lineEnded(
  state: WebState,
  characterId: string,
  clientMessageId: string,
  ending: LineEnding,
): WebState {
  const line = state.pending.get(clientMessageId);
  let next = state;

  if (line !== undefined) {
    next = ending.committed
      ? settled(state, clientMessageId)
      : handedBack(state, clientMessageId, line);
  }

  return ending.status === 'completed'
    ? next
    : noticed(
        next,
        `${characterName(state, characterId)}: ${
          ending.message ?? `The turn was ${ending.status}.`
        }`,
      );
}

/** A home is a world of its own: what was written for another one is not this one's. */
export function forgetWritten(state: WebState): WebState {
  return state.composers.size === 0 && state.pending.size === 0
    ? state
    : {...state, composers: new Map(), pending: new Map()};
}

/**
 * The daemon answered a click on a card with the news that the request
 * was not waiting any more: its deadline had passed, or another surface
 * settled it while this tab's stream was away. It is the same news the
 * cancelled frame carries, said the same way, so whichever reaches the
 * tab first the person hears it once.
 */
export function confirmationGone(
  state: WebState,
  id: string,
  outcome: ConfirmationAnswerStatus,
): WebState {
  const card = state.confirmations.find(pending => pending.id === id);

  if (card === undefined) {
    return state;
  }

  // The broker cancels what expires, so an expiry is the same news the
  // cancelled frame carries and is said the same way. A request the
  // daemon does not know is another matter: another surface may have
  // approved it, and its tool may have run, so the page says only that
  // it is not waiting — never that it was cancelled, which would invite
  // a person to do a settled thing again.
  return outcome === 'expired'
    ? cancelled(state, id, card.characterId, 'expired')
    : noticed(
        withoutConfirmation(state, id),
        `${characterName(state, card.characterId)}: A confirmation is no longer waiting.`,
      );
}

/** A confirmation that ended without this tab's answer, and why the person's click did nothing. */
function cancelled(
  state: WebState,
  id: string,
  characterId: string,
  reason: ConfirmationCancelReason,
): WebState {
  const name = characterName(state, characterId);

  return noticed(
    withoutConfirmation(state, id),
    reason === 'expired'
      ? `${name}: A confirmation expired before it was answered.`
      : `${name}: A confirmation was cancelled when the character stopped.`,
  );
}

function withoutConfirmation(state: WebState, id: string): WebState {
  return {
    ...state,
    confirmations: state.confirmations.filter(pending => pending.id !== id),
  };
}

export function applyEvent(state: WebState, event: GatewayEvent): WebState {
  switch (event.kind) {
    case 'state_changed':
      return withCharacter(state, event.characterId, character =>
        summaryOf(character, event.state, event.message),
      );
    case 'maintenance_failed':
      return withCharacter(state, event.characterId, character => ({
        ...character,
        maintenance: {at: event.at, message: event.message},
      }));
    case 'confirmation_requested':
      return state.confirmations.some(pending => pending.id === event.id)
        ? state
        : {...state, confirmations: [...state.confirmations, pendingOf(event)]};
    case 'confirmation_settled':
      // The card was on the page whoever raised it, so its end is too,
      // with the daemon's reason when nobody answered.
      return event.decision === 'cancelled'
        ? cancelled(state, event.id, event.characterId, event.reason)
        : withoutConfirmation(state, event.id);
    case 'turn_progress': {
      const {progress} = event;
      // The daemon took the line, whichever thread it went to.
      const taken =
        progress.kind === 'user_message' &&
        progress.clientMessageId !== undefined &&
        state.pending.has(progress.clientMessageId)
          ? settled(state, progress.clientMessageId)
          : state;
      const shown = withThread(taken, thread =>
        thread.conversationId === event.conversationId
          ? committed(thread, progress)
          : thread,
      );

      return withTurn(shown, event.conversationId, turn =>
        turnProgress(turn, progress),
      );
    }
    case 'turn_completed':
      return lineEnded(
        withTurn(state, event.conversationId, () => noTurn),
        event.characterId,
        event.clientMessageId,
        {
          status: event.status,
          committed: event.committed,
          ...(event.message === undefined
            ? event.reason === undefined
              ? {}
              : {message: event.reason}
            : {message: event.message}),
        },
      );
  }
}

/** A committed message of the thread on screen joins it; the log holds the rest. */
function committed(
  thread: Thread,
  progress: Extract<GatewayEvent, {kind: 'turn_progress'}>['progress'],
): Thread {
  return progress.kind === 'user_message' || progress.kind === 'visible_reply'
    ? {...thread, messages: appendMessage(thread.messages, messageOf(progress))}
    : thread;
}

function turnProgress(
  turn: TurnState,
  progress: Extract<GatewayEvent, {kind: 'turn_progress'}>['progress'],
): TurnState {
  switch (progress.kind) {
    case 'user_message':
      return turn.busy ? turn : {...turn, busy: true};
    case 'reply_delta': {
      const drafts = new Map(turn.drafts);

      drafts.set(
        progress.draftId,
        (drafts.get(progress.draftId) ?? '') + progress.text,
      );

      return {...turn, drafts};
    }
    case 'visible_reply':
    case 'reply_withdrawn': {
      if (!turn.drafts.has(progress.draftId)) {
        return turn;
      }

      const drafts = new Map(turn.drafts);

      drafts.delete(progress.draftId);

      return {...turn, drafts};
    }
    case 'tool_calls_requested':
    case 'tool_call_completed':
      return turn;
  }
}

function withThread(
  state: WebState,
  update: (thread: Thread) => Thread,
): WebState {
  if (state.thread === undefined) {
    return state;
  }

  const thread = update(state.thread);

  return thread === state.thread ? state : {...state, thread};
}

/** A conversation's turn record, kept while it has news and dropped when it has none. */
function withTurn(
  state: WebState,
  conversationId: string,
  update: (turn: TurnState) => TurnState,
): WebState {
  const turn = state.turns.get(conversationId) ?? noTurn;
  const next = update(turn);

  if (next === turn) {
    return state;
  }

  const turns = new Map(state.turns);

  if (next.busy || next.drafts.size > 0) {
    turns.set(conversationId, next);
  } else if (!turns.delete(conversationId)) {
    return state;
  }

  return {...state, turns};
}

/** The daemon took the line, whichever thread it went to; what its ending said stands. */
function settled(state: WebState, clientMessageId: string): WebState {
  const pending = new Map(state.pending);

  pending.delete(clientMessageId);

  return {...state, pending};
}

/**
 * The line was never taken: it goes back to its own thread's composer,
 * after what is there. Lines come back in the order they were sent, one
 * at a time from the stream or together from a page.
 */
function handedBack(
  state: WebState,
  clientMessageId: string,
  line: PendingLine,
): WebState {
  const pending = new Map(state.pending);
  const typed = state.composers.get(line.conversationId) ?? '';

  pending.delete(clientMessageId);

  return composing(
    {...state, pending},
    line.conversationId,
    typed.length === 0 ? line.text : `${typed} ${line.text}`,
  );
}

/** One conversation's unsent text; empty means nothing is being written there. */
function composing(
  state: WebState,
  conversationId: string,
  text: string,
): WebState {
  const composers = new Map(state.composers);

  if (text.length === 0) {
    composers.delete(conversationId);
  } else {
    composers.set(conversationId, text);
  }

  return {...state, composers};
}

function withCharacter(
  state: WebState,
  characterId: string,
  update: (character: CharacterSummary) => CharacterSummary,
): WebState {
  if (state.health === undefined) {
    return state;
  }

  return {
    ...state,
    health: {
      ...state.health,
      characters: state.health.characters.map(character =>
        character.id === characterId ? update(character) : character,
      ),
    },
  };
}

/**
 * A state change names the problem when it is one; a state without a
 * message has none. A fresh start clears the last boot's maintenance
 * note, as the runtime does.
 */
function summaryOf(
  character: CharacterSummary,
  state: CharacterSummary['state'],
  diagnostic: string | undefined,
): CharacterSummary {
  return {
    id: character.id,
    displayName: character.displayName,
    enabled: character.enabled,
    state,
    ...(diagnostic === undefined ? {} : {diagnostic}),
    ...(character.maintenance === undefined || state === 'starting'
      ? {}
      : {maintenance: character.maintenance}),
  };
}

function pendingOf(
  event: Extract<GatewayEvent, {kind: 'confirmation_requested'}>,
): PendingConfirmation {
  return {
    characterId: event.characterId,
    id: event.id,
    request: event.request,
    deadlineAt: event.deadlineAt,
    ...(event.turn === undefined ? {} : {turn: event.turn}),
  };
}

function messageOf(source: {
  readonly messageId: string;
  readonly speakerId: string;
  readonly speakerName: string;
  readonly text: string;
  readonly clientMessageId?: string;
}): Message {
  return {
    messageId: source.messageId,
    speakerId: source.speakerId,
    speakerName: source.speakerName,
    text: source.text,
    ...(source.clientMessageId === undefined
      ? {}
      : {clientMessageId: source.clientMessageId}),
  };
}

/** A message the page already shows — from a page, or the same frame twice — is shown once. */
function appendMessage(
  messages: readonly Message[],
  message: Message,
): readonly Message[] {
  return messages.some(shown => shown.messageId === message.messageId)
    ? messages
    : [...messages, message];
}
