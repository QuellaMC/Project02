import { readFlagValue } from '../shared/flags.ts';
import { createInterface } from 'node:readline';

import {
  type CharacterAgent,
  type ConversationSession,
  createConversationSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  RuntimeEventInputError
} from '../../core/index.ts';
import { buildUserTurnDecisionContext } from '../../role-model/index.ts';
import {
  recordLocalUserMessageInputRejection,
  runLocalUserMessageEvent,
  type LocalRuntimeTurnProgressEvent,
  type LocalRuntimeUserMessageInputRejectedResult,
  type LocalRuntimeUserMessageResult
} from '../../runtime/index.ts';
import { recoverPendingRuntimeConfigEffects } from '../../runtime/turn/index.ts';
import {
  type RawEventLogRecord,
  type RuntimeLogStore,
  type RuntimeTraceEntry,
} from '../../runtime/index.ts';
import {
  type ChatTraceSummary,
  createRuntimeLogStore,
  createTraceSummary,
  sameTraceIdentity,
  type TraceIdentity
} from '../../runtime/evidence/index.ts';
import {
  runtimePluginEvidenceOption,
  runtimePluginTurnEvidenceOption
} from '../../runtime/turn/index.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  createDurableChatRuntime,
  createLocalRuntimeMutationLockOwnerToken,
  createLocalRuntimeStorageLayout,
  type DurableChatRuntime,
  normalizeLocalRuntimeSessionId,
  runtimeLogStoreWithWriterOwner
} from '../../runtime/storage/index.ts';
import {
  createRuntimePluginContext,
  type RuntimePluginHookHostResult,
  type RuntimePluginHost,
  type RuntimePluginToolConfirmationHandler,
  type RuntimePluginToolConfirmationRequest
} from '../../plugins/index.ts';
import {
  createConfiguredProject02PluginHostFromPlan,
  resolveRuntimeCliStartup,
  type PreparedProject02PluginActivationPlan,
  type RuntimePluginFactoryDefinition
} from '../../app/index.ts';
import {
  diagnosticsHaveErrors,
  RuntimeEnvFileError,
  type RuntimeConfigDiagnostic
} from '../../runtime/config/index.ts';
import type { RoleModelAdapter } from '../../role-model/index.ts';
import {
  isLocalRuntimeTerminalError,
  type LocalRuntimeTerminalError,
  formatCliTerminalErrorMessage
} from '../shared/terminal-errors.ts';
import {
  parseRuntimeLocationFlag,
  RuntimeLocationCliUsageError,
  type RuntimeLocationCliState
} from '../shared/runtime-location-flags.ts';
import {
  createSelectedRoleModelAdapter, parseProviderName, providerOption,
  RoleModelProviderSelectionError,
  selectChatProvider, type ChatProviderName
} from '../../role-model/index.ts';
import {
  runBestEffortPluginSessionEnd,
  runBestEffortPluginShutdown
} from '../../plugins/host/index.ts';
import { isMainModule } from '../shared/main-module.ts';

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

type ChatCliArgs = {
  readonly traceMode: boolean;
  readonly provider?: ChatProviderName;
  readonly storeRoot?: string;
  readonly configPath?: string;
  readonly sessionId?: string;
  readonly newSessionId?: string;
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
    const selectedArgs = {
      ...parsedArgs,
      ...providerOption(
        selectChatProvider(
          parsedArgs.provider,
          runtimeEnv,
          startup.loadedConfig.config?.project02?.roleModelProvider
        )
      )
    } satisfies ChatCliArgs;

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
    if (isFormattedTerminalError(error)) {
      options.stderr.write(`Error: ${formatCliTerminalErrorMessage(error)}\n`);
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
    recoverPendingRuntimeConfigEffects({
      logStore: durableRuntime.logStore,
      pluginHost
    });
    roleModelAdapter = createSelectedRoleModelAdapter(
      options.runtimeArgs.provider,
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

      await runBestEffortPluginShutdown({
        pluginHost: options.configuredHost.host,
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

  await runBestEffortPluginSessionEnd({
    pluginHost: options.configuredHost.host,
    sessionId: decisionContext.sessionId,
    currentUserMessage: fatalFailurePluginCleanupMessage,
    character: decisionContext.characterSnapshot
  });
}

async function cleanupConfiguredChatPluginHostAfterStartupFailure(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly args: ChatCliArgs;
}): Promise<void> {
  await runBestEffortPluginSessionEnd({
    pluginHost: options.configuredHost.host,
    sessionId: normalizeLocalRuntimeSessionId(
      options.args.newSessionId ?? options.args.sessionId
    ),
    currentUserMessage: startupFailurePluginCleanupMessage,
    character: createConversationSession().character,
    hookOptions: { allowFileStoreWrites: false }
  });
  await runBestEffortPluginShutdown({
    pluginHost: options.configuredHost.host,
    sessionId: normalizeLocalRuntimeSessionId(
      options.args.newSessionId ?? options.args.sessionId
    ),
    currentUserMessage: configuredPluginShutdownMessage,
    character: createConversationSession().character
  });
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

async function runChatCliWithActiveWriter(
  options: RunChatCliOptions
): Promise<number> {
  const session = options.session ?? createConversationSession();
  const logStore =
    options.logStore ?? createRuntimeLogStore({ sessionId: session.id });
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
        ? formatCliTerminalErrorMessage(error)
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

  // A rejected runtime result is session-safe by construction: it exists only
  // after the rejection was durably appended (storage failures throw instead
  // and are wrapped as fatal by mapUnexpectedRuntimeFailureResult). The REPL
  // therefore always continues past it.
  return {
    status: 'rejected',
    errorMessage: result.message,
    fatal: false,
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

      provider = parseProviderName(readFlagValue(args, index, '--provider', (message) => new ChatCliUsageError(message)));
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

      sessionId = readFlagValue(args, index, '--session', (message) => new ChatCliUsageError(message));
      index += 1;
      continue;
    }

    if (arg === '--new-session') {
      if (newSessionId !== undefined) {
        throw new ChatCliUsageError('--new-session can only be provided once.');
      }

      newSessionId = readFlagValue(args, index, '--new-session', (message) => new ChatCliUsageError(message));
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


function isFormattedTerminalError(
  error: unknown
): error is
  | ChatCliUsageError
  | ChatCliStartupError
  | RoleModelProviderSelectionError
  | RuntimeLocationCliUsageError
  | RuntimeEnvFileError
  | LocalRuntimeTerminalError {
  return (
    error instanceof ChatCliUsageError ||
    error instanceof ChatCliStartupError ||
    error instanceof RoleModelProviderSelectionError ||
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
