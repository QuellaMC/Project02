import {describe, expect, it} from 'vitest';

import {
  applyEvent,
  composerChanged,
  composerText,
  confirmationGone,
  connectionRefused,
  doingIn,
  forgetWritten,
  historyPageRead,
  initialState,
  installSnapshot,
  keptLine,
  lineAnswered,
  lineEnded,
  lineSent,
  lineTakenBack,
  linesOnTheirWay,
  linesTaken,
  noticeSpent,
  pageUnread,
  pairingGone,
  streamLost,
  streamResumed,
  threadOpened,
  type WebState,
} from './store.ts';
import type {
  CharacterSummary,
  GatewayEvent,
  GatewayHealth,
  GatewayReady,
  HistoryMessage,
  HistoryOutcome,
  PairingRequest,
  PendingConfirmation,
  RunningTurn,
} from '@project02/wire/contract';

const mira: CharacterSummary = {
  id: 'mira',
  displayName: 'Mira',
  enabled: true,
  builtIn: true,
  state: 'ready',
};
const conversationId = 'conv-1';
/** When every message of these tests was sent: the store keeps it as the daemon says it. */
const sentAt = '2026-09-11T00:00:00.000Z';
/** When she read each line of the person's, a moment after it was sent: kept the same way. */
const readAt = '2026-09-11T00:00:02.000Z';

function health(...characters: readonly CharacterSummary[]): GatewayHealth {
  return {
    protocolVersion: 19,
    homeRoot: '/home/person/.project02',
    config: {diagnostics: []},
    packages: {diagnostics: []},
    characters,
    connectors: [],
    accounts: [],
    chatgpt: {state: 'signed_out'},
  };
}

function ready(
  confirmations: readonly PendingConfirmation[] = [],
  turns: readonly RunningTurn[] = [],
): GatewayReady {
  return {
    protocolVersion: 19,
    health: health(mira),
    confirmations,
    pairings: [],
    turns,
  };
}

/** A live tab with Mira's DM open and nothing shown yet. */
function opened(): WebState {
  return threadOpened(installSnapshot(initialState, ready()), {
    status: 'opened',
    conversationId,
    characterId: 'mira',
  });
}

function progress(
  progress: Extract<GatewayEvent, {kind: 'turn_progress'}>['progress'],
  conversation = conversationId,
): GatewayEvent {
  return {
    kind: 'turn_progress',
    characterId: 'mira',
    conversationId: conversation,
    progress,
  };
}

function userMessage(
  messageId: string,
  text: string,
  clientMessageId: string,
  conversation = conversationId,
): GatewayEvent {
  return progress(
    {
      kind: 'user_message',
      messageId,
      speakerId: 'local-user',
      speakerName: 'You',
      text,
      sentAt,
      readAt,
      app: 'messages',
      source: 'web',
      clientMessageId,
    },
    conversation,
  );
}

/** Mira's turn of the line `clientMessageId` as the daemon says it runs now, `writing` or not. */
function running(
  clientMessageId: string,
  writing = false,
  conversation = conversationId,
): GatewayEvent {
  return {
    kind: 'turn_running',
    characterId: 'mira',
    conversationId: conversation,
    source: 'web',
    clientMessageId,
    writing,
  };
}

/** A turn's end as the daemon sends it: `committed` is its word on the line. */
function completed(
  clientMessageId: string,
  status: 'completed' | 'rejected' | 'failed' | 'refused' = 'completed',
  message?: string,
  committed = true,
): GatewayEvent {
  return {
    kind: 'turn_completed',
    characterId: 'mira',
    conversationId,
    source: 'web',
    clientMessageId,
    status,
    committed,
    ...(message === undefined ? {} : {message}),
  };
}

/** A turn of Mira's own, which no line began, as the daemon says it runs now. */
function ownRunning(writing = false): GatewayEvent {
  return {kind: 'turn_running', characterId: 'mira', conversationId, writing};
}

/** A message of Mira's, committed in Messages. */
function hers(messageId: string, text: string): GatewayEvent {
  return progress({
    kind: 'visible_reply',
    messageId,
    speakerId: 'mira',
    speakerName: 'Mira',
    text,
    sentAt,
    app: 'messages',
  });
}

/** A turn of Mira's own as it ends: it carries no line's stamps. */
function ownCompleted(
  status: 'completed' | 'rejected' | 'failed',
  message?: string,
): GatewayEvent {
  return {
    kind: 'turn_completed',
    characterId: 'mira',
    conversationId,
    status,
    committed: true,
    ...(message === undefined ? {} : {message}),
  };
}

/** A call of a tool `pluginId` provides, come back in `characterId`'s turn on `conversation`. */
function called(
  pluginId: string,
  toolName: string,
  characterId = 'mira',
  conversation = conversationId,
): GatewayEvent {
  return {
    kind: 'turn_progress',
    characterId,
    conversationId: conversation,
    progress: {
      kind: 'tool_call_completed',
      round: 1,
      status: 'accepted',
      pluginId,
      toolName,
    },
  };
}

function confirmation(id: string): PendingConfirmation {
  return {
    characterId: 'mira',
    id,
    request: {
      pluginId: 'runtime.plugin',
      toolName: 'runtime.plugin.config.update',
      summary: 'Set tone to warm',
      preview: {tone: 'warm'},
    },
    deadlineAt: 1_000,
    turn: {conversationId, source: 'web', clientMessageId: 'line-1'},
  };
}

function pairing(code: string, label: string): PairingRequest {
  return {
    connectorId: 'telegram',
    code,
    subject: {id: `account-${code}`, label},
    source: 'telegram:mira_bot',
    requestedAt: '2026-10-17T09:00:00.000Z',
    expiresAt: 3_600_000,
  };
}

function page(
  messages: readonly HistoryMessage[],
  earlier?: string,
): HistoryOutcome {
  return {
    status: 'ok',
    conversationId,
    characterId: 'mira',
    messages,
    ...(earlier === undefined ? {} : {earlier}),
  };
}

