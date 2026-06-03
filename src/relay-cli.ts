import { pathToFileURL } from 'node:url';

import {
  createLocalRelayAgent,
  relayMessage,
  RelayInputError,
  type RelayAgent
} from './relay.ts';

type RelayCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly agent?: RelayAgent;
};

export async function runRelayCli(
  args: readonly string[],
  options: RelayCliOptions
): Promise<number> {
  try {
    const result = await relayMessage(readMessageArg(args), options.agent ?? createLocalRelayAgent());
    options.stdout.write(`${result.reply.text}\n`);
    return 0;
  } catch (error: unknown) {
    if (error instanceof RelayInputError) {
      options.stderr.write(`Error: ${error.message}\n`);
      return 1;
    }

    options.stderr.write('Error: Relay failed before producing a reply.\n');
    return 1;
  }
}

function readMessageArg(args: readonly string[]): string | undefined {
  const messageArgs = args[0] === '--' ? args.slice(1) : args;

  if (messageArgs.length !== 1) {
    return undefined;
  }

  return messageArgs[0];
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
