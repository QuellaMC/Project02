/**
 * The disposable dev chat: a terminal over the daemon's socket, and nothing
 * more. It reads a line, delivers it, prints what the stream carries, and
 * answers tool confirmations; the web UI replaces it at parity and deletes
 * it.
 */
import {randomUUID} from 'node:crypto';

import {
  createGatewayClient,
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
import {createLineDispatcher} from './lines.ts';
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

  const source = `chat-shim:${String(process.pid)}`;
  const lines = createLineDispatcher(options.stdin);
  const reportError = (error: unknown): void => {
    options.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  };
  const transcript = await createTranscript({
    client,
    conversationId: opened.conversationId,
    source,
    stdout: options.stdout,
  });
  const confirmations = createConfirmationPrompts({
    client,
    characterId,
    lines,
    stdout: options.stdout,
    stderr: options.stderr,
  });
  const turns = createTurnTracker();
  // A fatal turn — anyone's — costs the character its open threads; when
  // it is back, this terminal opens the same one again.
  let attached = true;
  const reattach = (): void => {
    client.openDirectConversation(characterId).then(outcome => {
      if (outcome.status === 'opened') {
        attached = true;
        options.stdout.write(`${characterId} is back.\n`);
      } else {
        options.stderr.write(`Error: ${outcome.message}\n`);
      }
    }, reportError);
  };
  const streaming = new AbortController();
  const streamEnded = client
    .events(
      event => {
        if (event.kind === 'turn_progress') {
          if (event.conversationId === opened.conversationId) {
            transcript.showProgress(event.progress);
          }
        } else if (event.kind === 'turn_completed') {
          if (event.conversationId === opened.conversationId) {
            turns.completed();
          }
        } else if (event.kind === 'confirmation_requested') {
          confirmations.ask(event);
        } else if (event.kind === 'confirmation_settled') {
          confirmations.settle(event.id, event.decision);
        } else if (
          event.kind === 'state_changed' &&
          event.characterId === characterId
        ) {
          if (event.state === 'failed') {
            attached = false;
          }

          if (event.message !== undefined) {
            options.stderr.write(`Warning: ${event.message}\n`);
          }

          if (event.state === 'ready' && !attached) {
            reattach();
          }
        }
      },
      {
        signal: streaming.signal,
        // Every handshake: what the stream did not carry — a confirmation
        // asked while this terminal was away, a message committed while
        // the stream was down — is read back from the daemon.
        onReady: () => {
          client.pendingConfirmations().then(pending => {
            for (const request of pending) {
              confirmations.ask(request);
            }
          }, reportError);
          transcript.catchUp().catch(reportError);
        },
      },
    )
    .catch(reportError);

  try {
    options.stdout.write(`${characterId} is ready.\n`);

    for (;;) {
      // The prompt appears only once the confirmation chain is idle, so
      // every keystroke answers the prompt that is actually on screen.
      await confirmations.idle();
      options.stdout.write('> ');

      const line = await lines.replLine();

      if (line === undefined || line.trim() === '/exit') {
        break;
      }

      if (line.trim().length === 0) {
        continue;
      }

      const before = turns.count();
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

      await turns.seen(before);
      await transcript.settled();
    }

    return 0;
  } finally {
    streaming.abort();
    await streamEnded;
    await transcript.settled();
    lines.close();
  }
}

/** How long a settled turn may take to show up on the stream. */
const turnEchoTimeoutMs = 5_000;

/** A turn is done here once the stream says so, not when the answer lands. */
function createTurnTracker(): {
  count(): number;
  completed(): void;
  seen(after: number): Promise<void>;
} {
  let completed = 0;
  const waiters: {readonly after: number; resolve(): void}[] = [];

  return {
    count: () => completed,
    completed() {
      completed += 1;

      for (const waiter of waiters.splice(0)) {
        if (completed > waiter.after) {
          waiter.resolve();
        } else {
          waiters.push(waiter);
        }
      }
    },
    seen: after =>
      completed > after
        ? Promise.resolve()
        : new Promise(resolve => {
            const timer = setTimeout(resolve, turnEchoTimeoutMs);

            waiters.push({
              after,
              resolve() {
                clearTimeout(timer);
                resolve();
              },
            });
          }),
  };
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runChatCliFromArgs(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
