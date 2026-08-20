import {type Session, createRuntimeEventIdentity} from '../../core/index.ts';
import type {RuntimeLogStore} from '../../runtime/index.ts';
import {
  runtimePluginEvidenceOption,
  runtimePluginTurnEvidenceOption,
} from '../../runtime/turn/index.ts';
import {
  createRuntimePluginContext,
  type RuntimePluginHookHostResult,
  type RuntimePluginHost,
} from '../../plugins/index.ts';

export const exitCommand = '/exit';

export type EndChatSessionOptions = {
  readonly session: Session;
  readonly logStore: RuntimeLogStore;
  readonly pluginHost: RuntimePluginHost;
};

export async function endChatSession(
  options: EndChatSessionOptions,
): Promise<void> {
  const identity = createRuntimeEventIdentity();
  const context = createRuntimePluginContext({
    ...identity,
    sessionId: options.session.id,
    eventType: 'USER_MESSAGE',
    currentUserMessage: exitCommand,
    character: options.session.character,
  });
  const sessionEndResult = await options.pluginHost.onSessionEnd(context);

  if (!shouldRecordSessionEndResult(options.pluginHost, sessionEndResult)) {
    return;
  }

  const payloadSummary = {
    rawInput: exitCommand,
    normalizedCurrentUserMessage: exitCommand,
  };

  options.logStore.appendRawEvent({
    ...identity,
    kind: 'runtime_event_received',
    eventType: 'USER_MESSAGE',
    payloadSummary,
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
      pluginHost: options.pluginHost,
      contextItems: [],
      toolInvocations: [],
      evidence: sessionEndResult.evidence,
      health: [],
    }),
  });
}

function shouldRecordSessionEndResult(
  pluginHost: RuntimePluginHost,
  result: RuntimePluginHookHostResult,
): boolean {
  return (
    result.evidence.length > 0 ||
    result.status === 'completed_with_failures' ||
    pluginHost
      .registrySnapshot()
      .plugins.some(plugin =>
        plugin.registeredLifecycleHooks.includes('on_session_end'),
      )
  );
}
