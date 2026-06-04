import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  CharacterInputError,
  createConversationSession,
  runCharacterTurn
} from './index.ts';

type ChatCliOptions = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
};

const exitCommand = '/exit';
const promptText = 'You: ';

export async function runChatCli(options: ChatCliOptions): Promise<number> {
  const session = createConversationSession();
  const lines = createInterface({
    input: options.stdin,
    crlfDelay: Infinity,
    terminal: false
  });

  options.stdout.write(`${session.character.displayName} is ready.\n`);
  options.stdout.write(promptText);

  try {
    for await (const line of lines) {
      if (line.trim() === exitCommand) {
        lines.close();
        return 0;
      }

      try {
        const result = await runCharacterTurn(session, line);
        options.stdout.write(
          `${session.character.displayName}: ${result.characterMessage.text}\n`
        );
      } catch (error: unknown) {
        if (error instanceof CharacterInputError) {
          options.stderr.write(`Error: ${error.message}\n`);
        } else {
          options.stderr.write('Error: Chat failed before producing a reply.\n');
          lines.close();
          return 1;
        }
      }

      options.stdout.write(promptText);
    }
  } finally {
    lines.close();
  }

  return 0;
}

function isMainModule(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];

  if (scriptPath === undefined) {
    return false;
  }

  return pathToFileURL(scriptPath).href === moduleUrl;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runChatCli({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  });
}
