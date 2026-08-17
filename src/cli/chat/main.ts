import {createInterface} from 'node:readline';

import {
  type CharacterProfile,
  type ConversationSession,
  createConversationSession,
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
  RuntimeEventInputError,
} from '../../core/index.ts';
import {shutdownConfiguredChatPluginHost} from './plugin-host-shutdown.ts';
import {endChatSession, exitCommand} from './session-end.ts';
import {
  parseChatCliArgs,
  validateDurableSessionArgs,
  type ChatCliArgs,
} from './args.ts';
import {
  continueChatSessionIfNeeded,
  durableSessionContinuation,
  writeContinuedSessionNotice,
  type ActiveChatSession,
  type ContinueChatSession,
} from './session-continuation.ts';
import {
  writeNonCommittedTopLevelText,
  writeRuntimeProgress,
  writeTraceSummary,
} from './turn-output.ts';
import {
  recordLocalUserMessageInputRejection,
  runLocalUserMessageEvent,
  type LocalRuntimeTurnProgressEvent,
  type LocalRuntimeUserMessageInputRejectedResult,
  type LocalRuntimeUserMessageResult,
} from '../../runtime/index.ts';
import {
  type RawEventLogRecord,
  type RuntimeLogStore,
  type RuntimeTraceEntry,
} from '../../runtime/index.ts';
import {
  type ChatTraceSummary,
  createRuntimeLogStore,
  createTraceSummary,
  deriveRuntimeTraceEntries,
  sameTraceIdentity,
  type TraceIdentity,
} from '../../runtime/evidence/index.ts';
import {
  acquireLocalRuntimeSessionWriterLease,
  createDurableChatRuntime,
  createLocalRuntimeMutationLockOwnerToken,
  type DurableChatRuntime,
  normalizeLocalRuntimeSessionId,
  runtimeLogStoreWithWriterOwner,
} from '../../runtime/storage/index.ts';
import {
  type RuntimePluginHost,
  type RuntimePluginToolConfirmationHandler,
  type RuntimePluginToolConfirmationRequest,
} from '../../plugins/index.ts';
import {
  createConfiguredProject02PluginHostFromPlan,
  resolveRuntimeCliStartup,
  type PreparedProject02PluginActivationPlan,
  type RuntimePluginFactoryDefinition,
} from '../../app/index.ts';
import {
  diagnosticsHaveErrors,
  runtimeConfigDiagnosticAttribution,
  runtimeConfigDiagnosticLocation,
  type RuntimeConfigDiagnostic,
} from '../../runtime/config/index.ts';
import type {
  RoleModelAdapter,
  RoleModelCharacterRef,
} from '../../role-model/index.ts';
import {
  ChatCliStartupError,
  isCliTerminalError,
  formatCliTerminalErrorMessage,
} from '../shared/terminal-errors.ts';
import {CliUsageError} from '../shared/usage-error.ts';
import {characterActivationFailureMessage} from '../shared/startup-outcome.ts';
import {cliPromptAnswerIsYes} from '../shared/prompt.ts';
import {assertProject02StoreConsent} from '../shared/store-consent.ts';
import {
  createSelectedRoleModelAdapter,
  providerOption,
  selectChatProvider,
} from '../../role-model/index.ts';
import {runBestEffortPluginSessionEnd} from '../../plugins/host/index.ts';
import {isMainModule} from '../shared/main-module.ts';
import {writeJson} from '../shared/output.ts';

type ChatCliOptions = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly traceMode?: boolean;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly pluginHost?: RuntimePluginHost;
  readonly session?: ConversationSession;
  readonly characterProfile?: CharacterProfile;
  readonly characterPersonaSections?: readonly string[];
  readonly characterRef?: RoleModelCharacterRef;
  readonly userDisplayName?: string;
  readonly contextWindowTokens?: number;
  /** Opens the session that continues the current one once its history outgrows the window. */
  readonly continueSession?: ContinueChatSession;
  /** Frees the first session's writer lease when the chat leaves it, not only at exit. */
  readonly releaseSession?: () => Promise<void>;
  readonly logStore?: RuntimeLogStore;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly toolConfirmationBridge?: ChatToolConfirmationBridge;
};

