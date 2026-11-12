import {describe, expect, it} from 'vitest';

import type {
  CharacterSummary,
  ConfigView,
  GatewayEvent,
  RunningDraft,
} from '@project02/wire/contract';
import {
  askKey,
  askersOf,
  confirmationKey,
  dockStepped,
  dockWaited,
  edgesOf,
  frontOf,
  herSettingsRead,
  pairingKey,
} from './dock.ts';
import {
  applyEvent,
  connectionRefused,
  initialState,
  installSnapshot,
  type WebState,
} from './store.ts';

function character(id: string, displayName: string): CharacterSummary {
  return {id, displayName, enabled: true, builtIn: true, state: 'ready'};
}

/** A live tab of Mira's and Nova's home, nothing waiting. */
function live(): WebState {
  return installSnapshot(initialState, {
    protocolVersion: 13,
    health: {
      protocolVersion: 13,
      homeRoot: '/home/person/.project02',
      config: {diagnostics: []},
      packages: {diagnostics: []},
      characters: [character('mira', 'Mira'), character('nova', 'Nova')],
      connectors: [],
      accounts: [],
    },
    confirmations: [],
    pairings: [],
    turns: [],
  });
}

/** A confirmation of `characterId`'s, raised, expiring at `deadlineAt`. */
function asks(
  id: string,
  deadlineAt: number,
  characterId = 'mira',
): GatewayEvent {
  return {
    kind: 'confirmation_requested',
    characterId,
    id,
    request: {
      pluginId: 'phone',
      toolName: 'phone.install',
      summary: 'Install "reminders" 1.0.0 from the App Store.',
      preview: {},
    },
    deadlineAt,
  };
}

function settled(
  id: string,
  decision: 'approved' | 'denied' | 'expired' | 'stopped',
  characterId = 'mira',
): GatewayEvent {
  return {
    kind: 'confirmation_settled',
    characterId,
    id,
    ...(decision === 'approved' || decision === 'denied'
      ? {decision}
      : {decision: 'cancelled', reason: decision}),
  };
}

const alex = {
  connectorId: 'telegram',
  code: '482913',
  subject: {id: '381940562', label: 'Alex'},
  source: 'telegram:mira_bot',
  requestedAt: '2026-11-12T09:00:00.000Z',
  expiresAt: 3_600_000,
};

/** Mira's turn on her line as the daemon says it runs now, with `drafts` begun. */
function running(
  drafts: readonly RunningDraft[],
  characterId = 'mira',
): GatewayEvent {
  return {
    kind: 'turn_running',
    characterId,
    conversationId: `dm-${characterId}`,
    source: 'web',
    clientMessageId: 'line-1',
    drafts,
  };
}

const reply: GatewayEvent = {
  kind: 'turn_progress',
  characterId: 'mira',
  conversationId: 'dm-mira',
  progress: {
    kind: 'visible_reply',
    messageId: 'm2',
    speakerId: 'mira',
    speakerName: 'Mira',
    text: 'Thank you.',
    draftId: 'd1',
  },
};

const ended: GatewayEvent = {
  kind: 'turn_completed',
  characterId: 'mira',
  conversationId: 'dm-mira',
  source: 'web',
  clientMessageId: 'line-1',
  status: 'completed',
  committed: true,
};

function applied(
  state: WebState,
  ...events: readonly GatewayEvent[]
): WebState {
  return events.reduce(applyEvent, state);
}

/** What the dock shows in front: which ask, and how it ended once it has. */
function shown(state: WebState): string | undefined {
  const front = frontOf(state);

  return front === undefined
    ? undefined
    : `${askKey(front.ask)}${front.answered === undefined ? '' : ` ${front.answered}`}`;
}

