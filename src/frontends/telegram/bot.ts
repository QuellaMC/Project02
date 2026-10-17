import type {GatewayEvent, GatewayReady} from '../../gateway/api/index.ts';
import {
  GatewayClientError,
  type GatewayClient,
} from '../../gateway/client/index.ts';
import {
  backoffMs,
  pause,
  pollUpdates,
  tokenRefused,
  type BotApi,
  type PollPacing,
  type PollProblem,
  type TelegramUpdate,
  type TelegramUser,
} from './bot-api.ts';

/** This connector's id on the daemon's wire. */
export const connectorId = 'telegram';

/**
 * What a bot runs on, as its entry in the connector config has it: whose
 * bot it is, and the accounts the home lets in.
 */
export type BotSettings = (
  | {
      readonly kind: 'management';
      /** Each character's name as health has it, by her id. */
      readonly names: ReadonlyMap<string, string>;
    }
  | {
      readonly kind: 'character';
      readonly characterId: string;
      /** Her name as health has it. */
      readonly name: string;
      readonly mirror: boolean;
    }
) & {
  readonly pairedUsers: Readonly<Record<string, unknown>>;
};

/** What a bot's rules run on: the daemon and the settings are read as they are at each use. */
export type BotContext = {
  readonly api: BotApi;
  /** As Telegram numbers the bot: stable where a username is not. */
  readonly id: number;
  /** As Telegram named the bot. */
  readonly username: string;
  readonly client: () => GatewayClient;
  readonly settings: () => BotSettings;
  readonly report: (line: string) => void;
  /** Aborts once the bot is stopped. */
  readonly signal: AbortSignal;
  /** Settles once the settings are read after a loss or a ready, or the bot stops: what a write to a paired account waits for. */
  readonly settled: () => Promise<void>;
};

/** What a bot does with a message, and with the daemon's frames and snapshots. */
export type BotRules = {
  readonly onUpdate: (update: TelegramUpdate) => Promise<void>;
  readonly dispatch: (event: GatewayEvent) => void;
  readonly snapshot: (ready: GatewayReady) => void;
};

export type Bot = {
  readonly settings: BotSettings;
  /** Takes the settings a later read gave, and the client that read came by. */
  update(settings: BotSettings, client: GatewayClient): void;
  dispatch(event: GatewayEvent): void;
  snapshot(ready: GatewayReady): void;
  /** Ends the bot's poll, and settles once it has ended. */
  stop(): Promise<void>;
};

/** Until Telegram has said who the bot is, whatever it gets, it does nothing with. */
const noRules: BotRules = {
  onUpdate: () => Promise.resolve(),
  dispatch: () => undefined,
  snapshot: () => undefined,
};

/**
 * One token's bot: asks Telegram who it is, says so, and polls until it is
 * stopped or Telegram refuses the token, handing what it gets to its
 * rules; a token refused ends the bot's writes with its poll. Trouble is
 * reported once per change, naming the bot, while the bot keeps trying.
 */
