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
  type GatewayConfirmationDecision,
  type GatewayHealth,
  type PendingConfirmation,
} from '../../gateway/index.ts';
import {runtimeConfigDiagnosticAttribution} from '../../runtime/config/index.ts';
import type {LocalRuntimeTurnProgressEvent} from '../../runtime/index.ts';
import {readFlagValue} from '../shared/flags.ts';
import {isMainModule} from '../shared/main-module.ts';
import {cliPromptAnswerIsYes} from '../shared/prompt.ts';
import {CliUsageError} from '../shared/usage-error.ts';
import {createLineDispatcher, type LineDispatcher} from './lines.ts';

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
    }

    return 0;
  } finally {
    streaming.abort();
    await streamEnded;
    lines.close();
  }
}

type ShownMessage = {
  readonly messageId: string;
  readonly speakerName: string;
  readonly text: string;
  readonly source?: string;
};

/**
 * Replies render from the stream, never from the turn's answer, so this
 * terminal shows the same thread every other surface shows. What the stream
 * did not carry is read back from history on every handshake, and nothing
 * shows twice.
 */
async function createTranscript(options: {
  readonly client: GatewayClient;
  readonly conversationId: string;
  readonly source: string;
  readonly stdout: NodeJS.WritableStream;
}): Promise<{
  showProgress(progress: LocalRuntimeTurnProgressEvent): void;
  catchUp(): Promise<void>;
}> {
  const shown = new Set<string>();
  const show = (message: ShownMessage): void => {
    if (shown.has(message.messageId)) {
      return;
    }

    shown.add(message.messageId);

    // This terminal's own lines are already on its screen.
    if (message.source !== options.source) {
      options.stdout.write(`${message.speakerName}: ${message.text}\n`);
    }
  };
  // The thread before this terminal joined stays where it was.
  const newest = await options.client.history(options.conversationId, {
    limit: 1,
  });
  const startAfter =
    newest.status === 'ok' ? (newest.messages.at(-1)?.messageId ?? null) : null;

  return {
    showProgress(progress) {
      if (
        progress.kind === 'visible_reply' ||
        progress.kind === 'user_message'
      ) {
        show(progress);
      }
    },
    async catchUp() {
      const page = await options.client.history(options.conversationId, {
        limit: 100,
      });

      if (page.status !== 'ok') {
        throw new Error(page.message);
      }

      // Not on the page any more means the whole page is newer than it.
      const from =
        startAfter === null
          ? 0
          : page.messages.findIndex(
              message => message.messageId === startAfter,
            ) + 1;

      for (const message of page.messages.slice(from)) {
        show(message);
      }
    },
  };
}

/**
 * Prompts chain: each prints only when it is next and consumes its own
 * line, so one keystroke never approves two proposed effects. The person
 * approves exactly what will happen: the summary and the full change — and
 * only for the character this terminal talks to.
 */
function createConfirmationPrompts(options: {
  readonly client: GatewayClient;
  readonly characterId: string;
  readonly lines: LineDispatcher;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}): {ask(pending: PendingConfirmation): void; idle(): Promise<void>} {
  const asked = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  const answer = (
    id: string,
    decision: GatewayConfirmationDecision,
  ): Promise<void> =>
    options.client.answerConfirmation(id, decision).then(
      () => undefined,
      (error: unknown) => {
        options.stderr.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
  const prompt = async (pending: PendingConfirmation): Promise<void> => {
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
      line = await options.lines.promptLine();
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
  };

  return {
    ask: pending => {
      if (
        pending.characterId !== options.characterId ||
        asked.has(pending.id)
      ) {
        return;
      }

      asked.add(pending.id);
      chain = chain.then(() => prompt(pending));
    },
    idle: () => chain,
  };
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
