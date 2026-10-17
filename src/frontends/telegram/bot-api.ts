import {setTimeout as sleep} from 'node:timers/promises';

import {describeFetchFailure} from '../../shared/fetch-failure.ts';
import {isJsonRecord} from '../../shared/json-boundary.ts';

export type TelegramUser = {
  readonly id: number;
  readonly isBot: boolean;
  readonly firstName: string;
  readonly lastName?: string;
  readonly username?: string;
};

export type TelegramMessage = {
  readonly messageId: number;
  readonly chatId: number;
  /** `private`, `group`, `supergroup` or `channel`. */
  readonly chatType: string;
  readonly from?: TelegramUser;
  readonly text?: string;
};

export type TelegramCallbackQuery = {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: {readonly messageId: number; readonly chatId: number};
  readonly data?: string;
};

/**
 * An update of a kind this connector does not read, or cannot, carries
 * its id alone: the poll that follows must still ask past it.
 */
export type TelegramUpdate = {
  readonly updateId: number;
  readonly message?: TelegramMessage;
  readonly callbackQuery?: TelegramCallbackQuery;
};

export type InlineKeyboard = readonly (readonly {
  readonly text: string;
  readonly callbackData: string;
}[])[];

/**
 * Telegram's answer to a method, or why there is none: `code` is
 * Telegram's error code, or 0 when no answer in its envelope arrived.
 */
export type BotApiOutcome<T> =
  | {readonly ok: true; readonly result: T}
  | {
      readonly ok: false;
      readonly code: number;
      readonly description: string;
      /** How long Telegram asks to be left alone before the next call. */
      readonly retryAfterMs?: number;
    };

/**
 * The Bot API as the connector calls it: whatever Telegram or the network
 * does comes back as an outcome, never a throw. A request's `signal` ends
 * the call: a bot's go under its own, so none outlives it.
 */
export type BotApi = {
  getMe(signal?: AbortSignal): Promise<BotApiOutcome<TelegramUser>>;
  /** Waits up to `timeoutSeconds` for messages and callback queries. */
  getUpdates(request: {
    readonly offset: number;
    readonly timeoutSeconds: number;
    readonly signal: AbortSignal;
  }): Promise<BotApiOutcome<readonly TelegramUpdate[]>>;
  sendMessage(request: {
    readonly chatId: number;
    readonly text: string;
    readonly keyboard?: InlineKeyboard;
    readonly signal?: AbortSignal;
  }): Promise<BotApiOutcome<TelegramMessage>>;
  editMessageText(request: {
    readonly chatId: number;
    readonly messageId: number;
    readonly text: string;
    readonly keyboard?: InlineKeyboard;
    readonly signal?: AbortSignal;
  }): Promise<BotApiOutcome<TelegramMessage>>;
  deleteMessage(request: {
    readonly chatId: number;
    readonly messageId: number;
    readonly signal?: AbortSignal;
  }): Promise<BotApiOutcome<true>>;
  answerCallbackQuery(request: {
    readonly callbackQueryId: string;
    readonly text?: string;
    readonly signal?: AbortSignal;
  }): Promise<BotApiOutcome<true>>;
  /** Shows the bot as typing in the chat. */
  sendChatAction(request: {
    readonly chatId: number;
    readonly signal?: AbortSignal;
  }): Promise<BotApiOutcome<true>>;
  /** Removes the webhook set on the token; Telegram sends a bot's updates to a webhook or to its polls, never both. */
  deleteWebhook(signal?: AbortSignal): Promise<BotApiOutcome<true>>;
};

