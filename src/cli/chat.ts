import { createInterface } from 'node:readline';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  createConversationSession,
  type CharacterAgent,
  type ConversationSession
} from '../core/conversation.ts';
import {
  createNvidiaRoleModelProviderAdapter,
  createNvidiaRoleModelProviderConfigFromEnv
} from '../role-model/providers/nvidia.ts';
import { buildUserTurnDecisionContext } from '../role-model/decision-context.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  RuntimeEventInputError
} from '../runtime/event.ts';
import {
  recordLocalUserMessageInputRejection,
  runLocalUserMessageEvent,
  type LocalRuntimeTurnProgressEvent,
  type LocalRuntimeUserMessageInputRejectedResult,
  type LocalRuntimeUserMessageResult
} from '../runtime/local.ts';
import {
  createRuntimeLogStore,
  runtimePluginEvidenceOption,
  runtimePluginTurnEvidenceOption,
  type RawEventLogRecord,
  type RuntimeLogStore,
  type RuntimeTraceEntry,
  type RuntimeTraceStepName,
  type RuntimeTurnStatus
} from '../runtime/log.ts';
import { createFileRuntimeLogStore } from '../runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeSessionId
} from '../runtime/storage/layout.ts';
import {
  createLocalRuntimeSessionStore,
  LocalRuntimeSessionStoreError
} from '../runtime/storage/session-store.ts';
import {
  createDefaultProject02PluginHost,
  createRuntimePluginContext,
  type RuntimePluginHookHostResult,
  type RuntimePluginHost
} from '../plugins/index.ts';
import type { RoleModelAdapter } from '../role-model/loop.ts';
import {
  formatLocalRuntimeTerminalError,
  isLocalRuntimeTerminalError,
  type LocalRuntimeTerminalError
} from '../runtime/terminal-errors.ts';

type ChatCliOptions = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly traceMode?: boolean;
  readonly agent?: CharacterAgent;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly pluginHost?: RuntimePluginHost;
  readonly session?: ConversationSession;
  readonly logStore?: RuntimeLogStore;
};

type ChatProviderName = 'local' | 'nvidia';

type ChatCliArgs = {
  readonly traceMode: boolean;
  readonly provider?: ChatProviderName;
  readonly storeRoot?: string;
  readonly sessionId?: string;
  readonly newSessionId?: string;
};

type ChatTraceSummary = {
  readonly eventId: string;
  readonly traceId: string;
  readonly status: RuntimeTurnStatus;
  readonly steps: readonly RuntimeTraceStepName[];
  readonly provider?: ChatTraceProviderSummary;
  readonly toolCalls?: readonly string[];
  readonly error?: string;
};

