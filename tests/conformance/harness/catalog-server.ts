/**
 * The App Store's catalog on loopback, standing in for where the build reads
 * it: the daemon's environment points it here, each path answers what the
 * test published there, a path nothing was published at answers 404, and
 * it keeps every path it was asked for.
 */
import {createServer} from 'node:http';

import {servedOnLoopback} from './server.ts';
import {attachEvidence} from './wait.ts';

export type CatalogServer = {
  /** The daemon's environment that points it here, in place of the build's own catalog. */
  readonly env: {readonly PROJECT02_TEST_APP_CATALOG: string};
  /** Every path asked, below the catalog's base, in order. */
  readonly requests: readonly string[];
  /** What a path below the catalog's base answers from now on. */
  readonly publish: (path: string, text: string) => void;
  /** Out of reach: every request from now on is cut off unanswered. */
  readonly away: () => void;
};

export async function startCatalogServer(): Promise<CatalogServer> {
  const requests: string[] = [];
  const published = new Map<string, string>();
  let reachable = true;
  const server = createServer((request, response) => {
    const path = (request.url ?? '').replace(/^\//u, '');
    const text = published.get(path);

    requests.push(path);

    if (!reachable) {
      request.socket.destroy();
    } else if (text === undefined) {
      response.writeHead(404).end();
    } else {
      response
        .writeHead(200, {'content-type': 'text/plain; charset=utf-8'})
        .end(text);
    }
  });

  const port = await servedOnLoopback(server);

  attachEvidence(() => `catalog server: ${requests.join(', ')}`);

  return {
    env: {PROJECT02_TEST_APP_CATALOG: `http://127.0.0.1:${String(port)}`},
    requests,
    publish: (path, text) => {
      published.set(path, text);
    },
    away: () => {
      reachable = false;
    },
  };
}
