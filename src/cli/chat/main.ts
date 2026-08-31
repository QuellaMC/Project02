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
import type {RoleModelAdapter} from '../../role-model/index.ts';
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

    await assertProject02StoreConsent({
      location: flags.location,
      init: flags.init,
      stdout: options.stdout,
      stdin: options.stdin,
      ...(options.env === undefined ? {} : {env: options.env}),
    });
    gateway = createGateway({
      location: flags.location,
      ...chatGatewayEnvOption(options.env, flags.provider),
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

    await runChat(gateway, selection.characterId, options);

    return 0;
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
    await gateway?.stop();
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
      provider = readFlagValue(args, index, '--provider');
      index += 1;
      continue;
    }

    throw new CliUsageError(`Unknown chat option: ${arg}.`);
  }

  return {location, init, ...(provider === undefined ? {} : {provider})};
}

/**
 * --provider rides the provider env var, so the one existing seam
 * validates the name and decides precedence.
 */
function chatGatewayEnvOption(
  env: NodeJS.ProcessEnv | undefined,
  provider: string | undefined,
): {env?: NodeJS.ProcessEnv} {
  if (provider === undefined) {
    return env === undefined ? {} : {env};
  }

  return {
    env: {...(env ?? process.env), [roleModelProviderEnvVarName]: provider},
  };
}

async function runChat(
  gateway: Gateway,
  characterId: string,
  options: ChatCliOptions,
): Promise<void> {
  const lines = createInterface({
    input: options.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  const lineIterator = lines[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string | undefined> => {
    const next = await lineIterator.next();

    return next.done === true ? undefined : next.value;
  };
  let bootFailure: string | undefined;
  const stopListening = gateway.events(event => {
    if (event.kind === 'turn_progress') {
      if (event.progress.kind === 'visible_reply') {
        options.stdout.write(
          `${event.progress.speakerName}: ${event.progress.text}\n`,
        );
      }
    } else if (event.kind === 'confirmation_requested') {
      // Between the prompt and the answer the REPL is mid-deliver, so the
      // confirmation is the only reader of the line stream.
      options.stdout.write(
        `Confirm ${event.request.toolName} (${event.request.pluginId}): ` +
          `${event.request.summary} [y/N] `,
      );
      void nextLine().then(line => {
        gateway.answerConfirmation(
          event.id,
          line?.trim() === 'y' ? 'approved' : 'denied',
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
    }
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