type ChatTraceProviderSummary = {
  readonly name: 'local' | 'nvidia';
  readonly model?: string;
  readonly responseStatus?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

type CompletedChatRuntimeTurn = {
  readonly status: 'completed';
  readonly characterReplyText?: string;
  readonly nonCommittedTopLevelText?: string;
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
const modelTextToggleCommand = '/model-text';
const showModelTextCommand = '/show-model-text';
const hideModelTextCommand = '/hide-model-text';
const promptText = 'You: ';
const chatFailedBeforeReplyMessage = 'Chat failed before producing a reply.';
const roleModelProviderEnvName = 'PROJECT02_ROLE_MODEL_PROVIDER';

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
    loadDefaultDotEnvFile();
    const parsedArgs = parseChatCliArgs(args);

    validateDurableSessionArgs(parsedArgs);
    const durableRuntime = await createDurableChatRuntime(parsedArgs);
    const roleModelAdapter = createSelectedRoleModelAdapter(parsedArgs);
    return await runChatCli({
      ...options,
      ...durableRuntime,
      ...(roleModelAdapter === undefined ? {} : { roleModelAdapter }),
      traceMode: options.traceMode === true || parsedArgs.traceMode
    });
  } catch (error: unknown) {
    if (
      error instanceof ChatCliUsageError ||
      isLocalRuntimeTerminalError(error)
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
  let showNonCommittedTopLevelText = false;

  options.stdout.write(`${session.character.displayName} is ready.\n`);
  options.stdout.write(promptText);

  try {
    for await (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine === exitCommand) {
        await endChatSession({
          session,
          logStore,
          ...(options.pluginHost === undefined
            ? {}
            : { pluginHost: options.pluginHost })
        });
        return 0;
      }

      const nextModelTextVisibility = modelTextVisibilityCommand(
        trimmedLine,
        showNonCommittedTopLevelText
      );

      if (nextModelTextVisibility !== undefined) {
        showNonCommittedTopLevelText = nextModelTextVisibility;
        options.stdout.write(
          `Model top-level text display: ${showNonCommittedTopLevelText ? 'shown' : 'hidden'}.\n`
        );
        options.stdout.write(promptText);
        continue;
      }

      try {
        const result = await handleUserMessageThroughRuntime({
          session,
          logStore,
          line,
          ...(options.agent === undefined ? {} : { agent: options.agent }),
          ...(options.roleModelAdapter === undefined
            ? {}
            : { roleModelAdapter: options.roleModelAdapter }),
          ...(options.pluginHost === undefined
            ? {}
            : { pluginHost: options.pluginHost }),
          onProgress(progressEvent) {
            writeRuntimeProgress(options.stdout, session, progressEvent);
          }
        });

        if (result.status === 'completed') {
          if (result.characterReplyText !== undefined) {
            options.stdout.write(`${session.character.displayName}: ${result.characterReplyText}\n`);
          }
          if (
            showNonCommittedTopLevelText &&
            result.nonCommittedTopLevelText !== undefined
          ) {
            writeNonCommittedTopLevelText(
              options.stdout,
              result.nonCommittedTopLevelText
            );
          }
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

    await endChatSession({
      session,
      logStore,
      ...(options.pluginHost === undefined
        ? {}
        : { pluginHost: options.pluginHost })
    });
  } finally {
    lines.close();
  }

  return 0;
}

type EndChatSessionOptions = {
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly pluginHost?: RuntimePluginHost;
};

async function endChatSession(options: EndChatSessionOptions): Promise<void> {
  const identity = createRuntimeEventIdentity();
  const decisionContext = buildUserTurnDecisionContext({
    session: options.session
  });
  const pluginHost = pluginHostForSessionEnd(options);
  const context = createRuntimePluginContext({
    ...identity,
    sessionId: decisionContext.sessionId,
    eventType: 'USER_MESSAGE',
    currentUserMessage: exitCommand,
    character: decisionContext.characterSnapshot
  });
  const sessionEndResult = await pluginHost.onSessionEnd(context);

  if (!shouldRecordSessionEndResult(pluginHost, sessionEndResult)) {
    return;
  }

  const payloadSummary = {
    rawInput: exitCommand,
    normalizedCurrentUserMessage: exitCommand
  };

  options.logStore.appendTrace({
    ...identity,
    step: 'runtime_event_received'
  });
  options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE',
    payloadSummary
  });
  options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_turn_completed',
    eventType: 'USER_MESSAGE',
    status: sessionEndResult.status,
    payloadSummary,
    ...runtimePluginEvidenceOption(sessionEndResult.evidence),
    ...runtimePluginTurnEvidenceOption({
      identity,
      pluginHost,
      contextItems: [],
      toolInvocations: [],
      evidence: sessionEndResult.evidence,
      health: []
    })
  });
  options.logStore.appendTrace({
    ...identity,
    step: 'raw_event_log_appended'
  });
  options.logStore.appendTrace({
    ...identity,
    step: 'runtime_turn_completed'
  });
}

function shouldRecordSessionEndResult(
  pluginHost: RuntimePluginHost,
  result: RuntimePluginHookHostResult
): boolean {
  return (
    result.evidence.length > 0 ||
    result.status === 'completed_with_failures' ||
    pluginHost
      .registrySnapshot()
      .plugins.some((plugin) =>
        plugin.registeredLifecycleHooks.includes('on_session_end')
      )
  );
}

