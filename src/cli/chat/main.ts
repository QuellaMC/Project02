/**
 * The disposable dev chat: a terminal over the daemon's socket, and nothing
 * more. It reads a line, delivers it, prints what the stream carries, and
 * answers tool confirmations; the web UI replaces it at parity and deletes
 * it.
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
} from '../../gateway/index.ts';
import {runtimeConfigDiagnosticAttribution} from '../../runtime/config/index.ts';
import {readFlagValue} from '../shared/flags.ts';
import {isMainModule} from '../shared/main-module.ts';
import {CliUsageError} from '../shared/usage-error.ts';
import {
  createLineDispatcher,
  createReadAhead,
  type ReadAhead,
} from './lines.ts';
import {createConfirmationPrompts} from './prompts.ts';
import {createTranscript} from './transcript.ts';

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
  const lines = createLineDispatcher(options.stdin);
  const reportError = (error: unknown): void => {
    options.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  };
  // A snapshot the daemon could not answer leaves the bootstrap incomplete;
  // rethrown, it makes the stream reconnect and run the whole handshake
  // again. Any other failure is reported and the stream carries on.
  const reportUnlessUnreachable = (error: unknown): void => {
    if (isUnreachable(error)) {
      throw error;
    }

    reportError(error);
  };
  const streaming = new AbortController();
  const transcript = await createTranscript({
    client,
    conversationId: opened.conversationId,
    source,
    stdout: options.stdout,
    signal: streaming.signal,
  });
  // A prompt that interrupted the REPL's read leaves it waiting without a
  // visible prompt; the REPL's own `> ` comes back once the prompt is gone.
  let replWaiting = false;
  const confirmations = createConfirmationPrompts({
    client,
    characterId,
    lines,
    stdout: options.stdout,
    stderr: options.stderr,
    afterPrompt: () => {
      if (replWaiting) {
        options.stdout.write('> ');
      }
    },
    signal: streaming.signal,
  });
  const watch = createCharacterWatch({
    client,
    characterId,
    stdout: options.stdout,
    stderr: options.stderr,
    reportError,
    signal: streaming.signal,
  });
  let streamFailure: unknown;
  // Nothing is read until the first handshake is through: a line typed —
  // or piped — before the stream listens would run a turn whose messages
  // the stream never carries.
  let firstHandshake: (() => void) | undefined;
  const streamListening = new Promise<void>(resolve => {
    firstHandshake = resolve;
  });
  // A handshake's snapshots are only as good as their handshake: one that
  // failed and was replaced must not have a slow answer applied late.
  let handshakes = 0;
  const streamEnded = client
    .events(
      event => {
        if (event.kind === 'turn_progress') {
          if (event.conversationId === opened.conversationId) {
            transcript.showProgress(event.progress);
          }
        } else if (event.kind === 'turn_completed') {
          if (event.conversationId === opened.conversationId) {
            transcript.turnEnded(
              event.clientMessageId,
              event.status,
              event.message,
            );

            // This terminal's own turn reports through its answer; another
            // surface's turn has only the stream to say how it ended.
            if (event.status !== 'completed' && event.source !== source) {
              options.stderr.write(
                `Warning: a turn on this thread was ${event.status}${event.message === undefined ? '' : `: ${event.message}`}\n`,
              );
            }
          }
        } else if (
          event.kind === 'maintenance_failed' &&
          event.characterId === characterId
        ) {
          watch.maintenanceFailed(event);
        } else if (event.kind === 'confirmation_requested') {
          confirmations.ask(event);
        } else if (event.kind === 'confirmation_settled') {
          confirmations.settle(event.id, event.decision);
        } else if (
          event.kind === 'state_changed' &&
          event.characterId === characterId
        ) {
          watch.stateChanged(event.state, event.message);
        }
      },
      {
        signal: streaming.signal,
        // Every handshake: what the stream did not carry — a confirmation
        // asked while this terminal was away, a message committed while
        // the stream was down — is read back from the daemon.
        // The stream waits for this: the snapshots are in place before any
        // event that followed the handshake is handled, so an older
        // snapshot can never undo what a newer event just did. Each step
        // reports its own failure; the stream itself stays up.
        onReady: () => {
          handshakes += 1;

          const mine = handshakes;

          return Promise.all([
            watch.reportHealth().catch(reportUnlessUnreachable),
            watch.ensureAttached().catch(reportUnlessUnreachable),
            client
              .pendingConfirmations({signal: streaming.signal})
              .then(pending => {
                if (mine === handshakes) {
                  confirmations.reconcile(pending);
                }
              }, reportUnlessUnreachable),
            transcript.catchUp().catch(reportUnlessUnreachable),
          ]).then(() => {
            firstHandshake?.();
            firstHandshake = undefined;
          });
        },
      },
    )
    .then(
      () => undefined,
      (error: unknown) => {
        // Replies and confirmations come only from the stream; without it
        // this terminal would keep taking lines it can show nothing for.
        streamFailure = error;
        reportError(error);
        watch.giveUp();
        lines.close();
        firstHandshake?.();
        firstHandshake = undefined;
      },
    );

  // Lines read while one was held for the thread: an exit ends the hold,
  // anything else is next in line.
  const later = createReadAhead(lines);

  try {
    await streamListening;

    // Ready means the stream listens and the thread is attached; if the
    // character failed between the open and the handshake, the warnings
    // already said so, and the first line waits for it to be back.
    if (streamFailure === undefined && watch.isAttached()) {
      options.stdout.write(`${characterId} is ready.\n`);
    }

    for (;;) {
      // The prompt appears only once the confirmation chain is idle, so
      // every keystroke answers the prompt that is actually on screen — but
      // an exit typed while an answer hangs still gets through.
      if ((await later.holdUntil(confirmations.idle())).kind === 'exit') {
        break;
      }

      options.stdout.write('> ');
      replWaiting = true;

      const line = await later.next();

      replWaiting = false;

      // Without the stream there is no one to show a reply to: nothing
      // more is sent, whatever was typed ahead.
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

      const sent = await sendLine(
        {
          client,
          watch,
          later,
          transcript,
          opened,
          source,
          characterId,
          options,
        },
        line,
      );

      if (sent === 'exit') {
        break;
      }

      if (sent === 'failed') {
        return 1;
      }
    }

    return streamFailure === undefined ? 0 : 1;
  } finally {
    streaming.abort();
    await streamEnded;
    lines.close();
  }
}

/**
 * This terminal's hold on its character: the thread it opened, reopened
 * when a fatal turn — anyone's — took it away and the character came back,
 * or on any handshake, since the stream may have missed the episode; and
 * what health says that the stream may have missed while it was down.
 */
