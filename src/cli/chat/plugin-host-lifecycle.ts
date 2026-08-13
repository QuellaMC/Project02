import type {CharacterProfile, ConversationSession} from '../../core/index.ts';
import {buildUserTurnDecisionContext} from '../../role-model/index.ts';
import {
  createConfiguredProject02PluginHostFromPlan,
  type PreparedProject02PluginActivationPlan,
} from '../../app/index.ts';
import {
  runBestEffortPluginSessionEnd,
  runBestEffortPluginShutdown,
} from '../../plugins/host/index.ts';
import {isRuntimePluginPackageConstructionFailure} from '../../plugins/index.ts';
import type {RuntimePluginToolConfirmationHandler} from '../../plugins/index.ts';
import {normalizeLocalRuntimeSessionId} from '../../runtime/storage/index.ts';
import {ChatCliStartupError} from '../shared/terminal-errors.ts';

export type ConfiguredChatPluginHost = Awaited<
  ReturnType<typeof createConfiguredProject02PluginHostFromPlan>
>;

const startupFailurePluginCleanupMessage =
  'chat startup failed before opening a durable session';
const fatalFailurePluginCleanupMessage =
  'chat turn failed before normal /exit cleanup';
const configuredPluginShutdownMessage =
  'chat configured plugin host lifetime ended';

export async function createConfiguredChatPluginHostBeforeSession(options: {
  readonly activationPlan: PreparedProject02PluginActivationPlan;
  readonly toolConfirmationHandler?: RuntimePluginToolConfirmationHandler;
}): Promise<ConfiguredChatPluginHost> {
  try {
    return await createConfiguredProject02PluginHostFromPlan(options);
  } catch (error: unknown) {
    // The loader composes its message from the manifest and declared-safe
    // package text; anything else may carry a resolved secret, so only
    // that one is repeated to the operator.
    throw new ChatCliStartupError(
      isRuntimePluginPackageConstructionFailure(error)
        ? `Configured plugin construction failed before creating a durable session. ${error.message}`
        : 'Configured plugin construction failed before creating a durable session.',
    );
  }
}

export async function shutdownConfiguredChatPluginHost(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly session: ConversationSession;
}): Promise<void> {
  const decisionContext = buildUserTurnDecisionContext({
    session: options.session,
  });

  await runBestEffortPluginShutdown({
    pluginHost: options.configuredHost.host,
    sessionId: decisionContext.sessionId,
    currentUserMessage: configuredPluginShutdownMessage,
    character: decisionContext.characterSnapshot,
  });
}

export async function cleanupConfiguredChatPluginHostAfterFatalExit(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly session: ConversationSession;
}): Promise<void> {
  const decisionContext = buildUserTurnDecisionContext({
    session: options.session,
  });

  await runBestEffortPluginSessionEnd({
    pluginHost: options.configuredHost.host,
    sessionId: decisionContext.sessionId,
    currentUserMessage: fatalFailurePluginCleanupMessage,
    character: decisionContext.characterSnapshot,
  });
}

export async function cleanupConfiguredChatPluginHostAfterStartupFailure(options: {
  readonly configuredHost: ConfiguredChatPluginHost;
  readonly sessionId: string | undefined;
  readonly character: CharacterProfile;
}): Promise<void> {
  const sessionId = normalizeLocalRuntimeSessionId(options.sessionId);

  await runBestEffortPluginSessionEnd({
    pluginHost: options.configuredHost.host,
    sessionId,
    currentUserMessage: startupFailurePluginCleanupMessage,
    character: options.character,
    hookOptions: {allowFileStoreWrites: false},
  });
  await runBestEffortPluginShutdown({
    pluginHost: options.configuredHost.host,
    sessionId,
    currentUserMessage: configuredPluginShutdownMessage,
    character: options.character,
  });
}
