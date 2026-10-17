import {Hono, type Context} from 'hono';

import {isJsonRecord} from '../../src/shared/json-boundary.ts';
import {listen} from './gateway-http.ts';

/** An update as Telegram's wire carries it. */
export type TelegramWireUpdate = Readonly<Record<string, unknown>> & {
  readonly update_id: number;
};

export type TelegramCall = {readonly method: string; readonly body: unknown};

export type FakeTelegram = {
  readonly baseUrl: string;
  readonly port: number;
  close(): Promise<void>;
  registerBot(
    token: string,
    bot: {readonly id: number; readonly username: string},
  ): void;
  /** Queues an update and hands it to the poll waiting on that token. */
  push(token: string, update: TelegramWireUpdate): void;
  /** Every call on that token, in order, the refused ones too. */
  calls(token: string): readonly TelegramCall[];
  /** The next call on that token — of `method`, when one is named — answers 429 with `retry_after`. */
  throttle(token: string, retryAfterSeconds: number, method?: string): void;
};

/** A waiting poll is answered, or ended by a newer one on its token. */
type PollEnding = 'answer' | 'conflict';

type Bot = {
  readonly id: number;
  readonly username: string;
  readonly calls: TelegramCall[];
  updates: TelegramWireUpdate[];
  /** Each sent message's text and keyboard, by chat and message id. */
  readonly contents: Map<string, string>;
  nextMessageId: number;
  throttled:
    | {readonly retryAfterSeconds: number; readonly method: string | undefined}
    | undefined;
  /** Ends the poll waiting on this token, if one is. */
  endWaitingPoll: ((ending: PollEnding) => void) | undefined;
};

const conflictDescription =
  'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';
const notModifiedDescription =
  'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';

/**
 * The Bot API's methods the connector calls, on a loopback socket, for a
 * `baseUrl` in place of api.telegram.org. Answers follow Telegram's
 * envelope and its server's rules; time is real, and only a long poll
 * waits.
 */
export async function createFakeTelegram(
  options: {readonly port?: number} = {},
): Promise<FakeTelegram> {
  const bots = new Map<string, Bot>();
  const app = new Hono().post('/bot:token/:method', async c => {
    const bot = bots.get(c.req.param('token') ?? '');

    if (bot === undefined) {
      return refusal(c, 401, 'Unauthorized');
    }

    const method = c.req.param('method');
    const body: unknown = await c.req.json().catch(() => ({}));
    const fields = isJsonRecord(body) ? body : {};

    bot.calls.push({method, body});

    if (
      bot.throttled !== undefined &&
      (bot.throttled.method === undefined || bot.throttled.method === method)
    ) {
      const retryAfter = bot.throttled.retryAfterSeconds;

      bot.throttled = undefined;

      return c.json(
        {
          ok: false,
          error_code: 429,
          description: `Too Many Requests: retry after ${String(retryAfter)}`,
          parameters: {retry_after: retryAfter},
        },
        429,
      );
    }

    switch (method) {
      case 'getMe':
        return c.json({
          ok: true,
          result: {
            id: bot.id,
            is_bot: true,
            first_name: bot.username,
            username: bot.username,
          },
        });
      case 'getUpdates':
        return answerPoll(c, bot, fields);
      case 'sendMessage':
        return answerMessage(c, bot, fields, bot.nextMessageId++);
      case 'editMessageText':
        return answerMessage(c, bot, fields, fields['message_id']);
      case 'deleteMessage':
      case 'answerCallbackQuery':
      case 'sendChatAction':
        return c.json({ok: true, result: true});
      default:
        return refusal(c, 404, 'Not Found');
    }
  });
  const server = await listen(app, options.port ?? 0);

  return {
    baseUrl: server.baseUrl,
    port: server.port,
    close: () => server.close(),
    registerBot(token, {id, username}) {
      bots.set(token, {
        id,
        username,
        calls: [],
        updates: [],
        contents: new Map(),
        nextMessageId: 1,
        throttled: undefined,
        endWaitingPoll: undefined,
      });
    },
    push(token, update) {
      const bot = registered(bots, token);

      bot.updates.push(update);
      bot.endWaitingPoll?.('answer');
    },
    calls: token => bots.get(token)?.calls ?? [],
    throttle(token, retryAfterSeconds, method) {
      registered(bots, token).throttled = {retryAfterSeconds, method};
    },
  };
}

function registered(bots: ReadonlyMap<string, Bot>, token: string): Bot {
  const bot = bots.get(token);

  if (bot === undefined) {
    throw new Error(`No bot is registered for ${token}.`);
  }

  return bot;
}

function refusal(
  c: Context,
  code: 400 | 401 | 404 | 409,
  description: string,
): Response {
  return c.json({ok: false, error_code: code, description}, code);
}

/**
 * Answers at once when updates wait past the offset; otherwise waits for
 * one, for `timeout` seconds, or until a newer poll on the token ends
 * this one — the older poll is the one Telegram's server answers 409.
 */
async function answerPoll(
  c: Context,
  bot: Bot,
  fields: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const offset = typeof fields['offset'] === 'number' ? fields['offset'] : 0;
  const timeoutSeconds =
    typeof fields['timeout'] === 'number' ? fields['timeout'] : 0;
  const pending = (): TelegramWireUpdate[] =>
    bot.updates.filter(update => update.update_id >= offset);

  // An offset confirms every update before it, which Telegram then forgets.
  bot.updates = pending();

  if (bot.updates.length === 0 && timeoutSeconds > 0) {
    bot.endWaitingPoll?.('conflict');

    const ending = await waitForUpdates(bot, timeoutSeconds, c.req.raw.signal);

    if (ending === 'conflict') {
      return refusal(c, 409, conflictDescription);
    }
  }

  return c.json({ok: true, result: pending()});
}

function waitForUpdates(
  bot: Bot,
  timeoutSeconds: number,
  clientGone: AbortSignal,
): Promise<PollEnding> {
  return new Promise(resolve => {
    const end = (ending: PollEnding): void => {
      clearTimeout(timer);
      clientGone.removeEventListener('abort', onGone);

      if (bot.endWaitingPoll === end) {
        bot.endWaitingPoll = undefined;
      }

      resolve(ending);
    };
    const timer = setTimeout(() => {
      end('answer');
    }, timeoutSeconds * 1_000);
    const onGone = (): void => {
      end('answer');
    };

    clientGone.addEventListener('abort', onGone, {once: true});
    bot.endWaitingPoll = end;
  });
}

/** Records a sent or edited message; an edit that changes nothing is Telegram's 400. */
function answerMessage(
  c: Context,
  bot: Bot,
  fields: Readonly<Record<string, unknown>>,
  messageId: unknown,
): Response {
  const chatId = fields['chat_id'];
  const key = `${String(chatId)}:${String(messageId)}`;
  const content = JSON.stringify([fields['text'], fields['reply_markup']]);

  if (bot.contents.get(key) === content) {
    return refusal(c, 400, notModifiedDescription);
  }

  bot.contents.set(key, content);

  return c.json({
    ok: true,
    result: {
      message_id: messageId,
      from: {
        id: bot.id,
        is_bot: true,
        first_name: bot.username,
        username: bot.username,
      },
      chat: {id: chatId, type: 'private'},
      date: Math.floor(Date.now() / 1_000),
      text: fields['text'],
    },
  });
}
