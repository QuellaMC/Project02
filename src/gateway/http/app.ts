import {serveStatic} from '@hono/node-server/serve-static';
import {Hono, type Context, type MiddlewareHandler} from 'hono';
import {bearerAuth} from 'hono/bearer-auth';
import {bodyLimit} from 'hono/body-limit';
import {HTTPException} from 'hono/http-exception';
import {relative} from 'node:path';

import type {Gateway} from '../api/contract.ts';
import {createApiRouter, errorBody} from './api.ts';
import type {ApiEnv} from './env.ts';
import type {EventStreams} from './events.ts';

export type GatewayLifecycle = {
  /** True once shutdown began: new API requests are told so, with a 503. */
  readonly stopping: () => boolean;
};

export type CreateGatewayAppOptions = {
  readonly gateway: Gateway;
  readonly token: string;
  readonly events: EventStreams;
  readonly lifecycle: GatewayLifecycle;
  /** Static files for the web UI, served without auth; absent until PR 4 ships one. */
  readonly uiRoot?: string;
};

/** A message is a few KiB; a body past this is not a message. */
const maxBodyBytes = 64 * 1024;

const loopbackHostnames = new Set(['127.0.0.1', 'localhost', '[::1]']);

const codeByStatus: Readonly<Record<number, string>> = Object.freeze({
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden_origin',
  404: 'not_found',
  413: 'payload_too_large',
  421: 'misdirected_host',
  503: 'unavailable',
});

const messageByStatus: Readonly<Record<number, string>> = Object.freeze({
  400: 'The request could not be read.',
  401: 'A bearer token is required.',
  413: 'The request body is too large.',
});

/**
 * The daemon's socket, as a Hono app: every `/api` request passes the
 * lifecycle check, the loopback check, bearer auth, and the body cap before
 * a route sees it; every transport refusal is one envelope. The app's type
 * is the wire contract a TypeScript client derives its calls from.
 */
export function createGatewayApp(options: CreateGatewayAppOptions) {
  const app = new Hono<ApiEnv>();

  app.onError((error, c) => {
    if (c.req.path.startsWith('/api')) {
      c.header('Cache-Control', 'no-store');
    }

    if (error instanceof HTTPException) {
      const code = codeByStatus[error.status] ?? 'internal';
      const message =
        error.message.length > 0
          ? error.message
          : (messageByStatus[error.status] ?? 'The request failed.');

      return c.json(errorBody(code, message), error.status);
    }

    return c.json(
      errorBody('internal', error.message.length > 0 ? error.message : 'Bug.'),
      500,
    );
  });
  app.notFound(c =>
    c.json(errorBody('not_found', `Nothing is served at ${c.req.path}.`), 404),
  );

  const guard: MiddlewareHandler<ApiEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store');

    if (options.lifecycle.stopping()) {
      throw new HTTPException(503, {message: 'The daemon is stopping.'});
    }

    assertLoopbackOrigin(c);
    await next();
  };
  const routes = app.route(
    '/api',
    createApiRouter(
      options.gateway,
      [
        guard,
        bearerAuth({token: options.token}),
        bodyLimit({maxSize: maxBodyBytes}),
      ],
      options.events,
    ),
  );

  if (options.uiRoot === undefined) {
    routes.get('/', c =>
      c.text('No web UI is installed here. The API is under /api.', 404),
    );
  } else {
    // The Node adapter resolves the root against the working directory.
    routes.get(
      '/*',
      serveStatic({root: relative(process.cwd(), options.uiRoot)}),
    );
  }

  return routes;
}

export type GatewayApp = ReturnType<typeof createGatewayApp>;

/**
 * The DNS-rebinding defence: a page on another origin cannot name this
 * host, and a browser that sends an Origin must be this daemon's own page.
 */
function assertLoopbackOrigin(c: Context<ApiEnv>): void {
  const host = c.req.header('host') ?? '';
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : (host.split(':')[0] ?? '');

  if (!loopbackHostnames.has(hostname)) {
    throw new HTTPException(421, {
      message: `Host "${host}" is not this daemon; it answers on 127.0.0.1.`,
    });
  }

  const origin = c.req.header('origin');

  if (origin !== undefined && origin !== `http://${host}`) {
    throw new HTTPException(403, {
      message: `Origin "${origin}" is not this daemon's page.`,
    });
  }
}
