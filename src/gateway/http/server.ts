import {Server, type IncomingMessage, type ServerResponse} from 'node:http';

import {createAdaptorServer, type ServerType} from '@hono/node-server';

import type {Gateway} from '../api/contract.ts';
import {createGatewayApp} from './app.ts';
import {createEventStreams} from './events.ts';

export type GatewayServerOptions = {
  readonly gateway: Gateway;
  readonly token: string;
  /** 0 asks the OS for a free port; a busy port falls back to one. */
  readonly port: number;
  readonly uiRoot?: string;
};

export type GatewayServer = {
  readonly port: number;
  /**
   * Stops in the order that loses nothing. New API requests answer 503 at
   * once; the gateway drains its turns and releases its leases with the
   * socket and the event streams still open — so an accepted turn still
   * receives its outcome, and the stream still carries its reply; then the
   * streams end, and only then does the listener close, letting an answer
   * still being written finish before its socket is cut.
   */
  close(): Promise<void>;
};

const loopback = '127.0.0.1';

/** The daemon's one socket: the API and the UI on a loopback port. */
export async function createGatewayServer(
  options: GatewayServerOptions,
): Promise<GatewayServer> {
  const events = createEventStreams(options.gateway);
  let stopping = false;
  const app = createGatewayApp({
    gateway: options.gateway,
    token: options.token,
    events,
    lifecycle: {stopping: () => stopping},
    ...(options.uiRoot === undefined ? {} : {uiRoot: options.uiRoot}),
  });
  const server = createAdaptorServer({fetch: app.fetch});
  const responses = trackResponses(server);
  const port = await listen(server, options.port);

  return Object.freeze({
    port,
    async close() {
      stopping = true;
      await options.gateway.stop();
      events.closeAll();
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });

        // An outcome the gateway just produced may still be leaving on a
        // slow socket. Idle connections go now; every answer still being
        // written is waited for, and only then is whatever remains cut.
        if ('closeIdleConnections' in server) {
          server.closeIdleConnections();
        }

        void responses.drained().then(() => {
          if ('closeAllConnections' in server) {
            server.closeAllConnections();
          }
        });
      });
    },
  });
}

/**
 * Tracks the exchanges in flight, so shutdown can wait for the answers
 * still being written. An exchange whose request never fully arrived — a
 * client that stalled mid-body — has no answer on the way and is not
 * waited for; the cut that follows the drain ends it.
 */
function trackResponses(server: ServerType): {drained(): Promise<void>} {
  const active = new Set<{
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
  }>();
  const waiting: (() => void)[] = [];
  const answering = (): boolean =>
    [...active].some(exchange => exchange.request.complete);
  const settle = (): void => {
    if (!answering()) {
      for (const resolve of waiting.splice(0)) {
        resolve();
      }
    }
  };

  // The adaptor is built on node:http here; the type allows more.
  if (!(server instanceof Server)) {
    return {drained: () => Promise.resolve()};
  }

  server.on('request', (request, response) => {
    const exchange = {request, response};

    active.add(exchange);
    response.once('close', () => {
      active.delete(exchange);
      settle();
    });
  });

  return {
    drained: () =>
      answering()
        ? new Promise(resolve => {
            waiting.push(resolve);
          })
        : Promise.resolve(),
  };
}

/** Binds the loopback port, or a free one when the asked-for port is taken. */
function listen(server: ServerType, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE' && port !== 0) {
        server.listen(0, loopback);

        return;
      }

      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);

      const address = server.address();

      if (address === null || typeof address === 'string') {
        reject(new Error('The gateway socket has no TCP address.'));

        return;
      }

      resolve(address.port);
    };

    server.on('error', onError);
    server.once('listening', onListening);
    server.listen(port, loopback);
  });
}
