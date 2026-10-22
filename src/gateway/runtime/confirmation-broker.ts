import {randomUUID} from 'node:crypto';

import type {
  RuntimePluginToolConfirmationHandler,
  RuntimePluginToolConfirmationRequest,
} from '../../plugins/index.ts';
import type {
  Answer,
  AnswerOutcome,
  ConfirmationSettlement,
  GatewayEvent,
  TurnIdentity,
} from '../api/index.ts';

type Decision = Awaited<ReturnType<RuntimePluginToolConfirmationHandler>>;

type ParkedRequest = {
  readonly request: RuntimePluginToolConfirmationRequest;
  readonly deadlineAt: number;
  readonly turn: TurnIdentity | undefined;
  readonly settle: (settlement: ConfirmationSettlement) => void;
};

export type ParkedConfirmation = {
  readonly id: string;
  readonly request: RuntimePluginToolConfirmationRequest;
  readonly deadlineAt: number;
  readonly turn?: TurnIdentity;
};

export type ConfirmationBroker = {
  /** Plugs into the host's tool-confirmation seam; nothing else changes there. */
  readonly handler: RuntimePluginToolConfirmationHandler;
  /** Everything parked right now, oldest first. */
  pending(): readonly ParkedConfirmation[];
  /**
   * Unknown or already-settled ids are `unknown`: a late answer is benign.
   * An answer at or past the deadline settles the request as cancelled and
   * reports `expired` — the deadline is enforced here, never trusted to the
   * client or to the host's timer having fired first.
   */
  answer(id: string, decision: Answer): AnswerOutcome['status'];
  /** Cancel every parked request, and settle later ones at once. */
  cancelAll(): void;
  /** Re-arm after a cancelAll, so a fresh boot parks confirmations again. */
  arm(): void;
};

/**
 * Turns the host's in-process confirmation call into an addressable event:
 * the request goes out with a gateway-unique id and parks until some client
 * answers it. The host keeps owning the deadline — its abort signal only
 * cleans up here.
 */
export function createConfirmationBroker(options: {
  readonly characterId: string;
  readonly emit: (event: GatewayEvent) => void;
  /** The turn running right now, whose tool is asking; none outside a turn. */
  readonly turnOf: () => TurnIdentity | undefined;
  /** Fires once per parked request, however it settled: with the answer, or cancelled and why. */
  readonly onSettled?: (id: string, settlement: ConfirmationSettlement) => void;
}): ConfirmationBroker {
  const pending = new Map<string, ParkedRequest>();
  let cancelling = false;

  return Object.freeze({
    handler(request, context) {
      const id = randomUUID();

      return new Promise<Decision>(resolve => {
        // A request raised once shutdown began settles at once: a turn
        // draining into an approval-gated tool must not park the drain for
        // the host's deadline.
        if (cancelling) {
          resolve({status: 'cancelled'});
          return;
        }

        const settle = (settlement: ConfirmationSettlement): void => {
          if (pending.delete(id)) {
            resolve({status: settlement.decision});
            options.onSettled?.(id, settlement);
          }
        };

        const turn = options.turnOf();

        pending.set(id, {
          request,
          deadlineAt: context.deadlineAt,
          turn,
          settle,
        });
        context.signal.addEventListener(
          'abort',
          () => {
            settle({decision: 'cancelled', reason: 'expired'});
          },
          {once: true},
        );
        options.emit({
          kind: 'confirmation_requested',
          characterId: options.characterId,
          id,
          request,
          deadlineAt: context.deadlineAt,
          ...(turn === undefined ? {} : {turn}),
        });
      });
    },
    pending() {
      return Object.freeze(
        [...pending.entries()].map(([id, parked]) =>
          Object.freeze({
            id,
            request: parked.request,
            deadlineAt: parked.deadlineAt,
            ...(parked.turn === undefined ? {} : {turn: parked.turn}),
          }),
        ),
      );
    },
    answer(id, decision) {
      const parked = pending.get(id);

      if (parked === undefined) {
        return 'unknown';
      }

      if (Date.now() >= parked.deadlineAt) {
        parked.settle({decision: 'cancelled', reason: 'expired'});
        return 'expired';
      }

      parked.settle({decision});
      return 'answered';
    },
    cancelAll() {
      cancelling = true;
      for (const parked of [...pending.values()]) {
        parked.settle({decision: 'cancelled', reason: 'stopped'});
      }
    },
    arm() {
      cancelling = false;
    },
  });
}
