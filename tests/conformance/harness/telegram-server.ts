/**
 * Telegram's Bot API on loopback, standing in for api.telegram.org: the
 * connector's environment points it here, and it answers the methods the
 * connector calls by Telegram's envelope and its server's rules — a long
 * poll waits for updates or its timeout, a message's id is unique only
 * within its chat, an edit that changes nothing is a 400 — keeping every
 * call, the refused ones too, with the moment it came.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {text} from 'node:stream/consumers';

import {servedOnLoopback} from './server.ts';
import {attachEvidence, observed} from './wait.ts';

export type TelegramCall = {
  readonly token: string;
  readonly method: string;
  readonly body: Readonly<Record<string, unknown>>;
  /** When it reached the server, by the monotonic clock. */
  readonly at: number;
  /** The id Telegram gave the message the call sent, numbered from one in its chat; none for a call that sent none. */
  readonly messageId: number | undefined;
};

/** An update as Telegram's wire carries it. */
export type TelegramUpdate = Readonly<Record<string, unknown>> & {
  readonly update_id: number;
};

/** A bot as Telegram knows it: its token, and who it is. */
export type TelegramBot = {
  readonly token: string;
  readonly id: number;
  readonly username: string;
};

/** A Telegram account, as an update names its sender. */
export type Account = {
  readonly id: number;
  readonly first_name: string;
  readonly username?: string;
};

export type TelegramServer = {
  /** The connector's environment that points it here, in Telegram's place. */
  readonly env: {readonly PROJECT02_TEST_TELEGRAM_API: string};
  /** Queues the updates and hands them to the poll waiting on the token. */
  readonly push: (token: string, ...updates: readonly TelegramUpdate[]) => void;
  /** Every call on the token, of the method when one is named, in order, the refused ones too. */
  readonly calls: (token: string, method?: string) => readonly TelegramCall[];
  /** Settles on what `find` finds in the token's calls, as soon as they hold it. */
  readonly called: <T>(
    token: string,
    find: (calls: readonly TelegramCall[]) => T | undefined,
  ) => Promise<T>;
  /** Settles once the token's bot has written these words in the chat, sent or edited. */
  readonly shows: (
    token: string,
    chatId: number,
    words: string,
  ) => Promise<void>;
  /** The next call on the token — of `method`, when one is named — answers 429 with `retry_after`. */
  readonly throttle: (
    token: string,
    retryAfterSeconds: number,
    method?: string,
  ) => void;
  /** Telegram out of reach: every call, a waiting poll's too, is dropped unanswered until `back`. */
  readonly away: () => void;
  readonly back: () => void;
};

type Bot = {
  readonly id: number;
  readonly username: string;
  updates: TelegramUpdate[];
  /** Each sent message's text and keyboard, by chat and message id. */
  readonly contents: Map<string, string>;
  /** The id of the last message sent in each chat. */
  readonly lastMessageIds: Map<string, number>;
  throttled:
    | {readonly retryAfterSeconds: number; readonly method: string | undefined}
    | undefined;
  /** Answers the poll waiting on this token, if one is. */
  endWaitingPoll: (() => void) | undefined;
};

const notModifiedDescription =
  'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';