export function createBotApi(options: {
  readonly token: string;
  readonly fetch: typeof fetch;
  readonly baseUrl?: string;
}): BotApi {
  const {token, fetch: send, baseUrl = 'https://api.telegram.org'} = options;

  async function call<T>(
    method: string,
    body: Readonly<Record<string, unknown>>,
    decode: (result: unknown) => T | undefined,
    signal?: AbortSignal,
  ): Promise<BotApiOutcome<T>> {
    let answer: {readonly status: number; readonly text: string};

    try {
      const response = await send(`${baseUrl}/bot${token}/${method}`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : {signal}),
      });

      answer = {status: response.status, text: await response.text()};
    } catch (error: unknown) {
      // The token rides in the URL, and a platform's error may name it.
      const failure = describeFetchFailure(error).replaceAll(
        token,
        '[redacted]',
      );

      return unanswered(`Telegram could not be reached: ${failure}`);
    }

    return outcomeOf(method, answer, decode);
  }

  return {
    getMe: signal => call('getMe', {}, decodeUser, signal),
    getUpdates: ({offset, timeoutSeconds, signal}) =>
      call(
        'getUpdates',
        {
          offset,
          timeout: timeoutSeconds,
          allowed_updates: ['message', 'callback_query'],
        },
        decodeUpdates,
        // A poll Telegram never answers still ends.
        AbortSignal.any([
          signal,
          AbortSignal.timeout((timeoutSeconds + 10) * 1_000),
        ]),
      ),
    sendMessage: ({chatId, text, keyboard, signal}) =>
      call(
        'sendMessage',
        {chat_id: chatId, text, ...replyMarkup(keyboard)},
        decodeMessage,
        signal,
      ),
    editMessageText: ({chatId, messageId, text, keyboard, signal}) =>
      call(
        'editMessageText',
        {
          chat_id: chatId,
          message_id: messageId,
          text,
          ...replyMarkup(keyboard),
        },
        decodeMessage,
        signal,
      ),
    deleteMessage: ({chatId, messageId, signal}) =>
      call(
        'deleteMessage',
        {chat_id: chatId, message_id: messageId},
        decodeTrue,
        signal,
      ),
    answerCallbackQuery: ({callbackQueryId, text, signal}) =>
      call(
        'answerCallbackQuery',
        {
          callback_query_id: callbackQueryId,
          ...(text === undefined ? {} : {text}),
        },
        decodeTrue,
        signal,
      ),
    sendChatAction: ({chatId, signal}) =>
      call(
        'sendChatAction',
        {chat_id: chatId, action: 'typing'},
        decodeTrue,
        signal,
      ),
    deleteWebhook: signal => call('deleteWebhook', {}, decodeTrue, signal),
  };
}

/** Why polling is not getting through; reported as `undefined` once it is again. */
export type PollProblem = {
  readonly code: 'conflict' | 'webhook' | 'unreachable';
  readonly description: string;
};

export type PollPacing = {
  /** The wait after Telegram says another poller holds the token. */
  readonly conflictRetryMs?: number;
  /** The longest wait between attempts while Telegram cannot be reached. */
  readonly backoffMaxMs?: number;
};

const pollTimeoutSeconds = 50;

/**
 * Long-polls until the signal aborts, handing each update on in order and
 * asking past a batch only once all of it was handed on. Resolves
 * `unauthorized` when Telegram refuses the token and `stopped` on abort; a
 * webhook left on the token is removed, since Telegram sends updates to it
 * or to the polls, never both; anything else Telegram or the network does
 * is reported and waited out, never thrown. What `onUpdate` throws is the
 * caller's, and ends the loop.
 */
export async function pollUpdates(options: {
  readonly api: BotApi;
  readonly onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  readonly report: (problem: PollProblem | undefined) => void;
  readonly signal: AbortSignal;
  readonly pacing?: PollPacing;
}): Promise<'unauthorized' | 'stopped'> {
  const {api, onUpdate, report, signal} = options;
  const conflictRetryMs = options.pacing?.conflictRetryMs ?? 30_000;
  const aborted = (): boolean => signal.aborted;
  let offset = 0;
  let failures = 0;
  let reported: PollProblem['code'] | undefined;
  const reportChange = (problem: PollProblem | undefined): void => {
    if (problem?.code !== reported) {
      reported = problem?.code;
      report(problem);
    }
  };

  while (!aborted()) {
    const outcome = await api.getUpdates({
      offset,
      timeoutSeconds: pollTimeoutSeconds,
      signal,
    });

    if (aborted()) {
      break;
    }

    if (outcome.ok) {
      reportChange(undefined);
      failures = 0;

      for (const update of outcome.result) {
        if (
          update.message !== undefined ||
          update.callbackQuery !== undefined
        ) {
          await onUpdate(update);
        }
      }

      offset = Math.max(
        offset,
        ...outcome.result.map(update => update.updateId + 1),
      );
    } else if (tokenRefused(outcome.code)) {
      return 'unauthorized';
    } else if (outcome.code === 409 && /webhook/iu.test(outcome.description)) {
      reportChange({code: 'webhook', description: outcome.description});

      if (!(await api.deleteWebhook(signal)).ok) {
        await pause(conflictRetryMs, signal);
      }
    } else if (outcome.code === 409) {
      reportChange({code: 'conflict', description: outcome.description});
      await pause(conflictRetryMs, signal);
    } else if (outcome.retryAfterMs !== undefined) {
      await pause(outcome.retryAfterMs, signal);
    } else {
      reportChange({code: 'unreachable', description: outcome.description});
      await pause(backoffMs(failures, options.pacing?.backoffMaxMs), signal);
      failures += 1;
    }
  }

  return 'stopped';
}

