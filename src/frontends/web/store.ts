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
  GatewayEvent,
  GatewayHealth,
  GatewayReady,
  HistoryOutcome,
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

/** A line this tab sent that the stream has not yet shown, whichever thread it went to. */
export type PendingLine = {
  readonly conversationId: string;
  readonly text: string;
  /**
   * What the line comes back with if the page finds it was never taken:
   * the daemon's verdict, when the answer came before the stream showed
   * the line, or the reason the answer never came.
   */
  readonly ended?: string;
};

/** The one open DM as its log shows it. */
export type Thread = {
  readonly characterId: string;
  readonly conversationId: string;
  readonly userParticipantId: string;
  /**
   * What was shown before the stream reconnected: still on screen, but
   * stitched to nothing that comes, until the newest page replaces it.
   */
  readonly stale: readonly Message[];
  /** Chronological, unique by message id. */
  readonly messages: readonly Message[];
  /** The cursor while older messages exist. */
  readonly earlier?: string | undefined;
};

/**
 * What a conversation has to show that its log does not, kept for every
 * conversation because only the stream says it: a turn running there —
 * the typing indicator until the first delta or the end — each draft's
 * text so far, and how its last turn ended, held for a thread not on
 * screen until it is opened.
 */
export type TurnState = {
  readonly busy: boolean;
  /** Draft id → the reply's text so far. */
  readonly drafts: ReadonlyMap<string, string>;
  readonly ended?: string;
};

export type WebState = {
  readonly connection: Connection;
  readonly health?: GatewayHealth;
  /** Every confirmation still waiting, whatever surface raised it. */
  readonly confirmations: readonly PendingConfirmation[];
  /** The one open DM. */
  readonly thread?: Thread;
  /** Client message id → a pending line; kept across a switch of threads. */
  readonly pending: ReadonlyMap<string, PendingLine>;
  /**
   * Conversation id → what a person has typed there and not sent. Kept
   * per conversation, so looking at another character loses nothing and a
   * line the daemon did not take comes back where it was written.
   */
  readonly composers: ReadonlyMap<string, string>;
  /** Conversation id → its turn's news; absent when there is none. */
  readonly turns: ReadonlyMap<string, TurnState>;
  /**
   * The page's one notice: how a turn on the thread on screen did not
   * complete, a confirmation that expired, a page that could not be read,
   * a verb the daemon refused. Spent by the person's next act.
   */
  readonly notice?: string | undefined;
};

/** How a line's turn ended, from the answer or the stream. */
export type LineEnding = {
  readonly status: TurnOutcome['status'];
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
};

/** What the person has typed in the thread on screen. */
export function composerText(state: WebState): string {
  return state.thread === undefined
    ? ''
    : (state.composers.get(state.thread.conversationId) ?? '');
}

/**
 * Every `ready` is the truth: the roster and the waiting confirmations
 * replace, every turn's news drops, and what the thread shows is set
 * aside for the newest page the session reads next — kept on screen,
 * stitched to nothing that comes.
 */
export function installSnapshot(
  state: WebState,
  snapshot: GatewayReady,
): WebState {
  return {
    ...state,
    connection: {status: 'live'},
    health: snapshot.health,
    confirmations: snapshot.confirmations,
    turns: new Map(),
    ...(state.thread === undefined
      ? {}
      : {
          thread: {
            ...state.thread,
            stale: [...state.thread.stale, ...state.thread.messages],
            messages: [],
            earlier: undefined,
          },
        }),
  };
}

/**
 * The address will never work again, so nothing can settle a line this tab
 * sent: every pending line comes back where it was written, and the page
 * stops taking new ones.
 */
export function connectionRefused(state: WebState, message: string): WebState {
  let next: WebState = {...state, connection: {status: 'refused', message}};

  for (const [clientMessageId, line] of state.pending) {
    next = told(
      handedBack(next, clientMessageId, line),
      line.conversationId,
      line.ended ?? message,
    );
  }

  return next;
}

export function noticed(state: WebState, notice: string): WebState {
  return state.notice === notice ? state : {...state, notice};
}

/** The person's next act — a send, an open, an answer, a start — spends the notice. */
export function noticeSpent(state: WebState): WebState {
  return state.notice === undefined ? state : {...state, notice: undefined};
}

/**
 * A page that could not be read, said only for the thread still on
 * screen: a read left behind by a switch of characters must not tell a
 * person that the thread in front of them failed.
 */
export function pageUnread(
  state: WebState,
  conversationId: string,
  message: string,
): WebState {
  return state.thread?.conversationId === conversationId
    ? noticed(state, message)
    : state;
}

