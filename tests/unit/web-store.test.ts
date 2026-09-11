import {describe, expect, it} from 'vitest';

import {
  applyEvent,
  composerChanged,
  connectionRefused,
  historyPageRead,
  initialState,
  installSnapshot,
  lineEnded,
  lineSent,
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
): GatewayEvent {
  return progress({
    kind: 'user_message',
    messageId,
    speakerId: 'local-user',
    speakerName: 'You',
    text,
    source: 'web',
    ...(clientMessageId === undefined ? {} : {clientMessageId}),
  });
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
      toolName: 'runtime.plugin_config_update',
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
  it('installs every ready as the truth: roster and confirmations replace, drafts drop, the thread empties for its newest page', () => {
    let state = applyEvent(
      opened(),
      progress({kind: 'reply_delta', draftId: '1.0', text: 'I rem'}),
    );

    state = applyEvent(state, userMessage('m-1', 'hello', 'line-1'));
    state = installSnapshot(state, ready([confirmation('c-1')]));

    expect(state.connection).toEqual({status: 'live'});
    expect(state.health?.characters).toEqual([mira]);
    expect(state.confirmations.map(pending => pending.id)).toEqual(['c-1']);
    expect(state.thread).toMatchObject({
      messages: [],
      drafts: new Map(),
      busy: false,
    });
  });

  it('shows a line once the daemon says so: the pending bubble becomes the message, and a frame seen twice shows once', () => {
    let state = sent(opened(), 'hello there', 'line-1');

    expect(state.composer).toBe('');
    expect([...(state.thread?.pending.entries() ?? [])]).toEqual([
      ['line-1', 'hello there'],
    ]);

    state = applyEvent(state, userMessage('m-1', 'hello there', 'line-1'));
    state = applyEvent(state, userMessage('m-1', 'hello there', 'line-1'));

    expect(state.thread?.pending.size).toBe(0);
    expect(state.thread?.busy).toBe(true);
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

    expect([...(state.thread?.drafts.entries() ?? [])]).toEqual([
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

    expect(state.thread?.drafts.size).toBe(0);
    expect(state.thread?.messages.map(message => message.text)).toEqual([
      'I remember you',
    ]);

    const unchanged = applyEvent(
      state,
      progress({kind: 'reply_withdrawn', draftId: 'never-opened'}),
    );

    expect(unchanged).toBe(state);
  });

  it('reads the newest page as the thread, keeps what arrived live meanwhile, settles the lines it carries, and prepends earlier pages', () => {
    let state = sent(opened(), 'hello', 'line-1');

    state = applyEvent(state, userMessage('m-3', 'meanwhile', 'line-9'));
    state = historyPageRead(
      state,
      conversationId,
      'newest',
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
    expect(state.thread?.pending.size).toBe(0);
    expect(state.thread?.earlier).toBe('v1:0:0');

    state = historyPageRead(
      state,
      conversationId,
      'earlier',
      page([committed('m-0', 'earlier still')]),
    );

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
      'newest',
      page([committed('x-1', 'elsewhere')]),
    );

    expect(other).toBe(state);
  });

  it('hands a line the daemon did not take back to the composer with the message, once, from the answer or the event alike', () => {
    const state = composerChanged(
      sent(opened(), 'hello', 'line-1'),
      'next thought',
    );
    const fromAnswer = lineEnded(state, 'line-1', {
      status: 'refused',
      message: 'The gateway holds no open conversation.',
    });

    expect(fromAnswer.composer).toBe('hello next thought');
    expect(fromAnswer.thread?.pending.size).toBe(0);
    expect(fromAnswer.thread?.notice).toBe(
      'The gateway holds no open conversation.',
    );

    const again = applyEvent(
      fromAnswer,
      completed('line-1', 'refused', 'The gateway holds no open conversation.'),
    );

    expect(again.composer).toBe('hello next thought');
    expect(again.thread?.notice).toBe(fromAnswer.thread?.notice);

    const fromEvent = applyEvent(
      state,
      completed('line-1', 'rejected', 'The line was blank.'),
    );

    expect(fromEvent.composer).toBe('hello next thought');
    expect(fromEvent.thread?.busy).toBe(false);

    const unsent = lineEnded(state, 'line-1', {
      status: 'unsent',
      message: 'The daemon could not be reached.',
    });

    expect(unsent.composer).toBe('hello next thought');
    expect(unsent.thread?.notice).toBe('The daemon could not be reached.');

    // A completed turn settles nothing here: the stream's user_message
    // did, or the next page will.
    expect(lineEnded(state, 'line-1', {status: 'completed'})).toBe(state);
  });

  it("keeps a committed line whose turn did not complete and says why, for its own turns and another surface's; the next send spends the notice", () => {
    let state = sent(opened(), 'hello', 'line-1');

    state = applyEvent(state, userMessage('m-1', 'hello', 'line-1'));
    state = applyEvent(
      state,
      completed('line-1', 'rejected', 'The model wrote nothing it could say.'),
    );

    expect(state.thread?.messages).toHaveLength(1);
    expect(state.thread?.busy).toBe(false);
    expect(state.thread?.notice).toBe('The model wrote nothing it could say.');

    state = applyEvent(state, {
      kind: 'turn_completed',
      characterId: 'mira',
      conversationId,
      source: 'telegram:bot',
      clientMessageId: 'tg-1',
      status: 'failed',
      reason: 'provider_error',
    });

    expect(state.thread?.notice).toBe('provider_error');

    state = sent(state, 'again', 'line-2');

    expect(state.thread?.notice).toBeUndefined();
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
    expect(approved.thread?.notice).toBeUndefined();

    const expired = applyEvent(state, {
      kind: 'confirmation_settled',
      characterId: 'mira',
      id: 'c-1',
      decision: 'cancelled',
    });

    expect(expired.confirmations).toEqual([]);
    expect(expired.thread?.notice).toBe(
      'A confirmation expired before it was answered.',
    );
  });

  it("applies roster events while dropping another conversation's progress", () => {
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

    const elsewhere = applyEvent(
      state,
      progress(
        {kind: 'reply_delta', draftId: '1.0', text: 'not here'},
        'conv-2',
      ),
    );

    expect(elsewhere).toBe(state);
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

    const unread = historyPageRead(opened(), conversationId, 'newest', {
      status: 'failed',
      code: 'missing_file',
      message: 'The thread could not be read.',
    });

    expect(unread.thread?.notice).toBe('The thread could not be read.');
    expect(unread.thread?.messages).toEqual([]);
  });
});
