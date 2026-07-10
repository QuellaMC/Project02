import { createInterface } from 'node:readline';
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
  createRuntimePluginHost,
  createRuntimePluginContext,
  type RuntimePluginHookHostResult,
  type RuntimePluginHost
} from '../plugins/index.ts';
import {
  runRuntimePluginSessionEndHooks,
  type RuntimePluginSessionEndOptions
} from '../plugins/host.ts';
import {
  createConfiguredProject02PluginHost,
  diagnosticsHaveErrors,
  loadProject02RuntimeConfig,
  roleModelProviderEnvVarName,
  resolveConfiguredProject02PluginActivation,
  resolveProject02RuntimeConfig,
  type RuntimeConfigDiagnostic,
  type RuntimePluginFactory
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
  defaultDotEnvForRuntimeLocation,
  loadRuntimeConfigEnvFile,
  readDefaultDotEnvFile,
  resolveRuntimeConfigActivationBeforeEnvFile,
  RuntimeEnvFileError,
  shouldReadDefaultDotEnvForRuntimeLocation
} from './runtime-env.ts';

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
  readonly factories?: Readonly<Record<string, RuntimePluginFactory>>;
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
};

type ConfiguredChatPluginHost = Awaited<
  ReturnType<typeof createConfiguredProject02PluginHost>
>;

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

export async function runChatCliFromArgs(
  args: readonly string[],
  options: ChatCliOptions
): Promise<number> {
  try {
    const explicitEnv =
      options.env === undefined || options.env === process.env
        ? undefined
        : options.env;
    const parsedArgs = parseChatCliArgs(args);
    const defaultEnv =
      explicitEnv === undefined &&
      shouldReadDefaultDotEnvForRuntimeLocation({
        location: parsedArgs,
        env: process.env
      })
        ? defaultDotEnvForRuntimeLocation(readDefaultDotEnvFile(), parsedArgs)
        : undefined;
    const baseEnv = explicitEnv ?? { ...(defaultEnv ?? {}), ...process.env };
    const loadedConfig = loadProject02RuntimeConfig({
      ...parsedArgs,
      env: baseEnv
    });

    assertNoRuntimeConfigErrors(loadedConfig.diagnostics, 'Runtime config is invalid');

    const activationBeforeEnv =
      options.pluginHost === undefined
        ? resolveRuntimeConfigActivationBeforeEnvFile({
            loadedConfig,
            ...(parsedArgs.storeRoot === undefined
              ? {}
              : { storeRoot: parsedArgs.storeRoot }),
            env: baseEnv,
            diagnoseUncheckedLegacyFactories: true,
            ...(options.factories === undefined ? {} : { factories: options.factories })
          })
        : undefined;

    if (activationBeforeEnv !== undefined) {
      assertNoRuntimeConfigErrors(
        activationBeforeEnv.activation.diagnostics,
        'Runtime config activation failed'
      );
    }

    const runtimeEnv = loadRuntimeConfigEnvFile({
      loadedConfig,
      ...(parsedArgs.storeRoot === undefined ? {} : { storeRoot: parsedArgs.storeRoot }),
      env: explicitEnv ?? process.env,
      ...(defaultEnv === undefined ? {} : { envDefaults: defaultEnv })
    });
    const selectedArgs = selectChatProvider(parsedArgs, runtimeEnv);

    const configuredActivation =
      options.pluginHost === undefined
        ? resolveConfiguredProject02PluginActivation({
            loadedConfig,
            ...(selectedArgs.storeRoot === undefined
              ? {}
              : { storeRoot: selectedArgs.storeRoot }),
            env: runtimeEnv,
            diagnoseUncheckedLegacyFactories: true,
            ...(options.factories === undefined ? {} : { factories: options.factories })
          })
        : undefined;
    const resolvedRuntimeConfig =
      configuredActivation?.resolvedConfig ??
      resolveProject02RuntimeConfig({
        loadedConfig,
        ...(selectedArgs.storeRoot === undefined ? {} : { storeRoot: selectedArgs.storeRoot }),
        env: runtimeEnv
      });
    if (configuredActivation !== undefined) {
      assertNoRuntimeConfigErrors(
        configuredActivation.activation.diagnostics,
        'Runtime config activation failed'
      );
    }
    const runtimeArgs = {
      ...selectedArgs,
      storeRoot: resolvedRuntimeConfig.storeRoot
    } satisfies ChatCliArgs;

    validateDurableSessionArgs(runtimeArgs);
    const configuredHost =
      options.pluginHost === undefined
        ? await createConfiguredChatPluginHostBeforeSession({
            loadedConfig,
            storeRoot: resolvedRuntimeConfig.storeRoot,
            env: runtimeEnv,
            ...(options.factories === undefined ? {} : { factories: options.factories })
          })
        : undefined;
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
      configuredHost
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
}): Promise<number> {
  let durableRuntime: DurableChatRuntime;
  let pluginHost: RuntimePluginHost | undefined;
  let roleModelAdapter: RoleModelAdapter | undefined;

  try {
    durableRuntime = await createDurableChatRuntime(options.runtimeArgs);
    const configuredSessionHost = configuredPluginHostForSession(
      options.configuredHost,
      durableRuntime.session
    );
    pluginHost = options.options.pluginHost ?? configuredSessionHost;
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

  const exitCode = await runChatCli({
    ...options.options,
    ...durableRuntime,
    ...(roleModelAdapter === undefined ? {} : { roleModelAdapter }),
    ...(pluginHost === undefined ? {} : { pluginHost }),
    traceMode: options.options.traceMode === true || options.parsedTraceMode
  });

  if (
    exitCode !== 0 &&
    options.configuredHost !== undefined &&
    pluginHost !== undefined
  ) {
    await cleanupConfiguredChatPluginHostAfterFatalExit({
      configuredHost: options.configuredHost,
      session: durableRuntime.session
    });
  }

  return exitCode;
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
    await runRuntimePluginSessionEndHooks({
      plugins: options.configuredHost.plugins,
      context: createRuntimePluginContext({
        ...createRuntimeEventIdentity(),
        sessionId: options.sessionId,
        eventType: 'USER_MESSAGE',
        currentUserMessage: options.currentUserMessage,
        character: options.character
      }),
      storeRoot: options.configuredHost.resolvedConfig.storeRoot,
      sessionId: options.sessionId,
      ...(options.sessionIdentity === undefined
        ? {}
        : { sessionIdentity: options.sessionIdentity }),
      ...(options.hookOptions === undefined
        ? {}
        : { hookOptions: options.hookOptions })
    });
  } catch {
    // Cleanup must not mask the startup or fatal turn error that triggered it.
  }
}

