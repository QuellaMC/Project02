import { createInterface } from 'node:readline';

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
import {
  createFileRuntimeLogStore,
  durableRuntimeSessionCharacterProfile
} from '../runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeSessionId
} from '../runtime/storage/layout.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  createLocalRuntimeSessionStore,
  LocalRuntimeSessionStoreError,
  type LocalRuntimeSessionConversationEvidence
} from '../runtime/storage/session-store.ts';
import {
  createLocalRuntimeMutationLockOwnerToken,
  type LocalRuntimeMutationLockLease
} from '../runtime/storage/mutation-lock.ts';
import {
  createRuntimePluginContext,
  type RuntimePluginHookHostResult,
  type RuntimePluginHost,
  type RuntimePluginToolConfirmationHandler,
  type RuntimePluginToolConfirmationRequest
} from '../plugins/index.ts';
import {
  type RuntimePluginSessionEndOptions
} from '../plugins/host.ts';
import {
  createConfiguredProject02PluginHostFromPlan,
  diagnosticsHaveErrors,
  roleModelProviderEnvVarName,
  type PreparedProject02PluginActivationPlan,
  type RuntimeConfigDiagnostic,
  type RuntimePluginFactoryDefinition
} from '../runtime/config/index.ts';
import type { RoleModelAdapter } from '../role-model/loop.ts';
import {
  formatLocalRuntimeTerminalError,
  isLocalRuntimeTerminalError,
  type LocalRuntimeTerminalError
} from '../runtime/terminal-errors.ts';
import {
  parseRuntimeLocationFlag,
  RuntimeLocationCliUsageError,
  type RuntimeLocationCliState
} from './runtime-location.ts';
import {
  RuntimeEnvFileError
} from './runtime-env.ts';
import { isMainModule } from './main-module.ts';
import { resolveRuntimeCliStartup } from './startup.ts';

type ChatCliOptions = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly traceMode?: boolean;
  readonly agent?: CharacterAgent;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly pluginHost?: RuntimePluginHost;
  readonly session?: ConversationSession;
  readonly logStore?: RuntimeLogStore;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly toolConfirmationHandler?: RuntimePluginToolConfirmationHandler;
  readonly toolConfirmationBridge?: ChatToolConfirmationBridge;
};

type RunChatCliOptions = Omit<ChatCliOptions, 'pluginHost'> & {
  readonly pluginHost: RuntimePluginHost;
};

type ChatProviderName = 'local' | 'nvidia';

type ChatCliArgs = {
  readonly traceMode: boolean;
  readonly provider?: ChatProviderName;
  readonly storeRoot?: string;
  readonly configPath?: string;
  readonly sessionId?: string;
  readonly newSessionId?: string;
};

type ChatTraceSummary = {
  readonly eventId: string;
  readonly traceId: string;
  readonly status: RuntimeTurnStatus;
  readonly steps: readonly RuntimeTraceStepName[];
  readonly provider?: ChatTraceProviderSummary;
  readonly requestedToolCalls?: readonly string[];
  readonly executedToolCalls?: readonly string[];
  readonly terminalToolCalls?: readonly string[];
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
  readonly writerLease: LocalRuntimeMutationLockLease;
};

type ConfiguredChatPluginHost = Awaited<
  ReturnType<typeof createConfiguredProject02PluginHostFromPlan>
>;

type ChatToolConfirmationBridge = {
  readonly handler: RuntimePluginToolConfirmationHandler;
  installTerminalHandler(
    handler: RuntimePluginToolConfirmationHandler
  ): () => void;
};

const exitCommand = '/exit';
const modelTextToggleCommand = '/model-text';
const showModelTextCommand = '/show-model-text';
const hideModelTextCommand = '/hide-model-text';
const promptText = 'You: ';
const chatFailedBeforeReplyMessage = 'Chat failed before producing a reply.';
const startupFailurePluginCleanupMessage =
  'chat startup failed before opening a durable session';
const fatalFailurePluginCleanupMessage =
  'chat turn failed before normal /exit cleanup';
const configuredPluginShutdownMessage =
  'chat configured plugin host lifetime ended';

class ChatCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatCliUsageError';
  }
}

class ChatCliStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatCliStartupError';
  }
}

function createChatToolConfirmationBridge(
  injectedHandler: RuntimePluginToolConfirmationHandler | undefined
): ChatToolConfirmationBridge {
  let activeHandler = injectedHandler;

  return Object.freeze({
    handler(request, context) {
      if (activeHandler === undefined) {
        return { status: 'cancelled' };
      }

      return activeHandler(request, context);
    },
    installTerminalHandler(handler) {
      if (injectedHandler !== undefined) {
        return () => {};
      }

      activeHandler = handler;

      return () => {
        if (activeHandler === handler) {
          activeHandler = undefined;
        }
      };
    }
  } satisfies ChatToolConfirmationBridge);
}