/** The stand-in, knowing these bots. */
export async function startTelegramServer(
  known: readonly TelegramBot[] = [],
): Promise<TelegramServer> {
  const bots = new Map<string, Bot>();
  const calls = observed<TelegramCall>();
  let away = false;
  const registered = (token: string): Bot => {
    const bot = bots.get(token);

    if (bot === undefined) {
      throw new Error(`No bot is registered for ${token}.`);
    }

    return bot;
  };
  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await text(request);
    const route = /^\/bot([^/]+)\/([^/]+)$/u.exec(
      new URL(request.url ?? '/', 'http://telegram').pathname,
    );

    if (request.method !== 'POST' || route === null) {
      refuse(response, 404, 'Not Found');

      return;
    }

    const token = decodeURIComponent(route[1] ?? '');
    const method = route[2] ?? '';
    const fields = objectOf(body);
    const call = {
      token,
      method,
      body: fields,
      at: performance.now(),
      messageId: undefined as number | undefined,
    };

    calls.add(call);

    if (away) {
      request.socket.destroy();

      return;
    }

    const bot = bots.get(token);

    if (bot === undefined) {
      refuse(response, 401, 'Unauthorized');

      return;
    }

    if (
      bot.throttled !== undefined &&
      (bot.throttled.method === undefined || bot.throttled.method === method)
    ) {
      const retryAfter = bot.throttled.retryAfterSeconds;

      bot.throttled = undefined;
      envelope(response, 429, {
        ok: false,
        error_code: 429,
        description: `Too Many Requests: retry after ${String(retryAfter)}`,
        parameters: {retry_after: retryAfter},
      });

      return;
    }

    switch (method) {
      case 'getMe':
        envelope(response, 200, {ok: true, result: userOf(bot)});
        break;
      case 'getUpdates':
        await answerPoll(bot, fields, response);
        break;
      case 'sendMessage': {
        const chat = String(fields['chat_id']);

        call.messageId = (bot.lastMessageIds.get(chat) ?? 0) + 1;
        bot.lastMessageIds.set(chat, call.messageId);
        answerMessage(bot, fields, call.messageId, response);
        break;
      }
      case 'editMessageText':
        answerMessage(bot, fields, fields['message_id'], response);
        break;
      case 'deleteMessage':
      case 'answerCallbackQuery':
      case 'sendChatAction':
        envelope(response, 200, {ok: true, result: true});
        break;
      default:
        refuse(response, 404, 'Not Found');
    }
  };
  const server = createServer((request, response) => {
    // A request that broke off has nobody left to answer.
    respond(request, response).catch(() => {
      request.socket.destroy();
    });
  });
  const port = await servedOnLoopback(server);

  attachEvidence(
    () =>
      `telegram: ${String(calls.items.length)} call(s):\n${calls.items
        .map(describeCall)
        .join('\n')}`,
  );

  for (const {token, id, username} of known) {
    bots.set(token, {
      id,
      username,
      updates: [],
      contents: new Map(),
      lastMessageIds: new Map(),
      throttled: undefined,
      endWaitingPoll: undefined,
    });
  }

  return {
    env: {PROJECT02_TEST_TELEGRAM_API: `http://127.0.0.1:${String(port)}`},
    push(token, ...updates) {
      const bot = registered(token);

      bot.updates.push(...updates);
      bot.endWaitingPoll?.();
    },
    calls: (token, method) =>
      calls.items.filter(
        call =>
          call.token === token &&
          (method === undefined || call.method === method),
      ),
    called: (token, find) =>
      calls.until(`Telegram to be called on ${token}`, items =>
        find(items.filter(call => call.token === token)),
      ),
    shows: async (token, chatId, words) => {
      await calls.until(
        `${JSON.stringify(words)} in chat ${String(chatId)} on ${token}`,
        items =>
          textsIn(
            items.filter(call => call.token === token),
            chatId,
          ).includes(words)
            ? true
            : undefined,
      );
    },
    throttle(token, retryAfterSeconds, method) {
      registered(token).throttled = {retryAfterSeconds, method};
    },
    away() {
      away = true;
      server.closeAllConnections();
    },
    back() {
      away = false;
    },
  };
}

/** What a bot wrote in one chat, sent or edited, in order. */
export function textsIn(
  calls: readonly TelegramCall[],
  chatId: number,
): readonly unknown[] {
  return calls
    .filter(
      call =>
        (call.method === 'sendMessage' || call.method === 'editMessageText') &&
        call.body['chat_id'] === chatId,
    )
    .map(call => call.body['text']);
}

let lastUpdateId = 0;

/**
 * A message from an account as Telegram's wire carries it: in its private
 * chat with the bot unless another chat is named, and a sticker when it
 * has no text.
 */
export function messageFrom(
  account: Account,
  messageId: number,
  words: string | undefined,
  chat: {readonly id: number; readonly type: string} = {
    id: account.id,
    type: 'private',
  },
): TelegramUpdate {
  lastUpdateId += 1;

  return {
    update_id: lastUpdateId,
    message: {
      message_id: messageId,
      date: 0,
      chat,
      from: {...account, is_bot: false},
      ...(words === undefined
        ? {sticker: {file_id: 'sticker'}}
        : {text: words}),
    },
  };
}

