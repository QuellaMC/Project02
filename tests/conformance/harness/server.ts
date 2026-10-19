import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';

import {onTestFinished} from 'vitest';

import {within} from './wait.ts';

/**
 * Listens on a loopback port of its own, under the ceiling and with a bind
 * that fails failing the test, and closes with the test; the port.
 */
export async function servedOnLoopback(server: Server): Promise<number> {
  await within(
    'the stub server to listen',
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    }),
  );
  onTestFinished(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );

  return (server.address() as AddressInfo).port;
}