function createCharacterWatch(options: {
  readonly client: GatewayClient;
  readonly characterId: string;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly reportError: (error: unknown) => void;
  /** Ends any reopen or health read still in flight when the terminal leaves. */
  readonly signal?: AbortSignal;
}): {
  ensureAttached(): Promise<void>;
  /**
   * Resolves true once the thread is attached — waiting, after one more
   * try, for the character to come back — and false when it never will,
   * because the roster no longer has it.
   */
  attached(): Promise<boolean>;
  isAttached(): boolean;
  /** The daemon refused the thread: it is lost until reopened. */
  lost(): void;
  /** Nothing will attach any more: every held line is let go. */
  giveUp(): void;
  stateChanged(state: string, message: string | undefined): void;
  maintenanceFailed(failure: {at: string; message: string}): void;
  reportHealth(): Promise<void>;
} {
  const {client, characterId} = options;
  const call = options.signal === undefined ? {} : {signal: options.signal};
  let attached = true;
  let gone = false;
  let attachment: Promise<void> = Promise.resolve();
  let reportedMaintenanceAt: string | undefined;
  const waiting: ((attached: boolean) => void)[] = [];
  const ensureAttached = (): Promise<void> => {
    attachment = client.openDirectConversation(characterId, call).then(
      outcome => {
        if (outcome.status === 'opened') {
          if (!attached) {
            options.stdout.write(`${characterId} is back.\n`);
          }

          attached = true;

          for (const resume of waiting.splice(0)) {
            resume(true);
          }
        } else {
          attached = false;
          gone =
            outcome.status === 'refused' &&
            outcome.reason === 'unknown_character';
          options.stderr.write(`Error: ${outcome.message}\n`);
        }
      },
      (error: unknown) => {
        // Not reached: the thread stays unattached and the next line, or
        // the next handshake, tries again.
        attached = false;
        throw error;
      },
    );

    return attachment;
  };
  const maintenanceFailed = (failure: {at: string; message: string}): void => {
    if (reportedMaintenanceAt === failure.at) {
      return;
    }

    reportedMaintenanceAt = failure.at;
    options.stderr.write(`Warning: ${failure.message}\n`);
  };

  return {
    ensureAttached,
    async attached() {
      await attachment.catch(() => undefined);

      if (!attached) {
        await ensureAttached().catch(options.reportError);
      }

      if (attached) {
        return true;
      }

      if (gone) {
        return false;
      }

      // The line waits, not the person's patience: it goes the moment the
      // character is back.
      options.stderr.write(
        `${characterId} is not available right now; your line will be sent when it is back.\n`,
      );

      return new Promise<boolean>(resolve => {
        waiting.push(resolve);
      });
    },
    isAttached: () => attached,
    lost() {
      attached = false;
    },
    giveUp() {
      gone = true;

      for (const resume of waiting.splice(0)) {
        resume(false);
      }
    },
    stateChanged(state, message) {
      if (state === 'failed') {
        attached = false;
      }

      if (message !== undefined) {
        options.stderr.write(`Warning: ${message}\n`);
      }

      if (state === 'ready' && !attached) {
        ensureAttached().catch(options.reportError);
      }
    },
    maintenanceFailed,
    async reportHealth() {
      const summary = (await client.health(call)).characters.find(
        character => character.id === characterId,
      );

      if (summary?.maintenance !== undefined) {
        maintenanceFailed(summary.maintenance);
      }

      if (summary?.state === 'failed' && summary.diagnostic !== undefined) {
        options.stderr.write(`Warning: ${summary.diagnostic}\n`);
      }
    },
  };
}

