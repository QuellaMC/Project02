import {
  type CharacterAgent,
  type CharacterProfile,
  type ConversationSession,
  createConversationSession,
  createUserMessageRuntimeEvent,
  normalizeOneLineMessage,
  OneLineMessageValidationError,
} from '../../core/index.ts';
import {runLocalUserMessageEvent} from '../../runtime/index.ts';
import {createRuntimeLogStore} from '../../runtime/evidence/index.ts';
import type {RuntimePluginHost} from '../../plugins/index.ts';
import type {RoleModelCharacterRef} from '../../role-model/index.ts';
import {
  createConfiguredProject02PluginHostFromPlan,
  resolveRuntimeCliStartup,
  type RuntimePluginFactoryDefinition,
} from '../../app/index.ts';
import {
  diagnosticsHaveErrors,
  runtimeConfigDiagnosticAttribution,
  RuntimeEnvFileError,
} from '../../runtime/config/index.ts';
import {
  runBestEffortPluginSessionEnd,
  runBestEffortPluginShutdown,
} from '../../plugins/host/index.ts';
import {
  parseRuntimeLocationFlag,
  RuntimeLocationCliUsageError,
} from '../shared/runtime-location-flags.ts';
import type {RuntimeLocationCliState} from '../shared/runtime-location-flags.ts';
import {
  formatCliTerminalErrorMessage,
  isLocalRuntimeTerminalError,
} from '../shared/terminal-errors.ts';
import {isMainModule} from '../shared/main-module.ts';

type RelayCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly pluginHost: RuntimePluginHost;
  readonly agent?: CharacterAgent;
  readonly session?: ConversationSession;
  readonly character?: CharacterProfile;
  readonly characterPersonaSections?: readonly string[];
  readonly characterRef?: RoleModelCharacterRef;
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
    const session =
      options.session ??
      createConversationSession({
        character: requiredRelayCharacter(options.character),
      });

    try {
      const result = await runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(message),
        session,
        logStore: createRuntimeLogStore({
          sessionId: session.id,
          boundCharacter: session.character,
          boundUserSpeaker: session.userSpeaker,
        }),
        pluginHost: options.pluginHost,
        rawInput: message,
        ...(options.characterPersonaSections === undefined
          ? {}
          : {characterPersonaSections: options.characterPersonaSections}),
        ...(options.characterRef === undefined
          ? {}
          : {characterRef: options.characterRef}),
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
  const invocation = configuredRelayInvocation(args, options.stderr);

  if (typeof invocation === 'number') {
    return invocation;
  }

  const {location, messageArgs} = invocation;

  let startup: Awaited<ReturnType<typeof resolveRuntimeCliStartup>>;

  try {
    startup = await resolveRuntimeCliStartup({
      location,
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

    if (isLocalRuntimeTerminalError(error)) {
      options.stderr.write(`Error: ${formatCliTerminalErrorMessage(error)}\n`);
      return 1;
    }

    throw error;
  }

  // Character activation ran inside startup, before any plugin
  // resources were constructed.
  if (startup.status === 'character_invalid') {
    options.stderr.write(
      `Error: ${
        (startup.characterActivation.status === 'failed'
          ? startup.characterActivation.messages[0]
          : undefined) ?? 'Character activation failed.'
      }\n`,
    );
    return 1;
  }

  const startupDiagnostic = (
    startup.status === 'config_invalid'
      ? startup.activationPlan.resolvedConfig.diagnostics
      : startup.activationPlan.activation.diagnostics
  ).find(item => item.severity === 'error');

  if (
    startup.status !== 'resolved' ||
    diagnosticsHaveErrors(startup.activationPlan.activation.diagnostics)
  ) {
    options.stderr.write(
      `Error: ${
        startupDiagnostic === undefined
          ? startup.status === 'config_invalid'
            ? 'Runtime config is invalid.'
            : 'Runtime plugin activation failed.'
          : `${runtimeConfigDiagnosticAttribution(startupDiagnostic)}${
              startupDiagnostic.message
            }`
      }\n`,
    );
    return 1;
  }

  const characterActivation = startup.characterActivation;

  if (characterActivation.status !== 'resolved') {
    options.stderr.write('Error: Character activation failed.\n');
    return 1;
  }
  for (const warning of characterActivation.warnings) {
    options.stderr.write(`Warning: ${warning}\n`);
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

  const session = createConversationSession({
    character: characterActivation.profile,
    userDisplayName:
      startup.activationPlan.resolvedConfig.project02.userDisplayName,
  });

  try {
    return await runRelayCli(messageArgs, {
      stdout: options.stdout,
      stderr: options.stderr,
      pluginHost: configuredHost.host,
      session,
      characterPersonaSections: characterActivation.personaSections,
      characterRef: characterActivation.characterRef,
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

function requiredRelayCharacter(
  character: CharacterProfile | undefined,
): CharacterProfile {
  if (character === undefined) {
    throw new Error('Relay requires a session or a character profile.');
  }

  return character;
}

/**
 * Parse and input validation for the configured relay, formatted like
 * every other relay failure. Rejecting malformed flags or messages
 * here keeps startup — and its durable materialization — from running
 * on invalid invocations; runRelayCli re-validates for injected-host
 * runs. Returns an exit code when the invocation is malformed.
 */
function configuredRelayInvocation(
  args: readonly string[],
  stderr: NodeJS.WritableStream,
): ReturnType<typeof parseRelayLocationArgs> | number {
  let parsed: ReturnType<typeof parseRelayLocationArgs>;

  try {
    parsed = parseRelayLocationArgs(args);
  } catch (error: unknown) {
    if (error instanceof RuntimeLocationCliUsageError) {
      stderr.write(`Error: ${error.message}\n`);
      return 1;
    }

    throw error;
  }

  try {
    readMessageArg(parsed.messageArgs);
  } catch (error: unknown) {
    if (error instanceof OneLineMessageValidationError) {
      stderr.write(`Error: ${error.message}\n`);
      return 1;
    }

    throw error;
  }

  return parsed;
}

function parseRelayLocationArgs(args: readonly string[]): {
  readonly location: RuntimeLocationCliState;
  readonly messageArgs: readonly string[];
} {
  let location: RuntimeLocationCliState = {};
  const messageArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    // Everything after the separator is message content, even when it
    // looks like a location flag; readMessageArg strips the separator.
    if (arg === '--') {
      messageArgs.push(...args.slice(index));
      break;
    }

    const locationResult = parseRuntimeLocationFlag({
      args,
      index,
      state: location,
    });

    if (locationResult.status === 'matched') {
      location = locationResult.state;
      index = locationResult.nextIndex;
      continue;
    }

    messageArgs.push(arg);
  }

  return {location, messageArgs};
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
