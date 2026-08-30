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
  cancelAll(): void;
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

  return Object.freeze({
    handler(request, context) {
      const id = randomUUID();

      return new Promise<Decision>(resolve => {
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
      for (const settle of [...pending.values()]) {
        settle({status: 'cancelled'});
      }
    },
  });
}
