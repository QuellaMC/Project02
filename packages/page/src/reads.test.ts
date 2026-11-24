import {describe, expect, it} from 'vitest';

import type {
  CharacterSummary,
  GatewayEvent,
  GatewayReady,
  HistoryMessage,
} from '@project02/wire/contract';
import {readOf} from './reads.ts';
import {settingsClosed, settingsOpened} from './settings.ts';
import {
  applyEvent,
  historyPageRead,
  initialState,
  installSnapshot,
  streamLost,
  threadOpened,
  type WebState,
} from './store.ts';

/** When every message of these tests was sent: the rule reads no time. */
const sentAt = '2026-11-24T10:00:00.000Z';

function character(id: string, displayName: string): CharacterSummary {
  return {id, displayName, enabled: true, builtIn: true, state: 'ready'};
}

const ready: GatewayReady = {
  protocolVersion: 18,
  health: {
    protocolVersion: 18,
    homeRoot: '/home/person/.project02',
    config: {diagnostics: []},
    packages: {diagnostics: []},
    characters: [character('mira', 'Mira'), character('nova', 'Nova')],
    connectors: [],
    accounts: [],
    chatgpt: {state: 'signed_out'},
  },
  confirmations: [],
  pairings: [],
  turns: [],
};

/** A live tab, nothing open yet. */
const live = installSnapshot(initialState, ready);

/** The chat of `characterId` open in `state` on `conversationId`, its newest page holding `messages`. */
function chat(
  state: WebState,
  conversationId: string,
  characterId: string,
  messages: readonly HistoryMessage[],
): WebState {
  return historyPageRead(
    threadOpened(state, {status: 'opened', conversationId, characterId}),
    conversationId,
    {},
    {status: 'ok', conversationId, characterId, messages},
  );
}

/** Message `messageId`, the person's or hers, as a page of the scrollback has it. */
function said(messageId: string, role: 'user' | 'character'): HistoryMessage {
  return {
    messageId,
    role,
    speakerId: role === 'user' ? 'local-user' : 'mira',
    speakerName: role === 'user' ? 'Sam' : 'Mira',
    text: 'Hi.',
    sentAt,
    app: 'messages',
  };
}

/** A message of `characterId`'s committed to `conversationId`, as the stream says it. */
function committed(
  messageId: string,
  conversationId: string,
  characterId = 'mira',
): GatewayEvent {
  return {
    kind: 'turn_progress',
    characterId,
    conversationId,
    progress: {
      kind: 'visible_reply',
      messageId,
      speakerId: characterId,
      speakerName: 'Mira',
      text: 'Hello.',
      sentAt,
      app: 'messages',
    },
  };
}

/** The window in front with the chat's end in view. */
const seen = {focused: true, endInView: true};

/** What is read in `state`, `told` having been told and the window `focused` or not, the chat's end in view. */
function readIn(
  state: WebState,
  focused = true,
  told: ReadonlyMap<string, string> = new Map(),
) {
  return readOf(told, state, {focused, endInView: true})?.read;
}

describe('when the person read a message of hers', () => {
  it("reads the newest message of hers the chat on screen shows while the window has the focus and the chat's end is in view: when the window comes to the front with her chat open, as a message arrives there, and when her chat opens; nothing while another window is in front, her phone's among them, while the person has scrolled away from the chat's end, while the settings stand in front of the chat, while the stream is down, with no chat open, or in a chat with no message of hers", () => {
    const mira = chat(live, 'conv-1', 'mira', [
      said('m1', 'user'),
      said('m2', 'character'),
      said('m3', 'user'),
    ]);
    const toldM2 = new Map([['conv-1', 'm2']]);
    const elsewhere = applyEvent(mira, committed('n2', 'conv-2', 'nova'));
    const settings = settingsOpened(mira, {kind: 'you'});

    expect(readIn(mira, false)).toBeUndefined();
    expect(
      readOf(new Map(), mira, {focused: true, endInView: false}),
    ).toBeUndefined();
    expect(readIn(mira)).toEqual({conversationId: 'conv-1', messageId: 'm2'});
    expect(
      readIn(applyEvent(mira, committed('m4', 'conv-1')), true, toldM2),
    ).toEqual({conversationId: 'conv-1', messageId: 'm4'});
    expect(readIn(elsewhere, true, toldM2)).toBeUndefined();
    expect(
      readIn(
        chat(elsewhere, 'conv-2', 'nova', [said('n2', 'character')]),
        true,
        toldM2,
      ),
    ).toEqual({conversationId: 'conv-2', messageId: 'n2'});
    expect(readIn(settings)).toBeUndefined();
    expect(readIn(settingsClosed(settings))).toEqual({
      conversationId: 'conv-1',
      messageId: 'm2',
    });
    expect(readIn(streamLost(mira))).toBeUndefined();
    expect(readIn(live)).toBeUndefined();
    expect(
      readIn(chat(live, 'conv-1', 'mira', [said('m1', 'user')])),
    ).toBeUndefined();
  });

  it('tells each message of hers once, in its own conversation: neither the window coming to the front again, a line of the person after it, a reconnect that sets the chat aside, nor her chat opened again after another tells it again', () => {
    const mira = chat(live, 'conv-1', 'mira', [said('m1', 'character')]);
    const first = readOf(new Map(), mira, seen);
    const told = first?.told ?? new Map<string, string>();
    const nova = chat(mira, 'conv-2', 'nova', [said('n1', 'character')]);
    const second = readOf(told, nova, seen);

    expect(first?.read).toEqual({conversationId: 'conv-1', messageId: 'm1'});
    expect(readIn(mira, true, told)).toBeUndefined();
    expect(
      readIn(
        chat(live, 'conv-1', 'mira', [
          said('m1', 'character'),
          said('m2', 'user'),
        ]),
        true,
        told,
      ),
    ).toBeUndefined();
    expect(readIn(installSnapshot(mira, ready), true, told)).toBeUndefined();
    expect(readIn(installSnapshot(mira, ready))).toEqual({
      conversationId: 'conv-1',
      messageId: 'm1',
    });
    expect(second?.read).toEqual({conversationId: 'conv-2', messageId: 'n1'});
    expect(
      readIn(
        chat(nova, 'conv-1', 'mira', [said('m1', 'character')]),
        true,
        second?.told,
      ),
    ).toBeUndefined();
  });
});
