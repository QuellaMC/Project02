import { pathToFileURL } from 'node:url';

import {
  createConversationSession,
  type CharacterAgent
} from '../core/conversation.ts';
import {
  normalizeOneLineMessage,
  OneLineMessageValidationError
} from '../core/message-validation.ts';
import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent
} from '../runtime/event.ts';
import { runLocalUserMessageEvent } from '../runtime/local.ts';
import { createRuntimeLogStore } from '../runtime/log.ts';
import type { RuntimePluginHost } from '../plugins/host.ts';
import { createRuntimePluginContext } from '../plugins/constructors.ts';
import {
  createConfiguredProject02PluginHost,
  createRuntimePluginFactoryCatalogSnapshot,
  diagnosticsHaveErrors,
  loadProject02RuntimeConfig
} from '../runtime/config/index.ts';
import {
  loadRuntimeConfigEnvFile,
  resolveRuntimeConfigActivationBeforeEnvFile,
  RuntimeEnvFileError
} from './runtime-env.ts';

type RelayCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly pluginHost: RuntimePluginHost;
  readonly agent?: CharacterAgent;
};

type ConfiguredRelayCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly agent?: CharacterAgent;
};

const relayMissingReplyErrorMessage = 'Relay completed without a visible reply.';

export async function runRelayCli(
  args: readonly string[],
  options: RelayCliOptions
): Promise<number> {
  try {
    const message = readMessageArg(args);
    const session = createConversationSession();

    try {
      const result = await runLocalUserMessageEvent({
        event: createUserMessageRuntimeEvent(message),
        session,
        logStore: createRuntimeLogStore(),
        pluginHost: options.pluginHost,
        rawInput: message,
        ...(options.agent === undefined ? {} : { agent: options.agent })
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
      await closeRelayPluginSession({
        pluginHost: options.pluginHost,
        sessionId: session.id,
        currentUserMessage: message,
        character: session.character
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
  options: ConfiguredRelayCliOptions
): Promise<number> {
  const env = options.env ?? process.env;
  const loadedConfig = loadProject02RuntimeConfig({ env });
  const loadedConfigDiagnostic = loadedConfig.diagnostics.find(
    (item) => item.severity === 'error'
  );

  if (diagnosticsHaveErrors(loadedConfig.diagnostics)) {
    options.stderr.write(
      `Error: ${loadedConfigDiagnostic?.message ?? 'Runtime config is invalid.'}\n`
    );
    return 1;
  }

  const catalogSnapshot = createRuntimePluginFactoryCatalogSnapshot({
    loadedConfig
  });
  const activationBeforeEnv = resolveRuntimeConfigActivationBeforeEnvFile({
    loadedConfig,
    env,
    catalogSnapshot
  });

  if (activationBeforeEnv !== undefined) {
    const diagnostic = activationBeforeEnv.activation.diagnostics.find(
      (item) => item.severity === 'error'
    );

    options.stderr.write(
      `Error: ${diagnostic?.message ?? 'Runtime plugin activation failed.'}\n`
    );
    return 1;
  }

  let runtimeEnv: NodeJS.ProcessEnv;

  try {
    runtimeEnv = loadRuntimeConfigEnvFile({ loadedConfig, env });
  } catch (error: unknown) {
    if (error instanceof RuntimeEnvFileError) {
      options.stderr.write(`Error: ${error.message}\n`);
      return 1;
    }

    throw error;
  }
  let configuredHost: Awaited<
    ReturnType<typeof createConfiguredProject02PluginHost>
  >;

  try {
    configuredHost = await createConfiguredProject02PluginHost({
      loadedConfig,
      env: runtimeEnv,
      catalogSnapshot
    });
  } catch {
    options.stderr.write(
      'Error: Runtime plugin construction failed before relay startup.\n'
    );
    return 1;
  }

  const diagnostic = configuredHost.activation.diagnostics.find(
    (item) => item.severity === 'error'
  );

  if (diagnosticsHaveErrors(configuredHost.activation.diagnostics)) {
    options.stderr.write(
      `Error: ${diagnostic?.message ?? 'Runtime plugin activation failed.'}\n`
    );
    return 1;
  }

  return await runRelayCli(args, {
    stdout: options.stdout,
    stderr: options.stderr,
    pluginHost: configuredHost.host,
    ...(options.agent === undefined ? {} : { agent: options.agent })
  });
}

async function closeRelayPluginSession(options: {
  readonly pluginHost: RuntimePluginHost;
  readonly sessionId: string;
  readonly currentUserMessage: string;
  readonly character: ReturnType<typeof createConversationSession>['character'];
}): Promise<void> {
  try {
    await options.pluginHost.onSessionEnd(
      createRuntimePluginContext({
        ...createRuntimeEventIdentity(),
        sessionId: options.sessionId,
        eventType: 'USER_MESSAGE',
        currentUserMessage: options.currentUserMessage,
        character: options.character
      })
    );
  } catch {
    // Session cleanup is best-effort and must not mask the relay result.
  }
}

function readMessageArg(args: readonly string[]): string {
  const messageArgs = args[0] === '--' ? args.slice(1) : args;

  if (messageArgs.length !== 1) {
    throw new OneLineMessageValidationError('empty');
  }

  return normalizeOneLineMessage(messageArgs[0]);
}

function isMainModule(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];

  if (scriptPath === undefined) {
    return false;
  }

  return pathToFileURL(scriptPath).href === moduleUrl;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runConfiguredRelayCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr
  });
}