function createTerminalToolConfirmationHandler(options: {
  readonly lines: ChatLineBroker;
  readonly stdout: NodeJS.WritableStream;
}): RuntimePluginToolConfirmationHandler {
  return async (request, context) => {
    writeTerminalToolConfirmationRequest(options.stdout, request);
    const response = await options.lines.next(context.signal);

    if (response.status !== 'line') {
      return { status: 'cancelled' };
    }

    const answer = response.value.trim().toLowerCase();

    if (answer === 'y' || answer === 'yes') {
      return { status: 'approved' };
    }

    return { status: 'denied' };
  };
}

type ChatLineResult =
  | { readonly status: 'line'; readonly value: string }
  | { readonly status: 'end' }
  | { readonly status: 'cancelled' };

type ChatLineBroker = {
  next(signal?: AbortSignal): Promise<ChatLineResult>;
};

function createChatLineBroker(
  iterator: AsyncIterator<string>
): ChatLineBroker {
  let pendingRead: Promise<IteratorResult<string>> | undefined;

  return Object.freeze({
    async next(signal?: AbortSignal): Promise<ChatLineResult> {
      if (signal?.aborted === true) {
        return { status: 'cancelled' };
      }

      const read = pendingRead ?? iterator.next();
      pendingRead = read;
      let removeAbortListener: (() => void) | undefined;
      const result = await Promise.race([
        read.then((value) => ({ status: 'read' as const, value })),
        ...(signal === undefined
          ? []
          : [
              new Promise<{ readonly status: 'cancelled' }>((resolve) => {
                const abort = () => {
                  resolve({ status: 'cancelled' });
                };

                signal.addEventListener('abort', abort, { once: true });
                removeAbortListener = () => {
                  signal.removeEventListener('abort', abort);
                };
              })
            ])
      ]);

      removeAbortListener?.();

      if (result.status === 'cancelled') {
        return result;
      }

      if (pendingRead === read) {
        pendingRead = undefined;
      }

      return result.value.done === true
        ? { status: 'end' }
        : { status: 'line', value: result.value.value };
    }
  });
}

function writeTerminalToolConfirmationRequest(
  stdout: NodeJS.WritableStream,
  request: RuntimePluginToolConfirmationRequest
): void {
  stdout.write('\nPlugin config update requires your approval.\n');
  stdout.write(`${request.summary}\n`);
  stdout.write(`${JSON.stringify(request.preview, null, 2)}\n`);
  stdout.write('Approve this one exact change? [y/N] ');
}

export async function runChatCliFromArgs(
  args: readonly string[],
  options: ChatCliOptions
): Promise<number> {
  try {
    const parsedArgs = parseChatCliArgs(args);
    const startup = resolveRuntimeCliStartup({
      location: parsedArgs,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.factories === undefined
        ? {}
        : { factories: options.factories }),
      continueAfterActivationErrors: options.pluginHost !== undefined
    });

    if (startup.status === 'config_invalid') {
      assertNoRuntimeConfigErrors(
        startup.loadedConfig.diagnostics,
        'Runtime config is invalid'
      );
      throw new ChatCliUsageError('Runtime config is invalid.');
    }

    if (startup.status === 'activation_blocked_before_runtime_env') {
      assertNoRuntimeConfigErrors(
        startup.activationPlan.activation.diagnostics,
        'Runtime config activation failed'
      );
      throw new ChatCliUsageError('Runtime config activation failed.');
    }

    const runtimeEnv = startup.runtimeEnv;
    const selectedArgs = selectChatProvider(
      parsedArgs,
      runtimeEnv,
      startup.loadedConfig.config?.project02?.roleModelProvider
    );

    const preparedActivationPlan =
      options.pluginHost === undefined
        ? startup.activationPlan
        : undefined;
    if (preparedActivationPlan !== undefined) {
      assertNoRuntimeConfigErrors(
        preparedActivationPlan.activation.diagnostics,
        'Runtime config activation failed'
      );
    }
    const runtimeArgs = {
      ...selectedArgs,
      storeRoot: startup.activationPlan.resolvedConfig.project02.storeRoot
    } satisfies ChatCliArgs;

    validateDurableSessionArgs(runtimeArgs);
    const toolConfirmationBridge =
      options.pluginHost === undefined
        ? createChatToolConfirmationBridge(options.toolConfirmationHandler)
        : undefined;
    const configuredHost =
      preparedActivationPlan === undefined
        ? undefined
        : await createConfiguredChatPluginHostBeforeSession({
            activationPlan: preparedActivationPlan,
            ...(toolConfirmationBridge === undefined
              ? {}
              : { toolConfirmationHandler: toolConfirmationBridge.handler })
          });
    if (configuredHost !== undefined) {
      assertNoRuntimeConfigErrors(
        configuredHost.activation.diagnostics,
        'Runtime config activation failed'
      );
    }

    return await runChatCliAfterConfiguredHost({
      options,
      runtimeArgs,
      runtimeEnv,
      parsedTraceMode: parsedArgs.traceMode,
      configuredHost,
      toolConfirmationBridge
    });
  } catch (error: unknown) {
    if (
      error instanceof ChatCliUsageError ||
      error instanceof ChatCliStartupError ||
      error instanceof RuntimeLocationCliUsageError ||
      error instanceof RuntimeEnvFileError ||
      isLocalRuntimeTerminalError(error)
    ) {
      options.stderr.write(`Error: ${formatTerminalErrorMessage(error)}\n`);
      return 1;
    }

    throw error;
  }
}