/** A press of a button on one of a bot's messages in the account's chat. */
export function pressOn(
  account: Account,
  messageId: number,
  data: string,
): TelegramUpdate {
  lastUpdateId += 1;

  return {
    update_id: lastUpdateId,
    callback_query: {
      id: String(lastUpdateId),
      from: {...account, is_bot: false},
      message: {
        message_id: messageId,
        date: 0,
        chat: {id: account.id, type: 'private'},
      },
      chat_instance: String(account.id),
      data,
    },
  };
}

/**
 * Answers at once when updates wait past the offset; otherwise waits for
 * one, for `timeout` seconds. An offset confirms every update before it,
 * which Telegram then forgets.
 */
async function answerPoll(
  bot: Bot,
  fields: Readonly<Record<string, unknown>>,
  response: ServerResponse,
): Promise<void> {
  const offset = typeof fields['offset'] === 'number' ? fields['offset'] : 0;
  const timeoutSeconds =
    typeof fields['timeout'] === 'number' ? fields['timeout'] : 0;
  const pending = (): TelegramUpdate[] =>
    bot.updates.filter(update => update.update_id >= offset);

  bot.updates = pending();

  if (bot.updates.length === 0 && timeoutSeconds > 0) {
    await waitForUpdates(bot, timeoutSeconds, response);
  }

  envelope(response, 200, {ok: true, result: pending()});
}

/** Ends at the timeout, at an update, or once the poller hung up. */
function waitForUpdates(
  bot: Bot,
  timeoutSeconds: number,
  response: ServerResponse,
): Promise<void> {
  return new Promise(resolve => {
    const end = (): void => {
      clearTimeout(timer);
      response.off('close', end);

      if (bot.endWaitingPoll === end) {
        bot.endWaitingPoll = undefined;
      }

      resolve();
    };
    const timer = setTimeout(end, timeoutSeconds * 1_000);

    response.once('close', end);
    bot.endWaitingPoll = end;
  });
}

/** Records a sent or edited message; an edit that changes nothing is Telegram's 400. */
function answerMessage(
  bot: Bot,
  fields: Readonly<Record<string, unknown>>,
  messageId: unknown,
  response: ServerResponse,
): void {
  const chatId = fields['chat_id'];
  const key = `${String(chatId)}:${String(messageId)}`;
  const content = JSON.stringify([fields['text'], fields['reply_markup']]);

  if (bot.contents.get(key) === content) {
    refuse(response, 400, notModifiedDescription);

    return;
  }

  bot.contents.set(key, content);
  envelope(response, 200, {
    ok: true,
    result: {
      message_id: messageId,
      from: userOf(bot),
      chat: {id: chatId, type: 'private'},
      date: Math.floor(Date.now() / 1_000),
      text: fields['text'],
    },
  });
}

function userOf(bot: Bot): Readonly<Record<string, unknown>> {
  return {
    id: bot.id,
    is_bot: true,
    first_name: bot.username,
    username: bot.username,
  };
}

function refuse(
  response: ServerResponse,
  code: number,
  description: string,
): void {
  envelope(response, code, {ok: false, error_code: code, description});
}

/** An answer in Telegram's envelope, unless the poller hung up waiting for it. */
function envelope(response: ServerResponse, status: number, body: object) {
  if (response.socket?.destroyed === false) {
    response
      .writeHead(status, {'content-type': 'application/json'})
      .end(JSON.stringify(body));
  }
}

function objectOf(body: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(body);

    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function describeCall({token, method, body, at}: TelegramCall): string {
  const words = body['text'];

  return [
    at.toFixed(0),
    token,
    method,
    ...(body['chat_id'] === undefined ? [] : [JSON.stringify(body['chat_id'])]),
    ...(typeof words === 'string'
      ? [JSON.stringify(words.length > 80 ? `${words.slice(0, 80)}…` : words)]
      : []),
  ].join(' ');
}