/** The thread opens empty for its newest page, with what its last turn left to say. */
export function threadOpened(state: WebState, opened: Opened): WebState {
  const {conversationId} = opened;

  return {
    ...withTurn(state, conversationId, turn => ({
      busy: turn.busy,
      drafts: turn.drafts,
    })),
    notice: state.turns.get(conversationId)?.ended,
    thread: {
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
 * The newest page is the thread. What was shown before its first message
 * — earlier pages — stays before it, and what arrived live after its last
 * message stays after it; a page that meets nothing shown is the whole
 * thread, and what was shown came live after it. What a reconnect set
 * aside is replaced. A pending line of this thread that the page carries
 * is settled; one it lacks whose turn has ended comes back to the
 * composer; one whose turn has not run yet stays pending. An earlier page
 * goes in front, once — the same cursor read twice is the same page.
 */
export function historyPageRead(
  state: WebState,
  conversationId: string,
  page: 'newest' | 'earlier',
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

  if (page === 'earlier') {
    const shown = new Set(thread.messages.map(message => message.messageId));

    return {
      ...state,
      thread: {
        ...thread,
        messages: [
          ...messages.filter(message => !shown.has(message.messageId)),
          ...thread.messages,
        ],
        earlier: outcome.earlier,
      },
    };
  }

  const onPage = new Set(messages.map(message => message.messageId));
  const carried = new Set(
    messages.flatMap(message =>
      message.clientMessageId === undefined ? [] : [message.clientMessageId],
    ),
  );
  const first = thread.messages.findIndex(message =>
    onPage.has(message.messageId),
  );
  const last = thread.messages.findLastIndex(message =>
    onPage.has(message.messageId),
  );
  const before = first === -1 ? [] : thread.messages.slice(0, first);
  const after = (
    first === -1 ? thread.messages : thread.messages.slice(last + 1)
  ).filter(message => !onPage.has(message.messageId));
  let next: WebState = {
    ...state,
    thread: {
      ...thread,
      stale: [],
      messages: [...before, ...messages, ...after],
      // Earlier pages already shown keep their cursor; the page's is for a thread that starts at it.
      earlier: before.length === 0 ? outcome.earlier : thread.earlier,
    },
  };

  for (const [clientMessageId, line] of state.pending) {
    if (line.conversationId !== conversationId) {
      continue;
    }

    if (carried.has(clientMessageId)) {
      next = settled(next, clientMessageId);
    } else if (line.ended !== undefined) {
      next = told(
        handedBack(next, clientMessageId, line),
        conversationId,
        line.ended,
      );
    }
  }

  return next;
}

/** The composer's line becomes pending under its id, for the open thread. */
export function lineSent(state: WebState, clientMessageId: string): WebState {
  const {thread} = state;
  const text = composerText(state).trim();

  if (thread === undefined || text.length === 0) {
    return state;
  }

  const pending = new Map(state.pending);

  pending.set(clientMessageId, {conversationId: thread.conversationId, text});

  return {
    ...noticeSpent(composing(state, thread.conversationId, '')),
    pending,
  };
}

/**
 * A line's end, from the stream or the turn's answer. The stream is
 * ordered: a `turn_completed` that finds the line still pending came
 * without a `user_message` before it, so the line was never committed and
 * goes back to the composer. The answer is not ordered against the stream
 * and can beat the frame that would show the line, so from the answer
 * only a refusal hands it back — nothing was recorded; a rejection or a
 * failure marks the line for the stream or the newest page to settle. A
 * line comes back to the thread it was written in, open or not. A turn
 * that did not complete is told to its conversation, this tab's or
 * another surface's. `completed` settles nothing here.
 */
export function lineEnded(
  state: WebState,
  conversationId: string,
  clientMessageId: string,
  ending: LineEnding,
  from: 'answer' | 'stream',
): WebState {
  if (ending.status === 'completed') {
    return state;
  }

  const notice = ending.message ?? `The turn was ${ending.status}.`;
  const line = state.pending.get(clientMessageId);
  const placed =
    line === undefined
      ? state
      : from === 'answer' && ending.status !== 'refused'
        ? marked(state, clientMessageId, line, notice)
        : handedBack(state, clientMessageId, line);

  return told(placed, conversationId, notice);
}

/**
 * The answer never came, and said nothing about the turn: the daemon may
 * have taken the line or never heard it. A line still pending keeps the
 * reason, to come back with if the newest page lacks it; a line the page
 * has already placed — shown by the stream, or returned — is left as it
 * is, so a lost answer never reads as a failure under a line that landed.
 */
export function answerLost(
  state: WebState,
  clientMessageId: string,
  message: string,
): WebState {
  const line = state.pending.get(clientMessageId);

  return line === undefined
    ? state
    : marked(state, clientMessageId, line, message);
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
    case 'confirmation_settled': {
      const settled = {
        ...state,
        confirmations: state.confirmations.filter(
          pending => pending.id !== event.id,
        ),
      };

      return event.decision === 'cancelled' &&
        state.thread?.characterId === event.characterId
        ? noticed(settled, 'A confirmation expired before it was answered.')
        : settled;
    }
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
        event.conversationId,
        event.clientMessageId,
        {
          status: event.status,
          ...(event.message === undefined
            ? event.reason === undefined
              ? {}
              : {message: event.reason}
            : {message: event.message}),
        },
        'stream',
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

  if (next.busy || next.drafts.size > 0 || next.ended !== undefined) {
    turns.set(conversationId, next);
  } else if (!turns.delete(conversationId)) {
    return state;
  }

  return {...state, turns};
}

/** A turn's end is told to its conversation: the notice while that thread is on screen, kept for it otherwise. */
function told(
  state: WebState,
  conversationId: string,
  notice: string,
): WebState {
  return state.thread?.conversationId === conversationId
    ? noticed(state, notice)
    : withTurn(state, conversationId, turn =>
        turn.ended === notice ? turn : {...turn, ended: notice},
      );
}

/** The daemon took the line, whichever thread it went to; what its ending said stands. */
function settled(state: WebState, clientMessageId: string): WebState {
  const pending = new Map(state.pending);

  pending.delete(clientMessageId);

  return {...state, pending};
}

/** The line keeps what it would come back with. */
function marked(
  state: WebState,
  clientMessageId: string,
  line: PendingLine,
  ended: string,
): WebState {
  const pending = new Map(state.pending);

  pending.set(clientMessageId, {...line, ended});

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
