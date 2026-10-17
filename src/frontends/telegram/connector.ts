import {join} from 'node:path';

import {
  type ConnectorConfigEntry,
  type ConnectorConfigView,
  foldRunningTurns,
  type GatewayEvent,
  type GatewayHealth,
  gatewayProtocolVersion,
  type GatewayReady,
} from '../../gateway/api/index.ts';
import {
  createGatewayClient,
  GatewayClientError,
  type GatewayClient,
} from '../../gateway/client/index.ts';
import {
  daemonRecordFileName,
  readDaemonRecord,
  type DaemonRecord,
} from '../../shared/daemon-record.ts';
import {isJsonRecord} from '../../shared/json-boundary.ts';
import {backoffMs, createBotApi, pause, type PollPacing} from './bot-api.ts';
import {
  botNames,
  connectorId,
  startBot,
  type Bot,
  type BotSettings,
} from './bot.ts';
import {characterChat} from './character-bot.ts';
import {managementChat} from './management-bot.ts';

/** The waits a test shortens. */
export type ConnectorPacing = {
  /** Between reads of a daemon record that is absent or unreadable, or whose token was refused. */
  readonly recordRetryMs?: number;
  /** The longest wait before a failed read of the connector config is tried again. */
  readonly readBackoffMaxMs?: number;
  readonly poll?: PollPacing;
};

export type TelegramConnectorOptions = {
  readonly homeRoot: string;
  /**
   * How the daemon is reached: a fetch that waits as long as the daemon
   * does. Telegram is reached by the platform's own.
   */
  readonly fetch: typeof fetch;
  /** Telegram's own Bot API unless another is named. */
  readonly telegramBaseUrl?: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly signal: AbortSignal;
  readonly pacing?: ConnectorPacing;
};

type WriteLine = (line: string) => void;

/**
 * Says a line unless it is the one said last, so a state that lasts is
 * said once; `undefined` says nothing and forgets the last.
 */
type Notice = (write: WriteLine, line: string | undefined) => void;

type Connector = {
  readonly options: TelegramConnectorOptions;
  readonly bots: BotTable;
  readonly say: WriteLine;
  readonly report: WriteLine;
  /** What is said of the daemon: waiting for it, connected, refused. */
  readonly notice: Notice;
};

/**
 * The Telegram connector's process: finds the daemon by the home's record,
 * follows its stream as the `telegram` connector, keeps its read of the
 * connector config current by the wire page's rule, and runs a bot for
 * each token that config holds. Resolves once the signal has stopped it
 * and every bot, with the exit code: 0, or 1 when the daemon speaks
 * another protocol.
 */
export async function runTelegramConnector(
  options: TelegramConnectorOptions,
): Promise<number> {
  const {homeRoot, signal} = options;
  const recordRetryMs = options.pacing?.recordRetryMs ?? 2_000;
  const say = linesTo(options.stdout);
  const report = linesTo(options.stderr);
  const bots = createBotTable({options, say, report});
  const connector: Connector = {
    options,
    bots,
    say,
    report,
    notice: createNotice(),
  };

  try {
    while (!signal.aborted) {
      const reading = readDaemonRecord({homeRoot});

      if (reading.status === 'ok') {
        const ending = await followDaemon(reading.record, connector);

        if (ending === 'protocol_mismatch') {
          return 1;
        }

        if (ending === 'moved') {
          continue;
        }
      } else if (reading.status === 'absent') {
        connector.notice(say, waitingLine(homeRoot));
      } else {
        connector.notice(report, reading.message);
      }

      await pause(recordRetryMs, signal);
    }

    return 0;
  } finally {
    await bots.stopAll();
  }
}

/**
 * Follows the daemon the record names until the signal stops the
 * connector, the record names another address, or the daemon refuses
 * this connector. A daemon that is down or stopping is waited for.
 */
