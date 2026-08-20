import {createInterface} from 'node:readline';

import type {CharacterProfile} from '../../core/index.ts';
import {shutdownConfiguredChatPluginHost} from './plugin-host-shutdown.ts';
import {
  parseChatCliArgs,
  validateChatStoreArgs,
  type ChatCliArgs,
} from './args.ts';
import {writeRuntimeProgress, writeTraceSummary} from './turn-output.ts';
import {
  deliverUserMessage,
  endSession,
  exitCommand,
  openConversation,
  type ActiveConversation,
  type LocalRuntimeUserMessageInputRejectedResult,
  type LocalRuntimeUserMessageResult,
  type UserMessageDelivery,
} from '../../runtime/index.ts';
import type {
  RawEventLogRecord,
  RuntimeTraceEntry,
} from '../../runtime/index.ts';
import {
  createTraceSummary,
  deriveRuntimeTraceEntries,
  type ChatTraceSummary,
  type TraceIdentity,
} from '../../runtime/evidence/index.ts';
import {
  type RuntimePluginHost,
  type RuntimePluginToolConfirmationHandler,
  type RuntimePluginToolConfirmationRequest,
} from '../../plugins/index.ts';
import {
  configuredPluginConstructionCleanupSessionId,
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
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
};

export type RunChatCliOptions = {
  readonly conversation: ActiveConversation;
  readonly pluginHost: RuntimePluginHost;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly traceMode?: boolean;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly characterPersonaSections?: readonly string[];
  readonly characterRef?: RoleModelCharacterRef;
  readonly contextWindowTokens?: number;
  readonly toolConfirmationBridge?: ChatToolConfirmationBridge;
};

type CompletedChatRuntimeTurn = {
  readonly status: 'completed';
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

const chatFailedBeforeReplyMessage = 'Chat failed before producing a reply.';

const startupFailurePluginCleanupMessage =
  'chat startup failed before opening a durable session';
const fatalFailurePluginCleanupMessage =
  'chat turn failed before normal /exit cleanup';

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
    validateChatStoreArgs(parsedArgs);

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

    validateChatStoreArgs(runtimeArgs);

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
  let conversation: ActiveConversation;
  let pluginHost: RuntimePluginHost;
  let roleModelAdapter: RoleModelAdapter | undefined;

  try {
    conversation = await openConversation({
      ...(options.runtimeArgs.storeRoot === undefined
        ? {}
        : {homeRoot: options.runtimeArgs.storeRoot}),
      character: options.characterProfile,
      ...(options.userDisplayName === undefined
        ? {}
        : {userDisplayName: options.userDisplayName}),
    });
  } catch (error: unknown) {
    if (options.configuredHost !== undefined) {
      await cleanupConfiguredChatPluginHostAfterStartupFailure({
        configuredHost: options.configuredHost,
        character: options.characterProfile,
        stderr: options.options.stderr,
      });
    }

    throw error;
  }

  try {
    const startupPluginHost =
      options.options.pluginHost ?? options.configuredHost?.host;

    if (startupPluginHost === undefined) {
      throw new ChatCliStartupError(
        'Chat startup did not provide a configured plugin host.',
      );
    }

    pluginHost = startupPluginHost;
    // The selected provider wins; an injected adapter covers the rest.
    roleModelAdapter =
      createSelectedRoleModelAdapter(
        options.runtimeArgs.provider,
        options.runtimeEnv,
      ) ?? options.options.roleModelAdapter;

    const exitCode = await runChatCli({
      conversation,
      pluginHost,
      stdin: options.options.stdin,
      stdout: options.options.stdout,
      stderr: options.options.stderr,
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
      ...(options.toolConfirmationBridge === undefined
        ? {}
        : {toolConfirmationBridge: options.toolConfirmationBridge}),
      traceMode: options.options.traceMode === true || options.parsedTraceMode,
    });

    if (exitCode !== 0 && options.configuredHost !== undefined) {
      await runBestEffortPluginSessionEnd({
        pluginHost: options.configuredHost.host,
        sessionId: conversation.session.id,
        currentUserMessage: fatalFailurePluginCleanupMessage,
        character: conversation.session.character,
      });
    }

    return exitCode;
  } finally {
    // Cleanup and shutdown name the segment the chat ended in.
    if (options.configuredHost !== undefined) {
      await shutdownConfiguredChatPluginHost({
        pluginHost: options.configuredHost.host,
        sessionId: conversation.session.id,
        character: conversation.session.character,
        stderr: options.options.stderr,
      });
    }
    await conversation.close();
  }
}

