/**
 * What each surface of the page is made of, the chat and her phone's
 * window alike: one value its components read, the client for the address
 * the page was opened at, and the one stream it follows for as long as the
 * page lives. Browser-only like the sessions built on it: the browser
 * suite is its cover.
 */
import type {GatewayEvent, GatewayReady} from '@project02/wire/contract';
import {createGatewayClient, type GatewayClient} from '@project02/wire/client';

/** A surface's one value, everyone watching it, and the one way it changes. */
export type Value<State> = {
  readonly getState: () => State;
  readonly subscribe: (listener: () => void) => () => void;
  /** A reducer that changes nothing returns the value it was given, and nobody is told. */
  readonly apply: (reduce: (state: State) => State) => void;
};

export function createValue<State>(initial: State): Value<State> {
  const listeners = new Set<() => void>();
  let state = initial;

  return {
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    apply: reduce => {
      const next = reduce(state);

      if (next === state) {
        return;
      }

      state = next;

      for (const listener of listeners) {
        listener();
      }
    },
  };
}

/** What a surface does with what its stream says. */
export type Follower = {
  readonly event: (event: GatewayEvent) => void;
  /** Every `ready`; the stream hands on nothing more until what it returns settles. */
  readonly ready: (snapshot: GatewayReady) => void | Promise<void>;
  readonly lost: () => void;
  readonly resumed: () => void;
  /** The address will never work: a dead token, a wrong protocol. */
  readonly refused: (message: string) => void;
};

export function problem(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The client for the address the page was opened at, or why that address can never work. */
export function clientFor(address: string): GatewayClient | string {
  try {
    return createGatewayClient({url: address});
  } catch (error: unknown) {
    return problem(error);
  }
}

/**
 * The stream, followed as long as the page lives: a tab that goes away
 * takes its socket with it, and the daemon notices. The client reconnects
 * it until the address is refused.
 */
export function follow(client: GatewayClient, follower: Follower): void {
  client
    .events(follower.event, {
      signal: new AbortController().signal,
      onReady: ({snapshot}) => follower.ready(snapshot),
      onLost: follower.lost,
      onResumed: follower.resumed,
    })
    .catch((error: unknown) => {
      follower.refused(problem(error));
    });
}
