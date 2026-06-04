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
  type CharacterAgent,
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
  readonly agent?: CharacterAgent;
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
const chatFailedBeforeReplyMessage = 'Chat failed before producing a reply.';

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
        const result = await handleUserMessageThroughRuntime({
          session,
          logStore,
          line,
          ...(options.agent === undefined ? {} : { agent: options.agent })
        });

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
        options.stderr.write(`Error: ${chatFailedBeforeReplyMessage}\n`);
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

type HandleUserMessageThroughRuntimeOptions = {
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly line: string;
  readonly agent?: CharacterAgent;
};

async function handleUserMessageThroughRuntime(
  options: HandleUserMessageThroughRuntimeOptions
): Promise<ChatRuntimeTurn> {
  const identity = createRuntimeEventIdentity();

  try {
    const event = createUserMessageRuntimeEvent(options.line, identity);

    try {
      const result = await runLocalUserMessageEvent({
        event,
        session: options.session,
        logStore: options.logStore,
        rawInput: options.line,
        ...(options.agent === undefined ? {} : { agent: options.agent })
      });

      return mapRuntimeResult(result);
    } catch {
      return mapUnexpectedRuntimeFailureResult(
        identity,
        traceEntriesForIdentity(options.logStore, identity)
      );
    }
  } catch (error: unknown) {
    if (error instanceof RuntimeEventInputError) {
      const result = recordLocalUserMessageInputRejection({
        identity: error.identity,
        logStore: options.logStore,
        message: error.message,
        rawInput: options.line
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

function mapUnexpectedRuntimeFailureResult(
  identity: TraceIdentity,
  traceEntries: readonly RuntimeTraceEntry[]
): RejectedChatRuntimeTurn {
  return {
    status: 'rejected',
    errorMessage: chatFailedBeforeReplyMessage,
    fatal: true,
    traceSummary: createTraceSummary(
      identity,
      'rejected',
      traceEntries,
      chatFailedBeforeReplyMessage
    )
  };
}

function traceEntriesForIdentity(
  logStore: RuntimeLogStore,
  identity: TraceIdentity
): readonly RuntimeTraceEntry[] {
  return Object.freeze(
    logStore
      .traceEntries()
      .filter(
        (entry) =>
          entry.eventId === identity.eventId && entry.traceId === identity.traceId
      )
  );
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
