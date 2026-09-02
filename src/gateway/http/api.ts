import {Hono, type Context, type MiddlewareHandler} from 'hono';
import {validator} from 'hono/validator';

import type {Gateway, GatewayErrorBody, HistoryPage} from '../api/contract.ts';
import type {ApiEnv} from './env.ts';
import type {EventStreams} from './events.ts';
import {
  answerConfirmationBody,
  gatewayMessageBody,
  openConversationBody,
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

/**
 * Every route returns its verb's outcome verbatim with a 200: the status
 * codes describe the transport, and `status` in the body describes what
 * happened. An unknown `/api` route is a 404 envelope here, behind the same
 * auth, so it can never fall through to the static files.
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
    .post('/confirmations/:id', jsonBody(answerConfirmationBody), c =>
      c.json(
        gateway.answerConfirmation(
          c.req.param('id'),
          c.req.valid('json').decision,
        ),
        200,
      ),
    )
    .get('/events', c => events.handler(c))
    .all('/*', c =>
      c.json(errorBody('not_found', `No API route at ${c.req.path}.`), 404),
    );
}