async function followDaemon(
  record: DaemonRecord,
  connector: Connector,
): Promise<'stopped' | 'moved' | 'refused' | 'protocol_mismatch'> {
  const {options, bots, say, report, notice} = connector;
  const baseUrl = `http://127.0.0.1:${String(record.port)}`;
  const own = new AbortController();
  const signal = AbortSignal.any([options.signal, own.signal]);
  const client = createGatewayClient({
    baseUrl,
    token: record.token,
    fetch: underSignal(options.fetch, signal),
  });
  const connected = (): void => {
    notice(say, `Telegram connector: connected to ${baseUrl}.`);
  };
  let health: GatewayHealth | undefined;
  const read = createConfigReads({
    client,
    signal,
    backoffMaxMs: options.pacing?.readBackoffMaxMs,
    report,
    apply: view => {
      bots.apply(view, health, client);
    },
  });

  try {
    await client.events(
      event => {
        bots.dispatch(event);

        if (event.kind === 'health_changed') {
          health = event.health;
          read();
        }
      },
      {
        signal,
        connector: connectorId,
        onReady: ({snapshot}) => {
          connected();
          health = snapshot.health;
          bots.snapshot(snapshot);
          read();
        },
        onResumed: connected,
        onLost: () => {
          if (recordMoved(options.homeRoot, record)) {
            own.abort();
          } else {
            notice(say, waitingLine(options.homeRoot));
          }
        },
      },
    );
  } catch (error: unknown) {
    const code = error instanceof GatewayClientError ? error.code : undefined;

    if (code === 'unauthorized') {
      notice(
        report,
        `Telegram connector: the daemon at ${baseUrl} refused the token in ${join(options.homeRoot, daemonRecordFileName)}; trying again.`,
      );

      return 'refused';
    }

    if (code === 'protocol_mismatch') {
      report(
        `This connector speaks protocol ${String(gatewayProtocolVersion)}; the daemon speaks ${String(record.protocolVersion)}. Update one of them.`,
      );

      return 'protocol_mismatch';
    }

    throw error;
  } finally {
    own.abort();
  }

  return options.signal.aborted ? 'stopped' : 'moved';
}

/** The transport with every request under the signal as well: none outlives the connection it was made on. */
function underSignal(
  transport: typeof fetch,
  signal: AbortSignal,
): typeof fetch {
  return (input, init) =>
    transport(input, {
      ...init,
      signal: AbortSignal.any([
        signal,
        ...(init?.signal === undefined || init.signal === null
          ? []
          : [init.signal]),
      ]),
    });
}

function waitingLine(homeRoot: string): string {
  return `Telegram connector: waiting for the daemon on ${homeRoot}; run pnpm serve.`;
}

/** Whether the home's record now names another address or token than the one followed. */
function recordMoved(homeRoot: string, followed: DaemonRecord): boolean {
  const reading = readDaemonRecord({homeRoot});

  return (
    reading.status === 'ok' &&
    (reading.record.port !== followed.port ||
      reading.record.token !== followed.token)
  );
}

/**
 * The wire page's reading rule: each call starts a read with a ticket of
 * its own, only the newest ticket's answer is applied, and a read that
 * fails is tried again with a backoff until it is answered or a newer
 * read starts.
 */
function createConfigReads(options: {
  readonly client: GatewayClient;
  readonly signal: AbortSignal;
  readonly backoffMaxMs: number | undefined;
  readonly report: WriteLine;
  readonly apply: (view: ConnectorConfigView) => void;
}): () => void {
  const {client, signal, report, apply} = options;
  let newest = 0;
  const current = (ticket: number): boolean =>
    ticket === newest && !signal.aborted;
  const readUntilAnswered = async (ticket: number): Promise<void> => {
    for (let failures = 0; current(ticket); failures += 1) {
      const answer = await client.connectorConfig(connectorId, {signal}).then(
        view => ({view}),
        (error: unknown) => ({error}),
      );

      if (!current(ticket)) {
        return;
      }

      if ('view' in answer) {
        apply(answer.view);

        return;
      }

      if (failures === 0) {
        report(
          `Telegram connector: the daemon's Telegram settings could not be read (${
            answer.error instanceof Error
              ? answer.error.message
              : String(answer.error)
          }); trying again.`,
        );
      }

      await pause(backoffMs(failures, options.backoffMaxMs), signal);
    }
  };

  return () => {
    newest += 1;
    void readUntilAnswered(newest);
  };
}