/** Telegram answers a wrong token with 401, and one it cannot even parse with 404. */
export function tokenRefused(code: number): boolean {
  return code === 401 || code === 404;
}

/** Ends at once, and without a throw, when the signal aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return sleep(ms, undefined, {signal}).catch(() => undefined);
}

/**
 * The wait before trying again after `failures` failures in a row: a
 * second, doubled with each, and never longer than `maxMs`.
 */
export function backoffMs(failures: number, maxMs = 30_000): number {
  return Math.min(1_000 * 2 ** failures, maxMs);
}

function unanswered(description: string): BotApiOutcome<never> {
  return {ok: false, code: 0, description};
}

function outcomeOf<T>(
  method: string,
  answer: {readonly status: number; readonly text: string},
  decode: (result: unknown) => T | undefined,
): BotApiOutcome<T> {
  const envelope = parsedJson(answer.text);
  const notEnvelope = `Telegram answered ${String(answer.status)} with something other than its JSON envelope.`;

  if (!isJsonRecord(envelope)) {
    return unanswered(notEnvelope);
  }

  const {ok, result, error_code: code, description, parameters} = envelope;

  if (ok === true) {
    const decoded = decode(result);

    return decoded === undefined
      ? unanswered(
          `Telegram's answer to ${method} is not the shape it documents.`,
        )
      : {ok: true, result: decoded};
  }

  if (typeof code !== 'number' || typeof description !== 'string') {
    return unanswered(notEnvelope);
  }

  const retryAfter = isJsonRecord(parameters)
    ? parameters['retry_after']
    : undefined;

  return {
    ok: false,
    code,
    description,
    ...(typeof retryAfter === 'number'
      ? {retryAfterMs: retryAfter * 1_000}
      : {}),
  };
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function replyMarkup(
  keyboard: InlineKeyboard | undefined,
): Readonly<Record<string, unknown>> {
  return keyboard === undefined
    ? {}
    : {
        reply_markup: {
          inline_keyboard: keyboard.map(row =>
            row.map(button => ({
              text: button.text,
              callback_data: button.callbackData,
            })),
          ),
        },
      };
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function decodeTrue(result: unknown): true | undefined {
  return result === true ? true : undefined;
}

function decodeUpdates(result: unknown): readonly TelegramUpdate[] | undefined {
  return Array.isArray(result)
    ? result.flatMap(item => decodeUpdate(item) ?? [])
    : undefined;
}

function decodeUpdate(value: unknown): TelegramUpdate | undefined {
  if (!isJsonRecord(value) || !isInteger(value['update_id'])) {
    return undefined;
  }

  const message = decodeMessage(value['message']);
  const callbackQuery = decodeCallbackQuery(value['callback_query']);

  return {
    updateId: value['update_id'],
    ...(message === undefined ? {} : {message}),
    ...(callbackQuery === undefined ? {} : {callbackQuery}),
  };
}

function decodeMessage(value: unknown): TelegramMessage | undefined {
  if (!isJsonRecord(value) || !isJsonRecord(value['chat'])) {
    return undefined;
  }

  const {message_id: messageId, text} = value;
  const {id: chatId, type: chatType} = value['chat'];
  const from = decodeUser(value['from']);

  if (
    !isInteger(messageId) ||
    !isInteger(chatId) ||
    typeof chatType !== 'string'
  ) {
    return undefined;
  }

  return {
    messageId,
    chatId,
    chatType,
    ...(from === undefined ? {} : {from}),
    ...(typeof text === 'string' ? {text} : {}),
  };
}

function decodeCallbackQuery(
  value: unknown,
): TelegramCallbackQuery | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const {id, data} = value;
  const from = decodeUser(value['from']);
  const message = decodeMessage(value['message']);

  if (typeof id !== 'string' || from === undefined) {
    return undefined;
  }

  return {
    id,
    from,
    ...(message === undefined
      ? {}
      : {message: {messageId: message.messageId, chatId: message.chatId}}),
    ...(typeof data === 'string' ? {data} : {}),
  };
}

function decodeUser(value: unknown): TelegramUser | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const {
    id,
    is_bot: isBot,
    first_name: firstName,
    last_name: lastName,
    username,
  } = value;

  if (
    !isInteger(id) ||
    typeof isBot !== 'boolean' ||
    typeof firstName !== 'string'
  ) {
    return undefined;
  }

  return {
    id,
    isBot,
    firstName,
    ...(typeof lastName === 'string' ? {lastName} : {}),
    ...(typeof username === 'string' ? {username} : {}),
  };
}