type RunChatCliOptions = Omit<ChatCliOptions, 'pluginHost'> & {
  readonly pluginHost: RuntimePluginHost;
};

type CompletedChatRuntimeTurn = {
  readonly status: 'completed';
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
    handler: RuntimePluginToolConfirmationHandler,
  ): () => void;
};

const modelTextToggleCommand = '/model-text';
const showModelTextCommand = '/show-model-text';
const hideModelTextCommand = '/hide-model-text';
const chatFailedBeforeReplyMessage = 'Chat failed before producing a reply.';

function promptTextFor(session: ConversationSession): string {
  return `${session.userSpeaker.displayName}: `;
}
const startupFailurePluginCleanupMessage =
  'chat startup failed before opening a durable session';
const fatalFailurePluginCleanupMessage =
  'chat turn failed before normal /exit cleanup';

function requiredChatCharacterProfile(
  characterProfile: CharacterProfile | undefined,
): CharacterProfile {
  if (characterProfile === undefined) {
    throw new ChatCliStartupError(
      'Chat startup requires a session or a character profile.',
    );
  }

  return characterProfile;
}

/** Plugins hold the bridge from startup; the terminal handler arrives later. */
function createChatToolConfirmationBridge(): ChatToolConfirmationBridge {
  let activeHandler: RuntimePluginToolConfirmationHandler | undefined;

  return Object.freeze({
    handler(request, context) {
      if (activeHandler === undefined) {
        return {status: 'cancelled'};
      }

      return activeHandler(request, context);
    },
    installTerminalHandler(handler) {
      activeHandler = handler;

      return () => {
        if (activeHandler === handler) {
          activeHandler = undefined;
        }
      };
    },
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
      return {status: 'cancelled'};
    }

    return cliPromptAnswerIsYes(response.value)
      ? {status: 'approved'}
      : {status: 'denied'};
  };
}

type ChatLineResult =
  | {readonly status: 'line'; readonly value: string}
  | {readonly status: 'end'}
  | {readonly status: 'cancelled'};

type ChatLineBroker = {
  next(signal?: AbortSignal): Promise<ChatLineResult>;
};

function createChatLineBroker(iterator: AsyncIterator<string>): ChatLineBroker {
  let pendingRead: Promise<IteratorResult<string>> | undefined;

  return Object.freeze({
    async next(signal?: AbortSignal): Promise<ChatLineResult> {
      if (signal?.aborted === true) {
        return {status: 'cancelled'};
      }

      const read = pendingRead ?? iterator.next();
      pendingRead = read;
      let removeAbortListener: (() => void) | undefined;
      const result = await Promise.race([
        read.then(value => ({status: 'read' as const, value})),
        ...(signal === undefined
          ? []
          : [
              new Promise<{readonly status: 'cancelled'}>(resolve => {
                const abort = () => {
                  resolve({status: 'cancelled'});
                };

                signal.addEventListener('abort', abort, {once: true});
                removeAbortListener = () => {
                  signal.removeEventListener('abort', abort);
                };
              }),
            ]),
      ]);

      removeAbortListener?.();

      if (result.status === 'cancelled') {
        return result;
      }

      if (pendingRead === read) {
        pendingRead = undefined;
      }

      return result.value.done === true
        ? {status: 'end'}
        : {status: 'line', value: result.value.value};
    },
  });
}

function writeTerminalToolConfirmationRequest(
  stdout: NodeJS.WritableStream,
  request: RuntimePluginToolConfirmationRequest,
): void {
  stdout.write('\nPlugin config update requires your approval.\n');
  stdout.write(`${request.summary}\n`);
  writeJson(stdout, request.preview);
  stdout.write('Approve this one exact change? [y/N] ');
}

