import {
  type CharacterAgent,
  type ConversationSession,
  createConversationSession,
  createUserMessageRuntimeEvent,
  normalizeOneLineMessage,
  OneLineMessageValidationError,
} from '../../core/index.ts';
import {runLocalUserMessageEvent} from '../../runtime/index.ts';
import {createRuntimeLogStore} from '../../runtime/evidence/index.ts';
import type {RuntimePluginHost} from '../../plugins/index.ts';
import {
  createConfiguredProject02PluginHostFromPlan,
  resolveRuntimeCliStartup,
  type RuntimePluginFactoryDefinition,
} from '../../app/index.ts';
import {
  diagnosticsHaveErrors,
  RuntimeEnvFileError,
} from '../../runtime/config/index.ts';
import {
  runBestEffortPluginSessionEnd,
  runBestEffortPluginShutdown,
} from '../../plugins/host/index.ts';
import {isMainModule} from '../shared/main-module.ts';

type RelayCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly pluginHost: RuntimePluginHost;
  readonly agent?: CharacterAgent;
  readonly session?: ConversationSession;
};

type ConfiguredRelayCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly agent?: CharacterAgent;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
};

const relayMissingReplyErrorMessage =
  'Relay completed without a visible reply.';
const configuredRelayShutdownMessage =
  'relay configured plugin host lifetime ended';

export async function runRelayCli(
  args: readonly string[],
  options: RelayCliOptions,
): Promise<number> {
  try {
    const message = readMessageArg(args);
    const session = options.session ?? createConversationSession();

    try {
      const result = await runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(message),
        session,
        logStore: createRuntimeLogStore({sessionId: session.id}),
        pluginHost: options.pluginHost,
        rawInput: message,
        ...(options.agent === undefined ? {} : {agent: options.agent}),
      });

      if (result.status === 'rejected') {
        options.stderr.write(`Error: ${result.message}\n`);
        return 1;
      }

      const replyText = result.turn?.characterMessage.text;

      if (replyText === undefined) {
        options.stderr.write(`Error: ${relayMissingReplyErrorMessage}\n`);
        return 1;
      }

      options.stdout.write(`${session.character.displayName}: ${replyText}\n`);
      return 0;
    } finally {
      await runBestEffortPluginSessionEnd({
        pluginHost: options.pluginHost,
        sessionId: session.id,
        currentUserMessage: message,
        character: session.character,
      });
    }
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
      options.stderr.write(`Error: ${error.message}\n`);
      return 1;
    }

    throw error;
  }
}

export async function runConfiguredRelayCli(
  args: readonly string[],
  options: ConfiguredRelayCliOptions,
): Promise<number> {
  let startup: ReturnType<typeof resolveRuntimeCliStartup>;

  try {
    startup = resolveRuntimeCliStartup({
      ...(options.env === undefined ? {} : {env: options.env}),
      ...(options.factories === undefined
        ? {}
        : {factories: options.factories}),
    });
  } catch (error: unknown) {
    if (error instanceof RuntimeEnvFileError) {
      options.stderr.write(`Error: ${error.message}\n`);
      return 1;
    }

    throw error;
  }

  const startupDiagnostic = (
    startup.status === 'config_invalid'
      ? startup.loadedConfig.diagnostics
      : startup.activationPlan.activation.diagnostics
  ).find(item => item.severity === 'error');

  if (
    startup.status !== 'resolved' ||
    diagnosticsHaveErrors(startup.activationPlan.activation.diagnostics)
  ) {
    options.stderr.write(
      `Error: ${
        startupDiagnostic?.message ??
        (startup.status === 'config_invalid'
          ? 'Runtime config is invalid.'
          : 'Runtime plugin activation failed.')
      }\n`,
    );
    return 1;
  }

  let configuredHost: Awaited<
    ReturnType<typeof createConfiguredProject02PluginHostFromPlan>
  >;

  try {
    configuredHost = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: startup.activationPlan,
    });
  } catch {
    options.stderr.write(
      'Error: Runtime plugin construction failed before relay startup.\n',
    );
    return 1;
  }

  const session = createConversationSession();

  try {
    return await runRelayCli(args, {
      stdout: options.stdout,
      stderr: options.stderr,
      pluginHost: configuredHost.host,
      session,
      ...(options.agent === undefined ? {} : {agent: options.agent}),
    });
  } finally {
    await runBestEffortPluginShutdown({
      pluginHost: configuredHost.host,
      sessionId: session.id,
      currentUserMessage: configuredRelayShutdownMessage,
      character: session.character,
    });
  }
}

function readMessageArg(args: readonly string[]): string {
  const messageArgs = args[0] === '--' ? args.slice(1) : args;

  if (messageArgs.length !== 1) {
    throw new OneLineMessageValidationError('empty');
  }

  return normalizeOneLineMessage(messageArgs[0]);
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runConfiguredRelayCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
