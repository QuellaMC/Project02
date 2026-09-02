/**
 * The disposable dev chat: a terminal over the daemon's socket, and nothing
 * more. It reads a line, delivers it, prints what the stream carries, and
 * answers tool confirmations; the web UI replaces it at parity and deletes
 * it.
 */
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';

import {
  createGatewayClient,
  gatewayUrlEnvVarName,
  type GatewayClient,
} from '../../gateway/client/index.ts';
import {
  selectProject02CharacterId,
  type GatewayConfirmationDecision,
  type GatewayHealth,
  type PendingConfirmation,
} from '../../gateway/index.ts';
import {runtimeConfigDiagnosticAttribution} from '../../runtime/config/index.ts';
import {readFlagValue} from '../shared/flags.ts';
import {isMainModule} from '../shared/main-module.ts';
import {cliPromptAnswerIsYes} from '../shared/prompt.ts';
import {CliUsageError} from '../shared/usage-error.ts';

export type ChatCliOptions = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
};

/** How long a settled turn may take to show up on the stream. */
const turnEchoTimeoutMs = 5_000;

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

  const source = `chat-shim:${String(process.pid)}`;
  const lines = createInterface({
    input: options.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  const lineIterator = lines[Symbol.asyncIterator]();
  // One shared in-flight read guards against double reads; the REPL waits
  // out the confirmation chain besides, so a line typed under a visible
  // [y/N] always answers that prompt and never becomes a chat message.
  let inFlightLine: Promise<string | undefined> | undefined;
  const nextLine = (): Promise<string | undefined> => {
    inFlightLine ??= lineIterator.next().then(next => {
      inFlightLine = undefined;

      return next.done === true ? undefined : next.value;
    });

    return inFlightLine;
  };
  const reportError = (error: unknown): void => {
    options.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  };
  const answer = (
    id: string,
    decision: GatewayConfirmationDecision,
  ): Promise<void> =>
    client.answerConfirmation(id, decision).then(() => undefined, reportError);
  // Prompts chain: each prints only when it is next and consumes its own
  // line, so one keystroke never approves two proposed effects. The person
  // approves exactly what will happen: the summary and the full change.
  let confirmations: Promise<void> = Promise.resolve();
  const asked = new Set<string>();
  const ask = (pending: PendingConfirmation): void => {
    if (asked.has(pending.id)) {
      return;
    }

    asked.add(pending.id);
    confirmations = confirmations.then(async () => {
      // Expired while queued: the daemon already cancelled it, and asking
      // now would feed the answer to the REPL.
      if (Date.now() >= pending.deadlineAt) {
        await answer(pending.id, 'denied');

        return;
      }

      options.stdout.write(
        `Confirm ${pending.request.toolName} (${pending.request.pluginId}): ` +
          `${pending.request.summary}\n` +
          `${JSON.stringify(pending.request.preview, null, 2)}\n[y/N] `,
      );

      let line: string | undefined;

      try {
        line = await nextLine();
      } catch {
        // A failed read is a denial, never a parked confirmation.
        await answer(pending.id, 'denied');

        return;
      }

      if (Date.now() >= pending.deadlineAt) {
        options.stderr.write(
          'Confirmation timed out; the answer was discarded.\n',
        );
        await answer(pending.id, 'denied');

        return;
      }

      await answer(
        pending.id,
        cliPromptAnswerIsYes(line) ? 'approved' : 'denied',
      );
    });
  };
  // Replies render from the stream, never from the turn's answer, so this
  // terminal shows the same thread every other surface shows. A turn is
  // done here once the stream says so.
  let turnsSeen = 0;
  const turnWaiters: {readonly after: number; resolve(): void}[] = [];
  const turnSeen = (after: number): Promise<void> =>
    turnsSeen > after
      ? Promise.resolve()
      : new Promise(resolve => {
          const timer = setTimeout(resolve, turnEchoTimeoutMs);

          turnWaiters.push({
            after,
            resolve() {
              clearTimeout(timer);
              resolve();
            },
          });
        });
  const streaming = new AbortController();
  const streamEnded = client
    .events(
      event => {
        if (event.kind === 'turn_progress') {
          if (event.conversationId !== opened.conversationId) {
            return;
          }

          const {progress} = event;

          if (
            progress.kind === 'visible_reply' ||
            (progress.kind === 'user_message' && progress.source !== source)
          ) {
            options.stdout.write(`${progress.speakerName}: ${progress.text}\n`);
          }
        } else if (event.kind === 'turn_completed') {
          if (event.conversationId === opened.conversationId) {
            turnsSeen += 1;

            for (const waiter of turnWaiters.splice(0)) {
              if (turnsSeen > waiter.after) {
                waiter.resolve();
              } else {
                turnWaiters.push(waiter);
              }
            }
          }
        } else if (event.kind === 'confirmation_requested') {
          ask(event);
        } else if (
          event.kind === 'state_changed' &&
          event.characterId === characterId &&
          event.message !== undefined
        ) {
          options.stderr.write(`Warning: ${event.message}\n`);
        }
      },
      {
        signal: streaming.signal,
        // Every handshake: whatever was asked while this terminal was away
        // is still waiting in the list.
        onReady: () => {
          client.pendingConfirmations().then(pending => {
            pending.forEach(ask);
          }, reportError);
        },
      },
    )
    .catch(reportError);

  try {
    options.stdout.write(`${characterId} is ready.\n`);

    for (;;) {
      // The prompt appears only once the confirmation chain is idle, so
      // every keystroke answers the prompt that is actually on screen.
      await confirmations;
      options.stdout.write('> ');

      const line = await nextLine();

      if (line === undefined || line.trim() === '/exit') {
        break;
      }

      if (line.trim().length === 0) {
        continue;
      }

      const before = turnsSeen;
      const outcome = await client.deliver({
        conversationId: opened.conversationId,
        senderId: opened.userParticipantId,
        text: line,
        source,
        clientMessageId: randomUUID(),
      });

      if (outcome.status !== 'completed') {
        options.stderr.write(`Error: ${outcome.message}\n`);
      }

      // The daemon restarts the character, but this thread died with the
      // turn; exiting nonzero beats chatting into the void.
      if (outcome.status === 'failed') {
        return 1;
      }

      await turnSeen(before);
    }

    return 0;
  } finally {
    streaming.abort();
    await streamEnded;
    lines.close();
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runChatCliFromArgs(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
