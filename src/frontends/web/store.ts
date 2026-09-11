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
  /** Client message id → a line the daemon has not yet said it took. */
  readonly pending: ReadonlyMap<string, string>;
  /** A turn runs: the typing indicator until the first delta or the end. */
  readonly busy: boolean;
  /** One line: how a turn did not complete, an expired confirmation, a page that could not be read. */
  readonly notice?: string | undefined;
};

export type WebState = {
  readonly connection: Connection;
  readonly health?: GatewayHealth;
  /** Every confirmation still waiting, whatever surface raised it. */
  readonly confirmations: readonly PendingConfirmation[];
  /** The one open DM. */
  readonly thread?: Thread;
  /** The composer's text, owned here so a line the daemon did not take can come back. */
  readonly composer: string;
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
  composer: '',
};

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

export function connectionRefused(state: WebState, message: string): WebState {
  return {...state, connection: {status: 'refused', message}};
}

export function threadOpened(state: WebState, opened: Opened): WebState {
  return {
    ...state,
    composer: '',
    thread: {
      characterId: opened.characterId,
      conversationId: opened.conversationId,
      userParticipantId: opened.userParticipantId,
      messages: [],
      drafts: new Map(),
      pending: new Map(),
      busy: false,
    },
  };
}

export function composerChanged(state: WebState, text: string): WebState {
  return state.composer === text ? state : {...state, composer: text};
}

/**
 * The newest page is the thread; a message that reached the page live
 * meanwhile stays after it, and a pending line the page carries is settled.
 * An earlier page goes in front: cursor pages are disjoint.
 */
export function historyPageRead(
  state: WebState,
  conversationId: string,
  page: 'newest' | 'earlier',
  outcome: HistoryOutcome,
): WebState {
  return withThread(state, thread => {
    if (thread.conversationId !== conversationId) {
      return thread;
    }

    if (outcome.status !== 'ok') {
      return {...thread, notice: outcome.message};
    }

    const messages = outcome.messages.map(messageOf);

    if (page === 'earlier') {
      return {
        ...thread,
        messages: [...messages, ...thread.messages],
        earlier: outcome.earlier,
      };
    }

    const onPage = new Set(messages.map(message => message.messageId));
    const pending = new Map(thread.pending);

    for (const message of messages) {
      if (message.clientMessageId !== undefined) {
        pending.delete(message.clientMessageId);
      }
    }

    return {
      ...thread,
      messages: [
        ...messages,
        ...thread.messages.filter(message => !onPage.has(message.messageId)),
      ],
      earlier: outcome.earlier,
      pending,
    };
  });
}

/** The composer's line becomes pending under its id; the notice is spent. */
export function lineSent(state: WebState, clientMessageId: string): WebState {
  const text = state.composer.trim();

  if (state.thread === undefined || text.length === 0) {
    return state;
  }

  const pending = new Map(state.thread.pending);

  pending.set(clientMessageId, text);

  return {
    ...state,
    composer: '',
    thread: {...state.thread, pending, notice: undefined},
  };
}

/**
 * One rule for a line's end, from the turn's answer and from the stream
 * alike. A line still pending goes back to the composer with the message:
 * the daemon did not take it, or refused or rejected it before any commit.
 * A line on the thread whose turn did not complete sets the notice, as
 * does another surface's. `completed` settles nothing here — the stream's
 * `user_message` did, or the next page will.
 */
export function lineEnded(
  state: WebState,
  clientMessageId: string,
  ending: LineEnding,
): WebState {
  const {thread} = state;

  if (thread === undefined || ending.status === 'completed') {
    return state;
  }

  const notice = ending.message ?? `The turn was ${ending.status}.`;
  const text = thread.pending.get(clientMessageId);

  if (text === undefined) {
    return thread.notice === notice
      ? state
      : {...state, thread: {...thread, notice}};
  }

  const pending = new Map(thread.pending);

  pending.delete(clientMessageId);

  return {
    ...state,
    composer: state.composer.length === 0 ? text : `${text} ${state.composer}`,
    thread: {...thread, pending, notice},
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
    case 'confirmation_settled': {
      const confirmations = state.confirmations.filter(
        pending => pending.id !== event.id,
      );
      const expired =
        event.decision === 'cancelled' &&
        state.thread?.characterId === event.characterId;

      return withThread({...state, confirmations}, thread =>
        expired
          ? {
              ...thread,
              notice: 'A confirmation expired before it was answered.',
            }
          : thread,
      );
    }
    case 'turn_progress':
      return withThread(state, thread =>
        thread.conversationId === event.conversationId
          ? applyProgress(thread, event.progress)
          : thread,
      );
    case 'turn_completed':
      return state.thread?.conversationId === event.conversationId
        ? lineEnded(
            {...state, thread: {...state.thread, busy: false}},
            event.clientMessageId,
            {
              status: event.status,
              ...(event.message === undefined
                ? event.reason === undefined
                  ? {}
                  : {message: event.reason}
                : {message: event.message}),
            },
          )
        : state;
  }
}

function applyProgress(
  thread: Thread,
  progress: Extract<GatewayEvent, {kind: 'turn_progress'}>['progress'],
): Thread {
  switch (progress.kind) {
    case 'user_message': {
      const pending = new Map(thread.pending);

      if (progress.clientMessageId !== undefined) {
        pending.delete(progress.clientMessageId);
      }

      return {
        ...thread,
        messages: appendMessage(thread.messages, messageOf(progress)),
        pending,
        busy: true,
      };
    }
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

/** A state change names the problem when it is one; a state without a message has none. */
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
    ...(character.maintenance === undefined
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