describe('the dock above the message box', () => {
  it('shows what waits one at a time, the one that expires first in front, with up to two more as edges behind it, and says whose asks wait', () => {
    let state = live();

    expect(shown(state)).toBeUndefined();
    expect(edgesOf(state)).toBe(0);

    state = applied(state, {kind: 'pairing_requested', ...alex});

    expect(shown(state)).toBe(pairingKey(alex.code));
    expect(askersOf(state)).toEqual(new Set());

    state = applied(state, asks('c1', 300_000), asks('c2', 400_000, 'nova'));

    expect(shown(state)).toBe(confirmationKey('c1'));
    expect(edgesOf(state)).toBe(2);
    expect(askersOf(state)).toEqual(new Set(['mira', 'nova']));
    expect(edgesOf(applied(state, asks('c3', 500_000)))).toBe(2);
  });

  it('keeps an ask that ended in front in the spot, saying how, Allowed, Not allowed or Expired, whoever answered it; one behind just leaves, and one that ended in a way no card says gives the spot to the next at once', () => {
    const waiting = applied(live(), asks('c1', 300_000), asks('c2', 400_000));
    const front = confirmationKey('c1');

    expect(shown(applied(waiting, settled('c1', 'approved')))).toBe(
      `${front} allowed`,
    );
    expect(shown(applied(waiting, settled('c1', 'denied')))).toBe(
      `${front} not_allowed`,
    );
    expect(shown(applied(waiting, settled('c1', 'expired')))).toBe(
      `${front} expired`,
    );
    expect(shown(applied(waiting, settled('c1', 'stopped')))).toBe(
      confirmationKey('c2'),
    );
    expect(shown(applied(waiting, settled('c2', 'approved')))).toBe(front);
    expect(askersOf(applied(waiting, settled('c1', 'approved')))).toEqual(
      new Set(['mira']),
    );

    const paired = applied(live(), {kind: 'pairing_requested', ...alex});
    const pairingEnded = (decision: 'approved' | 'denied' | 'expired') =>
      shown(
        applied(paired, {
          kind: 'pairing_settled',
          connectorId: alex.connectorId,
          code: alex.code,
          subject: alex.subject,
          decision,
        }),
      );

    expect(pairingEnded('approved')).toBe(`${pairingKey(alex.code)} allowed`);
    expect(pairingEnded('denied')).toBe(`${pairingKey(alex.code)} not_allowed`);
    expect(pairingEnded('expired')).toBe(`${pairingKey(alex.code)} expired`);
  });

  it('gives the spot to the next that waits half a second after the answer, the stack keeping its edges, and lets a moment of a card no longer there pass', () => {
    const answered = applied(
      live(),
      asks('c1', 300_000),
      asks('c2', 400_000),
      asks('c3', 500_000),
      settled('c1', 'approved'),
    );
    const next = dockStepped(answered, confirmationKey('c1'));

    expect(shown(next)).toBe(confirmationKey('c2'));
    expect(edgesOf(answered)).toBe(1);
    expect(edgesOf(next)).toBe(1);
    expect(dockStepped(answered, confirmationKey('c9'))).toBe(answered);
    expect(dockWaited(answered, confirmationKey('c1'))).toBe(answered);
  });

  it('keeps an answered card its room, with nothing else waiting, until her next line begins or her turn ends, or else the wait is over, and gives it at once to an ask that comes meanwhile', () => {
    const answered = applied(
      live(),
      asks('c1', 300_000),
      settled('c1', 'approved'),
    );
    const key = confirmationKey('c1');
    const lingering = dockStepped(answered, key);

    expect(shown(lingering)).toBe(`${key} allowed`);

    for (const went of [running([{draftId: 'd1', text: 'Th'}]), reply, ended]) {
      expect(shown(applied(answered, went))).toBeUndefined();
      expect(shown(applied(lingering, went))).toBeUndefined();
    }

    // A round without a line of hers yet, and a line of another's, are
    // not her going on.
    expect(shown(applied(lingering, running([])))).toBe(`${key} allowed`);
    expect(
      shown(applied(lingering, running([{draftId: 'd9', text: 'Hi'}], 'nova'))),
    ).toBe(`${key} allowed`);
    expect(shown(dockWaited(lingering, key))).toBeUndefined();
    expect(shown(applied(lingering, asks('c2', 400_000)))).toBe(
      confirmationKey('c2'),
    );
    expect(shown(connectionRefused(lingering, 'Gone.'))).toBeUndefined();

    // With another waiting, her line leaves the next to its half second;
    // someone new on a connector is not hers to go on from.
    expect(
      shown(
        applied(
          live(),
          asks('c1', 300_000),
          asks('c2', 400_000),
          settled('c1', 'approved'),
          running([{draftId: 'd1', text: 'Th'}]),
        ),
      ),
    ).toBe(`${key} allowed`);

    const paired = dockStepped(
      applied(
        live(),
        {kind: 'pairing_requested', ...alex},
        {
          kind: 'pairing_settled',
          connectorId: alex.connectorId,
          code: alex.code,
          subject: alex.subject,
          decision: 'approved',
        },
      ),
      pairingKey(alex.code),
    );

    expect(shown(applied(paired, reply, ended))).toBe(
      `${pairingKey(alex.code)} allowed`,
    );
    expect(shown(dockWaited(paired, pairingKey(alex.code)))).toBeUndefined();
  });

  it('keeps her settings as read for an ask of hers to change one, and nothing of a view the daemon refused', () => {
    const view: ConfigView = {
      status: 'ok',
      fingerprint: 'f1',
      diagnostics: [],
      model: {ready: true},
      project02: [],
      sections: [],
    };
    const read = herSettingsRead(live(), 'mira', view);

    expect(read.herSettings.get('mira')).toBe(view);
    expect(herSettingsRead(read, 'mira', view)).toBe(read);
    expect(
      herSettingsRead(read, 'nova', {
        status: 'refused',
        reason: 'unknown_character',
        message: 'Character "nova" was not found.',
      }),
    ).toBe(read);
  });
});