export async function runChatCliFromArgs(
  args: readonly string[],
  options: ChatCliOptions,
): Promise<number> {
  try {
    const parsedArgs = parseChatCliArgs(args);

    // Fails before startup materializes any durable character state.
    validateDurableSessionArgs(parsedArgs);

    await assertProject02StoreConsent({
      location: parsedArgs,
      init: parsedArgs.init,
      stdout: options.stdout,
      stdin: options.stdin,
      ...(options.env === undefined ? {} : {env: options.env}),
    });

    const startup = await resolveRuntimeCliStartup({
      location: parsedArgs,
      ...(options.env === undefined ? {} : {env: options.env}),
      ...(options.factories === undefined
        ? {}
        : {factories: options.factories}),
      continueAfterActivationErrors: options.pluginHost !== undefined,
      // Run early so an unusable provider env var is reported before
      // startup writes any marker. The config fallback cannot rescue it.
      validateRuntimeEnv: env => {
        selectChatProvider(parsedArgs.provider, env);
      },
    });

    if (startup.status === 'character_invalid') {
      throw new CliUsageError(characterActivationFailureMessage(startup));
    }

    if (startup.status === 'config_invalid') {
      // Resolved-config diagnostics carry both layers, overlay included.
      assertNoRuntimeConfigErrors(
        startup.activationPlan.resolvedConfig.diagnostics,
        'Runtime config is invalid',
      );
      throw new CliUsageError('Runtime config is invalid.');
    }

    if (startup.status === 'activation_blocked_before_runtime_env') {
      assertNoRuntimeConfigErrors(
        startup.activationPlan.activation.diagnostics,
        'Runtime config activation failed',
      );
      throw new CliUsageError('Runtime config activation failed.');
    }

    const runtimeEnv = startup.runtimeEnv;
    const selectedArgs = {
      ...parsedArgs,
      ...providerOption(
        selectChatProvider(
          parsedArgs.provider,
          runtimeEnv,
          startup.activationPlan.resolvedConfig.project02.roleModelProvider,
        ),
      ),
    } satisfies ChatCliArgs;

    const preparedActivationPlan =
      options.pluginHost === undefined ? startup.activationPlan : undefined;
    if (preparedActivationPlan !== undefined) {
      assertNoRuntimeConfigErrors(
        preparedActivationPlan.activation.diagnostics,
        'Runtime config activation failed',
      );
    }
    const runtimeArgs = {
      ...selectedArgs,
      storeRoot: startup.activationPlan.resolvedConfig.project02.storeRoot,
    } satisfies ChatCliArgs;

    validateDurableSessionArgs(runtimeArgs);

    // Character activation ran inside startup, before any plugin resources.
    const characterActivation = startup.characterActivation;

    if (characterActivation.status !== 'resolved') {
      throw new CliUsageError(characterActivationFailureMessage(startup));
    }
    for (const warning of characterActivation.warnings) {
      options.stderr.write(`Warning: ${warning}\n`);
    }
    const toolConfirmationBridge =
      options.pluginHost === undefined
        ? createChatToolConfirmationBridge()
        : undefined;
    const configuredHost =
      preparedActivationPlan === undefined
        ? undefined
        : await createConfiguredChatPluginHostBeforeSession({
            activationPlan: preparedActivationPlan,
            ...(toolConfirmationBridge === undefined
              ? {}
              : {toolConfirmationHandler: toolConfirmationBridge.handler}),
          });
    if (configuredHost !== undefined) {
      assertNoRuntimeConfigErrors(
        configuredHost.activation.diagnostics,
        'Runtime config activation failed',
      );
    }

    return await runChatCliAfterConfiguredHost({
      options,
      runtimeArgs,
      runtimeEnv,
      parsedTraceMode: parsedArgs.traceMode,
      configuredHost,
      toolConfirmationBridge,
      characterProfile: characterActivation.profile,
      characterPersonaSections: characterActivation.personaSections,
      characterRef: characterActivation.characterRef,
      userDisplayName:
        startup.activationPlan.resolvedConfig.project02.userDisplayName,
      contextWindowTokens:
        startup.activationPlan.resolvedConfig.project02.contextWindowTokens,
    });
  } catch (error: unknown) {
    if (isCliTerminalError(error)) {
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
  readonly characterProfile: CharacterProfile;
  readonly characterPersonaSections?: readonly string[];
  readonly characterRef?: RoleModelCharacterRef;
  readonly userDisplayName?: string;
  readonly contextWindowTokens?: number;
}): Promise<number> {
  let durableRuntime: DurableChatRuntime;
  let pluginHost: RuntimePluginHost;
  let roleModelAdapter: RoleModelAdapter | undefined;

  try {
    durableRuntime = await createDurableChatRuntime({
      ...(options.runtimeArgs.storeRoot === undefined
        ? {}
        : {homeRoot: options.runtimeArgs.storeRoot}),
      ...(options.runtimeArgs.sessionId === undefined
        ? {}
        : {sessionId: options.runtimeArgs.sessionId}),
      ...(options.runtimeArgs.newSessionId === undefined
        ? {}
        : {newSessionId: options.runtimeArgs.newSessionId}),
      character: options.characterProfile,
      ...(options.userDisplayName === undefined
        ? {}
        : {userDisplayName: options.userDisplayName}),
    });
    writeContinuedSessionNotice(
      options.options.stdout,
      options.runtimeArgs.sessionId,
      durableRuntime,
    );

    const startupPluginHost =
      options.options.pluginHost ?? options.configuredHost?.host;

    if (startupPluginHost === undefined) {
      throw new ChatCliStartupError(
        'Chat startup did not provide a configured plugin host.',
      );
    }

    pluginHost = startupPluginHost;
    roleModelAdapter = createSelectedRoleModelAdapter(
      options.runtimeArgs.provider,
      options.runtimeEnv,
    );
  } catch (error: unknown) {
    if (options.configuredHost !== undefined) {
      await cleanupConfiguredChatPluginHostAfterStartupFailure({
        configuredHost: options.configuredHost,
        args: options.runtimeArgs,
        character: options.characterProfile,
        stderr: options.options.stderr,
      });
    }

    throw error;
  }

  // The chat may continue into later sessions; cleanup and shutdown name the
  // one it was in at the end, which every continuation reports here.
  const continueSession = durableSessionContinuation({
    homeRoot: options.runtimeArgs.storeRoot,
  });
  let activeSession = durableRuntime.session;

  try {
    const exitCode = await runChatCli({
      ...options.options,
      session: durableRuntime.session,
      logStore: durableRuntime.logStore,
      ...(roleModelAdapter === undefined ? {} : {roleModelAdapter}),
      ...(options.characterPersonaSections === undefined
        ? {}
        : {characterPersonaSections: options.characterPersonaSections}),
      ...(options.characterRef === undefined
        ? {}
        : {characterRef: options.characterRef}),
      ...(options.contextWindowTokens === undefined
        ? {}
        : {contextWindowTokens: options.contextWindowTokens}),
      async continueSession(plan, current) {
        const next = await continueSession(plan, current);

        activeSession = next.session;
        return next;
      },
      releaseSession: () => durableRuntime.writerLease.release(),
      pluginHost,
      ...(options.toolConfirmationBridge === undefined
        ? {}
        : {toolConfirmationBridge: options.toolConfirmationBridge}),
      traceMode: options.options.traceMode === true || options.parsedTraceMode,
    });

    if (exitCode !== 0 && options.configuredHost !== undefined) {
      await cleanupConfiguredChatPluginHostAfterFatalExit({
        configuredHost: options.configuredHost,
        session: activeSession,
      });
    }

    return exitCode;
  } finally {
    if (options.configuredHost !== undefined) {
      await shutdownConfiguredChatPluginHost({
        pluginHost: options.configuredHost.host,
        sessionId: activeSession.id,
        character: activeSession.character,
        stderr: options.options.stderr,
      });
    }
    await durableRuntime.writerLease.release();
  }
}

async function cleanupConfiguredChatPluginHostAfterFatalExit(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly session: ConversationSession;
}): Promise<void> {
  await runBestEffortPluginSessionEnd({
    pluginHost: options.configuredHost.host,
    sessionId: options.session.id,
    currentUserMessage: fatalFailurePluginCleanupMessage,
    character: options.session.character,
  });
}