async function cleanupConfiguredChatPluginHostAfterStartupFailure(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly character: CharacterProfile;
  readonly stderr: NodeJS.WritableStream;
}): Promise<void> {
  await runBestEffortPluginSessionEnd({
    pluginHost: options.configuredHost.host,
    sessionId: configuredPluginConstructionCleanupSessionId,
    currentUserMessage: startupFailurePluginCleanupMessage,
    character: options.character,
    hookOptions: {allowFileStoreWrites: false},
  });
  await shutdownConfiguredChatPluginHost({
    pluginHost: options.configuredHost.host,
    sessionId: configuredPluginConstructionCleanupSessionId,
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
  const {conversation, pluginHost} = options;
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
  options.stdout.write(
    `${conversation.session.character.displayName} is ready.\n`,
  );
  options.stdout.write(promptTextFor(conversation));

  try {
    for (;;) {
      const nextLine = await lineBroker.next();

      if (nextLine.status !== 'line') {
        break;
      }

      const lineResult = await handleChatInputLine({
        options,
        line: nextLine.value,
      });

      if (lineResult.status === 'exit') {
        return lineResult.exitCode;
      }

      options.stdout.write(promptTextFor(conversation));
    }

    await endSession({
      session: conversation.session,
      logStore: conversation.logStore,
      pluginHost,
    });
  } finally {
    releaseTerminalConfirmationHandler?.();
    lines.close();
  }

  return 0;
}

function promptTextFor(conversation: ActiveConversation): string {
  return `${conversation.session.userSpeaker.displayName}: `;
}

type ChatInputLineResult =
  | {readonly status: 'continue'}
  | {readonly status: 'exit'; readonly exitCode: number};

async function handleChatInputLine(options: {
  readonly options: RunChatCliOptions;
  readonly line: string;
}): Promise<ChatInputLineResult> {
  const {conversation, pluginHost} = options.options;

  if (options.line.trim() === exitCommand) {
    await endSession({
      session: conversation.session,
      logStore: conversation.logStore,
      pluginHost,
    });
    return {status: 'exit', exitCode: 0};
  }

  try {
    const delivery = await deliverUserMessage({
      conversation,
      line: options.line,
      pluginHost,
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
      onProgress(progressEvent) {
        writeRuntimeProgress(options.options.stdout, progressEvent);
      },
    });
    const result = mapDelivery(delivery);

    writeChatRuntimeResult({options: options.options, result});

    if (result.status === 'rejected' && result.fatal) {
      return {status: 'exit', exitCode: 1};
    }
  } catch (error: unknown) {
    writeChatInputError(options.options.stderr, error);
    return {status: 'exit', exitCode: 1};
  }

  return {status: 'continue'};
}

function mapDelivery(delivery: UserMessageDelivery): ChatRuntimeTurn {
  switch (delivery.status) {
    case 'completed':
    case 'rejected':
      return mapRuntimeResult(delivery.turn);
    case 'input_rejected':
      return mapInputRejectionResult(delivery.turn);
    case 'failed':
      if (isCliTerminalError(delivery.error)) {
        throw delivery.error;
      }

      return mapUnexpectedRuntimeFailureResult(
        delivery.identity,
        delivery.traceEntries,
        delivery.rawEvents,
      );
  }
}

function writeChatRuntimeResult(options: {
  readonly options: RunChatCliOptions;
  readonly result: ChatRuntimeTurn;
}): void {
  if (
    options.result.status === 'rejected' &&
    options.options.traceMode !== true
  ) {
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

function mapRuntimeResult(
  result: LocalRuntimeUserMessageResult,
): ChatRuntimeTurn {
  if (result.status === 'completed') {
    return {
      status: 'completed',
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
