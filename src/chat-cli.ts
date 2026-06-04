import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  ConversationRehydrationError,
  createConversationSession,
  createFileRuntimeLogStore,
  createLocalRuntimeSessionStore,
  createRuntimeEventIdentity,
  createLocalRuntimeStorageLayout,
  createRuntimeLogStore,
  createUserMessageRuntimeEvent,
  LocalRuntimeStorageContractError,
  LocalRuntimeSessionStoreError,
  normalizeLocalRuntimeSessionId,
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
  readonly session?: ConversationSession;
  readonly logStore?: RuntimeLogStore;
};

type ChatCliArgs = {
  readonly traceMode: boolean;
  readonly storeRoot?: string;
  readonly sessionId?: string;
  readonly newSessionId?: string;
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

type DurableChatRuntime = {
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
};

const exitCommand = '/exit';
const promptText = 'You: ';
const chatFailedBeforeReplyMessage = 'Chat failed before producing a reply.';

class ChatCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatCliUsageError';
  }
}

export async function runChatCliFromArgs(
  args: readonly string[],
  options: ChatCliOptions
): Promise<number> {
  try {
    const parsedArgs = parseChatCliArgs(args);

    validateDurableSessionArgs(parsedArgs);
    const durableRuntime = await createDurableChatRuntime(parsedArgs);

    return await runChatCli({
      ...options,
      ...durableRuntime,
      traceMode: options.traceMode === true || parsedArgs.traceMode
    });
  } catch (error: unknown) {
    if (
      error instanceof ChatCliUsageError ||
      error instanceof LocalRuntimeStorageContractError ||
      error instanceof LocalRuntimeSessionStoreError ||
      error instanceof ConversationRehydrationError
    ) {
      options.stderr.write(`Error: ${formatTerminalErrorMessage(error)}\n`);
      return 1;
    }

    throw error;
  }
}

export async function runChatCli(options: ChatCliOptions): Promise<number> {
  const session = options.session ?? createConversationSession();
  const logStore = options.logStore ?? createRuntimeLogStore();
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
      } catch (error: unknown) {
        if (isFormattedTerminalError(error)) {
          options.stderr.write(`Error: ${formatTerminalErrorMessage(error)}\n`);
        } else {
          options.stderr.write(`Error: ${chatFailedBeforeReplyMessage}\n`);
        }

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
    } catch (error: unknown) {
      if (isFormattedTerminalError(error)) {
        throw error;
      }

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

function parseChatCliArgs(args: readonly string[]): ChatCliArgs {
  let traceMode = false;
  let storeRoot: string | undefined;
  let sessionId: string | undefined;
  let newSessionId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === '--') {
      continue;
    }

    if (arg === '--trace') {
      traceMode = true;
      continue;
    }

    if (arg === '--store') {
      if (storeRoot !== undefined) {
        throw new ChatCliUsageError('--store can only be provided once.');
      }

      storeRoot = readFlagValue(args, index, '--store');
      index += 1;
      continue;
    }

    if (arg === '--session') {
      if (sessionId !== undefined) {
        throw new ChatCliUsageError('--session can only be provided once.');
      }

      sessionId = readFlagValue(args, index, '--session');
      index += 1;
      continue;
    }

    if (arg === '--new-session') {
      if (newSessionId !== undefined) {
        throw new ChatCliUsageError('--new-session can only be provided once.');
      }

      newSessionId = readFlagValue(args, index, '--new-session');
      index += 1;
      continue;
    }

    throw new ChatCliUsageError(`Unknown chat option: ${arg}.`);
  }

  if (sessionId !== undefined && newSessionId !== undefined) {
    throw new ChatCliUsageError('Use either --session or --new-session, not both.');
  }

  return {
    traceMode,
    ...(storeRoot === undefined ? {} : { storeRoot }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(newSessionId === undefined ? {} : { newSessionId })
  } satisfies ChatCliArgs;
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new ChatCliUsageError(`${flag} requires a value.`);
  }

  return value;
}

