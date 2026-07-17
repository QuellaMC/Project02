import type { CharacterProfile } from '../../core/index.ts';
import { createRuntimeEventIdentity } from '../../core/index.ts';
import { createRuntimePluginContext } from '../api/index.ts';
import type { RuntimePluginHost, RuntimePluginSessionEndOptions } from './host.ts';

/**
 * Best-effort session-end / shutdown hooks shared by the chat and relay
 * CLIs (one owner for the synthesized-context cleanup pattern). Failures
 * are swallowed: cleanup must never mask the error that triggered it.
 */
export async function runBestEffortPluginSessionEnd(options: {
  readonly pluginHost: RuntimePluginHost;
  readonly sessionId: string;
  readonly currentUserMessage: string;
  readonly character: CharacterProfile;
  readonly hookOptions?: RuntimePluginSessionEndOptions;
}): Promise<void> {
  try {
    await options.pluginHost.onSessionEnd(
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

export async function runBestEffortPluginShutdown(options: {
  readonly pluginHost: RuntimePluginHost;
  readonly sessionId: string;
  readonly currentUserMessage: string;
  readonly character: CharacterProfile;
}): Promise<void> {
  try {
    await options.pluginHost.shutdown(
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