async function runChatCliAfterConfiguredHost(options: {
  readonly options: ChatCliOptions;
  readonly runtimeArgs: ChatCliArgs;
  readonly runtimeEnv: NodeJS.ProcessEnv;
  readonly parsedTraceMode: boolean;
  readonly configuredHost: ConfiguredChatPluginHost | undefined;
  readonly toolConfirmationBridge: ChatToolConfirmationBridge | undefined;
}): Promise<number> {
  let durableRuntime: DurableChatRuntime;
  let pluginHost: RuntimePluginHost;
  let roleModelAdapter: RoleModelAdapter | undefined;

  try {
    durableRuntime = await createDurableChatRuntime(options.runtimeArgs);
    const startupPluginHost =
      options.options.pluginHost ?? options.configuredHost?.host;

    if (startupPluginHost === undefined) {
      throw new ChatCliStartupError(
        'Chat startup did not provide a configured plugin host.'
      );
    }

    pluginHost = startupPluginHost;
    roleModelAdapter = createSelectedRoleModelAdapter(
      options.runtimeArgs,
      options.runtimeEnv
    );
  } catch (error: unknown) {
    if (options.configuredHost !== undefined) {
      await cleanupConfiguredChatPluginHostAfterStartupFailure({
        configuredHost: options.configuredHost,
        args: options.runtimeArgs
      });
    }

    throw error;
  }

  try {
    const exitCode = await runChatCli({
      ...options.options,
      session: durableRuntime.session,
      logStore: durableRuntime.logStore,
      ...(roleModelAdapter === undefined ? {} : { roleModelAdapter }),
      pluginHost,
      ...(options.toolConfirmationBridge === undefined
        ? {}
        : { toolConfirmationBridge: options.toolConfirmationBridge }),
      traceMode: options.options.traceMode === true || options.parsedTraceMode
    });

    if (
      exitCode !== 0 &&
      options.configuredHost !== undefined
    ) {
      await cleanupConfiguredChatPluginHostAfterFatalExit({
        configuredHost: options.configuredHost,
        session: durableRuntime.session
      });
    }

    return exitCode;
  } finally {
    if (options.configuredHost !== undefined) {
      const decisionContext = buildUserTurnDecisionContext({
        session: durableRuntime.session
      });

      await runBestEffortConfiguredChatPluginShutdown({
        configuredHost: options.configuredHost,
        sessionId: decisionContext.sessionId,
        currentUserMessage: configuredPluginShutdownMessage,
        character: decisionContext.characterSnapshot
      });
    }
    await durableRuntime.writerLease.release();
  }
}

async function cleanupConfiguredChatPluginHostAfterFatalExit(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly session: ConversationSession;
}): Promise<void> {
  const decisionContext = buildUserTurnDecisionContext({
    session: options.session
  });

  await runBestEffortConfiguredChatPluginSessionEndCleanup({
    configuredHost: options.configuredHost,
    sessionId: decisionContext.sessionId,
    sessionIdentity: options.session,
    currentUserMessage: fatalFailurePluginCleanupMessage,
    character: decisionContext.characterSnapshot
  });
}

async function cleanupConfiguredChatPluginHostAfterStartupFailure(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly args: ChatCliArgs;
}): Promise<void> {
  await runBestEffortConfiguredChatPluginSessionEndCleanup({
    configuredHost: options.configuredHost,
    sessionId: normalizeLocalRuntimeSessionId(
      options.args.newSessionId ?? options.args.sessionId
    ),
    currentUserMessage: startupFailurePluginCleanupMessage,
    character: createConversationSession().character,
    hookOptions: { allowFileStoreWrites: false }
  });
  await runBestEffortConfiguredChatPluginShutdown({
    configuredHost: options.configuredHost,
    sessionId: normalizeLocalRuntimeSessionId(
      options.args.newSessionId ?? options.args.sessionId
    ),
    currentUserMessage: configuredPluginShutdownMessage,
    character: createConversationSession().character
  });
}