function validateDurableSessionArgs(args: ChatCliArgs): void {
  if (args.storeRoot !== undefined) {
    createLocalRuntimeStorageLayout({ storeRoot: args.storeRoot });
  }

  if (args.sessionId !== undefined) {
    normalizeLocalRuntimeSessionId(args.sessionId);
  }

  if (args.newSessionId !== undefined) {
    normalizeLocalRuntimeSessionId(args.newSessionId);
  }
}

async function createDurableChatRuntime(
  args: ChatCliArgs
): Promise<DurableChatRuntime> {
  const sessionId = normalizeLocalRuntimeSessionId(
    args.newSessionId ?? args.sessionId
  );
  const storageOptions =
    args.storeRoot === undefined ? {} : { storeRoot: args.storeRoot };
  const sessionStore = createLocalRuntimeSessionStore({
    ...storageOptions,
    conversationLogReader: {
      readConversationMessages(selectedSessionId) {
        return createFileRuntimeLogStore({
          ...storageOptions,
          sessionId: selectedSessionId
        }).conversationMessages();
      }
    }
  });

  if (args.newSessionId !== undefined) {
    await sessionStore.createSession({ sessionId });
  } else if (args.sessionId !== undefined) {
    await sessionStore.selectSession(sessionId);
  } else {
    await selectOrCreateDefaultSession(sessionStore, sessionId);
  }

  return Object.freeze({
    session: await sessionStore.rehydrateConversationSession(sessionId),
    logStore: createFileRuntimeLogStore({
      ...storageOptions,
      sessionId
    })
  } satisfies DurableChatRuntime);
}

async function selectOrCreateDefaultSession(
  sessionStore: ReturnType<typeof createLocalRuntimeSessionStore>,
  sessionId: string
): Promise<void> {
  try {
    await sessionStore.selectSession(sessionId);
  } catch (error: unknown) {
    if (isMissingDefaultSessionStore(error)) {
      await sessionStore.createSession({ sessionId });
      return;
    }

    throw error;
  }
}

function isMissingDefaultSessionStore(error: unknown): boolean {
  return (
    (error instanceof LocalRuntimeStorageContractError &&
      error.code === 'missing_file') ||
    (error instanceof LocalRuntimeSessionStoreError &&
      error.code === 'session_not_found')
  );
}

function formatTerminalErrorMessage(
  error:
    | ChatCliUsageError
    | LocalRuntimeStorageContractError
    | LocalRuntimeSessionStoreError
    | ConversationRehydrationError
): string {
  if (error instanceof LocalRuntimeStorageContractError) {
    return formatLocalRuntimeStorageContractError(error);
  }

  return error.message;
}

function isFormattedTerminalError(
  error: unknown
): error is
  | ChatCliUsageError
  | LocalRuntimeStorageContractError
  | LocalRuntimeSessionStoreError
  | ConversationRehydrationError {
  return (
    error instanceof ChatCliUsageError ||
    error instanceof LocalRuntimeStorageContractError ||
    error instanceof LocalRuntimeSessionStoreError ||
    error instanceof ConversationRehydrationError
  );
}

function formatLocalRuntimeStorageContractError(
  error: LocalRuntimeStorageContractError
): string {
  const code: string = error.code;

  switch (code) {
    case 'missing_file':
      return 'Local runtime store is missing required files.';
    case 'read_failed':
      return 'Local runtime store could not be read.';
    case 'write_failed':
      return 'Local runtime store could not be written.';
    case 'partial_write':
      return 'Local runtime store write did not complete.';
    default:
      return error.message;
  }
}

function isMainModule(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];

  if (scriptPath === undefined) {
    return false;
  }

  return pathToFileURL(scriptPath).href === moduleUrl;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runChatCliFromArgs(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  });
}
