import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import {
  normalizeOneLineMessage,
  OneLineMessageValidationError
} from '../core/message-validation.ts';
import { runChatCli } from './chat.ts';

type RelayCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
};

export async function runRelayCli(
  args: readonly string[],
  options: RelayCliOptions
): Promise<number> {
  try {
    const message = readMessageArg(args);

    return await runChatCli({
      stdin: Readable.from([`${message}\n/exit\n`]),
      stdout: options.stdout,
      stderr: options.stderr
    });
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