async function cleanupConfiguredChatPluginHostAfterStartupFailure(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly args: ChatCliArgs;
  readonly character: CharacterProfile;
  readonly stderr: NodeJS.WritableStream;
}): Promise<void> {
  await runBestEffortPluginSessionEnd({
    pluginHost: options.configuredHost.host,
    sessionId: normalizeLocalRuntimeSessionId(
      options.args.newSessionId ?? options.args.sessionId,
    ),
    currentUserMessage: startupFailurePluginCleanupMessage,
    character: options.character,
    hookOptions: {allowFileStoreWrites: false},
  });
  await shutdownConfiguredChatPluginHost({
    pluginHost: options.configuredHost.host,
    sessionId: normalizeLocalRuntimeSessionId(
      options.args.newSessionId ?? options.args.sessionId,
    ),
    character: options.character,
    stderr: options.stderr,
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
      'Configured plugin construction failed before creating a durable session.',
    );
  }
}

function assertNoRuntimeConfigErrors(
  diagnostics: readonly RuntimeConfigDiagnostic[],
  messagePrefix: string,
): void {
  if (!diagnosticsHaveErrors(diagnostics)) {
    return;
  }

  const diagnostic = diagnostics.find(item => item.severity === 'error');
  throw new CliUsageError(
    diagnostic === undefined
      ? messagePrefix
      : formatRuntimeConfigDiagnosticError(messagePrefix, diagnostic),
  );
}

