import type {CharacterProfile} from '../../core/index.ts';
import {createRuntimeEventIdentity} from '../../core/index.ts';
import {createRuntimePluginContext} from '../api/index.ts';
import type {
  RuntimePluginHookHostResult,
  RuntimePluginHost,
  RuntimePluginSessionEndOptions,
} from './host.ts';

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
        character: options.character,
      }),
      options.hookOptions,
    );
  } catch {
    // Cleanup must not mask the startup or fatal turn error that triggered it.
  }
}

/**
 * Returns what shutdown recorded, so a caller can show it: this runs
 * after the last turn, and a plugin reporting work it could not finish
 * has no later hook to say so through.
 */
export async function runBestEffortPluginShutdown(options: {
  readonly pluginHost: RuntimePluginHost;
  readonly sessionId: string;
  readonly currentUserMessage: string;
  readonly character: CharacterProfile;
}): Promise<RuntimePluginHookHostResult | undefined> {
  try {
    return await options.pluginHost.shutdown(
      createRuntimePluginContext({
        ...createRuntimeEventIdentity(),
        sessionId: options.sessionId,
        eventType: 'USER_MESSAGE',
        currentUserMessage: options.currentUserMessage,
        character: options.character,
      }),
    );
  } catch {
    // Best-effort: shutdown must not mask the failing chat lifetime.
    return undefined;
  }
}
