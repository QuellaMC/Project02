import {describe, expect, it} from 'vitest';

import {
  answerLost,
  applyEvent,
  composerChanged,
  composerText,
  connectionRefused,
  historyPageRead,
  initialState,
  installSnapshot,
  lineEnded,
  lineSent,
  noticeSpent,
  pageUnread,
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
  PendingConfirmation,
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
    protocolVersion: 1,
    homeRoot: '/home/person/.project02',
    config: {diagnostics: []},
    packages: {diagnostics: []},
    characters,
  };
}

function ready(
  confirmations: readonly PendingConfirmation[] = [],
): GatewayReady {
  return {protocolVersion: 1, health: health(mira), confirmations};
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

function completed(
  clientMessageId: string,
  status: 'completed' | 'rejected' | 'failed' | 'refused' = 'completed',
  message?: string,
): GatewayEvent {
  return {
    kind: 'turn_completed',
    characterId: 'mira',
    conversationId,
    source: 'web',
    clientMessageId,
    status,
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
  it('installs every ready as the truth: roster and confirmations replace, turns in progress drop while how one ended is kept, and what the thread shows stays on screen until its newest page replaces it', () => {
    let state = applyEvent(
      opened(),
      progress({kind: 'reply_delta', draftId: '1.0', text: 'I rem'}),
    );

    state = applyEvent(state, userMessage('m-1', 'hello', 'line-1'));
    // Another thread's turn failed while this one was read: still news after the reconnect.
    state = applyEvent(state, {
      kind: 'turn_completed',
      characterId: 'nova',
      conversationId: 'conv-2',
      source: 'web',
      clientMessageId: 'line-9',
      status: 'failed',
      message: 'The store is full.',
    });
    state = installSnapshot(state, ready([confirmation('c-1')]));

    expect(state.connection).toEqual({status: 'live'});
    expect(state.health?.characters).toEqual([mira]);
    expect(state.confirmations.map(pending => pending.id)).toEqual(['c-1']);
    expect([...state.turns]).toEqual([
      ['conv-2', {busy: false, drafts: new Map(), ended: 'The store is full.'}],
    ]);
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

    expect(unread.thread?.stale.map(message => message.messageId)).toEqual([
      'm-1',
    ]);
    expect(unread.notice).toBe('The thread could not be read.');

    // An earlier page read before the reconnect is not this thread's: its
    // cursor went with what was set aside.
    expect(
      historyPageRead(
        state,
        conversationId,
        {before: 'v1:0:0'},
        page([committed('m-0', 'before')]),
      ),
    ).toBe(state);

    // The newest page replaces what was set aside and keeps what arrived
    // live after the reconnect.
    state = applyEvent(state, userMessage('m-3', 'meanwhile', 'line-3'));
    state = historyPageRead(
      state,
      conversationId,
      {},
      page([committed('m-1', 'hello', 'line-1'), committed('m-2', 'hi')]),
    );

    expect(state.thread?.stale).toEqual([]);
    expect(state.thread?.messages.map(message => message.messageId)).toEqual([
      'm-1',
      'm-2',
      'm-3',
    ]);
  });

  it('shows a line once the daemon says so: the pending bubble becomes the message, and a frame seen twice shows once', () => {
    let state = sent(opened(), 'hello there', 'line-1');

    expect(composerText(state)).toBe('');
    expect([...state.pending.entries()]).toEqual([
      ['line-1', {conversationId, text: 'hello there'}],
    ]);

    state = applyEvent(state, userMessage('m-1', 'hello there', 'line-1'));
    state = applyEvent(state, userMessage('m-1', 'hello there', 'line-1'));

    expect(state.pending.size).toBe(0);
    expect(state.turns.get(conversationId)?.busy).toBe(true);
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
    let state = applyEvent(
      opened(),
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

    expect([...(state.turns.get(conversationId)?.drafts ?? [])]).toEqual([
      ['1.0', 'I remember you'],
      ['1.1', 'and'],
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

    expect(state.turns.has(conversationId)).toBe(false);
    expect(state.thread?.messages.map(message => message.text)).toEqual([
      'I remember you',
    ]);

    const unchanged = applyEvent(
      state,
      progress({kind: 'reply_withdrawn', draftId: 'never-opened'}),
    );

    expect(unchanged).toBe(state);
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
      busy: true,
      drafts: new Map([['1.0', 'I remember you']]),
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

    expect(state.turns.get(conversationId)).toEqual({
      busy: true,
      drafts: new Map(),
    });

    state = applyEvent(state, completed('line-1'));

    expect(state.turns.has(conversationId)).toBe(false);
    expect(state.notice).toBeUndefined();
  });

  it('reads the newest page as the thread, keeps what arrived live meanwhile, settles the lines it carries, and prepends an earlier page once', () => {
    let state = sent(opened(), 'hello', 'line-1');

    state = applyEvent(state, userMessage('m-3', 'meanwhile', 'line-9'));
    state = historyPageRead(
      state,
      conversationId,
      {},
      page(
        [committed('m-1', 'hello', 'line-1'), committed('m-2', 'hi')],
        'v1:0:0',
      ),
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

    // A page that meets nothing shown is the thread, and what was shown
    // came live after it — a fresh open with a message arriving meanwhile.
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

  it('hands a line back to the composer at once when the stream ends its turn without having shown it, or when the answer refuses it — after what is typed, in the order sent, once, and never for a completed turn', () => {
    const state = composerChanged(
      sent(sent(opened(), 'first', 'line-1'), 'second', 'line-2'),
      'next thought',
    );
    const fromStream = applyEvent(
      state,
      completed('line-1', 'rejected', 'The line was blank.'),
    );

    expect(composerText(fromStream)).toBe('next thought first');
    expect(fromStream.pending.size).toBe(1);
    expect(fromStream.notice).toBe('The line was blank.');

    const again = applyEvent(
      fromStream,
      completed('line-1', 'rejected', 'The line was blank.'),
    );

    expect(composerText(again)).toBe('next thought first');
    expect(again.notice).toBe(fromStream.notice);

    // The ordered stream ends the queued line on its own, later: it lands
    // after the first, as it was sent.
    const both = applyEvent(
      again,
      completed('line-2', 'failed', 'The store is full.'),
    );

    expect(composerText(both)).toBe('next thought first second');
    expect(both.pending.size).toBe(0);
    expect(both.notice).toBe('The store is full.');

    const refused = lineEnded(
      state,
      conversationId,
      'line-1',
      {status: 'refused', message: 'The gateway holds no open conversation.'},
      'answer',
    );

    expect(composerText(refused)).toBe('next thought first');
    expect(refused.pending.size).toBe(1);
    expect(refused.notice).toBe('The gateway holds no open conversation.');

    expect(
      lineEnded(
        state,
        conversationId,
        'line-1',
        {status: 'completed'},
        'answer',
      ),
    ).toBe(state);
  });

  it('lets the answer mark a line ended but not hand it back, since its frame may still be on the way: the stream or the newest page settles it', () => {
    const state = sent(opened(), 'hello', 'line-1');
    const marked = lineEnded(
      state,
      conversationId,
      'line-1',
      {status: 'rejected', message: 'The model wrote nothing it could say.'},
      'answer',
    );

    expect(composerText(marked)).toBe('');
    expect(marked.pending.get('line-1')).toEqual({
      conversationId,
      text: 'hello',
      ended: 'The model wrote nothing it could say.',
    });
    expect(marked.notice).toBe('The model wrote nothing it could say.');

    // The stream shows the line after all: it was taken, and the daemon's
    // verdict on the turn stands — the line landing does not answer it.
    const shown = applyEvent(marked, userMessage('m-1', 'hello', 'line-1'));

    expect(shown.pending.size).toBe(0);
    expect(shown.thread?.messages).toHaveLength(1);
    expect(composerText(shown)).toBe('');
    expect(shown.notice).toBe('The model wrote nothing it could say.');

    // The newest page carries it: taken. The newest page lacks it: it
    // comes back. A line the answer never marked stays pending: its turn
    // has not run yet.
    const carried = historyPageRead(
      marked,
      conversationId,
      {},
      page([committed('m-1', 'hello', 'line-1')]),
    );

    expect(carried.pending.size).toBe(0);
    expect(composerText(carried)).toBe('');

    const absent = historyPageRead(marked, conversationId, {}, page([]));

    expect(absent.pending.size).toBe(0);
    expect(composerText(absent)).toBe('hello');

    const queued = historyPageRead(state, conversationId, {}, page([]));

    expect(queued.pending.get('line-1')).toEqual({
      conversationId,
      text: 'hello',
    });
  });

  it("keeps a line sent to one character while another is open, hands it back in its own thread, and tells a turn's end to its own thread when that thread is opened", () => {
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
      text: 'hello mira',
    });

    // Mira's turn ends while Nova is open: the line goes back to Mira's
    // composer, never into Nova's, and the reason waits for Mira's thread.
    const ended = lineEnded(
      state,
      conversationId,
      'line-1',
      {status: 'refused', message: 'Mira is away.'},
      'answer',
    );

    expect(composerText(ended)).toBe('');
    expect(ended.pending.size).toBe(0);
    expect(ended.notice).toBeUndefined();

    // Back in Mira's thread, it is where it was written, and the reason is said.
    state = threadOpened(ended, mira);

    expect(composerText(state)).toBe('hello mira');
    expect(state.notice).toBe('Mira is away.');
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

    expect(failed.pending.size).toBe(0);
    expect(failed.notice).toBeUndefined();
    expect(threadOpened(failed, mira)).toMatchObject({
      notice: 'The store is read-only.',
      composers: new Map([[conversationId, 'hello mira']]),
    });

    // Another surface's turn on a thread nobody is reading waits for it too.
    const theirs = applyEvent(elsewhere, completed('telegram-1', 'failed'));

    expect(theirs.notice).toBeUndefined();
    expect(threadOpened(theirs, mira).notice).toBe('The turn was failed.');
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

  it("says nothing of an answer that never came until the page knows the line's fate: nothing once it landed, the reason when it comes back", () => {
    const state = sent(opened(), 'hello', 'line-1');
    const lost = answerLost(
      state,
      'line-1',
      'The daemon could not be reached.',
    );

    expect(lost.notice).toBeUndefined();
    expect(lost.pending.get('line-1')).toEqual({
      conversationId,
      text: 'hello',
      ended: 'The daemon could not be reached.',
    });

    // The stream proves the daemon took the line, or the newest page does.
    const landed = applyEvent(lost, userMessage('m-1', 'hello', 'line-1'));

    expect(landed.notice).toBeUndefined();
    expect(landed.pending.size).toBe(0);

    const read = historyPageRead(
      lost,
      conversationId,
      {},
      page([committed('m-1', 'hello', 'line-1')]),
    );

    expect(read.notice).toBeUndefined();
    expect(read.pending.size).toBe(0);

    // The stream showed the line before the answer was lost: nothing to say.
    const shown = applyEvent(state, userMessage('m-1', 'hello', 'line-1'));

    expect(
      answerLost(shown, 'line-1', 'The daemon could not be reached.'),
    ).toBe(shown);

    // The newest page lacks it: it comes back, and the reason is said.
    const absent = historyPageRead(lost, conversationId, {}, page([]));

    expect(composerText(absent)).toBe('hello');
    expect(absent.pending.size).toBe(0);
    expect(absent.notice).toBe('The daemon could not be reached.');
  });

  it('gives every pending line back, in the order it was written, when the address will never work again', () => {
    const state = connectionRefused(
      sent(sent(opened(), 'first', 'line-1'), 'second', 'line-2'),
      'A bearer token is required.',
    );

    expect(state.connection).toEqual({
      status: 'refused',
      message: 'A bearer token is required.',
    });
    expect(state.pending.size).toBe(0);
    expect(composerText(state)).toBe('first second');
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
    expect(state.notice).toBe('The model wrote nothing it could say.');

    state = applyEvent(state, {
      kind: 'turn_completed',
      characterId: 'mira',
      conversationId,
      source: 'telegram:bot',
      clientMessageId: 'tg-1',
      status: 'failed',
      reason: 'provider_error',
    });

    expect(state.notice).toBe('provider_error');

    const spent = noticeSpent(state);

    expect(spent.notice).toBeUndefined();
    expect(noticeSpent(spent)).toBe(spent);
    expect(sent(state, 'again', 'line-2').notice).toBeUndefined();
  });

  it('tracks confirmations by id, whatever surface raised them, and says when one expired', () => {
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
    expect(approved.notice).toBeUndefined();

    const expired = applyEvent(state, {
      kind: 'confirmation_settled',
      characterId: 'mira',
      id: 'c-1',
      decision: 'cancelled',
    });

    expect(expired.confirmations).toEqual([]);
    expect(expired.notice).toBe(
      'A confirmation expired before it was answered.',
    );
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

    const elsewhere = applyEvent(
      state,
      progress(
        {kind: 'reply_delta', draftId: '1.0', text: 'not here'},
        'conv-2',
      ),
    );

    expect(elsewhere.thread).toBe(state.thread);
    expect(elsewhere.turns.get('conv-2')?.drafts.get('1.0')).toBe('not here');
  });

  it('reports a refused address and a page that could not be read', () => {
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

    expect(unread.notice).toBe('The thread could not be read.');
    expect(unread.thread?.messages).toEqual([]);

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
      pageUnread(
        switched,
        conversationId,
        {},
        'The daemon could not be reached.',
      ),
    ).toBe(switched);
    expect(
      pageUnread(switched, 'conv-2', {}, 'Its own read failed.').notice,
    ).toBe('Its own read failed.');

    // An earlier page the thread has moved past — a second click on Load
    // earlier — says nothing when it fails, either.
    const paged = historyPageRead(
      opened(),
      conversationId,
      {},
      page([committed('m-2', 'two')], 'v1:0:2'),
    );

    expect(pageUnread(paged, conversationId, {before: 'v1:0:0'}, 'Gone.')).toBe(
      paged,
    );
  });
});
