import {randomInt} from 'node:crypto';

import {isValidClientStamp, isValidSpeakerDisplayName} from '../core/index.ts';
import {
  builtInConnectors,
  type RuntimeConfigValue,
} from '../runtime/config/index.ts';
import type {
  ConfigChange,
  ConfigChangeOutcome,
  GatewayEvent,
  PairingDecision,
  PairingRequest,
  PairingRequestOutcome,
  PairingSettleOutcome,
  PairingSubject,
} from './api/contract.ts';

/** The owner's choice: a request nobody answers within the hour expires. */
const pairingTtlMs = 60 * 60 * 1000;
/** Writes in all for one approval while other writes keep moving the home's document. */
const writeAttempts = 3;

const invalidSubjectMessage =
  'A pairing names the account by its id, one token of letters, digits ' +
  'and any of ":._-" at most 64 characters, and by a name of one line, at ' +
  'most 128 characters.';

const pairingConnectorIds = builtInConnectors
  .filter(connector => connector.pairing !== undefined)
  .map(connector => connector.id)
  .join(', ');

/**
 * The accounts a connector's allowlist field holds in the home's document,
 * in the clear, since an approval writes them back, and the fingerprint
 * that write presents.
 */
export type AllowlistReading =
  | {
      readonly status: 'ok';
      readonly fingerprint: string;
      readonly accounts: Readonly<Record<string, RuntimeConfigValue>>;
    }
  | {readonly status: 'refused'; readonly message: string};

export type PairingSeam = {
  readonly request: (
    connectorId: string,
    subject: PairingSubject,
  ) => PairingRequestOutcome;
  readonly pending: () => readonly PairingRequest[];
  readonly settle: (
    code: string,
    decision: PairingDecision,
  ) => Promise<PairingSettleOutcome>;
  readonly stop: () => void;
};

type Waiting = {
  readonly request: PairingRequest;
  /** The field an approval writes the account into. */
  readonly field: string;
  readonly timer: NodeJS.Timeout;
  /** An approval is on its way to disk; no second answer is taken meanwhile. */
  readonly writing?: true;
};

/**
 * The pairing requests the daemon holds, as it holds tool confirmations:
 * each under a code, announced on the stream, settled once for every
 * surface. An approval is a config write into the field the connector's
 * declaration names, in the home's document, through the façade's own
 * apply, so `health_changed` is on the stream before the settlement.
 */
