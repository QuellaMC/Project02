/**
 * The disposable dev chat: a terminal over the daemon's socket, and nothing
 * more. It reads a line, delivers it, prints what the stream carries, and
 * answers its own turns' confirmations; the web UI replaces it at parity
 * and deletes it.
 */
import {randomUUID} from 'node:crypto';

import {
  createGatewayClient,
  GatewayClientError,
  gatewayUrlEnvVarName,
  type GatewayClient,
} from '../../gateway/client/index.ts';
import {
  selectProject02CharacterId,
  type GatewayHealth,
  type GatewayMessage,
  type PendingConfirmation,
  type TurnOutcome,
} from '../../gateway/index.ts';
import {runtimeConfigDiagnosticAttribution} from '../../runtime/config/index.ts';
import {readFlagValue} from '../shared/flags.ts';
import {isMainModule} from '../shared/main-module.ts';
import {CliUsageError} from '../shared/usage-error.ts';
import {createLineDispatcher} from './lines.ts';
import {createConfirmationPrompts} from './prompts.ts';
import {createTranscript, type Transcript} from './transcript.ts';

export type ChatCliOptions = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
};

export async function runChatCliFromArgs(
  args: readonly string[],
  options: ChatCliOptions,
): Promise<number> {
  try {
    const explicitCharacterId = parseChatCliFlags(args);
    const url = (options.env ?? process.env)[gatewayUrlEnvVarName];

    if (url === undefined || url.trim().length === 0) {
      throw new CliUsageError(
        `${gatewayUrlEnvVarName} is not set. Run \`pnpm serve\` and export the ${gatewayUrlEnvVarName}=... line it prints.`,
      );
    }

    const client = createGatewayClient({url});
    const health = await client.health();
    const configError = health.config.diagnostics.find(
      diagnostic => diagnostic.severity === 'error',
    );

    if (configError !== undefined) {
      options.stderr.write(
        `Warning: ${runtimeConfigDiagnosticAttribution(configError)}${configError.message}\n`,
      );
    }

    const selection = selectProject02CharacterId(
      health.characters,
      explicitCharacterId,
    );

    if (selection.status === 'failed') {
      throw new CliUsageError(`${selection.message} (pass --character <id>)`);
    }

    await ensureStarted(client, health, selection.characterId);

    return await runChat(client, selection.characterId, options);
  } catch (error: unknown) {
    options.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    return 1;
  }
}

function parseChatCliFlags(args: readonly string[]): string | undefined {
  let characterId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';

    if (arg === '--character') {
      if (characterId !== undefined) {
        throw new CliUsageError('--character can only be provided once.');
      }

      characterId = readFlagValue(args, index, '--character');
      index += 1;
      continue;
    }

    throw new CliUsageError(`Unknown chat option: ${arg}.`);
  }

  return characterId;
}

/** The daemon boots the roster; this is the operator's retry for the rest. */
async function ensureStarted(
  client: GatewayClient,
  health: GatewayHealth,
  characterId: string,
): Promise<void> {
  const summary = health.characters.find(
    character => character.id === characterId,
  );

  if (summary?.state === 'ready') {
    return;
  }

  const started = await client.startCharacter(characterId);

  if (started.status === 'refused') {
    throw new CliUsageError(started.message);
  }

  if (started.character.state !== 'ready') {
    throw new CliUsageError(
      started.character.diagnostic ?? `${characterId} did not start.`,
    );
  }
}

