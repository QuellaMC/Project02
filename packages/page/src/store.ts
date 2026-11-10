/**
 * Everything a tab shows, as one value, and every change to it as a pure
 * function of the previous value and one input: the daemon's snapshot, an
 * event, a history page, a send, a line's end. The session applies them
 * and React reads the value; a reducer that changes nothing returns the
 * value it was given. Nothing here touches the DOM, so the rules a page
 * follows are tested in Node with the rest of the suite.
 */
import type {
  AnswerOutcome,
  CharacterPreviewOutcome,
  CharacterSummary,
  ConfigTarget,
  ConfigView,
  ConfirmationCancelReason,
  GatewayEvent,
  GatewayHealth,
  GatewayReady,
  HistoryOutcome,
  OpenOutcome,
  PairingRequest,
  PairingSettleOutcome,
  PendingConfirmation,
  RunningTurn,
  RuntimeConfigSectionNamespace,
  TurnStatus,
  VisibleMessageRole,
} from '@project02/wire/contract';
import type {HistoryPage} from '@project02/wire/client';

export type Connection =
  | {readonly status: 'connecting'}
  | {readonly status: 'live'}
  /** The address will never work: a dead token, a wrong protocol, no token. */
  | {readonly status: 'refused'; readonly message: string};

/** A committed message as the page shows it; a person's own is told by its role. */
export type Message = {
  readonly messageId: string;
  readonly role: VisibleMessageRole;
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
  readonly text: string;
};

