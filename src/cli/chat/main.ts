/**
 * The disposable dev chat: a terminal over the gateway façade, and nothing
 * more. It reads a line, delivers it, prints events, and answers tool
 * confirmations; the web UI replaces it at parity and deletes it.
 */
import {createInterface} from 'node:readline';

import {
  createGateway,
  selectProject02CharacterId,
  type Gateway,
} from '../../gateway/index.ts';
import type {RuntimePluginHost} from '../../plugins/index.ts';
import {
  selectChatProvider,
  type RoleModelAdapter,
} from '../../role-model/index.ts';
import {
  roleModelProviderEnvVarName,
  type RuntimeLocationCliState,
} from '../../runtime/config/index.ts';
import {readFlagValue} from '../shared/flags.ts';
import {isMainModule} from '../shared/main-module.ts';
import {
  matchesRuntimeStoreInitFlag,
  parseRuntimeStoreFlag,
} from '../shared/runtime-location-flags.ts';
import {cliPromptAnswerIsYes} from '../shared/prompt.ts';
import {assertProject02StoreConsent} from '../shared/store-consent.ts';
import {
  formatCliTerminalErrorMessage,
  isCliTerminalError,
} from '../shared/terminal-errors.ts';
import {CliUsageError} from '../shared/usage-error.ts';

export type ChatCliOptions = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  /** Test and dev injection, handed through to the gateway. */
  readonly pluginHost?: RuntimePluginHost;
  readonly roleModelAdapter?: RoleModelAdapter;
};

type ChatCliFlags = {
  readonly location: RuntimeLocationCliState;
  readonly init: boolean;
  readonly provider?: string;
};

export async function runChatCliFromArgs(
  args: readonly string[],
  options: ChatCliOptions,
): Promise<number> {
  let gateway: Gateway | undefined;

  try {
    const flags = parseChatCliFlags(args);

    // The one provider validator runs before consent can create a store,
    // so a typo never mutates durable state — and its typed result rides
    // the gateway option, leaving the process env (and its cwd-dotenv
    // mode) untouched.
    const provider =
      flags.provider === undefined
        ? undefined
        : selectChatProvider(undefined, {
            [roleModelProviderEnvVarName]: flags.provider,
          });

    await assertProject02StoreConsent({
      location: flags.location,
      init: flags.init,
      stdout: options.stdout,
      stdin: options.stdin,
      ...(options.env === undefined ? {} : {env: options.env}),
    });
    gateway = createGateway({
      location: flags.location,
      ...(options.env === undefined ? {} : {env: options.env}),
      ...(provider === undefined ? {} : {provider}),
      ...(options.roleModelAdapter === undefined
        ? {}
        : {roleModelAdapter: options.roleModelAdapter}),
      ...(options.pluginHost === undefined
        ? {}
        : {createPluginHost: () => options.pluginHost as RuntimePluginHost}),
    });

    const selection = selectProject02CharacterId(
      gateway.characters(),
      flags.location.character,
    );

    if (selection.status === 'failed') {
      throw new CliUsageError(`${selection.message} (pass --character <id>)`);
    }

    return await runChat(gateway, selection.characterId, options);
  } catch (error: unknown) {
    options.stderr.write(
      `Error: ${
        isCliTerminalError(error)
          ? formatCliTerminalErrorMessage(error)
          : error instanceof Error
            ? error.message
            : String(error)
      }\n`,
    );

    return 1;
  } finally {
    if (gateway !== undefined) {
      // Shutdown problems ride the event stream only; listen through the
      // stop so failed plugin cleanup reaches the person leaving.
      const stopListening = gateway.events(event => {
        if (event.kind === 'state_changed' && event.message !== undefined) {
          options.stderr.write(`Warning: ${event.message}\n`);
        }
      });

      await gateway.stop();
      stopListening();
    }
  }
}

function parseChatCliFlags(args: readonly string[]): ChatCliFlags {
  let location: RuntimeLocationCliState = {};
  let init = false;
  let provider: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const store = parseRuntimeStoreFlag({args, index, location});

    if (store.status === 'matched') {
      location = store.location;
      index = store.nextIndex;
      continue;
    }

    if (matchesRuntimeStoreInitFlag(arg, init)) {
      init = true;
      continue;
    }

    if (arg === '--provider') {
      if (provider !== undefined) {
        throw new CliUsageError('--provider can only be provided once.');
      }

      provider = readFlagValue(args, index, '--provider');
      index += 1;
      continue;
    }

    throw new CliUsageError(`Unknown chat option: ${arg}.`);
  }

  return {location, init, ...(provider === undefined ? {} : {provider})};
}

async function runChat(
  gateway: Gateway,
  characterId: string,
  options: ChatCliOptions,
): Promise<number> {
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
  let bootFailure: string | undefined;
  // Between a prompt and its answer the REPL is mid-deliver, so a
  // confirmation is the only reader of the line stream.
  let confirmations: Promise<void> = Promise.resolve();
  const stopListening = gateway.events(event => {
    if (event.kind === 'turn_progress') {
      if (event.progress.kind === 'visible_reply') {
        options.stdout.write(
          `${event.progress.speakerName}: ${event.progress.text}\n`,
        );
      }
    } else if (event.kind === 'confirmation_requested') {
      // Concurrent requests chain: each prompt prints only when it is next
      // and consumes its own line, so one keystroke never approves two
      // proposed effects. The person approves exactly what will happen:
      // summary and the full proposed change, never the summary alone.
      confirmations = confirmations.then(() => {
        // Expired while queued behind earlier prompts: the broker already
        // cancelled it, and asking now would feed the answer to the REPL.
        if (Date.now() >= event.deadlineAt) {
          gateway.answerConfirmation(event.id, 'denied');
          return;
        }

        options.stdout.write(
          `Confirm ${event.request.toolName} (${event.request.pluginId}): ` +
            `${event.request.summary}\n` +
            `${JSON.stringify(event.request.preview, null, 2)}\n[y/N] `,
        );

        return nextLine().then(
          line => {
            // Landed past the deadline: deny outright rather than trust the
            // host's timer to have cancelled first — and say the line was
            // discarded.
            if (Date.now() >= event.deadlineAt) {
              options.stderr.write(
                'Confirmation timed out; the answer was discarded.\n',
              );
              gateway.answerConfirmation(event.id, 'denied');
              return;
            }

            gateway.answerConfirmation(
              event.id,
              cliPromptAnswerIsYes(line) ? 'approved' : 'denied',
            );
          },
          () => {
            // A failed read is a denial, never a parked confirmation.
            gateway.answerConfirmation(event.id, 'denied');
          },
        );
      });
    } else if (event.state === 'failed' && event.message !== undefined) {
      // Turn failures reach the user through the delivery outcome; this
      // remembers the one failure with no outcome to carry it.
      bootFailure ??= event.message;
    }
  });

  try {
    await gateway.startCharacter(characterId);

    if (bootFailure !== undefined) {
      throw new CliUsageError(bootFailure);
    }

    const ref = await gateway.openDirectConversation(characterId);

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

      const outcome = await gateway.deliver({
        conversationId: ref.conversationId,
        senderId: ref.userParticipantId,
        text: line,
      });

      if (outcome.status !== 'completed') {
        options.stderr.write(`Error: ${outcome.message}\n`);
      }

      // The gateway restarts the character, but this terminal's attachment
      // died with the turn; exiting nonzero beats chatting into the void.
      if (outcome.status === 'failed') {
        return 1;
      }
    }

    return 0;
  } finally {
    stopListening();
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
