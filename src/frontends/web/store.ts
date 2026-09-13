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
   * The turn's answer, when it came before the stream showed the line.
   * Its status matters later: `unsent` is the answer that never came, and
   * proof that the line landed takes that verdict back; every other one is
   * the daemon's word on the turn and stands whatever the line did.
   */
  readonly ended?: {
    readonly status: LineEnding['status'];
    readonly notice: string;
  };
};

export type Thread = {
  readonly characterId: string;
  readonly conversationId: string;
  readonly userParticipantId: string;
  /** Chronological, unique by message id. */
  readonly messages: readonly Message[];
  /** The cursor while older messages exist. */
  readonly earlier?: string | undefined;
  /** Draft id → the reply's text so far. */
  readonly drafts: ReadonlyMap<string, string>;
  /** A turn runs: the typing indicator until the first delta or the end. */
  readonly busy: boolean;
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
  /**
   * The page's one notice: how a turn did not complete, a confirmation
   * that expired, a page that could not be read, a verb the daemon
   * refused. Spent by the next send or open.
   */
  readonly notice?: string | undefined;
};

/** How a line's turn ended, from the answer or the stream; `unsent` is the answer that never came. */
export type LineEnding = {
  readonly status: TurnOutcome['status'] | 'unsent';
  readonly message?: string;
};

export type Opened = Extract<OpenOutcome, {status: 'opened'}>;

export const initialState: WebState = {
  connection: {status: 'connecting'},
  confirmations: [],
  pending: new Map(),
  composers: new Map(),
};

/** What the person has typed in the thread on screen. */
export function composerText(state: WebState): string {
  return state.thread === undefined
    ? ''
    : (state.composers.get(state.thread.conversationId) ?? '');
}

/**
 * Every `ready` is the truth: the roster and the waiting confirmations
 * replace, every open draft drops, and the thread empties for the newest
 * page the session reads next — nothing shown is stitched to it.
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
    ...(state.thread === undefined
      ? {}
      : {
          thread: {
            ...state.thread,
            messages: [],
            earlier: undefined,
            drafts: new Map(),
            busy: false,
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

  for (const [clientMessageId, line] of newestFirst(state)) {
    next = handedBack(
      next,
      clientMessageId,
      line,
      line.ended?.notice ?? message,
    );
  }

  return next;
}

/**
 * Newest line first, because each one returned goes in front of what is
 * already in its composer: several returned together land in the order
 * they were written.
 */
function newestFirst(state: WebState): readonly [string, PendingLine][] {
  return [...state.pending].reverse();
}