export function startBot(options: {
  readonly api: BotApi;
  readonly client: GatewayClient;
  readonly settings: BotSettings;
  readonly say: (line: string) => void;
  readonly report: (line: string) => void;
  readonly pacing?: PollPacing;
  /** What the bot does with what it gets, once Telegram has said who it is. */
  readonly rules: (bot: BotContext) => BotRules;
  /** The stream's snapshot as its frames have moved it on, installed as the rules start, so a bot started late knows what runs and waits. */
  readonly snapshot: () => GatewayReady | undefined;
  /** Settles once the settings a ready is shown by have been read; an update waits for it, so none is judged by settings that may have changed while the stream was away. */
  readonly settled: () => Promise<void>;
}): Bot {
  const {api, say, report, pacing} = options;
  const stopping = new AbortController();
  const {signal} = stopping;
  const stopped = (): boolean => signal.aborted;
  /** Settles when the bot stops: what a wait for the settings is raced with, so a stop never hangs on them. */
  const halted = new Promise<void>(resolve => {
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      {once: true},
    );
  });
  let settings = options.settings;
  let client = options.client;
  let username: string | undefined;
  let rules = noRules;
  /**
   * Whether the token's polls are this bot's: they are from the poll it
   * sends, since Telegram hands the token to the newest poller, until a
   * 409 says another took them. Only an owner writes, so two connectors
   * on one token do not both answer; one that polls again after a 409
   * catches up from the snapshot.
   */
  let owning = false;
  const installLatest = async (): Promise<void> => {
    // A snapshot is installed by the settings it is shown by, read first.
    await Promise.race([options.settled(), halted]);

    if (stopped()) {
      return;
    }

    const latest = options.snapshot();

    if (latest !== undefined) {
      rules.snapshot(latest);
    }
  };
  const refused = (): string => {
    const {bot, page} = botNames(settings);

    return `Telegram refused ${bot} token. Replace it on ${page}.`;
  };
  const identify = async (): Promise<TelegramUser | undefined> => {
    for (let failures = 0; !stopped(); failures += 1) {
      const me = await api.getMe(signal);

      if (stopped()) {
        break;
      }

      if (me.ok) {
        return me.result;
      }

      if (tokenRefused(me.code)) {
        report(refused());

        break;
      }

      if (failures === 0) {
        report(
          `Telegram cannot be reached for ${botNames(settings).bot}: ${me.description}`,
        );
      }

      await pause(
        me.retryAfterMs ?? backoffMs(failures, pacing?.backoffMaxMs),
        signal,
      );
    }

    return undefined;
  };
  const run = async (): Promise<void> => {
    const me = await identify();

    if (me === undefined) {
      return;
    }

    username = me.username ?? String(me.id);
    say(
      settings.kind === 'management'
        ? `Telegram: management bot @${username} is on.`
        : `Telegram: @${username} answers for ${settings.name}.`,
    );
    rules = options.rules({
      api,
      id: me.id,
      username,
      client: () => client,
      settings: () => settings,
      report,
      signal,
      settled: () => Promise.race([options.settled(), halted]),
    });

    const ended = await pollUpdates({
      api,
      onPoll: async () => {
        if (!owning) {
          owning = true;
          await installLatest();
        }
      },
      onUpdate: async update => {
        await Promise.race([options.settled(), halted]);

        if (!stopped()) {
          await rules.onUpdate(update);
        }
      },
      report: problem => {
        if (problem?.code === 'conflict') {
          owning = false;
        }

        report(problemSentence(problem, botNames(settings).bot));
      },
      signal,
      ...(pacing === undefined ? {} : {pacing}),
    });

    if (ended === 'unauthorized') {
      report(refused());
      stopping.abort();
    }
  };
  const running = run();

  return {
    get settings() {
      return settings;
    },
    update(nextSettings, nextClient) {
      settings = nextSettings;
      client = nextClient;
    },
    dispatch(event) {
      if (owning) {
        rules.dispatch(event);
      }
    },
    snapshot(ready) {
      if (owning) {
        rules.snapshot(ready);
      }
    },
    async stop() {
      stopping.abort();
      await running;

      if (username !== undefined) {
        say(`Telegram: stopped @${username} (${botNames(settings).owner}).`);
      }
    },
  };
}

/**
 * What a deadline has left, in whole minutes and at least one, as a chat
 * says it: a clock time would be this machine's, and the reader may be
 * elsewhere.
 */
export function minutesLeft(deadlineAt: number): string {
  const minutes = Math.max(1, Math.ceil((deadlineAt - Date.now()) / 60_000));

  return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** Said in a chat when what it asked could not reach the daemon. */
export const daemonDown =
  'The daemon is not running right now; send that again in a moment.';

/** The client's own error is a daemon out of reach or answering with an error; anything else is a bug. */
export function rethrowUnlessTransport(error: unknown): void {
  if (!(error instanceof GatewayClientError)) {
    throw error;
  }
}

/** How the terminal names a bot: whose it is, the bot, and where its token is replaced. */
export function botNames(settings: BotSettings): {
  readonly owner: string;
  readonly bot: string;
  readonly page: string;
} {
  return settings.kind === 'management'
    ? {
        owner: 'the management bot',
        bot: 'the management bot',
        page: "the home's settings page",
      }
    : {
        owner: settings.name,
        bot: `${settings.name}'s bot`,
        page: `${settings.name}'s settings page`,
      };
}

/** One sentence ends every problem: after a 409 as after an outage, the bot gets its messages again. */
function problemSentence(
  problem: PollProblem | undefined,
  bot: string,
): string {
  switch (problem?.code) {
    case undefined:
      return `Telegram: ${bot} gets its messages again.`;
    case 'conflict':
      return `Another program is polling ${bot} (409); this one waits.`;
    case 'webhook':
      return (
        `Telegram was sending the messages for ${bot} to a webhook, another ` +
        "program's; this connector removed it to poll. If that program " +
        'should have them, give this connector a token of its own.'
      );
    case 'unreachable':
      return `Telegram cannot be reached for ${bot}: ${problem.description}`;
  }
}
