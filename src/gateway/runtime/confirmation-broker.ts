import {randomUUID} from 'node:crypto';

import type {RuntimePluginToolConfirmationHandler} from '../../plugins/index.ts';
import type {
  GatewayConfirmationDecision,
  GatewayEvent,
} from '../api/contract.ts';

type Decision = Awaited<ReturnType<RuntimePluginToolConfirmationHandler>>;

export type ConfirmationBroker = {
  /** Plugs into the host's tool-confirmation seam; nothing else changes there. */
  readonly handler: RuntimePluginToolConfirmationHandler;
  /** Unknown or already-settled ids are a no-op: a late answer is benign. */
  answer(id: string, decision: GatewayConfirmationDecision): void;
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
}): ConfirmationBroker {
  const pending = new Map<string, (decision: Decision) => void>();
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

        const settle = (decision: Decision): void => {
          if (pending.delete(id)) {
            resolve(decision);
          }
        };

        pending.set(id, settle);
        context.signal.addEventListener(
          'abort',
          () => {
            settle({status: 'cancelled'});
          },
          {once: true},
        );
        options.emit({
          kind: 'confirmation_requested',
          characterId: options.characterId,
          id,
          request,
          deadlineAt: context.deadlineAt,
        });
      });
    },
    answer(id, decision) {
      pending.get(id)?.({status: decision});
    },
    cancelAll() {
      cancelling = true;
      for (const settle of [...pending.values()]) {
        settle({status: 'cancelled'});
      }
    },
    arm() {
      cancelling = false;
    },
  });
}
