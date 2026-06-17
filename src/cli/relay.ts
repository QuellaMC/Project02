import { pathToFileURL } from 'node:url';

import {
  createConversationSession,
  type CharacterAgent
} from '../core/conversation.ts';
import {
  normalizeOneLineMessage,
  OneLineMessageValidationError
} from '../core/message-validation.ts';
import { createUserMessageRuntimeEvent } from '../runtime/event.ts';
import { runLocalUserMessageEvent } from '../runtime/local.ts';
import { createRuntimeLogStore } from '../runtime/log.ts';

type RelayCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly agent?: CharacterAgent;
};

const relayMissingReplyErrorMessage = 'Relay completed without a visible reply.';

export async function runRelayCli(
  args: readonly string[],
  options: RelayCliOptions
): Promise<number> {
  try {
    const message = readMessageArg(args);
    const session = createConversationSession();
    const result = await runLocalUserMessageEvent({
      event: createUserMessageRuntimeEvent(message),
      session,
      logStore: createRuntimeLogStore(),
      rawInput: message,
      ...(options.agent === undefined ? {} : { agent: options.agent })
    });

    if (result.status === 'rejected') {
      options.stderr.write(`Error: ${result.message}\n`);
      return 1;
    }

    const replyText = result.turn?.characterMessage.text;

    if (replyText === undefined) {
      options.stderr.write(`Error: ${relayMissingReplyErrorMessage}\n`);
      return 1;
    }

    options.stdout.write(`${session.character.displayName}: ${replyText}\n`);
    return 0;
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
      options.stderr.write(`Error: ${error.message}\n`);
      return 1;
    }

    throw error;
  }
}

function readMessageArg(args: readonly string[]): string {
  const messageArgs = args[0] === '--' ? args.slice(1) : args;

  if (messageArgs.length !== 1) {
    throw new OneLineMessageValidationError('empty');
  }

  return normalizeOneLineMessage(messageArgs[0]);
}

function isMainModule(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];

  if (scriptPath === undefined) {
    return false;
  }

  return pathToFileURL(scriptPath).href === moduleUrl;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runRelayCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr
  });
}
