import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {
  ConfigChange,
  ConfigChangeOutcome,
  GatewayEvent,
  PairingDecision,
  PairingRequest,
} from '../../src/gateway/index.ts';
import {createPairingSeam} from '../../src/gateway/pairing.ts';

const hourMs = 60 * 60 * 1000;
const alice = {id: '123456789', label: 'Alice (@alice)'};
const bob = {id: '987654321', label: 'Bob (@bob)'};
const carol = {'555': 'Carol'};
const applied: ConfigChangeOutcome = {
  status: 'applied',
  fingerprint: 'fp-written',
};
const conflictMessage = 'The config changed since it was read.';
const conflict: ConfigChangeOutcome = {
  status: 'refused',
  reason: 'conflict',
  message: conflictMessage,
};

/** Writes that answer in turn, then `applied`. */
function answering(
  ...outcomes: ConfigChangeOutcome[]
): () => Promise<ConfigChangeOutcome> {
  return () => Promise.resolve(outcomes.shift() ?? applied);
}

/**
 * Telegram's allowlist holds Carol until `setAllowlist` writes it as
 * another settings window would, and the document moves with every write
 * tried, so each read after one sees a new fingerprint.
 */
function createPairingHarness(write = answering()) {
  const events: GatewayEvent[] = [];
  const changes: ConfigChange[] = [];
  let accounts: Readonly<Record<string, string>> = carol;
  const seam = createPairingSeam({
    readAllowlist: () => ({
      status: 'ok',
      fingerprint: `fp-${String(changes.length + 1)}`,
      accounts,
    }),
    applyChange: change => {
      changes.push(change);

      return write();
    },
    emit: event => {
      events.push(event);
    },
  });
  const ask = (subject = alice): PairingRequest => {
    const asked = seam.request('telegram', subject);

    if (asked.status !== 'pending') {
      expect.fail(`The request was ${asked.status}.`);
    }

    return asked.request;
  };
  const setAllowlist = (written: Readonly<Record<string, string>>): void => {
    accounts = written;
  };

  return {seam, events, changes, ask, setAllowlist};
}

function settledAs(
  request: PairingRequest,
  decision: PairingDecision | 'expired',
): GatewayEvent {
  return {
    kind: 'pairing_settled',
    connectorId: request.connectorId,
    code: request.code,
    subject: request.subject,
    decision,
  };
}

describe('gateway pairing seam', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles a request nobody answers within the hour as expired, whether the clock or a late answer finds it first', async () => {
    const {seam, events, changes, ask} = createPairingHarness();
    const timedOut = ask();

    vi.advanceTimersByTime(hourMs - 1);
    expect(seam.pending()).toEqual([timedOut]);

    vi.advanceTimersByTime(1);
    expect(seam.pending()).toEqual([]);
    expect(events.at(-1)).toEqual(settledAs(timedOut, 'expired'));
    await expect(seam.settle(timedOut.code, 'approved')).resolves.toEqual({
      status: 'unknown',
    });

    // The daemon judges the deadline, even before its clock has fired.
    const late = ask();

    vi.setSystemTime(late.expiresAt);
    await expect(seam.settle(late.code, 'approved')).resolves.toEqual({
      status: 'expired',
    });
    expect(events.at(-1)).toEqual(settledAs(late, 'expired'));
    expect(changes).toEqual([]);
  });

  it('writes an approval again from a fresh read when another write moved the home first, keeping the accounts already paired', async () => {
    const {seam, events, changes, ask} = createPairingHarness(
      answering(conflict),
    );
    const request = ask();

    await expect(seam.settle(request.code, 'approved')).resolves.toEqual({
      status: 'settled',
      decision: 'approved',
    });
    expect(changes.map(change => change.expectedFingerprint)).toEqual([
      'fp-1',
      'fp-2',
    ]);
    expect(changes.at(-1)).toEqual({
      target: {scope: 'global'},
      expectedFingerprint: 'fp-2',
      operation: {
        kind: 'section_field_set',
        namespace: 'connectors',
        id: 'telegram',
        field: 'pairedUsers',
        value: {...carol, [alice.id]: alice.label},
      },
    });
    expect(events.at(-1)).toEqual(settledAs(request, 'approved'));
    expect(seam.pending()).toEqual([]);
  });

  it('keeps a request waiting when its approval cannot be written, saying why', async () => {
    const {seam, events, changes, ask} = createPairingHarness(
      answering(
        {status: 'failed', message: 'The disk is full.'},
        conflict,
        conflict,
        conflict,
      ),
    );
    const request = ask();

    await expect(seam.settle(request.code, 'approved')).resolves.toEqual({
      status: 'failed',
      message: 'The disk is full.',
    });
    // A document that keeps moving is given three writes in all.
    await expect(seam.settle(request.code, 'approved')).resolves.toEqual({
      status: 'failed',
      message: conflictMessage,
    });
    expect(changes).toHaveLength(4);
    expect(seam.pending()).toEqual([request]);
    // Put back twice, announced twice; never settled.
    expect(events.map(event => event.kind)).toEqual([
      'pairing_requested',
      'pairing_requested',
      'pairing_requested',
    ]);
  });

  it('keeps a request in place while its approval is written, taking no second answer, and puts it back on the clock when the write fails', async () => {
    const writes: ((outcome: ConfigChangeOutcome) => void)[] = [];
    const {seam, events, ask} = createPairingHarness(
      () =>
        new Promise(resolve => {
          writes.push(resolve);
        }),
    );
    const request = ask();
    const approving = seam.settle(request.code, 'approved');

    // Asking for the account again gets this request, not a second one.
    expect(seam.pending()).toEqual([request]);
    expect(seam.request('telegram', alice)).toEqual({
      status: 'pending',
      request,
    });
    await expect(seam.settle(request.code, 'denied')).resolves.toEqual({
      status: 'unknown',
    });

    vi.advanceTimersByTime(hourMs / 2);
    writes.shift()?.({status: 'failed', message: 'The disk is full.'});
    await expect(approving).resolves.toEqual({
      status: 'failed',
      message: 'The disk is full.',
    });
    expect(seam.pending()).toEqual([request]);

    // Back on the clock for what is left of its hour, not a fresh one.
    vi.advanceTimersByTime(hourMs / 2 - 1);
    expect(seam.pending()).toEqual([request]);

    vi.advanceTimersByTime(1);
    expect(seam.pending()).toEqual([]);
    expect(events).toEqual([
      {kind: 'pairing_requested', ...request},
      {kind: 'pairing_requested', ...request},
      settledAs(request, 'expired'),
    ]);
  });

  it('settles a waiting request as approved once another window pairs its account, writing nothing over the name that window gave', async () => {
    const {seam, events, changes, ask, setAllowlist} = createPairingHarness();
    const forAlice = ask();
    const forBob = ask(bob);

    // Another settings window pairs both, under names of its own.
    setAllowlist({...carol, [alice.id]: 'Alice', [bob.id]: 'Bob'});
    expect(seam.request('telegram', alice)).toEqual({status: 'paired'});
    expect(seam.pending()).toEqual([forBob]);
    expect(events.at(-1)).toEqual(settledAs(forAlice, 'approved'));

    await expect(seam.settle(forBob.code, 'approved')).resolves.toEqual({
      status: 'settled',
      decision: 'approved',
    });
    expect(changes).toEqual([]);
  });
});