async function runBestEffortConfiguredChatPluginSessionEndCleanup(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly sessionId: string;
  readonly currentUserMessage: string;
  readonly character: ReturnType<typeof createConversationSession>['character'];
  readonly sessionIdentity?: object;
  readonly hookOptions?: RuntimePluginSessionEndOptions;
}): Promise<void> {
  try {
    await options.configuredHost.host.onSessionEnd(
      createRuntimePluginContext({
        ...createRuntimeEventIdentity(),
        sessionId: options.sessionId,
        eventType: 'USER_MESSAGE',
        currentUserMessage: options.currentUserMessage,
        character: options.character
      }),
      options.hookOptions
    );
  } catch {
    // Cleanup must not mask the startup or fatal turn error that triggered it.
  }
}

async function runBestEffortConfiguredChatPluginShutdown(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly sessionId: string;
  readonly currentUserMessage: string;
  readonly character: ReturnType<typeof createConversationSession>['character'];
}): Promise<void> {
  try {
    await options.configuredHost.host.shutdown(
      createRuntimePluginContext({
        ...createRuntimeEventIdentity(),
        sessionId: options.sessionId,
        eventType: 'USER_MESSAGE',
        currentUserMessage: options.currentUserMessage,
        character: options.character
      })
    );
  } catch {
    // Shutdown is best-effort and must not mask the completed or failing chat lifetime.
  }
}

async function createConfiguredChatPluginHostBeforeSession(options: {
  readonly activationPlan: PreparedProject02PluginActivationPlan;
  readonly toolConfirmationHandler?: RuntimePluginToolConfirmationHandler;
}): Promise<ConfiguredChatPluginHost> {
  try {
    return await createConfiguredProject02PluginHostFromPlan(options);
  } catch {
    throw new ChatCliStartupError(
      'Configured plugin construction failed before creating a durable session.'
    );
  }
}

function assertNoRuntimeConfigErrors(
  diagnostics: readonly RuntimeConfigDiagnostic[],
  messagePrefix: string
): void {
  if (!diagnosticsHaveErrors(diagnostics)) {
    return;
  }

  const diagnostic = diagnostics.find((item) => item.severity === 'error');
  throw new ChatCliUsageError(
    diagnostic === undefined
      ? messagePrefix
      : formatRuntimeConfigDiagnosticError(messagePrefix, diagnostic)
  );
}

function formatRuntimeConfigDiagnosticError(
  messagePrefix: string,
  diagnostic: RuntimeConfigDiagnostic
): string {
  const diagnosticLocation =
    diagnostic.path === undefined
      ? diagnostic.code
      : `${diagnostic.code} at ${diagnostic.path}`;

  return `${messagePrefix}: ${diagnostic.message} (${diagnosticLocation})`;
}

export async function runChatCli(options: RunChatCliOptions): Promise<number> {
  const configuredLogStore = options.logStore;
  const sessionPaths = configuredLogStore?.localRuntimeSessionPaths;

  if (configuredLogStore === undefined || sessionPaths === undefined) {
    return await runChatCliWithActiveWriter(options);
  }

  const writerOwnerToken =
    configuredLogStore.localRuntimeWriterLockOwnerToken ??
    createLocalRuntimeMutationLockOwnerToken();
  const writerLease = await acquireLocalRuntimeSessionWriterLease({
    storeRoot: sessionPaths.storeRoot,
    sessionId: sessionPaths.sessionId,
    ownerToken: writerOwnerToken
  });
  const activeLogStore =
    configuredLogStore.localRuntimeWriterLockOwnerToken === undefined
      ? runtimeLogStoreWithWriterOwner(configuredLogStore, writerOwnerToken)
      : configuredLogStore;

  try {
    activeLogStore.recoverAbandonedWriterEvidence?.();
    return await runChatCliWithActiveWriter({
      ...options,
      logStore: activeLogStore
    });
  } finally {
    await writerLease.release();
  }
}

function runtimeLogStoreWithWriterOwner(
  logStore: RuntimeLogStore,
  ownerToken: ReturnType<typeof createLocalRuntimeMutationLockOwnerToken>
): RuntimeLogStore {
  return Object.freeze({
    ...(logStore.localRuntimeSessionPaths === undefined
      ? {}
      : { localRuntimeSessionPaths: logStore.localRuntimeSessionPaths }),
    localRuntimeWriterLockOwnerToken: ownerToken,
    appendTrace(entry) {
      return logStore.appendTrace(entry);
    },
    appendRawEvent(record) {
      return logStore.appendRawEvent(record);
    },
    appendConversationMessage(record, expectedCharacter) {
      return logStore.appendConversationMessage(record, expectedCharacter);
    },
    removeConversationMessages(messageIds) {
      logStore.removeConversationMessages(messageIds);
    },
    ...(logStore.checkpointWriterEvidence === undefined
      ? {}
      : {
          checkpointWriterEvidence() {
            logStore.checkpointWriterEvidence?.();
          }
        }),
    ...(logStore.recoverAbandonedWriterEvidence === undefined
      ? {}
      : {
          recoverAbandonedWriterEvidence() {
            return logStore.recoverAbandonedWriterEvidence?.() ?? false;
          }
        }),
    readSessionEvidence() {
      return logStore.readSessionEvidence();
    },
    traceEntries() {
      return logStore.traceEntries();
    },
    rawEvents() {
      return logStore.rawEvents();
    },
    conversationMessages() {
      return logStore.conversationMessages();
    }
  } satisfies RuntimeLogStore);
}