function committed(
  messageId: string,
  text: string,
  clientMessageId?: string,
): HistoryMessage {
  return {
    messageId,
    role: clientMessageId === undefined ? 'character' : 'user',
    speakerId: clientMessageId === undefined ? 'mira' : 'local-user',
    speakerName: clientMessageId === undefined ? 'Mira' : 'You',
    text,
    sentAt,
    app: 'messages',
    ...(clientMessageId === undefined ? {} : {source: 'web', clientMessageId}),
  };
}

function sent(state: WebState, text: string, clientMessageId: string) {
  return lineSent(composerChanged(state, text), clientMessageId);
}

describe('web store', () => {
  it('says it is connecting again while the stream is down, keeps what it shows, is live again on a resume with nothing moved, and leaves a refused address refused', () => {
    const live = opened();
    const lost = streamLost(live);

    expect(lost.connection).toEqual({status: 'connecting'});
    expect(lost.thread).toBe(live.thread);
    expect(streamLost(lost)).toBe(lost);
    expect(installSnapshot(lost, ready()).connection).toEqual({status: 'live'});

    const resumed = streamResumed(lost);

    expect(resumed.connection).toEqual({status: 'live'});
    expect(resumed.thread).toBe(live.thread);
    expect(streamResumed(live)).toBe(live);

    const refused = connectionRefused(live, 'A bearer token is required.');

    expect(streamLost(refused)).toBe(refused);
    expect(streamResumed(refused)).toBe(refused);
  });

  it('installs every ready as the truth: roster, confirmations and the turns in progress replace, and what the thread shows stays on screen until its newest page replaces it', () => {
    let state = applyEvent(opened(), userMessage('m-1', 'hello', 'line-1'));

    state = applyEvent(state, running('line-1', true));
    expect(state.turns.has(conversationId)).toBe(true);

    const elsewhere: RunningTurn = {
      characterId: 'nova',
      conversationId: 'conv-2',
      source: 'telegram:bot',
      clientMessageId: 'line-7',
      writing: true,
    };

    state = installSnapshot(state, ready([confirmation('c-1')], [elsewhere]));

    expect(state.connection).toEqual({status: 'live'});
    expect(state.health?.characters).toEqual([mira]);
    expect(state.confirmations.map(pending => pending.id)).toEqual(['c-1']);
    expect([...state.turns]).toEqual([['conv-2', elsewhere]]);
    expect(state.thread).toMatchObject({
      stale: [{messageId: 'm-1'}],
      messages: [],
    });

    // A page that cannot be read leaves what was shown in place, with the notice.
    const unread = historyPageRead(
      state,
      conversationId,
      {},
      {
        status: 'failed',
        code: 'missing_file',
        message: 'The thread could not be read.',
      },
    );

    expect(unread.thread?.stale?.map(message => message.messageId)).toEqual([
      'm-1',
    ]);
    expect(unread.thread?.unread).toBe('The thread could not be read.');

    // The newest page replaces what was set aside and keeps what arrived
    // live after the reconnect.
    state = applyEvent(state, userMessage('m-3', 'meanwhile', 'line-3'));
    state = historyPageRead(
      state,
      conversationId,
      {},
      page([committed('m-1', 'hello', 'line-1'), committed('m-2', 'hi')]),
    );

    // The page has landed, so the thread is what it has read: a later
    // page that meets none of it is a thread this tab has fallen behind,
    // not a page to put in front of what is shown.
    expect(state.thread?.stale).toBeUndefined();
    expect(state.thread?.messages.map(message => message.messageId)).toEqual([
      'm-1',
      'm-2',
      'm-3',
    ]);
  });

  it('sets the thread aside when its own character is opened again, so a refresh that cannot be read leaves the conversation in place', () => {
    const state = applyEvent(opened(), userMessage('m-1', 'hello', 'line-1'));
    const again = threadOpened(state, {
      status: 'opened',
      conversationId,
      characterId: 'mira',
    });

    expect(again.thread?.stale?.map(message => message.messageId)).toEqual([
      'm-1',
    ]);
    expect(again.thread?.messages).toEqual([]);

    // Another character's thread starts empty: what was shown is not its own.
    const nova = threadOpened(state, {
      status: 'opened',
      conversationId: 'conv-2',
      characterId: 'nova',
    });

    expect(nova.thread?.stale).toEqual([]);
  });

  it('shows a line once the daemon says so: the pending bubble, sending, becomes the message, with when it was sent, when she read it and its app, and a frame seen twice shows once', () => {
    let state = sent(opened(), 'hello there', 'line-1');

    expect(composerText(state)).toBe('');
    expect([...state.pending.entries()]).toEqual([
      [
        'line-1',
        {
          conversationId,
          characterId: 'mira',
          text: 'hello there',
          state: 'sending',
        },
      ],
    ]);

    state = applyEvent(state, userMessage('m-1', 'hello there', 'line-1'));
    state = applyEvent(state, userMessage('m-1', 'hello there', 'line-1'));

    expect(state.pending.size).toBe(0);
    expect(state.thread?.messages).toEqual([
      {
        messageId: 'm-1',
        role: 'user',
        speakerName: 'You',
        text: 'hello there',
        sentAt,
        readAt,
        app: 'messages',
        clientMessageId: 'line-1',
      },
    ]);
  });

  it("keeps both forms of a message as the wire gives them, from a frame or a page: the person's line as she read it and as they wrote it, hers in her words and in theirs", () => {
    const written = 'Would you like some tea?';
    const translation = 'I would love some.';
    const live = [
      progress({
        kind: 'user_message',
        messageId: 'm-1',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'お茶はいかが？',
        written,
        sentAt,
        readAt,
        app: 'messages',
        source: 'web',
        clientMessageId: 'line-1',
      }),
      progress({
        kind: 'visible_reply',
        messageId: 'm-2',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'いただきます。',
        translation,
        sentAt,
        app: 'messages',
      }),
    ].reduce(applyEvent, opened());
    const read = historyPageRead(
      opened(),
      conversationId,
      {},
      page([
        {...committed('m-1', 'お茶はいかが？', 'line-1'), written},
        {...committed('m-2', 'いただきます。'), translation},
      ]),
    );

    for (const state of [live, read]) {
      expect(state.thread?.messages).toMatchObject([
        {text: 'お茶はいかが？', written},
        {text: 'いただきます。', translation},
      ]);
    }
  });

  it("says a line is delivered once the daemon answers that her inbox has it, now or already, and not delivered when it refuses it or cannot queue it, saying why; a duplicate is the line in the log, and no answer after a line's end moves it", () => {
    const state = sent(sent(opened(), 'first', 'line-1'), 'second', 'line-2');
    const queued = lineAnswered(state, 'mira', 'line-1', {status: 'queued'});

    expect(queued.pending.get('line-1')?.state).toBe('delivered');
    expect(
      lineAnswered(state, 'mira', 'line-1', {
        status: 'already_queued',
      }).pending.get('line-1')?.state,
    ).toBe('delivered');
    // Sent again by itself, as on a new stream, it stays delivered.
    expect(
      lineAnswered(queued, 'mira', 'line-1', {status: 'already_queued'}),
    ).toBe(queued);

    const refused = lineAnswered(state, 'mira', 'line-1', {
      status: 'refused',
      reason: 'character_unavailable',
      message: 'Character "mira" is not running.',
    });
    const failed = lineAnswered(refused, 'mira', 'line-2', {
      status: 'failed',
      code: 'write_failed',
      message: 'The disk is full.',
    });

    expect([...failed.pending.values()].map(line => line.state)).toEqual([
      'not_delivered',
      'not_delivered',
    ]);
    expect(failed.notices).toEqual([
      'Mira: Character "mira" is not running.',
      'Mira: The disk is full.',
    ]);
    // An answer that comes after the line's end leaves it as it ended.
    expect(lineAnswered(failed, 'mira', 'line-1', {status: 'queued'})).toBe(
      failed,
    );

    const duplicate = lineAnswered(queued, 'mira', 'line-1', {
      status: 'refused',
      reason: 'duplicate_submission',
      message: 'clientMessageId "line-1" is already on this conversation.',
    });

    expect([...duplicate.pending.keys()]).toEqual(['line-2']);
    expect(duplicate.notices).toEqual([
      'Mira: clientMessageId "line-1" is already on this conversation.',
    ]);
    // Delivered, it becomes the message by its frame or a page that carries it.
    expect(
      applyEvent(queued, userMessage('m-1', 'first', 'line-1')).pending.has(
        'line-1',
      ),
    ).toBe(false);
    expect(
      linesTaken(
        queued,
        page([committed('m-1', 'first', 'line-1')]),
      ).pending.has('line-1'),
    ).toBe(false);
  });

  it('sends again by itself only the lines still on their way, never one that did not reach her', () => {
    const state = lineEnded(
      lineAnswered(
        sent(
          sent(sent(opened(), 'first', 'line-1'), 'second', 'line-2'),
          'third',
          'line-3',
        ),
        'mira',
        'line-2',
        {status: 'queued'},
      ),
      'mira',
      'line-3',
      {status: 'refused', committed: false, message: 'Mira is away.'},
    );

    expect([...linesOnTheirWay(state).keys()]).toEqual(['line-1', 'line-2']);
  });

  it('reads a line a tab kept as it was kept, one an earlier build kept without a state as sending, and nothing that is no line', () => {
    const kept = {conversationId, characterId: 'mira', text: 'hello'};

    expect(keptLine({...kept, state: 'not_delivered'})).toEqual({
      ...kept,
      state: 'not_delivered',
    });
    expect(keptLine(kept)).toEqual({...kept, state: 'sending'});
    expect([keptLine({...kept, text: 7}), keptLine('hello')]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("holds each turn as the daemon last said it, writing or not, and ends it at its own line's end, never at another's", () => {
    let state = applyEvent(opened(), userMessage('m-1', 'hello', 'line-1'));

    state = applyEvent(state, running('line-1', true));

    expect(state.turns.get(conversationId)).toEqual({
      characterId: 'mira',
      conversationId,
      source: 'web',
      clientMessageId: 'line-1',
      writing: true,
    });

    // Her message joins the thread, and the turn the daemon says next has
    // her writing no more.
    state = applyEvent(state, hers('m-2', 'I remember you'));
    state = applyEvent(state, running('line-1'));

    expect(state.turns.get(conversationId)?.writing).toBe(false);
    expect(state.thread?.messages.map(message => message.text)).toEqual([
      'hello',
      'I remember you',
    ]);

    // A turn ends at its own completion; another submission's ending on
    // the same conversation leaves it running, writing as it was.
    state = applyEvent(state, running('line-1', true));

    const other = applyEvent(
      state,
      completed('line-2', 'refused', 'wrong sender', false),
    );

    expect(other.turns).toBe(state.turns);
    expect(applyEvent(other, completed('line-1')).turns.size).toBe(0);
  });

  it("shows her typing where her next message will be while she writes in a line's turn, and nothing while she does not, in a turn of her own, or once her turn ended; while she uses her phone, that in its place", () => {
    let state = applyEvent(opened(), userMessage('m-1', 'hello', 'line-1'));

    state = applyEvent(state, running('line-1'));

    expect(doingIn(state, conversationId)).toBeUndefined();

    state = applyEvent(state, running('line-1', true));

    expect(doingIn(state, conversationId)).toBe('typing');
    expect(doingIn(state, 'conv-2')).toBeUndefined();
    expect(
      doingIn(applyEvent(state, called('phone', 'phone.open')), conversationId),
    ).toBe('phoning');
    expect(
      doingIn(applyEvent(state, completed('line-1')), conversationId),
    ).toBeUndefined();
    expect(
      doingIn(applyEvent(opened(), ownRunning(true)), conversationId),
    ).toBeUndefined();
  });

  it('keeps her typing in a thread the person left, for when they come back', () => {
    const nova = {
      status: 'opened' as const,
      conversationId: 'conv-2',
      characterId: 'nova',
    };
    const mira = {
      status: 'opened' as const,
      conversationId,
      characterId: 'mira',
    };
    let state = applyEvent(opened(), userMessage('m-1', 'hello', 'line-1'));

    state = threadOpened(state, nova);
    state = applyEvent(state, running('line-1', true));
    state = threadOpened(state, mira);

    expect(doingIn(state, conversationId)).toBe('typing');

    // Her message, and her turn's end, reach the tab wherever the person
    // is.
    state = applyEvent(threadOpened(state, nova), hers('m-2', 'I remember'));
    state = applyEvent(state, running('line-1'));
    state = applyEvent(state, completed('line-1'));

    expect(state.turns.has(conversationId)).toBe(false);
    expect(state.notices).toEqual([]);
    expect(state.thread?.conversationId).toBe('conv-2');
  });

  it("holds a turn of her own, which no line began, as the daemon says it, ends it at its own end and never at a line's, and says nothing of how it ended", () => {
    let state = applyEvent(opened(), ownRunning());

    expect(state.turns.get(conversationId)).toEqual({
      characterId: 'mira',
      conversationId,
      writing: false,
    });

    state = applyEvent(state, ownRunning(true));
    state = applyEvent(state, hers('m-1', 'Found your keys yet?'));
    state = applyEvent(state, ownRunning());

    expect(state.thread?.messages.map(message => message.text)).toEqual([
      'Found your keys yet?',
    ]);
    expect(
      applyEvent(state, completed('line-1', 'refused', 'wrong sender', false))
        .turns,
    ).toBe(state.turns);

    for (const status of ['completed', 'rejected', 'failed'] as const) {
      const ended = applyEvent(
        state,
        ownCompleted(status, 'The provider answered 503.'),
      );

      expect(ended.turns.size).toBe(0);
      expect(ended.notices).toEqual([]);
    }

    // Her own turn's end leaves a line's turn running.
    const answering = applyEvent(state, running('line-1'));

    expect(applyEvent(answering, ownCompleted('completed')).turns).toBe(
      answering.turns,
    );
  });

  it("marks a character whose reply landed in a chat not on screen, once however many land, never for the thread on screen or the person's own line, until her chat opens", () => {
    const nova = {
      status: 'opened' as const,
      conversationId: 'conv-2',
      characterId: 'nova',
    };
    const reply = (messageId: string) =>
      hers(messageId, 'Found your keys yet?');

    expect(applyEvent(opened(), reply('m-1')).unseen.size).toBe(0);
    // No thread is open until a person picks one of several characters.
    expect([
      ...applyEvent(installSnapshot(initialState, ready()), reply('m-1'))
        .unseen,
    ]).toEqual(['mira']);

    let state = applyEvent(
      threadOpened(opened(), nova),
      userMessage('m-1', 'From the phone.', 'phone'),
    );

    expect(state.unseen.size).toBe(0);

    state = applyEvent(state, reply('m-2'));

    expect([...state.unseen]).toEqual(['mira']);
    expect(applyEvent(state, reply('m-3'))).toBe(state);
    expect(
      threadOpened(state, {
        status: 'opened',
        conversationId,
        characterId: 'mira',
      }).unseen.size,
    ).toBe(0);
  });

  it("says she is using her phone from a call of one of its tools until her next message or her turn's end, while she writes too, in a line's turn as in one of her own, and never for another character's turn", () => {
    const phoned = called('phone', 'phone.open');
    let state = applyEvent(
      applyEvent(opened(), userMessage('m-1', 'Wake me at seven.', 'line-1')),
      running('line-1'),
    );

    expect(applyEvent(state, called('notes', 'notes.add')).phoning.size).toBe(
      0,
    );

    state = applyEvent(state, phoned);

    expect([...state.phoning]).toEqual([conversationId]);
    // Her writing goes on under it until her message comes; another
    // line's end leaves her turn, and her phone in it, as they were.
    expect([...applyEvent(state, running('line-1', true)).phoning]).toEqual([
      conversationId,
    ]);
    expect(applyEvent(state, hers('m-2', 'Set for seven.')).phoning.size).toBe(
      0,
    );
    expect(applyEvent(state, completed('line-1')).phoning.size).toBe(0);
    expect(
      applyEvent(state, completed('line-2', 'refused', 'wrong sender', false))
        .phoning,
    ).toBe(state.phoning);
    // What the stream said before a snapshot is not said again by it.
    expect(installSnapshot(state, ready()).phoning.size).toBe(0);

    const own = applyEvent(applyEvent(opened(), ownRunning()), phoned);

    expect([...own.phoning]).toEqual([conversationId]);
    expect(applyEvent(own, ownCompleted('completed')).phoning.size).toBe(0);

    const novas = applyEvent(
      applyEvent(opened(), {
        kind: 'turn_running',
        characterId: 'nova',
        conversationId: 'conv-2',
        writing: false,
      }),
      called('phone', 'phone.open', 'nova', 'conv-2'),
    );

    expect(novas.phoning.has(conversationId)).toBe(false);
  });

  it('reads the newest page as the thread, keeps what arrived live meanwhile, settles the lines it carries, and prepends an earlier page once', () => {
    let state = sent(opened(), 'hello', 'line-1');

    state = applyEvent(state, userMessage('m-3', 'meanwhile', 'line-9'));

    const newest = page(
      [committed('m-1', 'hello', 'line-1'), committed('m-2', 'hi')],
      'v1:0:0',
    );

    state = linesTaken(
      historyPageRead(state, conversationId, {}, newest),
      newest,
    );

    expect(state.thread?.messages.map(message => message.messageId)).toEqual([
      'm-1',
      'm-2',
      'm-3',
    ]);
    expect(state.pending.size).toBe(0);
    expect(state.thread?.earlier).toBe('v1:0:0');

    const earlier = page([committed('m-0', 'earlier still')]);

    state = historyPageRead(state, conversationId, {before: 'v1:0:0'}, earlier);
    // The same cursor read twice — a second click before the first page
    // came — is a page the thread has moved past: shown once.
    state = historyPageRead(state, conversationId, {before: 'v1:0:0'}, earlier);

    expect(state.thread?.messages.map(message => message.messageId)).toEqual([
      'm-0',
      'm-1',
      'm-2',
      'm-3',
    ]);
    expect(state.thread?.earlier).toBeUndefined();

    const other = historyPageRead(
      state,
      'conv-2',
      {},
      page([committed('x-1', 'elsewhere')]),
    );

    expect(other).toBe(state);
  });

  it('replaces a thread it has fallen more than a page behind, rather than placing what it shows against a page with none of it', () => {
    // No reconnect and no reopen: the thread is simply what it read, and
    // a recovery read comes back with a hundred newer messages.
    const behind = historyPageRead(
      opened(),
      conversationId,
      {},
      page([committed('m-1', 'one'), committed('m-2', 'two')], 'v1:0:0'),
    );
    const caught = historyPageRead(
      behind,
      conversationId,
      {},
      page([committed('m-201', 'two hundred and one')], 'v1:0:200'),
    );

    expect(caught.thread?.messages.map(message => message.messageId)).toEqual([
      'm-201',
    ]);
    expect(caught.thread?.earlier).toBe('v1:0:200');
  });

  it('keeps earlier pages ahead of a refreshed newest page, and what arrived live after it behind', () => {
    let state = historyPageRead(
      opened(),
      conversationId,
      {},
      page([committed('m-2', 'two'), committed('m-3', 'three')], 'v1:0:2'),
    );

    state = historyPageRead(
      state,
      conversationId,
      {before: 'v1:0:2'},
      page([committed('m-0', 'zero'), committed('m-1', 'one')]),
    );
    state = applyEvent(state, userMessage('m-4', 'four', 'line-4'));
    // A recovery read after a lost answer: the newest page now holds a
    // line another surface added; the older pages stay in front.
    state = historyPageRead(
      state,
      conversationId,
      {},
      page(
        [
          committed('m-2', 'two'),
          committed('m-3', 'three'),
          committed('m-4', 'four', 'line-4'),
          committed('m-5', 'five'),
        ],
        'v1:0:2',
      ),
    );

    expect(state.thread?.messages.map(message => message.messageId)).toEqual([
      'm-0',
      'm-1',
      'm-2',
      'm-3',
      'm-4',
      'm-5',
    ]);
    expect(state.thread?.earlier).toBeUndefined();

    // A page that meets nothing shown, on a thread set aside for it, has
    // what was shown after it: a fresh open with a message arriving
    // while its page was being read.
    const fresh = historyPageRead(
      applyEvent(opened(), userMessage('m-9', 'nine', 'line-9')),
      conversationId,
      {},
      page([committed('m-7', 'seven'), committed('m-8', 'eight')], 'v1:0:7'),
    );

    expect(fresh.thread?.messages.map(message => message.messageId)).toEqual([
      'm-7',
      'm-8',
      'm-9',
    ]);
    expect(fresh.thread?.earlier).toBe('v1:0:7');
  });

  it("keeps a line the daemon says it never put in the log in its thread, not delivered, and says why; taken back, it goes to its box after what is typed; one in the log is the thread's, and a completed turn says nothing", () => {
    const state = composerChanged(
      sent(sent(opened(), 'first', 'line-1'), 'second', 'line-2'),
      'next thought',
    );
    const refused = lineEnded(state, 'mira', 'line-1', {
      status: 'refused',
      committed: false,
      message: 'The gateway holds no open conversation.',
    });

    expect(refused.pending.get('line-1')?.state).toBe('not_delivered');
    expect(composerText(refused)).toBe('next thought');
    expect(refused.notices.at(-1)).toBe(
      'Mira: The gateway holds no open conversation.',
    );

    // A turn that failed before writing the line says so, and the line
    // did not reach her — a full disk on the first append, and nothing in
    // the log will ever mention it.
    const both = applyEvent(
      refused,
      completed('line-2', 'failed', 'The store is full.', false),
    );

    expect(both.pending.get('line-2')?.state).toBe('not_delivered');
    expect(both.notices.at(-1)).toBe('Mira: The store is full.');

    // Taken back, each leaves the thread for its box, after what is there.
    const first = lineTakenBack(both, 'line-1');

    expect(composerText(first)).toBe('next thought first');
    expect([...first.pending.keys()]).toEqual(['line-2']);
    expect(composerText(lineTakenBack(first, 'line-2'))).toBe(
      'next thought first second',
    );

    // A turn the daemon judged after writing the line says so, and the
    // line belongs to the thread: settled, and not offered back.
    const judged = applyEvent(
      state,
      completed('line-1', 'rejected', 'The line was blank.'),
    );

    expect(composerText(judged)).toBe('next thought');
    expect(judged.pending.has('line-1')).toBe(false);
    expect(judged.notices.at(-1)).toBe('Mira: The line was blank.');
    // The same news twice is the same notice.
    expect(
      applyEvent(judged, completed('line-1', 'rejected', 'The line was blank.'))
        .notices,
    ).toEqual(judged.notices);

    // A completed turn says nothing, and the line is the thread's.
    const done = lineEnded(state, 'mira', 'line-1', {
      status: 'completed',
      committed: true,
    });

    expect(done.notices).toEqual(state.notices);
    expect(done.pending.has('line-1')).toBe(false);
    expect(composerText(done)).toBe('next thought');
  });

  it('settles a judged line the daemon says it took, and says why the turn ended', () => {
    const state = sent(opened(), 'hello', 'line-1');
    const judged = lineEnded(state, 'mira', 'line-1', {
      status: 'rejected',
      committed: true,
      message: 'The model wrote nothing it could say.',
    });

    expect(composerText(judged)).toBe('');
    expect(judged.pending.has('line-1')).toBe(false);
    expect(judged.notices.at(-1)).toBe(
      'Mira: The model wrote nothing it could say.',
    );

    // The stream shows the line: it was taken, and the daemon's verdict
    // on the turn stands — the line landing does not answer it.
    const shown = applyEvent(judged, userMessage('m-1', 'hello', 'line-1'));

    expect(shown.pending.size).toBe(0);
    expect(shown.thread?.messages).toHaveLength(1);
    expect(composerText(shown)).toBe('');
    expect(shown.notices.at(-1)).toBe(
      'Mira: The model wrote nothing it could say.',
    );
  });

  it("keeps a line sent to one character while another is open in her own thread, there when it did not reach her, and says a turn's end at once, naming its character", () => {
    const nova = {
      status: 'opened' as const,
      conversationId: 'conv-2',
      characterId: 'nova',
    };
    const mira = {
      status: 'opened' as const,
      conversationId,
      characterId: 'mira',
    };
    let state = threadOpened(sent(opened(), 'hello mira', 'line-1'), nova);

    expect(state.pending.get('line-1')).toEqual({
      conversationId,
      characterId: 'mira',
      text: 'hello mira',
      state: 'sending',
    });

    // Mira's line is refused while Nova is open: it stays Mira's, never
    // goes into Nova's box, and the reason is said at once with Mira's
    // name on it.
    const ended = lineEnded(state, 'mira', 'line-1', {
      status: 'refused',
      committed: false,
      message: 'Mira is away.',
    });

    expect(composerText(ended)).toBe('');
    expect(ended.pending.get('line-1')).toEqual({
      conversationId,
      characterId: 'mira',
      text: 'hello mira',
      state: 'not_delivered',
    });
    expect(ended.notices.at(-1)).toBe('Mira: Mira is away.');

    // Back in Mira's thread, the line is where it was written, and taken
    // back it goes into her box. What the page had to say is spent by the
    // person asking to open, not by the answer that comes back, so a turn
    // that failed meanwhile survives the open it raced.
    state = threadOpened(ended, mira);

    expect(composerText(lineTakenBack(state, 'line-1'))).toBe('hello mira');
    expect(state.notices).toEqual(['Mira: Mira is away.']);
    expect(state.turns.has(conversationId)).toBe(false);

    // The daemon taking the line settles it whichever thread is open, and
    // a turn that ends without it ends the line just as well.
    const elsewhere = threadOpened(
      sent(opened(), 'hello mira', 'line-2'),
      nova,
    );
    const taken = applyEvent(
      elsewhere,
      userMessage('m-1', 'hello mira', 'line-2'),
    );

    expect(taken.pending.size).toBe(0);
    expect(taken.thread?.messages).toEqual([]);

    const failed = applyEvent(
      elsewhere,
      completed('line-2', 'failed', 'The store is read-only.'),
    );

    // The turn's end is said wherever the person is, and a line the
    // daemon kept is settled wherever it landed.
    expect(failed.pending.has('line-2')).toBe(false);
    expect(failed.notices.at(-1)).toBe('Mira: The store is read-only.');

    // Another surface's turn is said the same way, named the same way,
    // and stands beside a failure that came before it rather than
    // replacing it: nothing the daemon said is overwritten.
    expect(
      applyEvent(failed, completed('telegram-1', 'failed')).notices,
    ).toEqual(['Mira: The store is read-only.', 'Mira: The turn was failed.']);
  });

  it('settles a pending line from whichever page carries it, and from no page that does not', () => {
    const state = sent(opened(), 'hello', 'line-1');
    // An earlier page carries the line: the daemon took it, whichever
    // page says so, and the faded bubble goes.
    // A page says what it carries whichever page it is, and whether or
    // not its conversation is the thread on screen.
    const earlier = linesTaken(
      threadOpened(state, {
        status: 'opened',
        conversationId: 'conv-2',
        characterId: 'nova',
      }),
      page([committed('m-1', 'hello', 'line-1')]),
    );

    expect(earlier.pending.size).toBe(0);

    // A page that lacks it proves nothing, newest or not: a page is a
    // hundred messages, and a busy turn can put more than that between a
    // line and now.
    for (const request of [{}, {before: 'v1:0:0'}]) {
      const read = linesTaken(
        historyPageRead(state, conversationId, request, page([])),
        page([]),
      );

      expect(read.pending.get('line-1')).toEqual({
        conversationId,
        characterId: 'mira',
        text: 'hello',
        state: 'sending',
      });
      expect(composerText(read)).toBe('');
    }
  });

  it('lets go of what was written for another home', () => {
    const restored = sent(opened(), 'hello', 'line-1');

    // Another daemon on the same address is another world: nothing
    // written for the first one belongs to it.
    const forgotten = forgetWritten(
      composerChanged(restored, 'half a thought'),
    );

    expect(forgotten.pending.size).toBe(0);
    expect(composerText(forgotten)).toBe('');
    expect(forgetWritten(forgotten)).toBe(forgotten);
  });

  it('keeps what a person typed in each thread', () => {
    const nova = {
      status: 'opened' as const,
      conversationId: 'conv-2',
      characterId: 'nova',
    };
    const mira = {
      status: 'opened' as const,
      conversationId,
      characterId: 'mira',
    };
    let state = composerChanged(opened(), 'half a thought');

    state = composerChanged(threadOpened(state, nova), 'something for nova');

    expect(composerText(state)).toBe('something for nova');
    expect(composerText(threadOpened(state, mira))).toBe('half a thought');
  });

  it('keeps a line it has already sent, with the id it was sent under, when the address will never work again, and lets go of what it can never settle', () => {
    let live = sent(sent(opened(), 'first', 'line-1'), 'second', 'line-2');

    live = applyEvent(live, {
      kind: 'confirmation_requested',
      ...confirmation('c-1'),
    });
    live = applyEvent(live, {
      kind: 'pairing_requested',
      ...pairing('123456', 'Alice'),
    });
    live = applyEvent(live, running('line-1', true));
    live = composerChanged(live, 'and this is unsent');

    const state = connectionRefused(live, 'A bearer token is required.');

    expect(state.connection).toEqual({
      status: 'refused',
      message: 'A bearer token is required.',
    });
    // A token dies when a daemon restarts, and a line it committed just
    // before is one the log can still be asked about — under the id it
    // was sent with, which ordinary text would not carry.
    expect([...state.pending.keys()]).toEqual(['line-1', 'line-2']);
    expect(composerText(state)).toBe('and this is unsent');
    // An answer would never reach the daemon, nor a turn's end the page.
    expect(state.confirmations).toEqual([]);
    expect(state.pairings).toEqual([]);
    expect(state.turns.size).toBe(0);
  });

  it("keeps a committed line whose turn did not complete and says why, for its own turns and another surface's; the person's next act spends the notice", () => {
    let state = sent(opened(), 'hello', 'line-1');

    state = applyEvent(state, userMessage('m-1', 'hello', 'line-1'));
    state = applyEvent(
      state,
      completed('line-1', 'rejected', 'The model wrote nothing it could say.'),
    );

    expect(state.thread?.messages).toHaveLength(1);
    expect(state.turns.has(conversationId)).toBe(false);
    expect(state.notices.at(-1)).toBe(
      'Mira: The model wrote nothing it could say.',
    );

    state = applyEvent(state, {
      kind: 'turn_completed',
      characterId: 'mira',
      conversationId,
      source: 'telegram:bot',
      clientMessageId: 'tg-1',
      status: 'failed',
      committed: true,
      reason: 'provider_error',
    });

    expect(state.notices.at(-1)).toBe('Mira: provider_error');

    const spent = noticeSpent(state);

    expect(spent.notices).toEqual([]);
    expect(noticeSpent(spent)).toBe(spent);
    expect(sent(state, 'again', 'line-2').notices).toEqual([]);
  });

  it('tracks confirmations by id, whatever surface raised them, and says when one was cancelled, naming its character', () => {
    let state = applyEvent(opened(), {
      kind: 'confirmation_requested',
      ...confirmation('c-1'),
    });

    state = applyEvent(state, {
      kind: 'confirmation_requested',
      ...confirmation('c-1'),
    });

    expect(state.confirmations).toEqual([confirmation('c-1')]);

    const approved = applyEvent(state, {
      kind: 'confirmation_settled',
      characterId: 'mira',
      id: 'c-1',
      decision: 'approved',
    });

    expect(approved.confirmations).toEqual([]);
    expect(approved.notices).toEqual([]);

    const expired = applyEvent(state, {
      kind: 'confirmation_settled',
      characterId: 'mira',
      id: 'c-1',
      decision: 'cancelled',
      reason: 'expired',
    });

    expect(expired.confirmations).toEqual([]);
    expect(expired.notices.at(-1)).toBe(
      'Mira: A confirmation expired before it was answered.',
    );
    expect(
      applyEvent(state, {
        kind: 'confirmation_settled',
        characterId: 'mira',
        id: 'c-1',
        decision: 'cancelled',
        reason: 'stopped',
      }).notices.at(-1),
    ).toBe('Mira: A confirmation was cancelled when the character stopped.');

    // A card for a character nobody is reading was on the page too, so
    // its expiry is said as well.
    const elsewhere = applyEvent(
      threadOpened(state, {
        status: 'opened',
        conversationId: 'conv-2',
        characterId: 'nova',
      }),
      {
        kind: 'confirmation_settled',
        characterId: 'mira',
        id: 'c-1',
        decision: 'cancelled',
        reason: 'expired',
      },
    );

    expect(elsewhere.notices.at(-1)).toBe(
      'Mira: A confirmation expired before it was answered.',
    );

    // The daemon can say the request is not waiting when this tab answers
    // it — the deadline passed, or another surface settled it while the
    // stream was away — and then no frame is coming to remove the card.
    const gone = confirmationGone(state, 'c-1', 'expired');

    expect(gone.confirmations).toEqual([]);
    expect(gone.notices.at(-1)).toBe(
      'Mira: A confirmation expired before it was answered.',
    );
    expect(confirmationGone(gone, 'c-1', 'expired')).toBe(gone);

    // A request the daemon no longer knows may have been answered
    // somewhere else, and its tool may have run: the page says only that
    // it is not waiting, never that it was cancelled.
    expect(confirmationGone(state, 'c-1', 'unknown').notices.at(-1)).toBe(
      'Mira: A confirmation is no longer waiting.',
    );

    // A card that ends while the tab is away: the snapshot no longer
    // carries it, and the frame that said how is never replayed.
    const away = installSnapshot(state, ready());

    expect(away.confirmations).toEqual([]);
    expect(away.notices.at(-1)).toBe(
      'Mira: A confirmation ended while this page was away.',
    );

    // One ending, said once, whichever of the two reaches the tab first.
    expect(
      applyEvent(gone, {
        kind: 'confirmation_settled',
        characterId: 'mira',
        id: 'c-1',
        decision: 'cancelled',
        reason: 'expired',
      }).notices,
    ).toEqual(gone.notices);
  });

  it('shows every pairing request waiting, whatever connector asked, and says when one expired unanswered or an answer to one did not settle it', () => {
    const alice = pairing('123456', 'Alice (@alice)');
    const bob = pairing('654321', 'Bob');
    let state = installSnapshot(opened(), {...ready(), pairings: [alice]});

    expect(state.pairings).toEqual([alice]);

    state = applyEvent(state, {kind: 'pairing_requested', ...bob});
    state = applyEvent(state, {kind: 'pairing_requested', ...bob});

    expect(state.pairings).toEqual([alice, bob]);

    const approved = applyEvent(state, {
      kind: 'pairing_settled',
      connectorId: 'telegram',
      code: alice.code,
      subject: alice.subject,
      decision: 'approved',
    });

    expect(approved.pairings).toEqual([bob]);
    expect(approved.notices).toEqual([]);

    const expired = applyEvent(state, {
      kind: 'pairing_settled',
      connectorId: 'telegram',
      code: bob.code,
      subject: bob.subject,
      decision: 'expired',
    });

    expect(expired.pairings).toEqual([alice]);
    expect(expired.notices).toEqual([
      'A pairing request expired before it was answered: Bob, code 654321.',
    ]);

    // The daemon's answer to a click: a settlement leaves the card to its
    // frame, and an expiry is that frame's news, said once whichever of
    // the two comes first.
    expect(
      pairingGone(state, bob.code, {status: 'settled', decision: 'approved'}),
    ).toBe(state);
    expect(pairingGone(state, bob.code, {status: 'expired'})).toEqual(expired);
    expect(pairingGone(expired, bob.code, {status: 'expired'})).toBe(expired);

    // A request the daemon does not know may have been answered on another
    // surface either way; one whose approval could not be written waits.
    const unknown = pairingGone(state, bob.code, {status: 'unknown'});

    expect(unknown.pairings).toEqual([alice]);
    expect(unknown.notices).toEqual([
      'A pairing request is no longer waiting.',
    ]);

    const failed = pairingGone(state, bob.code, {
      status: 'failed',
      message: 'The disk is full.',
    });

    expect(failed.pairings).toEqual([alice, bob]);
    expect(failed.notices).toEqual(['The disk is full.']);

    // One that ended while the tab was away simply goes.
    const away = installSnapshot(state, ready());

    expect(away.pairings).toEqual([]);
    expect(away.notices).toEqual([]);
  });

  it("applies roster events, clears a maintenance note on a fresh start, keeps the language she speaks, and keeps another conversation's progress for it", () => {
    const speaking: CharacterSummary = {...mira, language: 'ja'};
    let state = applyEvent(opened(), {
      kind: 'health_changed',
      health: health(speaking),
    });

    state = applyEvent(state, {
      kind: 'state_changed',
      characterId: 'mira',
      state: 'failed',
      message: 'The provider refused the key.',
    });

    expect(state.health?.characters[0]).toMatchObject({
      state: 'failed',
      diagnostic: 'The provider refused the key.',
    });

    state = applyEvent(state, {
      kind: 'state_changed',
      characterId: 'mira',
      state: 'ready',
    });

    expect(state.health?.characters[0]).toEqual(speaking);

    state = applyEvent(state, {
      kind: 'maintenance_failed',
      characterId: 'mira',
      at: '2026-09-11T00:00:00.000Z',
      message: 'The segment could not rotate.',
    });

    expect(state.health?.characters[0]?.maintenance).toEqual({
      at: '2026-09-11T00:00:00.000Z',
      message: 'The segment could not rotate.',
    });

    state = applyEvent(state, {
      kind: 'state_changed',
      characterId: 'mira',
      state: 'starting',
    });
    state = applyEvent(state, {
      kind: 'state_changed',
      characterId: 'mira',
      state: 'ready',
    });

    expect(state.health?.characters[0]).toEqual(speaking);

    const away = applyEvent(
      state,
      userMessage('m-9', 'hi there', 'line-9', 'conv-2'),
    );
    const elsewhere = applyEvent(away, running('line-9', true, 'conv-2'));

    expect(elsewhere.thread).toBe(state.thread);
    expect(elsewhere.turns.get('conv-2')?.writing).toBe(true);
  });

  it('takes the roster as the daemon says it after a change landed', () => {
    const state = opened();
    const nova: CharacterSummary = {
      id: 'nova',
      displayName: 'Nova',
      enabled: true,
      builtIn: false,
      state: 'starting',
    };
    const changed = applyEvent(state, {
      kind: 'health_changed',
      health: health({...mira, enabled: false}, nova),
    });

    expect(changed.health?.characters).toEqual([
      {...mira, enabled: false},
      nova,
    ]);
    expect(changed.thread).toBe(state.thread);
  });

  it('reports a refused address, and says on the thread itself when its page could not be read', () => {
    const refused = connectionRefused(
      initialState,
      'The gateway URL carries no #token.',
    );

    expect(refused.connection).toEqual({
      status: 'refused',
      message: 'The gateway URL carries no #token.',
    });

    const unreadable: HistoryOutcome = {
      status: 'failed',
      code: 'missing_file',
      message: 'The thread could not be read.',
    };
    const unread = historyPageRead(opened(), conversationId, {}, unreadable);

    expect(unread.thread?.unread).toBe('The thread could not be read.');
    expect(unread.thread?.messages).toEqual([]);

    // A turn that failed meanwhile is different news, and neither erases
    // the other: the next page that can be read answers its own.
    const both = applyEvent(
      unread,
      completed('line-1', 'failed', 'The store is read-only.'),
    );
    const read = historyPageRead(
      both,
      conversationId,
      {},
      page([committed('m-1', 'hello')]),
    );

    expect(read.thread?.unread).toBeUndefined();
    expect(read.notices.at(-1)).toBe('Mira: The store is read-only.');

    // A read left behind by a switch of characters says nothing about the
    // thread in front of the person — by either way of failing.
    const switched = threadOpened(opened(), {
      status: 'opened',
      conversationId: 'conv-2',
      characterId: 'nova',
    });

    expect(historyPageRead(switched, conversationId, {}, unreadable)).toBe(
      switched,
    );
    expect(
      pageUnread(switched, conversationId, 'The daemon could not be reached.'),
    ).toBe(switched);
    expect(
      pageUnread(switched, 'conv-2', 'Its own read failed.').thread?.unread,
    ).toBe('Its own read failed.');
  });
});
