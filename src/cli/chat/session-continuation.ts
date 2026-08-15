import type {ConversationSession} from '../../core/index.ts';
import type {RuntimeLogStore} from '../../runtime/index.ts';
import {
  createContinuedDurableChatRuntime,
  type DurableChatRuntime,
} from '../../runtime/storage/index.ts';
import type {CharacterProfile} from '../../core/index.ts';
import {
  planSessionContinuation,
  type SessionContinuationPlan,
} from '../../runtime/turn/index.ts';
import type {RoleModelAdapter} from '../../role-model/index.ts';
import type {RuntimePluginHost} from '../../plugins/index.ts';
import {endChatSession} from './session-end.ts';

/** The session the chat loop is writing to, and how to let go of it. */
export type ActiveChatSession = {
  readonly session: ConversationSession;
  readonly logStore: RuntimeLogStore;
  release(): Promise<void>;
};

export type ContinueChatSession = (
  plan: SessionContinuationPlan,
) => Promise<DurableChatRuntime>;

/** Continues into the same home, character, and speaker the chat opened with. */
export function durableSessionContinuation(options: {
  readonly homeRoot: string | undefined;
  readonly character: CharacterProfile;
  readonly userDisplayName: string | undefined;
}): ContinueChatSession {
  return plan =>
    createContinuedDurableChatRuntime({
      ...(options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot}),
      character: options.character,
      ...(options.userDisplayName === undefined
        ? {}
        : {userDisplayName: options.userDisplayName}),
      plan,
    });
}

/**
 * After a completed turn: if the session's history has outgrown its window,
 * open the continuing session, close this one, and hand back the new active
 * session. Returns undefined when nothing changes.
 */
export async function continueChatSessionIfNeeded(options: {
  readonly current: ActiveChatSession;
  readonly pluginHost: RuntimePluginHost;
  readonly continueSession: ContinueChatSession | undefined;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly contextWindowTokens?: number;
  readonly stdout: NodeJS.WritableStream;
}): Promise<ActiveChatSession | undefined> {
  if (options.continueSession === undefined) {
    return undefined;
  }

  const {session, logStore} = options.current;
  const userDisplayName = session.userSpeaker.displayName;
  const plan = await planSessionContinuation({
    sessionId: session.id,
    logStore,
    ...(options.roleModelAdapter === undefined
      ? {}
      : {roleModelAdapter: options.roleModelAdapter}),
    ...(options.contextWindowTokens === undefined
      ? {}
      : {contextWindowTokens: options.contextWindowTokens}),
    characterName: session.character.displayName,
    userDisplayName,
  });

  if (plan === undefined) {
    return undefined;
  }

  const next = await options.continueSession(plan);

  try {
    await endChatSession({session, logStore, pluginHost: options.pluginHost});
  } catch (error: unknown) {
    options.stdout.write(
      `[context] Could not close session ${session.id} cleanly: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }

  options.stdout.write(
    plan.summarizer.status === 'model'
      ? `[context] Continuing in session ${next.session.id}: ${String(
          plan.summarizedTurnCount,
        )} earlier turns condensed into a summary.\n`
      : `[context] Continuing in session ${next.session.id}: ${String(
          plan.summarizedTurnCount,
        )} earlier turns condensed mechanically; the summariser was unavailable (${
          plan.summarizer.reason
        }).\n`,
  );

  return {
    session: next.session,
    logStore: next.logStore,
    release: () => next.writerLease.release(),
  };
}