async function runChatCliWithActiveWriter(
  options: RunChatCliOptions
): Promise<number> {
  const session = options.session ?? createConversationSession();
  const logStore = options.logStore ?? createRuntimeLogStore();
  const pluginHost = options.pluginHost;
  const lines = createInterface({
    input: options.stdin,
    crlfDelay: Infinity,
    terminal: false
  });
  const lineIterator = lines[Symbol.asyncIterator]();
  const lineBroker = createChatLineBroker(lineIterator);
  const releaseTerminalConfirmationHandler =
    options.toolConfirmationBridge?.installTerminalHandler(
      createTerminalToolConfirmationHandler({
        lines: lineBroker,
        stdout: options.stdout
      })
    );
  let showNonCommittedTopLevelText = false;

  options.stdout.write(`${session.character.displayName} is ready.\n`);
  options.stdout.write(promptText);

  try {
    for (;;) {
      const nextLine = await lineBroker.next();

      if (nextLine.status !== 'line') {
        break;
      }

      const lineResult = await handleChatInputLine({
        options,
        session,
        logStore,
        pluginHost,
        line: nextLine.value,
        showNonCommittedTopLevelText
      });

      if (lineResult.status === 'exit') {
        return lineResult.exitCode;
      }

      showNonCommittedTopLevelText = lineResult.showNonCommittedTopLevelText;
    }

    await endChatSession({
      session,
      logStore,
      pluginHost
    });
  } finally {
    releaseTerminalConfirmationHandler?.();
    lines.close();
  }

  return 0;
}

type ChatInputLineResult =
  | {
      readonly status: 'continue';
      readonly showNonCommittedTopLevelText: boolean;
    }
  | { readonly status: 'exit'; readonly exitCode: number };

async function handleChatInputLine(options: {
  readonly options: RunChatCliOptions;
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly pluginHost: RuntimePluginHost;
  readonly line: string;
  readonly showNonCommittedTopLevelText: boolean;
}): Promise<ChatInputLineResult> {
  const trimmedLine = options.line.trim();

  if (trimmedLine === exitCommand) {
    await endChatSession(options);
    return { status: 'exit', exitCode: 0 };
  }

  const nextModelTextVisibility = modelTextVisibilityCommand(
    trimmedLine,
    options.showNonCommittedTopLevelText
  );

  if (nextModelTextVisibility !== undefined) {
    options.options.stdout.write(
      `Model top-level text display: ${nextModelTextVisibility ? 'shown' : 'hidden'}.\n`
    );
    options.options.stdout.write(promptText);
    return {
      status: 'continue',
      showNonCommittedTopLevelText: nextModelTextVisibility
    };
  }

  try {
    const result = await handleUserMessageThroughRuntime({
      session: options.session,
      logStore: options.logStore,
      line: options.line,
      ...(options.options.agent === undefined
        ? {}
        : { agent: options.options.agent }),
      ...(options.options.roleModelAdapter === undefined
        ? {}
        : { roleModelAdapter: options.options.roleModelAdapter }),
      pluginHost: options.pluginHost,
      onProgress(progressEvent) {
        writeRuntimeProgress(
          options.options.stdout,
          options.session,
          progressEvent
        );
      }
    });

    writeChatRuntimeResult({
      options: options.options,
      session: options.session,
      result,
      showNonCommittedTopLevelText: options.showNonCommittedTopLevelText
    });

    if (result.status === 'rejected' && result.fatal) {
      return { status: 'exit', exitCode: 1 };
    }
  } catch (error: unknown) {
    writeChatInputError(options.options.stderr, error);
    return { status: 'exit', exitCode: 1 };
  }

  options.options.stdout.write(promptText);
  return {
    status: 'continue',
    showNonCommittedTopLevelText: options.showNonCommittedTopLevelText
  };
}