type BotTable = {
  /**
   * Makes the running bots the ones the config's answer asks for, each
   * reaching the daemon by the client the answer came by.
   */
  apply(
    view: ConnectorConfigView,
    health: GatewayHealth | undefined,
    client: GatewayClient,
  ): void;
  /** Hands each running bot a frame of the daemon's stream, once the snapshot before it has been handed on. */
  dispatch(event: GatewayEvent): void;
  /**
   * Keeps the daemon's snapshot from a stream it did not resume, moved on
   * by every frame since, for each bot started after; and hands it to the
   * running bots once the settings read that follows a ready has been
   * applied, the frames meanwhile folded into it and not handed on, and
   * the bots' updates waiting, so nothing is shown or judged by settings
   * that may have changed while the stream was away.
   */
  snapshot(ready: GatewayReady): void;
  /** Stops every bot, and settles once each has stopped. */
  stopAll(): Promise<void>;
};

/** The bots running, one per token, kept from one connection to the next. */
function createBotTable(context: {
  readonly options: TelegramConnectorOptions;
  readonly say: WriteLine;
  readonly report: WriteLine;
}): BotTable {
  const {options, say, report} = context;
  const running = new Map<string, Bot>();
  const stopping = new Set<Promise<void>>();
  const notice = createNotice();
  let latest: GatewayReady | undefined;
  /** A snapshot not handed on yet: the settings it is shown by are being read; the bots' updates wait for them too. */
  let unread = false;
  let settle = (): void => undefined;
  let settled: Promise<void> = Promise.resolve();
  const stop = (token: string, bot: Bot): void => {
    const stopped = bot.stop().finally(() => {
      stopping.delete(stopped);
    });

    running.delete(token);
    stopping.add(stopped);
  };
  const start = (
    token: string,
    settings: BotSettings,
    client: GatewayClient,
  ): void => {
    running.set(
      token,
      startBot({
        api: createBotApi({
          token,
          fetch: globalThis.fetch,
          ...(options.telegramBaseUrl === undefined
            ? {}
            : {baseUrl: options.telegramBaseUrl}),
        }),
        client,
        settings,
        say,
        report,
        ...(options.pacing?.poll === undefined
          ? {}
          : {pacing: options.pacing.poll}),
        rules:
          settings.kind === 'character'
            ? characterChat(settings.characterId)
            : managementChat(),
        snapshot: () => latest,
        settled: () => settled,
      }),
    );
  };

  return {
    apply(view, health, client) {
      const {wanted, shared} =
        view.status === 'ok'
          ? wantedBots(view, health)
          : {wanted: new Map<string, BotSettings>(), shared: []};

      for (const line of shared) {
        report(line);
      }

      for (const [token, bot] of running) {
        if (!wanted.has(token)) {
          stop(token, bot);
        }
      }

      for (const [token, settings] of wanted) {
        const bot = running.get(token);

        if (bot !== undefined && sameOwner(bot.settings, settings)) {
          bot.update(settings, client);
        } else {
          if (bot !== undefined) {
            stop(token, bot);
          }

          start(token, settings, client);
        }
      }

      if (view.status === 'refused') {
        notice(report, view.message);
      } else {
        notice(
          say,
          wanted.size === 0
            ? 'Telegram is off, or no token is set; waiting for a change.'
            : undefined,
        );
      }

      if (unread && latest !== undefined) {
        unread = false;
        settle();

        for (const bot of running.values()) {
          bot.snapshot(latest);
        }
      }
    },
    dispatch(event) {
      if (latest !== undefined) {
        latest = movedOn(latest, event);
      }

      if (!unread) {
        for (const bot of running.values()) {
          bot.dispatch(event);
        }
      }
    },
    snapshot(ready) {
      latest = ready;

      if (!unread) {
        unread = true;
        settled = new Promise(resolve => {
          settle = resolve;
        });
      }
    },
    async stopAll() {
      for (const [token, bot] of running) {
        stop(token, bot);
      }

      await Promise.all(stopping);
    },
  };
}

