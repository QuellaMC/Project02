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
   * once, event streams end, the gateway drains its turns and releases its
   * leases with the socket still open — so an accepted turn still receives
   * its outcome — and only then does the listener close, giving a response
   * still being written a moment to finish before its socket is cut.
   */
  close(): Promise<void>;
};

const loopback = '127.0.0.1';
/** How long an answer still on its way out may take before the socket goes. */
const responseGraceMs = 2_000;

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
  const port = await listen(server, options.port);

  return Object.freeze({
    port,
    async close() {
      stopping = true;
      events.closeAll();
      await options.gateway.stop();
      await new Promise<void>(resolve => {
        const closed = (): void => {
          clearTimeout(cutoff);
          resolve();
        };
        // An outcome the gateway just produced may still be leaving on a
        // slow socket; idle connections go now, active ones get a moment.
        const cutoff = setTimeout(() => {
          if ('closeAllConnections' in server) {
            server.closeAllConnections();
          }
        }, responseGraceMs);

        server.close(closed);

        if ('closeIdleConnections' in server) {
          server.closeIdleConnections();
        }
      });
    },
  });
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