function writeChatRuntimeResult(options: {
  readonly options: RunChatCliOptions;
  readonly session: ConversationSession;
  readonly result: Awaited<ReturnType<typeof handleUserMessageThroughRuntime>>;
  readonly showNonCommittedTopLevelText: boolean;
}): void {
  if (options.result.status === 'completed') {
    if (options.result.characterReplyText !== undefined) {
      options.options.stdout.write(
        `${options.session.character.displayName}: ${options.result.characterReplyText}\n`
      );
    }
    if (
      options.showNonCommittedTopLevelText &&
      options.result.nonCommittedTopLevelText !== undefined
    ) {
      writeNonCommittedTopLevelText(
        options.options.stdout,
        options.result.nonCommittedTopLevelText
      );
    }
  } else if (options.options.traceMode !== true) {
    options.options.stderr.write(`Error: ${options.result.errorMessage}\n`);
  }

  if (options.options.traceMode === true) {
    writeTraceSummary(options.options.stderr, options.result.traceSummary);
  }
}

function writeChatInputError(
  stderr: NodeJS.WritableStream,
  error: unknown
): void {
  stderr.write(
    `Error: ${
      isFormattedTerminalError(error)
        ? formatTerminalErrorMessage(error)
        : chatFailedBeforeReplyMessage
    }\n`
  );
}

type EndChatSessionOptions = {
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly pluginHost: RuntimePluginHost;
};

async function endChatSession(options: EndChatSessionOptions): Promise<void> {
  const identity = createRuntimeEventIdentity();
  const decisionContext = buildUserTurnDecisionContext({
    session: options.session
  });
  const context = createRuntimePluginContext({
    ...identity,
    sessionId: decisionContext.sessionId,
    eventType: 'USER_MESSAGE',
    currentUserMessage: exitCommand,
    character: decisionContext.characterSnapshot
  });
  const sessionEndResult = await options.pluginHost.onSessionEnd(context);

  if (!shouldRecordSessionEndResult(options.pluginHost, sessionEndResult)) {
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
      pluginHost: options.pluginHost,
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

type HandleUserMessageThroughRuntimeOptions = {
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly line: string;
  readonly agent?: CharacterAgent;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly pluginHost: RuntimePluginHost;
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
        pluginHost: options.pluginHost,
        ...(options.onProgress === undefined
          ? {}
          : { onProgress: options.onProgress })
      });

      return mapRuntimeResult(result);
    } catch (error: unknown) {
      if (isFormattedTerminalError(error)) {
        throw error;
      }

      const evidence = options.logStore.readSessionEvidence().stored;

      return mapUnexpectedRuntimeFailureResult(
        identity,
        evidence.traceEntries.filter((entry) => sameTraceIdentity(entry, identity)),
        evidence.rawEvents.filter((event) => sameTraceIdentity(event, identity))
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
        result.rawEvent,
        result.rawEventLogRecords
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
      result.rawEvent,
      result.rawEventLogRecords
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
  traceEntries: readonly RuntimeTraceEntry[],
  rawEvents: readonly RawEventLogRecord[]
): RejectedChatRuntimeTurn {
  return {
    status: 'rejected',
    errorMessage: chatFailedBeforeReplyMessage,
    fatal: true,
    traceSummary: createTraceSummary(
      identity,
      'rejected',
      traceEntries,
      chatFailedBeforeReplyMessage,
      undefined,
      rawEvents
    )
  };
}

function sameTraceIdentity(
  evidence: TraceIdentity,
  identity: TraceIdentity
): boolean {
  return (
    evidence.eventId === identity.eventId &&
    evidence.traceId === identity.traceId
  );
}

function createTraceSummary(
  identity: TraceIdentity,
  status: RuntimeTurnStatus,
  entries: readonly RuntimeTraceEntry[],
  error?: string,
  rawEvent?: RawEventLogRecord,
  rawEvents?: readonly RawEventLogRecord[]
): ChatTraceSummary {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    status,
    steps: Object.freeze(entries.map((entry) => entry.step)),
    ...traceProviderSummaryOption(rawEvent, rawEvents),
    ...traceToolCallSummaryOption(rawEvent, rawEvents),
    ...(error === undefined ? {} : { error })
  } satisfies ChatTraceSummary);
}

