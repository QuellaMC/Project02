import type {CharacterProfile} from '../../core/index.ts';
import {
  runBestEffortPluginShutdown,
  type RuntimePluginHost,
} from '../../plugins/host/index.ts';

const configuredPluginShutdownMessage =
  'chat configured plugin host lifetime ended';

/**
 * The last thing this host does. Nothing runs after it -- no turn, no
 * health check, and the next launch builds fresh plugins -- so a plugin
 * reporting work it could not finish is telling the person leaving, and
 * this is the only line that reaches them.
 */
export async function shutdownConfiguredChatPluginHost(options: {
  readonly pluginHost: RuntimePluginHost;
  readonly sessionId: string;
  readonly character: CharacterProfile;
  readonly stderr: NodeJS.WritableStream;
}): Promise<void> {
  const result = await runBestEffortPluginShutdown({
    pluginHost: options.pluginHost,
    sessionId: options.sessionId,
    currentUserMessage: configuredPluginShutdownMessage,
    character: options.character,
  });

  // Named, because several plugins shut down together and their
  // host-generated summaries read alike: "cleanup failed" without saying
  // whose leaves the operator nothing to act on.
  for (const evidence of result?.evidence ?? []) {
    if (evidence.status !== 'accepted') {
      options.stderr.write(
        `Warning: ${evidence.pluginId}: ${evidence.summary}\n`,
      );
    }
  }
}