async function createConfiguredChatPluginHostBeforeSession(options: {
  readonly loadedConfig: Parameters<
    typeof createConfiguredProject02PluginHost
  >[0]['loadedConfig'];
  readonly storeRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactory>>;
}): Promise<ConfiguredChatPluginHost> {
  try {
    return await createConfiguredProject02PluginHost(options);
  } catch {
    throw new ChatCliStartupError(
      'Configured plugin construction failed before creating a durable session.'
    );
  }
}

function configuredPluginHostForSession(
  configuredHost: ConfiguredChatPluginHost | undefined,
  session: ConversationSession
): RuntimePluginHost | undefined {
  if (configuredHost === undefined) {
    return undefined;
  }

  return createRuntimePluginHost({
    plugins: configuredHost.plugins,
    enabledPluginIds: configuredHost.activation.enabledPluginIds,
    storeRoot: configuredHost.resolvedConfig.storeRoot,
    sessionId: session.id,
    sessionIdentity: session
  });
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
        traceEntriesForIdentity(options.logStore, identity),
        rawEventsForIdentity(options.logStore, identity)
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

function rawEventsForIdentity(
  logStore: RuntimeLogStore,
  identity: TraceIdentity
): readonly RawEventLogRecord[] {
  return Object.freeze(
    logStore
      .rawEvents()
      .filter(
        (event) =>
          event.eventId === identity.eventId && event.traceId === identity.traceId
      )
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
  const hasRoleModelEvidence = turnRawEvents.some(
    (event) => event.parsedRoleModelDecisionSnapshot !== undefined
  ) || terminalRawEvent?.parsedRoleModelDecisionSnapshot !== undefined;
  const hasExecutedToolEvidence = turnRawEvents.some(
    (event) => event.kind === 'tool_call_finished'
  );

  if (!hasRoleModelEvidence && !hasExecutedToolEvidence) {
    return {};
  }

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

  const terminalDecision = terminalDecisionEvidenceRawEvent(
    terminalRawEvent,
    turnRawEvents
  )?.parsedRoleModelDecisionSnapshot?.result;
  const terminalToolCalls =
    terminalDecision?.status === 'accepted'
      ? terminalDecision.decision.toolCalls.map((call) => call.name)
      : [];

  requestedToolCalls.push(...terminalToolCalls);

  return {
    requestedToolCalls: Object.freeze(requestedToolCalls),
    executedToolCalls: Object.freeze(executedToolCalls),
    terminalToolCalls: Object.freeze(terminalToolCalls)
  };
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
  env: NodeJS.ProcessEnv
): ChatCliArgs {
  return {
    ...args,
    ...providerOption(args.provider ?? providerFromEnvironment(env))
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
