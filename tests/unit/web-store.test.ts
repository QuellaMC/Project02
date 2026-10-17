import {describe, expect, it} from 'vitest';

import {
  applyEvent,
  composerChanged,
  composerText,
  confirmationGone,
  connectionRefused,
  forgetWritten,
  historyPageRead,
  initialState,
  installSnapshot,
  lineEnded,
  lineSent,
  linesTaken,
  noticeSpent,
  pageUnread,
  pairingGone,
  streamLost,
  streamResumed,
  threadOpened,
  type WebState,
} from '../../src/frontends/web/store.ts';
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
} from '../../src/gateway/api/index.ts';

const mira: CharacterSummary = {
  id: 'mira',
  displayName: 'Mira',
  enabled: true,
  state: 'ready',
};
const conversationId = 'conv-1';

function health(...characters: readonly CharacterSummary[]): GatewayHealth {
  return {
    protocolVersion: 7,
    homeRoot: '/home/person/.project02',
    config: {diagnostics: []},
    packages: {diagnostics: []},
    characters,
    connectors: [],
  };
}

function ready(
  confirmations: readonly PendingConfirmation[] = [],
  turns: readonly RunningTurn[] = [],
): GatewayReady {
  return {
    protocolVersion: 7,
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
    userParticipantId: 'local-user',
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
  clientMessageId?: string,
  conversation = conversationId,
): GatewayEvent {
  return progress(
    {
      kind: 'user_message',
      messageId,
      speakerId: 'local-user',
      speakerName: 'You',
      text,
      source: 'web',
      ...(clientMessageId === undefined ? {} : {clientMessageId}),
    },
    conversation,
  );
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

function confirmation(id: string): PendingConfirmation {
  return {
    characterId: 'mira',
    id,
    request: {
      pluginId: 'demo-config',
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
    committedAt: '2026-09-11T00:00:00.000Z',
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

    state = applyEvent(
      state,
      progress({kind: 'reply_delta', draftId: '1.0', text: 'I rem'}),
    );
    expect(state.turns.get(conversationId)?.drafts).toEqual([
      {draftId: '1.0', text: 'I rem'},
    ]);

    const elsewhere: RunningTurn = {
      characterId: 'nova',
      conversationId: 'conv-2',
      source: 'telegram:bot',
      clientMessageId: 'line-7',
      drafts: [{draftId: '1.0', text: 'as far as I '}],
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
      userParticipantId: 'local-user',
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
      userParticipantId: 'local-user',
    });

    expect(nova.thread?.stale).toEqual([]);
  });

  it('shows a line once the daemon says so: the pending bubble becomes the message, and a frame seen twice shows once', () => {
    let state = sent(opened(), 'hello there', 'line-1');

    expect(composerText(state)).toBe('');
    expect([...state.pending.entries()]).toEqual([
      [
        'line-1',
        {
          conversationId,
          characterId: 'mira',
          senderId: 'local-user',
          text: 'hello there',
        },
      ],
    ]);

    state = applyEvent(state, userMessage('m-1', 'hello there', 'line-1'));
    state = applyEvent(state, userMessage('m-1', 'hello there', 'line-1'));

    expect(state.pending.size).toBe(0);
    expect(state.turns.get(conversationId)).toBeDefined();
    expect(state.thread?.messages).toEqual([
      {
        messageId: 'm-1',
        speakerId: 'local-user',
        speakerName: 'You',
        text: 'hello there',
        clientMessageId: 'line-1',
      },
    ]);
  });

  it('fills a draft bubble per draft id, replaces it with its commit, and removes one withdrawn', () => {
    let state = applyEvent(opened(), userMessage('m-1', 'hello', 'line-1'));

    state = applyEvent(
      state,
      progress({kind: 'reply_delta', draftId: '1.0', text: 'I remember '}),
    );
    state = applyEvent(
      state,
      progress({kind: 'reply_delta', draftId: '1.0', text: 'you'}),
    );
    state = applyEvent(
      state,
      progress({kind: 'reply_delta', draftId: '1.1', text: 'and'}),
    );

    expect(state.turns.get(conversationId)?.drafts).toEqual([
      {draftId: '1.0', text: 'I remember you'},
      {draftId: '1.1', text: 'and'},
    ]);

    state = applyEvent(
      state,
      progress({
        kind: 'visible_reply',
        messageId: 'm-2',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'I remember you',
        draftId: '1.0',
      }),
    );
    state = applyEvent(
      state,
      progress({kind: 'reply_withdrawn', draftId: '1.1'}),
    );

    expect(state.turns.get(conversationId)?.drafts).toEqual([]);
    expect(state.thread?.messages.map(message => message.text)).toEqual([
      'hello',
      'I remember you',
    ]);

    const unchanged = applyEvent(
      state,
      progress({kind: 'reply_withdrawn', draftId: 'never-opened'}),
    );

    expect(unchanged).toBe(state);

    // A turn ends at its own completion; another submission's ending on
    // the same conversation — one the daemon refused on the spot — leaves
    // it running, drafts and all.
    state = applyEvent(
      state,
      progress({kind: 'reply_delta', draftId: '2.0', text: 'and then'}),
    );

    const other = applyEvent(
      state,
      completed('line-2', 'refused', 'wrong sender', false),
    );

    expect(other.turns).toBe(state.turns);
    expect(applyEvent(other, completed('line-1')).turns.size).toBe(0);
  });

  it('keeps a reply being written in a thread the person left, whole, with its typing indicator, for when they come back', () => {
    const nova = {
      status: 'opened' as const,
      conversationId: 'conv-2',
      characterId: 'nova',
      userParticipantId: 'local-user',
    };
    const mira = {
      status: 'opened' as const,
      conversationId,
      characterId: 'mira',
      userParticipantId: 'local-user',
    };
    let state = applyEvent(opened(), userMessage('m-1', 'hello', 'line-1'));

    state = applyEvent(
      state,
      progress({kind: 'reply_delta', draftId: '1.0', text: 'I remember '}),
    );
    state = threadOpened(state, nova);
    state = applyEvent(
      state,
      progress({kind: 'reply_delta', draftId: '1.0', text: 'you'}),
    );
    state = threadOpened(state, mira);

    expect(state.turns.get(conversationId)).toEqual({
      characterId: 'mira',
      conversationId,
      source: 'web',
      clientMessageId: 'line-1',
      drafts: [{draftId: '1.0', text: 'I remember you'}],
    });

    // The commit takes the draft wherever the person is, and the turn's
    // end takes the rest.
    state = applyEvent(
      threadOpened(state, nova),
      progress({
        kind: 'visible_reply',
        messageId: 'm-2',
        speakerId: 'mira',
        speakerName: 'Mira',
        text: 'I remember you',
        draftId: '1.0',
      }),
    );

    expect(state.turns.get(conversationId)?.drafts).toEqual([]);

    state = applyEvent(state, completed('line-1'));

    expect(state.turns.has(conversationId)).toBe(false);
    expect(state.notices).toEqual([]);
    expect(state.thread?.conversationId).toBe('conv-2');
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

  it('hands a line back at once when the daemon says it never put it in the log — after what is typed, in the order sent, and never for a completed turn', () => {
    const state = composerChanged(
      sent(sent(opened(), 'first', 'line-1'), 'second', 'line-2'),
      'next thought',
    );
    const refused = lineEnded(state, 'mira', 'line-1', {
      status: 'refused',
      committed: false,
      message: 'The gateway holds no open conversation.',
    });

    expect(composerText(refused)).toBe('next thought first');
    expect(refused.pending.size).toBe(1);
    expect(refused.notices.at(-1)).toBe(
      'Mira: The gateway holds no open conversation.',
    );

    // The queued line is refused too, later: it lands after the first, as
    // it was sent.
    const both = lineEnded(refused, 'mira', 'line-2', {
      status: 'refused',
      committed: false,
      message: 'The gateway holds no open conversation.',
    });

    expect(composerText(both)).toBe('next thought first second');
    expect(both.pending.size).toBe(0);

    // A turn that failed before writing the line says so, and the line is
    // the person's again — a full disk on the first append, and nothing
    // in the log will ever mention it.
    const unwritten = applyEvent(
      state,
      completed('line-1', 'failed', 'The store is full.', false),
    );

    expect(composerText(unwritten)).toBe('next thought first');
    expect(unwritten.pending.has('line-1')).toBe(false);

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

  it("keeps a line sent to one character while another is open, hands it back in its own thread, and says a turn's end at once, naming its character", () => {
    const nova = {
      status: 'opened' as const,
      conversationId: 'conv-2',
      characterId: 'nova',
      userParticipantId: 'local-user',
    };
    const mira = {
      status: 'opened' as const,
      conversationId,
      characterId: 'mira',
      userParticipantId: 'local-user',
    };
    let state = threadOpened(sent(opened(), 'hello mira', 'line-1'), nova);

    expect(state.pending.get('line-1')).toEqual({
      conversationId,
      characterId: 'mira',
      senderId: 'local-user',
      text: 'hello mira',
    });

    // Mira's turn ends while Nova is open: the line goes back to Mira's
    // composer, never into Nova's, and the reason is said at once with
    // Mira's name on it.
    const ended = lineEnded(state, 'mira', 'line-1', {
      status: 'refused',
      committed: false,
      message: 'Mira is away.',
    });

    expect(composerText(ended)).toBe('');
    expect(ended.pending.size).toBe(0);
    expect(ended.notices.at(-1)).toBe('Mira: Mira is away.');

    // Back in Mira's thread, the line is where it was written. What the
    // page had to say is spent by the person asking to open, not by the
    // answer that comes back, so a turn that failed meanwhile survives
    // the open it raced.
    state = threadOpened(ended, mira);

    expect(composerText(state)).toBe('hello mira');
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
        userParticipantId: 'local-user',
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
        senderId: 'local-user',
        text: 'hello',
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
      userParticipantId: 'local-user',
    };
    const mira = {
      status: 'opened' as const,
      conversationId,
      characterId: 'mira',
      userParticipantId: 'local-user',
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
    live = applyEvent(
      live,
      progress({kind: 'reply_delta', draftId: '1.0', text: 'half a thought'}),
    );
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
    // An answer would never reach the daemon, and a draft never finish.
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
        userParticipantId: 'local-user',
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

  it("applies roster events, clears a maintenance note on a fresh start, and keeps another conversation's progress for it", () => {
    let state = opened();

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

    expect(state.health?.characters[0]).toEqual(mira);

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

    expect(state.health?.characters[0]).toEqual(mira);

    const away = applyEvent(
      state,
      userMessage('m-9', 'hi there', 'line-9', 'conv-2'),
    );
    const elsewhere = applyEvent(
      away,
      progress(
        {kind: 'reply_delta', draftId: '1.0', text: 'not here'},
        'conv-2',
      ),
    );

    expect(elsewhere.thread).toBe(state.thread);
    expect(elsewhere.turns.get('conv-2')?.drafts).toEqual([
      {draftId: '1.0', text: 'not here'},
    ]);
  });

  it('takes the roster as the daemon says it after a change landed', () => {
    const state = opened();
    const nova: CharacterSummary = {
      id: 'nova',
      displayName: 'Nova',
      enabled: true,
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
      userParticipantId: 'local-user',
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
