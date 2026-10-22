import {Hono, type Context, type MiddlewareHandler} from 'hono';
import {validator} from 'hono/validator';

import {builtInConnectors} from '../../runtime/config/index.ts';
import type {ConfigTarget, GatewayErrorBody} from '../api/index.ts';
import type {HistoryPage} from '../client/index.ts';
import type {Gateway} from '../gateway.ts';
import type {ApiEnv} from './env.ts';
import type {EventStreams} from './events.ts';
import {
  answerBody,
  configChangeBody,
  gatewayMessageBody,
  openConversationBody,
  pairingRequestBody,
  type BodyValidator,
} from './schemas.ts';

export function errorBody(code: string, message: string): GatewayErrorBody {
  return Object.freeze({error: Object.freeze({code, message})});
}

/** A body that fails its schema is a 400 with the envelope; nothing else runs. */
function jsonBody<T>(validate: BodyValidator<T>) {
  return validator('json', (value: unknown, c: Context<ApiEnv>) => {
    const validation = validate(value);

    if (!validation.ok) {
      return c.json(errorBody('invalid_request', validation.message), 400);
    }

    return validation.value;
  });
}

/** Raw strings through to the façade's one page parser; typed for the client. */
const historyQuery = validator(
  'query',
  (value: Record<string, string | string[]>): HistoryPage => ({
    ...(typeof value['before'] === 'string' ? {before: value['before']} : {}),
    ...(typeof value['limit'] === 'string' ? {limit: value['limit']} : {}),
  }),
);

/** The document a config verb targets, spelled in the query; anything else is a 400. */
const configTargetQuery = validator(
  'query',
  (value: Record<string, string | string[]>, c: Context<ApiEnv>) => {
    const scope = value['scope'];
    const characterId = value['characterId'];

    if (scope === 'global') {
      return {scope: 'global'} as const satisfies ConfigTarget;
    }

    if (scope === 'character' && typeof characterId === 'string') {
      return {scope: 'character', characterId} as const satisfies ConfigTarget;
    }

    return c.json(
      errorBody(
        'invalid_request',
        'A config target is ?scope=global or ?scope=character&characterId=<id>.',
      ),
      400,
    );
  },
);

/** The connector a stream's process names itself as, if any: one this version has, or a 400. */
const eventsQuery = validator(
  'query',
  (value: Record<string, string | string[]>, c: Context<ApiEnv>) => {
    const connector = value['connector'];

    if (
      connector === undefined ||
      (typeof connector === 'string' &&
        builtInConnectors.some(known => known.id === connector))
    ) {
      return {connector};
    }

    return c.json(
      errorBody(
        'invalid_request',
        `A connector is one of: ${builtInConnectors.map(known => known.id).join(', ')}.`,
      ),
      400,
    );
  },
);

/**
 * Every route returns its verb's outcome verbatim with a 200: the status
 * codes describe the transport, and `status` in the body describes what
 * happened. An unknown `/api` route is a 404 envelope here, behind the same
 * auth, so nothing outside the API ever answers for one.
 */
export function createApiRouter(
  gateway: Gateway,
  middleware: readonly MiddlewareHandler<ApiEnv>[],
  events: EventStreams,
) {
  const api = new Hono<ApiEnv>();

  for (const handler of middleware) {
    api.use('/*', handler);
  }

  return api
    .get('/health', c => c.json(gateway.health(), 200))
    .post('/characters/:id/start', async c =>
      c.json(await gateway.startCharacter(c.req.param('id')), 200),
    )
    .post('/conversations/open', jsonBody(openConversationBody), async c =>
      c.json(
        await gateway.openDirectConversation(c.req.valid('json').characterId),
        200,
      ),
    )
    .post('/turns', jsonBody(gatewayMessageBody), async c =>
      c.json(await gateway.deliver(c.req.valid('json')), 200),
    )
    .get('/conversations/:id/messages', historyQuery, async c =>
      c.json(
        await gateway.history(c.req.param('id'), c.req.valid('query')),
        200,
      ),
    )
    .get('/confirmations', c => c.json(gateway.pendingConfirmations(), 200))
    .post('/confirmations/:id', jsonBody(answerBody), c =>
      c.json(
        gateway.answerConfirmation(
          c.req.param('id'),
          c.req.valid('json').decision,
        ),
        200,
      ),
    )
    .get('/config', configTargetQuery, c =>
      c.json(gateway.configView(c.req.valid('query')), 200),
    )
    .post('/config', jsonBody(configChangeBody), async c =>
      c.json(await gateway.applyConfigChange(c.req.valid('json')), 200),
    )
    .get('/connectors/:id/config', c =>
      c.json(gateway.connectorConfig(c.req.param('id')), 200),
    )
    .post('/connectors/:id/pairing', jsonBody(pairingRequestBody), c =>
      c.json(
        gateway.requestPairing(c.req.param('id'), c.req.valid('json').subject),
        200,
      ),
    )
    .get('/pairing', c => c.json(gateway.pendingPairings(), 200))
    .post('/pairing/:code', jsonBody(answerBody), async c =>
      c.json(
        await gateway.settlePairing(
          c.req.param('code'),
          c.req.valid('json').decision,
        ),
        200,
      ),
    )
    .get('/events', eventsQuery, c =>
      events.handler(c, c.req.valid('query').connector),
    )
    .all('/*', c =>
      c.json(errorBody('not_found', `No API route at ${c.req.path}.`), 404),
    );
}