function formatRuntimeConfigDiagnosticError(
  messagePrefix: string,
  diagnostic: RuntimeConfigDiagnostic,
): string {
  return (
    `${messagePrefix}: ${runtimeConfigDiagnosticAttribution(diagnostic)}` +
    `${diagnostic.message} (${runtimeConfigDiagnosticLocation(diagnostic)})`
  );
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
    ownerToken: writerOwnerToken,
  });
  const activeLogStore =
    configuredLogStore.localRuntimeWriterLockOwnerToken === undefined
      ? runtimeLogStoreWithWriterOwner(configuredLogStore, writerOwnerToken)
      : configuredLogStore;

  try {
    return await runChatCliWithActiveWriter({
      ...options,
      logStore: activeLogStore,
      async releaseSession() {
        await writerLease.release();
        await options.releaseSession?.();
      },
    });
  } finally {
    await writerLease.release();
  }
}

async function runChatCliWithActiveWriter(
  options: RunChatCliOptions,
): Promise<number> {
  const session =
    options.session ??
    createConversationSession({
      character: requiredChatCharacterProfile(options.characterProfile),
      ...(options.userDisplayName === undefined
        ? {}
        : {userDisplayName: options.userDisplayName}),
    });
  let active: ActiveChatSession = {
    session,
    logStore:
      options.logStore ??
      createRuntimeLogStore({
        sessionId: session.id,
        boundCharacter: session.character,
        boundUserSpeaker: session.userSpeaker,
      }),
    release: options.releaseSession ?? (() => Promise.resolve()),
  };
  const pluginHost = options.pluginHost;
  const lines = createInterface({
    input: options.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  const lineIterator = lines[Symbol.asyncIterator]();
  const lineBroker = createChatLineBroker(lineIterator);
  const releaseTerminalConfirmationHandler =
    options.toolConfirmationBridge?.installTerminalHandler(
      createTerminalToolConfirmationHandler({
        lines: lineBroker,
        stdout: options.stdout,
      }),
    );
  let showNonCommittedTopLevelText = false;

  options.stdout.write(`${session.character.displayName} is ready.\n`);
  options.stdout.write(promptTextFor(session));

  try {
    for (;;) {
      const nextLine = await lineBroker.next();

      if (nextLine.status !== 'line') {
        break;
      }

      const lineResult = await handleChatInputLine({
        options,
        session: active.session,
        logStore: active.logStore,
        pluginHost,
        line: nextLine.value,
        showNonCommittedTopLevelText,
      });

      if (lineResult.status === 'exit') {
        return lineResult.exitCode;
      }

      showNonCommittedTopLevelText = lineResult.showNonCommittedTopLevelText;

      if (lineResult.turnCompleted) {
        const next = await continueChatSessionIfNeeded({
          current: active,
          pluginHost,
          continueSession: options.continueSession,
          ...(options.roleModelAdapter === undefined
            ? {}
            : {roleModelAdapter: options.roleModelAdapter}),
          ...(options.contextWindowTokens === undefined
            ? {}
            : {contextWindowTokens: options.contextWindowTokens}),
          stdout: options.stdout,
        });

        if (next !== undefined) {
          await active.release();
          active = next;
        }
      }

      options.stdout.write(promptTextFor(active.session));
    }

    await endChatSession({
      session: active.session,
      logStore: active.logStore,
      pluginHost,
    });
  } finally {
    await active.release();
    releaseTerminalConfirmationHandler?.();
    lines.close();
  }

  return 0;
}

type ChatInputLineResult =
  | {
      readonly status: 'continue';
      readonly showNonCommittedTopLevelText: boolean;
      readonly turnCompleted: boolean;
    }
  | {readonly status: 'exit'; readonly exitCode: number};

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
    return {status: 'exit', exitCode: 0};
  }

  const nextModelTextVisibility = modelTextVisibilityCommand(
    trimmedLine,
    options.showNonCommittedTopLevelText,
  );

  if (nextModelTextVisibility !== undefined) {
    options.options.stdout.write(
      `Model top-level text display: ${nextModelTextVisibility ? 'shown' : 'hidden'}.\n`,
    );
    return {
      status: 'continue',
      showNonCommittedTopLevelText: nextModelTextVisibility,
      turnCompleted: false,
    };
  }

  let turnCompleted: boolean;

  try {
    const result = await handleUserMessageThroughRuntime({
      session: options.session,
      logStore: options.logStore,
      line: options.line,
      ...(options.options.roleModelAdapter === undefined
        ? {}
        : {roleModelAdapter: options.options.roleModelAdapter}),
      ...(options.options.characterPersonaSections === undefined
        ? {}
        : {
            characterPersonaSections: options.options.characterPersonaSections,
          }),
      ...(options.options.characterRef === undefined
        ? {}
        : {characterRef: options.options.characterRef}),
      ...(options.options.contextWindowTokens === undefined
        ? {}
        : {contextWindowTokens: options.options.contextWindowTokens}),
      pluginHost: options.pluginHost,
      onProgress(progressEvent) {
        writeRuntimeProgress(
          options.options.stdout,
          options.session,
          progressEvent,
        );
      },
    });

    writeChatRuntimeResult({
      options: options.options,
      session: options.session,
      result,
      showNonCommittedTopLevelText: options.showNonCommittedTopLevelText,
    });

    if (result.status === 'rejected' && result.fatal) {
      return {status: 'exit', exitCode: 1};
    }

    turnCompleted = result.status === 'completed';
  } catch (error: unknown) {
    writeChatInputError(options.options.stderr, error);
    return {status: 'exit', exitCode: 1};
  }

  return {
    status: 'continue',
    showNonCommittedTopLevelText: options.showNonCommittedTopLevelText,
    turnCompleted,
  };
}