function traceProviderSummaryOption(
  rawEvent: RawEventLogRecord | undefined,
  rawEvents: readonly RawEventLogRecord[] | undefined
): { readonly provider?: ChatTraceProviderSummary } {
  const providerMetadata =
    rawEvent?.roleModelIOSnapshot?.providerMetadata ??
    [...(rawEvents ?? [])]
      .reverse()
      .find(
        (event) => event.roleModelIOSnapshot?.providerMetadata !== undefined
      )
      ?.roleModelIOSnapshot?.providerMetadata;

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

function traceToolCallSummaryOption(
  terminalRawEvent: RawEventLogRecord | undefined,
  rawEvents: readonly RawEventLogRecord[] | undefined
): {
  readonly requestedToolCalls?: readonly string[];
  readonly executedToolCalls?: readonly string[];
  readonly terminalToolCalls?: readonly string[];
} {
  const turnRawEvents = rawEvents ?? [];
  if (!hasTraceToolCallEvidence(terminalRawEvent, turnRawEvents)) {
    return {};
  }

  const requestedToolCalls = requestedToolCallNames(turnRawEvents);
  const executedToolCalls = executedToolCallNames(turnRawEvents);
  const terminalDecision = terminalDecisionEvidenceRawEvent(
    terminalRawEvent,
    turnRawEvents
  )?.parsedRoleModelDecisionSnapshot?.result;
  const terminalToolCalls =
    terminalDecision?.status === 'accepted'
      ? terminalDecision.decision.toolCalls.map((call) => call.name)
      : [];

  if (terminalDecision?.status === 'rejected') {
    requestedToolCalls.push(...(terminalDecision.requestedToolNames ?? []));
  }

  requestedToolCalls.push(...terminalToolCalls);

  return {
    requestedToolCalls: Object.freeze(requestedToolCalls),
    executedToolCalls: Object.freeze(executedToolCalls),
    terminalToolCalls: Object.freeze(terminalToolCalls)
  };
}

function hasTraceToolCallEvidence(
  terminalRawEvent: RawEventLogRecord | undefined,
  turnRawEvents: readonly RawEventLogRecord[]
): boolean {
  return (
    terminalRawEvent?.parsedRoleModelDecisionSnapshot !== undefined ||
    turnRawEvents.some(
      (event) =>
        event.parsedRoleModelDecisionSnapshot !== undefined ||
        event.kind === 'tool_call_finished'
    )
  );
}

function requestedToolCallNames(
  turnRawEvents: readonly RawEventLogRecord[]
): string[] {
  const requestedToolCalls: string[] = [];
  const seenRequestedDecisions = new Set<string>();

  for (const event of turnRawEvents) {
    if (
      event.kind !== 'tool_call_started' &&
      event.kind !== 'interim_visible_reply_emitted'
    ) {
      continue;
    }

    const decisionSnapshot = event.parsedRoleModelDecisionSnapshot;
    const decisionEvidenceKey = requestedDecisionEvidenceKey(event);

    if (
      decisionSnapshot?.result.status !== 'accepted' ||
      decisionEvidenceKey === undefined ||
      seenRequestedDecisions.has(decisionEvidenceKey)
    ) {
      continue;
    }

    seenRequestedDecisions.add(decisionEvidenceKey);
    requestedToolCalls.push(
      ...decisionSnapshot.result.decision.toolCalls.map((call) => call.name)
    );
  }

  return requestedToolCalls;
}

function executedToolCallNames(
  turnRawEvents: readonly RawEventLogRecord[]
): string[] {
  const executedToolCalls: string[] = [];
  const seenExecutedToolCallIds = new Set<string>();

  for (const event of turnRawEvents) {
    if (
      event.kind !== 'tool_call_finished' ||
      event.dispatchedToHost !== true ||
      event.toolName === undefined
    ) {
      continue;
    }

    if (
      event.toolCallId !== undefined &&
      seenExecutedToolCallIds.has(event.toolCallId)
    ) {
      continue;
    }

    if (event.toolCallId !== undefined) {
      seenExecutedToolCallIds.add(event.toolCallId);
    }

    executedToolCalls.push(event.toolName);
  }

  return executedToolCalls;
}

function requestedDecisionEvidenceKey(event: RawEventLogRecord): string | undefined {
  const roleModelIOSnapshot = event.roleModelIOSnapshot;

  if (
    roleModelIOSnapshot === undefined ||
    event.parsedRoleModelDecisionSnapshot === undefined
  ) {
    return undefined;
  }

  // Every executable round appends at least one observation before the next
  // model invocation. That makes the prior-observation count plus raw output a
  // stable key shared by the interim event and every tool-start event for the
  // same decision, including after durable decoding.
  return `${String(
    roleModelIOSnapshot.inputEnvelope.toolObservations.length
  )}:${roleModelIOSnapshot.rawOutputText}`;
}

function terminalDecisionEvidenceRawEvent(
  terminalRawEvent: RawEventLogRecord | undefined,
  turnRawEvents: readonly RawEventLogRecord[]
): RawEventLogRecord | undefined {
  if (terminalRawEvent !== undefined) {
    return terminalRawEvent;
  }

  const reverseEvents = [...turnRawEvents].reverse();
  const persistedTerminalEvent = reverseEvents.find(
    (event) =>
      (event.kind === 'runtime_turn_completed' ||
        event.kind === 'runtime_turn_rejected') &&
      event.parsedRoleModelDecisionSnapshot !== undefined
  );

  return (
    persistedTerminalEvent ??
    reverseEvents.find(
      (event) =>
        event.kind === 'visible_reply_committed' &&
        (event.visibleMessageIds?.length ?? 0) > 0
    )
  );
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
  let location: RuntimeLocationCliState = {};
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

    const locationResult = parseRuntimeLocationFlag({
      args,
      index,
      state: location
    });

    if (locationResult.status === 'matched') {
      location = locationResult.state;
      index = locationResult.nextIndex;
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
    ...providerOption(provider),
    ...(location.storeRoot === undefined ? {} : { storeRoot: location.storeRoot }),
    ...(location.configPath === undefined ? {} : { configPath: location.configPath }),
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
  const value = env[roleModelProviderEnvVarName];

  if (value === undefined || value.length === 0) {
    return undefined;
  }

  try {
    return parseProviderName(value);
  } catch {
    throw new ChatCliUsageError(
      `${roleModelProviderEnvVarName} must be either "local" or "nvidia".`
    );
  }
}

function providerOption(provider: ChatProviderName | undefined): {
  readonly provider?: ChatProviderName;
} {
  return provider === undefined ? {} : { provider };
}

function selectChatProvider(
  args: ChatCliArgs,
  env: NodeJS.ProcessEnv,
  configuredProvider?: ChatProviderName
): ChatCliArgs {
  return {
    ...args,
    ...providerOption(
      args.provider ?? providerFromEnvironment(env) ?? configuredProvider
    )
  } satisfies ChatCliArgs;
}

function createSelectedRoleModelAdapter(
  args: ChatCliArgs,
  env: NodeJS.ProcessEnv = process.env
): RoleModelAdapter | undefined {
  if (args.provider !== 'nvidia') {
    return undefined;
  }

  return createNvidiaRoleModelProviderAdapter(
    createNvidiaRoleModelProviderConfigFromEnv(env)
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
    sessionReadinessValidator: {
      assertSessionReadable(selectedSessionId) {
        const logStore = createFileRuntimeLogStore({
          ...storageOptions,
          sessionId: selectedSessionId
        });

        logStore.readSessionEvidence();
      }
    }
  });
  const ownerToken = createLocalRuntimeMutationLockOwnerToken();
  const writerLease = await acquireLocalRuntimeSessionWriterLease({
    ...storageOptions,
    sessionId,
    ownerToken
  });

  try {
    if (args.newSessionId !== undefined) {
      await sessionStore.createSession({ sessionId });
    } else if (args.sessionId !== undefined) {
      await sessionStore.selectSession(sessionId);
    } else {
      await selectOrCreateDefaultSession(sessionStore, sessionId);
    }

    const logStore = createFileRuntimeLogStore({
      ...storageOptions,
      sessionId,
      writerLockOwnerToken: ownerToken
    });
    logStore.recoverAbandonedWriterEvidence?.();

    return Object.freeze({
      session: await sessionStore.rehydrateConversationSession(sessionId, {
        conversationLogReader: {
          readConversationMessages() {
            return readDurableConversationEvidence(logStore).messages;
          },
          readConversationEvidence() {
            return readDurableConversationEvidence(logStore);
          }
        }
      }),
      logStore,
      writerLease
    } satisfies DurableChatRuntime);
  } catch (error: unknown) {
    await writerLease.release();
    throw error;
  }
}

function readDurableConversationEvidence(
  logStore: RuntimeLogStore
): LocalRuntimeSessionConversationEvidence {
  const evidence = logStore.readSessionEvidence().stored;

  return Object.freeze({
    character: durableRuntimeSessionCharacterProfile(evidence),
    messages: evidence.conversationMessages
  } satisfies LocalRuntimeSessionConversationEvidence);
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
  error:
    | ChatCliUsageError
    | ChatCliStartupError
    | RuntimeLocationCliUsageError
    | RuntimeEnvFileError
    | LocalRuntimeTerminalError
): string {
  if (
    error instanceof ChatCliUsageError ||
    error instanceof ChatCliStartupError ||
    error instanceof RuntimeLocationCliUsageError ||
    error instanceof RuntimeEnvFileError
  ) {
    return error.message;
  }

  return formatLocalRuntimeTerminalError(error);
}

function isFormattedTerminalError(
  error: unknown
): error is
  | ChatCliUsageError
  | ChatCliStartupError
  | RuntimeLocationCliUsageError
  | RuntimeEnvFileError
  | LocalRuntimeTerminalError {
  return (
    error instanceof ChatCliUsageError ||
    error instanceof ChatCliStartupError ||
    error instanceof RuntimeLocationCliUsageError ||
    error instanceof RuntimeEnvFileError ||
    isLocalRuntimeTerminalError(error)
  );
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runChatCliFromArgs(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  });
}