async function runChat(
  client: GatewayClient,
  characterId: string,
  options: ChatCliOptions,
): Promise<number> {
  const opened = await client.openDirectConversation(characterId);

  if (opened.status !== 'opened') {
    throw new CliUsageError(opened.message);
  }

  // Per invocation, not per process id: a reused pid would make a new
  // terminal take an earlier one's lines for its own and hide them.
  const source = `chat-shim:${randomUUID()}`;
  const streaming = new AbortController();
  const lines = createLineDispatcher(options.stdin);
  const transcript = createTranscript({
    client,
    conversationId: opened.conversationId,
    source,
    stdout: options.stdout,
    signal: streaming.signal,
  });
  const prompts = createConfirmationPrompts({
    client,
    lines,
    stdout: options.stdout,
    stderr: options.stderr,
    signal: streaming.signal,
  });
  const warn = (message: string): void => {
    options.stderr.write(`Warning: ${message}\n`);
  };
  const reportError = (error: unknown): void => {
    options.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  };
  // A maintenance failure is known by its time, so a handshake's health
  // does not repeat one the stream already carried.
  let reportedMaintenanceAt: string | undefined;
  const reportMaintenance = (failure: {at: string; message: string}): void => {
    if (reportedMaintenanceAt !== failure.at) {
      reportedMaintenanceAt = failure.at;
      warn(failure.message);
    }
  };
  // This terminal answers for its own turns; the surface that sent a turn
  // answers for it.
  const own = (pending: PendingConfirmation): boolean =>
    pending.turn?.source === source;
  let streamFailure: unknown;
  // Nothing is read until the first handshake is through: a line typed —
  // or piped — before the stream listens would run a turn whose messages
  // the stream never carries.
  let firstHandshake: (() => void) | undefined;
  const streamListening = new Promise<void>(resolve => {
    firstHandshake = resolve;
  });
  const streamEnded = client
    .events(
      event => {
        if (event.kind === 'turn_progress') {
          if (event.conversationId === opened.conversationId) {
            transcript.showProgress(event.progress);
          }
        } else if (event.kind === 'turn_completed') {
          // This terminal's own turn reports through its answer; another
          // surface's turn has only the stream to say how it ended.
          if (
            event.conversationId === opened.conversationId &&
            event.source !== source &&
            event.status !== 'completed'
          ) {
            warn(
              `a turn on this thread was ${event.status}${event.message === undefined ? '' : `: ${event.message}`}`,
            );
          }
        } else if (event.kind === 'confirmation_requested') {
          if (own(event)) {
            prompts.ask(event);
          }
        } else if (event.kind === 'confirmation_settled') {
          prompts.settle(event.id);
        } else if (event.kind === 'state_changed') {
          if (
            event.characterId === characterId &&
            event.message !== undefined
          ) {
            warn(event.message);
          }
        } else if (event.characterId === characterId) {
          reportMaintenance(event);
        }
      },
      {
        signal: streaming.signal,
        // The snapshot is the whole handshake: what health says the stream
        // may have missed, the confirmations still waiting, and then the
        // thread's tail — nothing to fetch and order.
        onReady: async ({snapshot}) => {
          const summary = snapshot.health.characters.find(
            character => character.id === characterId,
          );

          if (summary?.maintenance !== undefined) {
            reportMaintenance(summary.maintenance);
          }

          if (summary?.state === 'failed' && summary.diagnostic !== undefined) {
            warn(summary.diagnostic);
          }

          prompts.reconcile(snapshot.confirmations.filter(own));
          await transcript.catchUp().catch(reportError);
          firstHandshake?.();
          firstHandshake = undefined;
        },
      },
    )
    .then(
      () => undefined,
      (error: unknown) => {
        // Replies come only from the stream; without it this terminal would
        // keep taking lines it can show nothing for.
        streamFailure = error;
        reportError(error);
        lines.close();
        firstHandshake?.();
        firstHandshake = undefined;
      },
    );

  try {
    await streamListening;

    if (streamFailure === undefined) {
      options.stdout.write(`${characterId} is ready.\n`);
    }

    for (;;) {
      // The prompt appears only once the confirmation chain is idle, so
      // every keystroke answers the prompt that is actually on screen.
      await prompts.idle();
      options.stdout.write('> ');

      const line = await lines.replLine();

      if (
        streamFailure !== undefined ||
        line === undefined ||
        line.trim() === '/exit'
      ) {
        break;
      }

      if (line.trim().length === 0) {
        continue;
      }

      const outcome = await send(
        client,
        transcript,
        {
          conversationId: opened.conversationId,
          senderId: opened.userParticipantId,
          text: line,
          source,
          clientMessageId: randomUUID(),
        },
        options,
        streaming.signal,
      );

      if (outcome === undefined) {
        continue;
      }

      if (outcome.status !== 'completed') {
        options.stderr.write(`Error: ${outcome.message}\n`);
      }

      // This turn is done here once its own messages are on the screen.
      await transcript.whenShown(
        outcome.status === 'completed'
          ? outcome.messages.map(message => message.messageId)
          : [],
      );
    }

    return streamFailure === undefined ? 0 : 1;
  } finally {
    streaming.abort();
    await streamEnded;
    lines.close();
  }
}

/**
 * Delivers a line. A daemon that cannot be reached is waited for, and the
 * line goes again under the same id once it is back — the daemon's ledger
 * answers a repeat with the turn's outcome rather than running it twice —
 * unless the thread already has it, from a daemon that came back as a new
 * run. A daemon that is stopping refused the line before any turn: not
 * sent, and said so.
 */
async function send(
  client: GatewayClient,
  transcript: Transcript,
  message: GatewayMessage,
  options: ChatCliOptions,
  signal: AbortSignal,
): Promise<TurnOutcome | undefined> {
  for (;;) {
    try {
      return await client.deliver(message);
    } catch (error: unknown) {
      if (!(error instanceof GatewayClientError)) {
        throw error;
      }

      if (error.status === 503) {
        options.stderr.write(
          'The daemon is stopping; your line was not sent.\n',
        );

        return undefined;
      }

      if (error.status !== 0) {
        throw error;
      }

      options.stderr.write(
        'The daemon could not be reached; your line waits for it to be back.\n',
      );
      await untilReachable(client, signal);

      if (await transcript.onThread(message.clientMessageId)) {
        options.stdout.write('Your line did land.\n');

        return undefined;
      }
    }
  }
}

/** Resolves once the daemon answers health again; a second apart. */
async function untilReachable(
  client: GatewayClient,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    try {
      await client.health({signal});

      return;
    } catch (error: unknown) {
      if (
        signal.aborted ||
        !(error instanceof GatewayClientError) ||
        error.status !== 0
      ) {
        throw error;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runChatCliFromArgs(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
