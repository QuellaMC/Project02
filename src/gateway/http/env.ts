import type {HttpBindings} from '@hono/node-server';

/** Under the Node adapter every handler sees the raw request and response. */
export type ApiEnv = {Bindings: HttpBindings};