type SendContext = {
  readonly client: GatewayClient;
  readonly watch: ReturnType<typeof createCharacterWatch>;
  readonly later: ReadAhead;
  readonly transcript: Awaited<ReturnType<typeof createTranscript>>;
  readonly opened: {
    readonly conversationId: string;
    readonly userParticipantId: string;
  };
  readonly source: string;
  readonly characterId: string;
  readonly options: ChatCliOptions;
};

/**
 * One line, sent once the thread is attached — held while it is not — and
 * sent once more, under a fresh id, if the daemon refused it because the
 * thread had gone before this terminal heard so.
 */
async function sendLine(
  context: SendContext,
  line: string,
): Promise<'sent' | 'exit' | 'failed' | 'dropped'> {
  const {client, watch, later, transcript, opened, options} = context;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Only a thread that is lost holds the line; an attached one sends it
    // at once, with no read run ahead of it.
    const held = watch.isAttached()
      ? {kind: 'done' as const, value: true}
      : await later.holdUntil(watch.attached());

    if (held.kind === 'exit') {
      watch.giveUp();

      return 'exit';
    }

    if (!held.value) {
      options.stderr.write(
        `Your line was not sent: ${context.characterId} is gone.\n`,
      );

      return 'dropped';
    }

    const clientMessageId = randomUUID();
    const outcome = await deliverOrReport(client, {
      conversationId: opened.conversationId,
      senderId: opened.userParticipantId,
      text: line,
      source: context.source,
      clientMessageId,
    });

    // The daemon could not be reached: the turn may or may not have
    // landed, and only the thread can say. The transcript keeps the
    // line's id and says which, as soon as the thread is read again.
    if (outcome === undefined) {
      options.stderr.write(
        `${context.characterId}'s daemon could not be reached; whether that line landed shows once it is back.\n`,
      );
      transcript.expectLanding(clientMessageId, line);
      // The stream may be fine and bring no handshake: read the thread now.
      transcript.catchUp().catch((error: unknown) => {
        options.stderr.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });

      return 'dropped';
    }

    // The thread went before this terminal heard so: the line was never
    // taken, so once the thread is back it goes again, under a new id.
    if (
      attempt === 0 &&
      outcome.status === 'refused' &&
      (outcome.reason === 'unknown_conversation' ||
        outcome.reason === 'character_unavailable')
    ) {
      watch.lost();
      continue;
    }

    if (outcome.status !== 'completed') {
      options.stderr.write(`Error: ${outcome.message}\n`);
    }

    // The daemon restarts the character, but this thread died with the
    // turn; exiting nonzero beats chatting into the void.
    if (outcome.status === 'failed') {
      return 'failed';
    }

    // This turn is done here once its own messages are on the screen.
    await transcript.whenShown(
      outcome.status === 'completed'
        ? outcome.messages.map(message => message.messageId)
        : [],
    );
    await transcript.settled();

    return 'sent';
  }

  return 'dropped';
}

/** The daemon could not be reached at all, or is stopping. */
function isUnreachable(error: unknown): boolean {
  return (
    error instanceof GatewayClientError &&
    (error.status === 0 || error.status === 503)
  );
}

/** A turn's outcome, or undefined when the daemon could not be reached. */
async function deliverOrReport(
  client: GatewayClient,
  message: Parameters<GatewayClient['deliver']>[0],
): Promise<Awaited<ReturnType<GatewayClient['deliver']>> | undefined> {
  try {
    return await client.deliver(message);
  } catch (error: unknown) {
    if (isUnreachable(error)) {
      return undefined;
    }

    throw error;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runChatCliFromArgs(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