export function createPairingSeam(seams: {
  readonly readAllowlist: (
    connectorId: string,
    field: string,
  ) => AllowlistReading;
  readonly applyChange: (change: ConfigChange) => Promise<ConfigChangeOutcome>;
  readonly emit: (event: GatewayEvent) => void;
  readonly ttlMs?: number;
}): PairingSeam {
  const ttlMs = seams.ttlMs ?? pairingTtlMs;
  const waiting = new Map<string, Waiting>();

  return Object.freeze({
    request,
    pending: () =>
      Object.freeze([...waiting.values()].map(entry => entry.request)),
    settle,
    stop() {
      for (const entry of waiting.values()) {
        clearTimeout(entry.timer);
      }
    },
  });

  function request(
    connectorId: string,
    subject: PairingSubject,
  ): PairingRequestOutcome {
    const field = builtInConnectors.find(
      connector => connector.id === connectorId,
    )?.pairing?.field;

    if (field === undefined) {
      return refusedRequest(
        'unknown_connector',
        `Connector "${connectorId}" does not pair. Connectors that pair: ` +
          `${pairingConnectorIds}.`,
      );
    }

    if (
      !isValidClientStamp(subject.id) ||
      !isValidSpeakerDisplayName(subject.label)
    ) {
      return refusedRequest('invalid_subject', invalidSubjectMessage);
    }

    const reading = seams.readAllowlist(connectorId, field);

    if (reading.status !== 'ok') {
      return refusedRequest('config_unloadable', reading.message);
    }

    const asked = [...waiting.values()].find(
      entry =>
        entry.request.connectorId === connectorId &&
        entry.request.subject.id === subject.id,
    );

    if (Object.hasOwn(reading.accounts, subject.id)) {
      // Another hand paired the account while its request waited; a request
      // whose approval is being written is settled by that write instead.
      if (asked !== undefined && asked.writing !== true) {
        settleAs(asked, 'approved');
      }

      return Object.freeze({status: 'paired' as const});
    }

    return Object.freeze({
      status: 'pending' as const,
      request: asked?.request ?? ask(connectorId, subject, field),
    });
  }

  /** A new request under a fresh code, on the list, the clock and the stream. */
  function ask(
    connectorId: string,
    subject: PairingSubject,
    field: string,
  ): PairingRequest {
    const now = Date.now();
    const request: PairingRequest = Object.freeze({
      connectorId,
      code: freshCode(waiting),
      subject: Object.freeze({id: subject.id, label: subject.label}),
      requestedAt: new Date(now).toISOString(),
      expiresAt: now + ttlMs,
    });

    arm(request, field);

    return request;
  }

  /**
   * On the list, on the clock until its deadline, and on the stream: a
   * request put back after a failed write is announced again, so a surface
   * that joined meanwhile shows it too, and one that has it keeps one card.
   */
  function arm(request: PairingRequest, field: string): void {
    const timer = setTimeout(
      () => {
        expire(request.code);
      },
      Math.max(0, request.expiresAt - Date.now()),
    );

    timer.unref();
    waiting.set(request.code, {request, field, timer});
    seams.emit(Object.freeze({kind: 'pairing_requested' as const, ...request}));
  }

  async function settle(
    code: string,
    decision: PairingDecision,
  ): Promise<PairingSettleOutcome> {
    const entry = waiting.get(code);

    if (entry === undefined || entry.writing === true) {
      return Object.freeze({status: 'unknown' as const});
    }

    if (Date.now() >= entry.request.expiresAt) {
      settleAs(entry, 'expired');

      return Object.freeze({status: 'expired' as const});
    }

    if (decision === 'denied') {
      settleAs(entry, decision);

      return Object.freeze({status: 'settled' as const, decision});
    }

    // Kept on the list while the write runs, so asking for the account
    // again gets this request and not a second one; off the clock, and
    // taking no second answer.
    clearTimeout(entry.timer);
    waiting.set(code, {...entry, writing: true});

    const failure = await admit(entry, writeAttempts);

    if (failure !== undefined) {
      arm(entry.request, entry.field);

      return Object.freeze({status: 'failed' as const, message: failure});
    }

    waiting.delete(code);
    seams.emit(settlement(entry.request, decision));

    return Object.freeze({status: 'settled' as const, decision});
  }

  /** Writes the account in, reading again after another write moved the document; a failure's message. */
  async function admit(
    entry: Waiting,
    attemptsLeft: number,
  ): Promise<string | undefined> {
    const reading = seams.readAllowlist(entry.request.connectorId, entry.field);

    if (reading.status !== 'ok') {
      return reading.message;
    }

    // Another hand paired the account meanwhile; the name it gave stands.
    if (Object.hasOwn(reading.accounts, entry.request.subject.id)) {
      return undefined;
    }

    const outcome = await seams.applyChange(admission(reading, entry));

    if (outcome.status === 'applied') {
      return undefined;
    }

    return outcome.status === 'refused' &&
      outcome.reason === 'conflict' &&
      attemptsLeft > 1
      ? admit(entry, attemptsLeft - 1)
      : outcome.message;
  }

  function expire(code: string): void {
    const entry = waiting.get(code);

    if (entry !== undefined) {
      settleAs(entry, 'expired');
    }
  }

  /** Off the list and the clock, and on the stream, so every surface hears how it ended. */
  function settleAs(
    entry: Waiting,
    decision: PairingDecision | 'expired',
  ): void {
    waiting.delete(entry.request.code);
    clearTimeout(entry.timer);
    seams.emit(settlement(entry.request, decision));
  }
}

/** The account added to those the reading holds, bound to its fingerprint. */
function admission(
  {fingerprint, accounts}: Extract<AllowlistReading, {status: 'ok'}>,
  {request, field}: Waiting,
): ConfigChange {
  return {
    target: {scope: 'global'},
    expectedFingerprint: fingerprint,
    operation: {
      kind: 'section_field_set',
      namespace: 'connectors',
      id: request.connectorId,
      field,
      value: {...accounts, [request.subject.id]: request.subject.label},
    },
  };
}

function settlement(
  request: PairingRequest,
  decision: PairingDecision | 'expired',
): GatewayEvent {
  return Object.freeze({
    kind: 'pairing_settled' as const,
    connectorId: request.connectorId,
    code: request.code,
    subject: request.subject,
    decision,
  });
}

/** Six digits a person reads off one screen and finds on another. */
function freshCode(taken: ReadonlyMap<string, unknown>): string {
  for (;;) {
    const code = String(randomInt(100_000, 1_000_000));

    if (!taken.has(code)) {
      return code;
    }
  }
}

function refusedRequest(
  reason: Extract<PairingRequestOutcome, {status: 'refused'}>['reason'],
  message: string,
): PairingRequestOutcome {
  return Object.freeze({status: 'refused' as const, reason, message});
}