function writeChatRuntimeResult(options: {
  readonly options: RunChatCliOptions;
  readonly session: ConversationSession;
  readonly result: Awaited<ReturnType<typeof handleUserMessageThroughRuntime>>;
  readonly showNonCommittedTopLevelText: boolean;
}): void {
  if (options.result.status === 'completed') {
    if (
      options.showNonCommittedTopLevelText &&
      options.result.nonCommittedTopLevelText !== undefined
    ) {
      writeNonCommittedTopLevelText(
        options.options.stdout,
        options.result.nonCommittedTopLevelText,
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
  error: unknown,
): void {
  stderr.write(
    `Error: ${
      isCliTerminalError(error)
        ? formatCliTerminalErrorMessage(error)
        : chatFailedBeforeReplyMessage
    }\n`,
  );
}

type HandleUserMessageThroughRuntimeOptions = {
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  readonly line: string;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly characterPersonaSections?: readonly string[];
  readonly characterRef?: RoleModelCharacterRef;
  readonly contextWindowTokens?: number;
  readonly pluginHost: RuntimePluginHost;
  readonly onProgress?: (
    event: LocalRuntimeTurnProgressEvent,
  ) => Promise<void> | void;
};

async function handleUserMessageThroughRuntime(
  options: HandleUserMessageThroughRuntimeOptions,
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
        ...(options.roleModelAdapter === undefined
          ? {}
          : {roleModelAdapter: options.roleModelAdapter}),
        ...(options.characterPersonaSections === undefined
          ? {}
          : {characterPersonaSections: options.characterPersonaSections}),
        ...(options.characterRef === undefined
          ? {}
          : {characterRef: options.characterRef}),
        ...(options.contextWindowTokens === undefined
          ? {}
          : {contextWindowTokens: options.contextWindowTokens}),
        pluginHost: options.pluginHost,
        ...(options.onProgress === undefined
          ? {}
          : {onProgress: options.onProgress}),
      });

      return mapRuntimeResult(result);
    } catch (error: unknown) {
      if (isCliTerminalError(error)) {
        throw error;
      }

      const evidence = options.logStore.readSessionEvidence();

      return mapUnexpectedRuntimeFailureResult(
        identity,
        options.logStore
          .traceEntries()
          .filter(traceEntry => sameTraceIdentity(traceEntry, identity)),
        evidence.rawEvents.filter(rawEvent =>
          sameTraceIdentity(rawEvent, identity),
        ),
      );
    }
  } catch (error: unknown) {
    if (error instanceof RuntimeEventInputError) {
      const result = recordLocalUserMessageInputRejection({
        identity: error.identity,
        logStore: options.logStore,
        message: error.message,
        rawInput: options.line,
      });

      return mapInputRejectionResult(result);
    }

    throw error;
  }
}

