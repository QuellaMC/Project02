import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  createConversationSession,
  createRuntimeEventIdentity,
  createRuntimeLogStore,
  createUserMessageRuntimeEvent,
  recordLocalUserMessageInputRejection,
  runLocalUserMessageEvent,
  RuntimeEventInputError,
  type ConversationSession,
  type LocalRuntimeUserMessageInputRejectedResult,
  type LocalRuntimeUserMessageResult,
  type RuntimeLogStore,
  type RuntimeTraceEntry,
  type RuntimeTraceStepName,
  type RuntimeTurnStatus
} from './index.ts';

type ChatCliOptions = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly traceMode?: boolean;
};

type ChatTraceSummary = {
  readonly eventId: string;
  readonly traceId: string;
  readonly status: RuntimeTurnStatus;
  readonly steps: readonly RuntimeTraceStepName[];
  readonly error?: string;
};

type CompletedChatRuntimeTurn = {
  readonly status: 'completed';
  readonly characterReplyText: string;
  readonly traceSummary: ChatTraceSummary;
};

type RejectedChatRuntimeTurn = {
  readonly status: 'rejected';
  readonly errorMessage: string;
  readonly fatal: boolean;
  readonly traceSummary: ChatTraceSummary;
};

type ChatRuntimeTurn = CompletedChatRuntimeTurn | RejectedChatRuntimeTurn;

type TraceIdentity = {
  readonly eventId: string;
  readonly traceId: string;
};

const exitCommand = '/exit';
const promptText = 'You: ';

export async function runChatCli(options: ChatCliOptions): Promise<number> {
  const session = createConversationSession();
  const logStore = createRuntimeLogStore();
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
        const result = await handleUserMessageThroughRuntime(session, logStore, line);

        if (result.status === 'completed') {
          options.stdout.write(`${session.character.displayName}: ${result.characterReplyText}\n`);
        } else if (options.traceMode === true) {
          writeTraceSummary(options.stderr, result.traceSummary);
        } else {
          options.stderr.write(`Error: ${result.errorMessage}\n`);
        }

        if (result.status === 'completed' && options.traceMode === true) {
          writeTraceSummary(options.stderr, result.traceSummary);
        }

        if (result.status === 'rejected' && result.fatal) {
          lines.close();
          return 1;
        }
      } catch {
        options.stderr.write('Error: Chat failed before producing a reply.\n');
        lines.close();
        return 1;
      }

      options.stdout.write(promptText);
    }
  } finally {
    lines.close();
  }

  return 0;
}

async function handleUserMessageThroughRuntime(
  session: ConversationSession,
  logStore: RuntimeLogStore,
  line: string
): Promise<ChatRuntimeTurn> {
  const identity = createRuntimeEventIdentity();

  try {
    const event = createUserMessageRuntimeEvent(line, identity);
    const result = await runLocalUserMessageEvent({
      event,
      session,
      logStore,
      rawInput: line
    });

    return mapRuntimeResult(result);
  } catch (error: unknown) {
    if (error instanceof RuntimeEventInputError) {
      const result = recordLocalUserMessageInputRejection({
        identity: error.identity,
        logStore,
        message: error.message,
        rawInput: line
      });

      return mapInputRejectionResult(result);
    }

    throw error;
  }
}

function mapRuntimeResult(result: LocalRuntimeUserMessageResult): ChatRuntimeTurn {
  if (result.status === 'completed') {
    return {
      status: 'completed',
      characterReplyText: result.turn.characterMessage.text,
      traceSummary: createTraceSummary(
        result.event,
        'completed',
        result.traceEntries
      )
    };
  }

  return {
    status: 'rejected',
    errorMessage: result.message,
    fatal: result.reason !== 'input_validation_rejected',
    traceSummary: createTraceSummary(
      result.event,
      'rejected',
      result.traceEntries,
      result.message
    )
  };
}

function mapInputRejectionResult(
  result: LocalRuntimeUserMessageInputRejectedResult
): RejectedChatRuntimeTurn {
  return {
    status: 'rejected',
    errorMessage: result.message,
    fatal: false,
    traceSummary: createTraceSummary(
      result.identity,
      'rejected',
      result.traceEntries,
      result.message
    )
  };
}

function createTraceSummary(
  identity: TraceIdentity,
  status: RuntimeTurnStatus,
  entries: readonly RuntimeTraceEntry[],
  error?: string
): ChatTraceSummary {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    status,
    steps: Object.freeze(entries.map((entry) => entry.step)),
    ...(error === undefined ? {} : { error })
  } satisfies ChatTraceSummary);
}

function writeTraceSummary(
  stderr: NodeJS.WritableStream,
  summary: ChatTraceSummary
): void {
  stderr.write(`${JSON.stringify(summary)}\n`);
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
    stderr: process.stderr,
    traceMode: process.argv.slice(2).includes('--trace')
  });
}