/** The one open DM as its log shows it. */
export type Thread = {
  readonly characterId: string;
  readonly conversationId: string;
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
 * A page of the settings window. A sub-page names the page it opens from,
 * which its Back button returns to and the sidebar marks.
 */
export type SettingsPage =
  | {readonly kind: 'you'}
  | {readonly kind: 'character'; readonly characterId: string}
  | {readonly kind: 'model'}
  | {readonly kind: 'telegram'}
  /** A plugin's account, set up once for everyone. */
  | {readonly kind: 'connection'; readonly pluginId: string}
  | {readonly kind: 'advanced'}
  /** A plugin's own page for one character, from her page. */
  | {
      readonly kind: 'feature';
      readonly characterId: string;
      readonly pluginId: string;
    }
  /** A character's own AI model, from her page. */
  | {readonly kind: 'character-model'; readonly characterId: string}
  /** A bot's page: the home's own, or a character's. */
  | {
      readonly kind: 'bot';
      readonly target: ConfigTarget;
      readonly from: 'character' | 'telegram';
    }
  /** What the app knows of one plugin or connector, from Advanced. */
  | {
      readonly kind: 'plugin';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
    }
  /**
   * A character file the person chose, and what the daemon said of it:
   * who she is and what adding her would do, or why she cannot be added
   * from it. Nothing of the file outlives the page.
   */
  | {
      readonly kind: 'add';
      /** The file's name on the person's computer. */
      readonly fileName: string;
      /** The file's text as it was read, sent again to add her; none when it holds no character. */
      readonly text?: string;
      readonly preview: CharacterPreviewOutcome;
      /** What the daemon said when adding her did not land. */
      readonly problem?: string;
      /** The page the file was chosen from, which Cancel goes back to. */
      readonly from: SettingsPage;
    }
  /** Her page, asking whether to remove her, with what the daemon said when removing her did not land. */
  | {
      readonly kind: 'remove';
      readonly characterId: string;
      readonly problem?: string;
    };

/** What stands in front of the chat: the settings window on a page, or the first run's welcome at a step. */
export type SettingsScreen =
  | {readonly kind: 'window'; readonly page: SettingsPage}
  | {readonly kind: 'welcome'; readonly step: 1 | 2 | 3};

/** One change on its way. */
export type Saving = {
  /** Its end is known by it: the end of an earlier change is not taken for this one's. */
  readonly ticket: number;
  readonly target: ConfigTarget;
  readonly place: SettingsPlace;
  /** The text it carried, none for a secret, which the tab keeps no copy of. */
  readonly text?: string;
  /** What the row held in the view the change was sent against. */
  readonly base: string;
  /** Whether it was sent again once already after someone else saved first. */
  readonly retried: boolean;
};

/** Where one value lives in a view: a host field, a section's switch, or a section's field. */
export type SettingsPlace =
  | {readonly kind: 'host'; readonly name: string}
  | {
      readonly kind: 'switch';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
    }
  | {
      readonly kind: 'field';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
      readonly name: string;
    };

/**
 * The settings in front of the chat, the window or the welcome, with the
 * views they draw from and what the person has typed; its rules live in
 * settings.ts.
 */
export type Settings = {
  readonly screen: SettingsScreen;
  /**
   * Each view as last read, by its target's key: the home's and each
   * character's. Every value the page shows is one of theirs.
   */
  readonly views: ReadonlyMap<string, ConfigView>;
  /** Row key → what is typed or clicked there and not saved; survives a re-read. */
  readonly edits: ReadonlyMap<string, string>;
  /** Row key → what the daemon said of the last change there. */
  readonly problems: ReadonlyMap<string, string>;
  readonly saving?: Saving;
  /** The row whose last change landed, and that change: its check shows for a moment. */
  readonly saved?: {readonly key: string; readonly ticket: number};
};

export type WebState = {
  readonly connection: Connection;
  readonly health?: GatewayHealth;
  /** Every confirmation still waiting, whatever surface raised it. */
  readonly confirmations: readonly PendingConfirmation[];
  /** Every pairing request waiting for the owner's answer, whatever connector asked. */
  readonly pairings: readonly PairingRequest[];
  /** The one open DM. */
  readonly thread?: Thread;
  /** The settings window or the welcome, when one is open in front of the chat. */
  readonly settings?: Settings;
  /**
   * The window's Advanced switch: what most people never need is shown
   * while it is on. The window remembers it, not the home.
   */
  readonly advanced: boolean;
  /** Client message id → a pending line; kept across a switch of threads. */
  readonly pending: ReadonlyMap<string, PendingLine>;
  /**
   * Conversation id → what a person has typed there and not sent. Kept
   * per conversation, so looking at another character loses nothing and a
   * line the daemon did not take comes back where it was written.
   */
  readonly composers: ReadonlyMap<string, string>;
  /**
   * Conversation id → the turn in progress there, for every conversation
   * and not only the one on screen, as the daemon last said it: the typing
   * indicator until her first draft or the end, and each draft's text so
   * far.
   */
  readonly turns: ReadonlyMap<string, RunningTurn>;
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

/** How a line ended, from the daemon's answer to it or from the stream. */
export type LineEnding = {
  readonly status: TurnStatus;
  /** Whether the line is in the log; the daemon says, and only it knows. */
  readonly committed: boolean;
  readonly message?: string;
};

export type Opened = Extract<OpenOutcome, {status: 'opened'}>;

export const initialState: WebState = {
  connection: {status: 'connecting'},
  advanced: false,
  confirmations: [],
  pairings: [],
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
 * Every `ready` is the truth: the roster, the waiting confirmations and
 * pairing requests, and the turns in progress replace what the tab held —
 * how a turn ended is still news — and what the thread shows is set aside
 * for the newest page the session reads next, kept on screen and stitched
 * to nothing that comes.
 */
export function installSnapshot(
  state: WebState,
  snapshot: GatewayReady,
): WebState {
  const waiting = new Set(snapshot.confirmations.map(pending => pending.id));
  let next: WebState = {
    ...rosterSaid(state, snapshot.health),
    connection: {status: 'live'},
    confirmations: snapshot.confirmations,
    pairings: snapshot.pairings,
    turns: new Map(snapshot.turns.map(turn => [turn.conversationId, turn])),
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
 * The stream is back where it left off: the daemon still held the last
 * frame this tab applied, so what follows is what it missed, and nothing
 * on screen moves. A refused address stays refused.
 */
export function streamResumed(state: WebState): WebState {
  return state.connection.status === 'connecting'
    ? {...state, connection: {status: 'live'}}
    : state;
}

/**
 * The address will never work again: the page stops taking new lines,
 * and every confirmation and pairing request waiting and every turn in
 * progress goes, since an answer would never reach the daemon and a draft
 * would never be finished. A line already sent stays as it is, with the
 * id it was sent under — a token dies when a daemon restarts, and a line
 * it committed just before is one the log can still be asked about.
 * Turning it back into ordinary text would lose the only name it can be
 * recognised by.
 */
export function connectionRefused(state: WebState, message: string): WebState {
  return {
    ...state,
    connection: {status: 'refused', message},
    confirmations: [],
    pairings: [],
    turns: new Map(),
  };
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
    text,
  });

  return {
    ...noticeSpent(composing(state, thread.conversationId, '')),
    pending,
  };
}

/**
 * A line's end, however it reaches the tab — the daemon's refusal of a
 * send, or the stream's word on its turn — said at once, naming its
 * character, this tab's line or another surface's. The end says whether
 * the line is in the log: one that is not is the person's to write again
 * and goes back to the thread it was written in, open or not; one that is
 * is the thread's, settled here, and the page or the frame shows it where
 * it landed — which may be far back, for a line the daemon took long
 * before. The page works none of this out — an answer can beat the frame
 * that would show the line, a stream is ordered only within one
 * connection, and a page of the log is a hundred messages, not the whole
 * of it — the daemon says. `completed` says only that.
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
  outcome: AnswerOutcome['status'],
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

/**
 * The daemon's answer to a click on a pairing card. A settlement is left
 * to the settled frame, which removes the card. An expiry is the news
 * that frame carries, said the same way, so whichever reaches the tab
 * first the person hears it once. A request the daemon does not know may
 * have been answered on another surface either way, so the page says only
 * that it is not waiting. An approval that could not be written leaves the
 * request waiting: the card stays, and the person hears why.
 */
export function pairingGone(
  state: WebState,
  code: string,
  outcome: PairingSettleOutcome,
): WebState {
  const card = state.pairings.find(pairing => pairing.code === code);

  if (card === undefined) {
    return state;
  }

  switch (outcome.status) {
    case 'settled':
      return state;
    case 'expired':
      return pairingExpired(state, card);
    case 'unknown':
      return noticed(
        withoutPairing(state, code),
        'A pairing request is no longer waiting.',
      );
    case 'failed':
      return noticed(state, outcome.message);
  }
}

/** A pairing request whose hour ran out unanswered, said the same way whichever news of it comes first. */
function pairingExpired(
  state: WebState,
  {code, subject}: Pick<PairingRequest, 'code' | 'subject'>,
): WebState {
  return noticed(
    withoutPairing(state, code),
    `A pairing request expired before it was answered: ${subject.label}, code ${code}.`,
  );
}

function withoutPairing(state: WebState, code: string): WebState {
  return {
    ...state,
    pairings: state.pairings.filter(pairing => pairing.code !== code),
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
    case 'health_changed':
      // The daemon's word on the roster, in order with every state frame.
      return rosterSaid(state, event.health);
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
    case 'pairing_requested':
      return state.pairings.some(pairing => pairing.code === event.code)
        ? state
        : {...state, pairings: [...state.pairings, pairingOf(event)]};
    case 'pairing_settled':
      return event.decision === 'expired'
        ? pairingExpired(state, event)
        : withoutPairing(state, event.code);
    case 'turn_progress': {
      const {progress} = event;
      // The daemon took the line, whichever thread it went to.
      const taken =
        progress.kind === 'user_message' &&
        state.pending.has(progress.clientMessageId)
          ? settled(state, progress.clientMessageId)
          : state;
      return withThread(taken, thread =>
        thread.conversationId === event.conversationId
          ? committed(thread, progress)
          : thread,
      );
    }
    case 'turn_running':
      // The daemon's word on the turn replaces the tab's copy whole.
      return {
        ...state,
        turns: new Map(state.turns).set(event.conversationId, runningOf(event)),
      };
    case 'turn_completed':
      return lineEnded(
        withoutTurnEnded(state, event),
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
    ? {
        ...thread,
        messages: appendMessage(
          thread.messages,
          messageOf({
            ...progress,
            role: progress.kind === 'user_message' ? 'user' : 'character',
          }),
        ),
      }
    : thread;
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

function runningOf(
  event: Extract<GatewayEvent, {kind: 'turn_running'}>,
): RunningTurn {
  return {
    characterId: event.characterId,
    conversationId: event.conversationId,
    source: event.source,
    clientMessageId: event.clientMessageId,
    drafts: event.drafts,
  };
}

/**
 * A turn ends at the completion of its own line, never at another's: a
 * line's end that names another submission leaves the turn running.
 */
function withoutTurnEnded(
  state: WebState,
  ended: Extract<GatewayEvent, {kind: 'turn_completed'}>,
): WebState {
  const turn = state.turns.get(ended.conversationId);

  if (
    turn?.source !== ended.source ||
    turn.clientMessageId !== ended.clientMessageId
  ) {
    return state;
  }

  const turns = new Map(state.turns);

  turns.delete(ended.conversationId);

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

/**
 * The roster as the daemon says it now. The settings window leaves the
 * page of a character it no longer lists; one it has not listed yet is on
 * her way, and her page stays.
 */
function rosterSaid(state: WebState, health: GatewayHealth): WebState {
  const listed = new Set(health.characters.map(character => character.id));
  let next: WebState = {...state, health};

  for (const character of state.health?.characters ?? []) {
    if (!listed.has(character.id)) {
      next = characterLeft(next, character.id);
    }
  }

  return next;
}

/**
 * A character is gone: the settings window leaves a page of hers for
 * You, and so does the page a preview goes back to.
 */
export function characterLeft(state: WebState, characterId: string): WebState {
  const {settings} = state;

  if (settings?.screen.kind !== 'window') {
    return state;
  }

  const page = pageWithout(settings.screen.page, characterId);

  return page === settings.screen.page
    ? state
    : {...state, settings: {...settings, screen: {kind: 'window', page}}};
}

function pageWithout(page: SettingsPage, characterId: string): SettingsPage {
  if (page.kind === 'add') {
    const from = pageWithout(page.from, characterId);

    return from === page.from ? page : {...page, from};
  }

  return characterOfPage(page) === characterId ? {kind: 'you'} : page;
}

/** The character a page of the window is about, when it is about one. */
function characterOfPage(page: SettingsPage): string | undefined {
  switch (page.kind) {
    case 'character':
    case 'remove':
    case 'feature':
    case 'character-model':
      return page.characterId;
    case 'bot':
      return page.target.scope === 'character'
        ? page.target.characterId
        : undefined;
    default:
      return undefined;
  }
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
    builtIn: character.builtIn,
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

function pairingOf(
  event: Extract<GatewayEvent, {kind: 'pairing_requested'}>,
): PairingRequest {
  return {
    connectorId: event.connectorId,
    code: event.code,
    subject: event.subject,
    source: event.source,
    requestedAt: event.requestedAt,
    expiresAt: event.expiresAt,
  };
}

function messageOf(source: {
  readonly messageId: string;
  readonly role: VisibleMessageRole;
  readonly speakerName: string;
  readonly text: string;
  readonly clientMessageId?: string;
}): Message {
  return {
    messageId: source.messageId,
    role: source.role,
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