export function noticed(state: WebState, notice: string): WebState {
  return state.notice === notice ? state : {...state, notice};
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

export function threadOpened(state: WebState, opened: Opened): WebState {
  return {
    ...state,
    notice: undefined,
    thread: {
      characterId: opened.characterId,
      conversationId: opened.conversationId,
      userParticipantId: opened.userParticipantId,
      messages: [],
      drafts: new Map(),
      busy: false,
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
 * thread, and what was shown came live after it. A pending line of this
 * thread that the page carries is settled; one it lacks whose turn has
 * ended comes back to the composer; one whose turn has not run yet stays
 * pending. An earlier page goes in front, once — the same cursor read
 * twice is the same page.
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
      messages: [...before, ...messages, ...after],
      // Earlier pages already shown keep their cursor; the page's is for a thread that starts at it.
      earlier: before.length === 0 ? outcome.earlier : thread.earlier,
    },
  };

  for (const [clientMessageId, line] of newestFirst(state)) {
    if (line.conversationId !== conversationId) {
      continue;
    }

    if (carried.has(clientMessageId)) {
      next = settled(next, clientMessageId);
    } else if (line.ended !== undefined) {
      next = handedBack(next, clientMessageId, line, line.ended.notice);
    }
  }

  return next;
}

/** The composer's line becomes pending under its id, for the open thread; the notice is spent. */
export function lineSent(state: WebState, clientMessageId: string): WebState {
  const {thread} = state;
  const text = composerText(state).trim();

  if (thread === undefined || text.length === 0) {
    return state;
  }

  const pending = new Map(state.pending);

  pending.set(clientMessageId, {conversationId: thread.conversationId, text});

  return {
    ...composing(state, thread.conversationId, ''),
    notice: undefined,
    pending,
  };
}

/**
 * A line's end. The stream is ordered: a `turn_completed` that finds the
 * line still pending came without a `user_message` before it, so the line
 * was never committed and goes back to the composer with the message. The
 * turn's answer is not ordered against the stream and can beat the frame
 * that would show the line, so from the answer only a refusal hands it
 * back — nothing was recorded; a rejection, a failure, or an answer that
 * never came marks the line ended, and the stream or the newest page
 * settles it. A line comes back to the thread it was written in, open or
 * not. A line on the thread whose turn did not complete sets the notice,
 * as does another surface's. `completed` settles nothing here.
 */
export function lineEnded(
  state: WebState,
  clientMessageId: string,
  ending: LineEnding,
  from: 'answer' | 'stream',
): WebState {
  if (ending.status === 'completed') {
    return state;
  }

  const notice = ending.message ?? `The turn was ${ending.status}.`;
  const line = state.pending.get(clientMessageId);

  if (line === undefined) {
    return noticed(state, notice);
  }

  if (from === 'answer' && ending.status !== 'refused') {
    const pending = new Map(state.pending);

    pending.set(clientMessageId, {
      ...line,
      ended: {status: ending.status, notice},
    });

    return {...state, notice, pending};
  }

  return handedBack(state, clientMessageId, line, notice);
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

      return withThread(taken, thread =>
        thread.conversationId === event.conversationId
          ? applyProgress(thread, progress)
          : thread,
      );
    }
    case 'turn_completed': {
      // A turn's end reaches this tab's own line wherever it was written;
      // another surface's turn is news only on the thread being read.
      if (
        !state.pending.has(event.clientMessageId) &&
        state.thread?.conversationId !== event.conversationId
      ) {
        return state;
      }

      return lineEnded(
        withThread(state, thread =>
          thread.conversationId === event.conversationId
            ? {...thread, busy: false}
            : thread,
        ),
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
}

function applyProgress(
  thread: Thread,
  progress: Extract<GatewayEvent, {kind: 'turn_progress'}>['progress'],
): Thread {
  switch (progress.kind) {
    case 'user_message':
      return {
        ...thread,
        messages: appendMessage(thread.messages, messageOf(progress)),
        busy: true,
      };
    case 'visible_reply': {
      const drafts = new Map(thread.drafts);

      drafts.delete(progress.draftId);

      return {
        ...thread,
        messages: appendMessage(thread.messages, messageOf(progress)),
        drafts,
      };
    }
    case 'reply_delta': {
      const drafts = new Map(thread.drafts);

      drafts.set(
        progress.draftId,
        (drafts.get(progress.draftId) ?? '') + progress.text,
      );

      return {...thread, drafts};
    }
    case 'reply_withdrawn': {
      if (!thread.drafts.has(progress.draftId)) {
        return thread;
      }

      const drafts = new Map(thread.drafts);

      drafts.delete(progress.draftId);

      return {...thread, drafts};
    }
    case 'tool_calls_requested':
    case 'tool_call_completed':
      return thread;
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

/**
 * The daemon took the line after all. An answer that never came said
 * nothing about the turn, so the doubt it raised goes with it; a turn the
 * daemon judged — rejected, failed — keeps its word, since the line
 * landing is not a rebuttal of it.
 */
function settled(state: WebState, clientMessageId: string): WebState {
  const ended = state.pending.get(clientMessageId)?.ended;
  const pending = new Map(state.pending);

  pending.delete(clientMessageId);

  return {
    ...state,
    pending,
    ...(ended?.status === 'unsent' && state.notice === ended.notice
      ? {notice: undefined}
      : {}),
  };
}

/** The line was never taken: it is its own thread's composer again, with the reason. */
function handedBack(
  state: WebState,
  clientMessageId: string,
  line: PendingLine,
  notice: string,
): WebState {
  const pending = new Map(state.pending);
  const typed = state.composers.get(line.conversationId) ?? '';

  pending.delete(clientMessageId);

  return {
    ...composing(
      {...state, pending},
      line.conversationId,
      typed.length === 0 ? line.text : `${line.text} ${typed}`,
    ),
    notice,
  };
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