function pluginHostForSessionEnd(
  options: EndChatSessionOptions
): RuntimePluginHost {
  if (options.pluginHost !== undefined) {
    return options.pluginHost;
  }

  const sessionPaths = options.logStore.localRuntimeSessionPaths;

  return createDefaultProject02PluginHost({
    ...(sessionPaths === undefined ? {} : { storeRoot: sessionPaths.storeRoot }),
    sessionId: sessionPaths?.sessionId ?? options.session.id,
    sessionIdentity: options.session
  });
}

type HandleUserMessageThroughRuntimeOptions = {
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly line: string;
  readonly agent?: CharacterAgent;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly pluginHost?: RuntimePluginHost;
  readonly onProgress?: (
    event: LocalRuntimeTurnProgressEvent
  ) => Promise<void> | void;
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
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.roleModelAdapter === undefined
          ? {}
          : { roleModelAdapter: options.roleModelAdapter }),
        ...(options.pluginHost === undefined
          ? {}
          : { pluginHost: options.pluginHost }),
        ...(options.onProgress === undefined
          ? {}
          : { onProgress: options.onProgress })
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
    const turn = result.turn;

    return {
      status: 'completed',
      ...(turn === undefined
        ? {}
        : { characterReplyText: turn.characterMessage.text }),
      ...nonCommittedTopLevelTextOption(result.rawEvent),
      traceSummary: createTraceSummary(
        result.event,
        'completed',
        result.traceEntries,
        undefined,
        result.rawEvent
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
      result.message,
      result.rawEvent
    )
  };
}

function writeRuntimeProgress(
  stdout: NodeJS.WritableStream,
  session: ConversationSession,
  progressEvent: LocalRuntimeTurnProgressEvent
): void {
  if (progressEvent.kind === 'visible_reply') {
    if (!progressEvent.final) {
      stdout.write(`${session.character.displayName}: ${progressEvent.text}\n`);
    }

    return;
  }

  if (progressEvent.kind === 'tool_calls_requested') {
    stdout.write(
      `[tools] Model requested ${String(progressEvent.toolNames.length)} ${progressEvent.toolNames.length === 1 ? 'tool call' : 'tool calls'}: ${progressEvent.toolNames.join(', ')}\n`
    );
    return;
  }

  stdout.write(
    `[tools] ${progressEvent.toolName} ${progressEvent.status === 'accepted' ? 'completed' : 'rejected'}\n`
  );
}

function nonCommittedTopLevelTextOption(
  rawEvent: RawEventLogRecord
): { readonly nonCommittedTopLevelText?: string } {
  const result = rawEvent.parsedRoleModelDecisionSnapshot?.result;

  if (result?.status !== 'accepted' || result.nonCommittedText === undefined) {
    return {};
  }

  return {
    nonCommittedTopLevelText: result.nonCommittedText
  };
}

function modelTextVisibilityCommand(
  trimmedLine: string,
  currentlyVisible: boolean
): boolean | undefined {
  if (trimmedLine === modelTextToggleCommand) {
    return !currentlyVisible;
  }

  if (trimmedLine === showModelTextCommand) {
    return true;
  }

  if (trimmedLine === hideModelTextCommand) {
    return false;
  }

  return undefined;
}

function writeNonCommittedTopLevelText(
  stdout: NodeJS.WritableStream,
  text: string
): void {
  stdout.write('[model top-level text | not committed]\n');
  stdout.write(text);

  if (!text.endsWith('\n')) {
    stdout.write('\n');
  }

  stdout.write('[/model top-level text]\n');
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
      result.message,
      result.rawEvent
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
  error?: string,
  rawEvent?: RawEventLogRecord
): ChatTraceSummary {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    status,
    steps: Object.freeze(entries.map((entry) => entry.step)),
    ...traceProviderSummaryOption(rawEvent),
    ...traceToolCallsOption(rawEvent),
    ...(error === undefined ? {} : { error })
  } satisfies ChatTraceSummary);
}