function mapRuntimeResult(
  result: LocalRuntimeUserMessageResult,
): ChatRuntimeTurn {
  if (result.status === 'completed') {
    return {
      status: 'completed',
      ...nonCommittedTopLevelTextOption(result.rawEvent),
      traceSummary: createTraceSummary(
        result.event,
        'completed',
        deriveRuntimeTraceEntries(result.rawEventLogRecords),
        undefined,
        result.rawEvent,
        result.rawEventLogRecords,
      ),
    };
  }

  // Session-safe by construction: the rejection was already durably appended.
  return {
    status: 'rejected',
    errorMessage: result.message,
    fatal: false,
    traceSummary: createTraceSummary(
      result.event,
      'rejected',
      deriveRuntimeTraceEntries(result.rawEventLogRecords),
      result.message,
      result.rawEvent,
      result.rawEventLogRecords,
    ),
  };
}

function nonCommittedTopLevelTextOption(rawEvent: RawEventLogRecord): {
  readonly nonCommittedTopLevelText?: string;
} {
  const result = rawEvent.parsedRoleModelDecisionSnapshot?.result;

  if (result?.status !== 'accepted' || result.nonCommittedText === undefined) {
    return {};
  }

  return {
    nonCommittedTopLevelText: result.nonCommittedText,
  };
}

function modelTextVisibilityCommand(
  trimmedLine: string,
  currentlyVisible: boolean,
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

function mapInputRejectionResult(
  result: LocalRuntimeUserMessageInputRejectedResult,
): RejectedChatRuntimeTurn {
  return {
    status: 'rejected',
    errorMessage: result.message,
    fatal: false,
    traceSummary: createTraceSummary(
      result.identity,
      'rejected',
      deriveRuntimeTraceEntries(result.rawEventLogRecords),
      result.message,
      result.rawEvent,
      result.rawEventLogRecords,
    ),
  };
}

function mapUnexpectedRuntimeFailureResult(
  identity: TraceIdentity,
  traceEntries: readonly RuntimeTraceEntry[],
  rawEvents: readonly RawEventLogRecord[],
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
      rawEvents,
    ),
  };
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runChatCliFromArgs(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
