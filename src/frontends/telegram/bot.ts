import {
  backoffMs,
  pause,
  pollUpdates,
  tokenRefused,
  type BotApi,
  type PollPacing,
  type PollProblem,
  type TelegramUser,
} from './bot-api.ts';

/**
 * What a bot runs on, as its entry in the connector config has it: whose
 * bot it is, and the accounts the home lets in.
 */
export type BotSettings = (
  | {readonly kind: 'management'}
  | {
      readonly kind: 'character';
      readonly characterId: string;
      /** Her name as health has it, for what the terminal says. */
      readonly name: string;
      readonly mirror: boolean;
    }
) & {
  readonly pairedUsers: Readonly<Record<string, unknown>>;
};

export type Bot = {
  readonly settings: BotSettings;
  update(settings: BotSettings): void;
  /** Ends the bot's poll, and settles once it has ended. */
  stop(): Promise<void>;
};

/**
 * One token's bot: asks Telegram who it is, says so, and polls until it is
 * stopped or Telegram refuses the token. Trouble is reported once per
 * change, naming the bot, while the bot keeps trying.
 */
export function startBot(options: {
  readonly api: BotApi;
  readonly settings: BotSettings;
  readonly say: (line: string) => void;
  readonly report: (line: string) => void;
  readonly pacing?: PollPacing;
}): Bot {
  const {api, say, report, pacing} = options;
  const stopping = new AbortController();
  const {signal} = stopping;
  const stopped = (): boolean => signal.aborted;
  let settings = options.settings;
  let username: string | undefined;
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

      await pause(backoffMs(failures, pacing?.backoffMaxMs), signal);
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

    const ended = await pollUpdates({
      api,
      onUpdate: () => undefined,
      report: problem => {
        report(problemSentence(problem, botNames(settings).bot));
      },
      signal,
      ...(pacing === undefined ? {} : {pacing}),
    });

    if (ended === 'unauthorized') {
      report(refused());
    }
  };
  const running = run();

  return {
    get settings() {
      return settings;
    },
    update(next) {
      settings = next;
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

/** One sentence ends either problem: after a 409 as after an outage, the bot gets its messages again. */
function problemSentence(
  problem: PollProblem | undefined,
  bot: string,
): string {
  if (problem === undefined) {
    return `Telegram: ${bot} gets its messages again.`;
  }

  return problem.code === 'conflict'
    ? `Another program is polling ${bot} (409); this one waits.`
    : `Telegram cannot be reached for ${bot}: ${problem.description}`;
}