function traceProviderSummaryOption(
  rawEvent: RawEventLogRecord | undefined
): { readonly provider?: ChatTraceProviderSummary } {
  const providerMetadata = rawEvent?.roleModelIOSnapshot?.providerMetadata;

  if (providerMetadata === undefined) {
    return {};
  }

  return {
    provider: Object.freeze({
      name: providerMetadata.provider,
      ...(providerMetadata.model === undefined
        ? {}
        : { model: providerMetadata.model }),
      ...(providerMetadata.response?.status === undefined
        ? {}
        : { responseStatus: providerMetadata.response.status }),
      ...(providerMetadata.error === undefined
        ? {}
        : {
            errorCode: providerMetadata.error.code,
            errorMessage: providerMetadata.error.message
          })
    } satisfies ChatTraceProviderSummary)
  };
}

function traceToolCallsOption(
  rawEvent: RawEventLogRecord | undefined
): { readonly toolCalls?: readonly string[] } {
  const result = rawEvent?.parsedRoleModelDecisionSnapshot?.result;

  if (result?.status !== 'accepted') {
    return {};
  }

  return {
    toolCalls: Object.freeze(result.decision.toolCalls.map((call) => call.name))
  };
}

function writeTraceSummary(
  stderr: NodeJS.WritableStream,
  summary: ChatTraceSummary
): void {
  stderr.write(`${JSON.stringify(summary)}\n`);
}

function parseChatCliArgs(args: readonly string[]): ChatCliArgs {
  let traceMode = false;
  let provider: ChatProviderName | undefined;
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

    if (arg === '--provider') {
      if (provider !== undefined) {
        throw new ChatCliUsageError('--provider can only be provided once.');
      }

      provider = parseProviderName(readFlagValue(args, index, '--provider'));
      index += 1;
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
    ...providerOption(provider ?? providerFromEnvironment(process.env)),
    ...(storeRoot === undefined ? {} : { storeRoot }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(newSessionId === undefined ? {} : { newSessionId })
  } satisfies ChatCliArgs;
}

function parseProviderName(value: string): ChatProviderName {
  if (value === 'local' || value === 'nvidia') {
    return value;
  }

  throw new ChatCliUsageError(
    '--provider must be either "local" or "nvidia".'
  );
}

function providerFromEnvironment(
  env: NodeJS.ProcessEnv
): ChatProviderName | undefined {
  const value = env[roleModelProviderEnvName];

  if (value === undefined || value.length === 0) {
    return undefined;
  }

  try {
    return parseProviderName(value);
  } catch {
    throw new ChatCliUsageError(
      `${roleModelProviderEnvName} must be either "local" or "nvidia".`
    );
  }
}

function providerOption(provider: ChatProviderName | undefined): {
  readonly provider?: ChatProviderName;
} {
  return provider === undefined ? {} : { provider };
}

function createSelectedRoleModelAdapter(
  args: ChatCliArgs
): RoleModelAdapter | undefined {
  if (args.provider !== 'nvidia') {
    return undefined;
  }

  return createNvidiaRoleModelProviderAdapter(
    createNvidiaRoleModelProviderConfigFromEnv()
  );
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
    },
    sessionReadinessValidator: {
      assertSessionReadable(selectedSessionId) {
        const logStore = createFileRuntimeLogStore({
          ...storageOptions,
          sessionId: selectedSessionId
        });

        logStore.traceEntries();
        logStore.rawEvents();
        logStore.conversationMessages();
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
    await sessionStore.readSession(sessionId);
  } catch (error: unknown) {
    if (isMissingDefaultSessionStore(error)) {
      await sessionStore.createSession({ sessionId });
      return;
    }

    throw error;
  }

  await sessionStore.selectSession(sessionId);
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
  error: ChatCliUsageError | LocalRuntimeTerminalError
): string {
  if (error instanceof ChatCliUsageError) {
    return error.message;
  }

  return formatLocalRuntimeTerminalError(error);
}

function isFormattedTerminalError(
  error: unknown
): error is ChatCliUsageError | LocalRuntimeTerminalError {
  return (
    error instanceof ChatCliUsageError ||
    isLocalRuntimeTerminalError(error)
  );
}

function loadDefaultDotEnvFile(): void {
  try {
    loadEnvFile();
  } catch (error: unknown) {
    if (isMissingDotEnvFile(error)) {
      return;
    }

    throw new ChatCliUsageError(
      `Could not load .env file: ${error instanceof Error ? error.message : 'unknown error'}.`
    );
  }
}

function isMissingDotEnvFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
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