/**
 * The snapshot moved on by a frame: what the daemon would say in a `ready`
 * now, for a bot that starts now. The turns are folded by the contract's
 * one rule; what waits is added as it is raised, announced again or not,
 * and dropped as it is settled; health is as last said.
 */
function movedOn(ready: GatewayReady, event: GatewayEvent): GatewayReady {
  switch (event.kind) {
    case 'turn_progress':
    case 'turn_completed':
      return {
        ...ready,
        turns: [
          ...foldRunningTurns(
            new Map(ready.turns.map(turn => [turn.conversationId, turn])),
            event,
          ).values(),
        ],
      };
    case 'confirmation_requested':
      return {
        ...ready,
        confirmations: [
          ...ready.confirmations.filter(pending => pending.id !== event.id),
          event,
        ],
      };
    case 'confirmation_settled':
      return {
        ...ready,
        confirmations: ready.confirmations.filter(
          pending => pending.id !== event.id,
        ),
      };
    case 'pairing_requested':
      return {
        ...ready,
        pairings: [
          ...ready.pairings.filter(request => request.code !== event.code),
          event,
        ],
      };
    case 'pairing_settled':
      return {
        ...ready,
        pairings: ready.pairings.filter(request => request.code !== event.code),
      };
    case 'health_changed':
      return {...ready, health: event.health};
    default:
      return ready;
  }
}

/** A bot is one owner's: a token that moves to another starts a bot of its own. */
function sameOwner(running: BotSettings, wanted: BotSettings): boolean {
  return running.kind === 'management'
    ? wanted.kind === 'management'
    : wanted.kind === 'character' && wanted.characterId === running.characterId;
}

/**
 * The bots the config asks for, by the daemon's own judgment of each
 * entry: the management bot while the home's entry is active and holds
 * its token, then each character's whose entry is active and holds hers.
 * A token an earlier bot has is not started again, and that is said.
 */
function wantedBots(
  view: Extract<ConnectorConfigView, {readonly status: 'ok'}>,
  health: GatewayHealth | undefined,
): {
  readonly wanted: ReadonlyMap<string, BotSettings>;
  readonly shared: readonly string[];
} {
  const names = new Map(
    health?.characters.map((character): [string, string] => [
      character.id,
      character.displayName,
    ]),
  );
  const entries: readonly {
    readonly token: string | undefined;
    readonly settings: BotSettings;
  }[] = [
    {
      token: tokenOf(view.home, 'managementBotToken'),
      settings: {
        kind: 'management',
        names,
        pairedUsers: pairedUsersOf(view.home),
      },
    },
    ...view.characters.map(entry => ({
      token: tokenOf(entry, 'botToken'),
      settings: {
        kind: 'character' as const,
        characterId: entry.characterId,
        name: names.get(entry.characterId) ?? entry.characterId,
        mirror: entry.values['mirror'] === true,
        pairedUsers: pairedUsersOf(entry),
      },
    })),
  ];
  const wanted = new Map<string, BotSettings>();
  const shared: string[] = [];

  for (const {token, settings} of entries) {
    const first = token === undefined ? undefined : wanted.get(token);

    if (first !== undefined) {
      const {owner} = botNames(settings);

      shared.push(
        `${owner}'s bot token is also ${botNames(first).owner}'s; ${owner}'s bot is not started.`,
      );
    } else if (token !== undefined) {
      wanted.set(token, settings);
    }
  }

  return {wanted, shared};
}

function tokenOf(
  entry: ConnectorConfigEntry,
  field: string,
): string | undefined {
  const token = entry.values[field];

  return entry.activation.status === 'active' && typeof token === 'string'
    ? token
    : undefined;
}

function pairedUsersOf(
  entry: ConnectorConfigEntry,
): Readonly<Record<string, unknown>> {
  const paired = entry.values['pairedUsers'];

  return isJsonRecord(paired) ? paired : {};
}

function createNotice(): Notice {
  let last: string | undefined;

  return (write, line) => {
    if (line !== undefined && line !== last) {
      write(line);
    }

    last = line;
  };
}

function linesTo(stream: NodeJS.WritableStream): WriteLine {
  return line => {
    stream.write(`${line}\n`);
  };
}
