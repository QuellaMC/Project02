import type {Session} from '../../core/index.ts';
import type {RuntimeLogStore} from '../../runtime/index.ts';
import {
  createContinuedDurableChatRuntime,
  type DurableChatRuntime,
} from '../../runtime/storage/index.ts';
import {
  planSessionContinuation,
  type SessionContinuationPlan,
} from '../../runtime/turn/index.ts';
import type {RoleModelAdapter} from '../../role-model/index.ts';
import type {RuntimePluginHost} from '../../plugins/index.ts';
import {endChatSession} from './session-end.ts';

/** The session the chat loop is writing to, and how to let go of it. */
export type ActiveChatSession = {
  readonly session: Session;
  readonly logStore: RuntimeLogStore;
  release(): Promise<void>;
};

/** Opens the session that continues `current`, keeping its character and speaker. */
export type ContinueChatSession = (
  plan: SessionContinuationPlan,
  current: Session,
) => Promise<DurableChatRuntime>;

/** Naming a closed segment opens it, but the person should know it went on. */
export function writeContinuedSessionNotice(
  stdout: NodeJS.WritableStream,
  namedSessionId: string | undefined,
  durableRuntime: DurableChatRuntime,
): void {
  if (
    namedSessionId !== undefined &&
    durableRuntime.continuedBy !== undefined
  ) {
    stdout.write(
      `Session ${durableRuntime.session.id} was continued in ${durableRuntime.continuedBy}; opening the one you named.\n`,
    );
  }
}

/**
 * Continues in the same home with the identities the current session really
 * has: a reopened session keeps its recorded character and speaker even when
 * the configuration has since changed, and its continuation must too.
 */
export function durableSessionContinuation(options: {
  readonly homeRoot: string | undefined;
}): ContinueChatSession {
  return (plan, current) =>
    createContinuedDurableChatRuntime({
      ...(options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot}),
      character: current.character,
      userDisplayName: current.userSpeaker.displayName,
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

  // The current session stays current until the next one is open: a failure
  // here is reported and the plan is simply made again after the next turn.
  let next: DurableChatRuntime;

  try {
    next = await options.continueSession(plan, session);
  } catch (error: unknown) {
    options.stdout.write(
      `[context] Could not continue in a new session, staying in ${session.id}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return undefined;
  }

  // Closing the old session writes to its log after the new one opened, so
  // the new one is stamped active last: a flagless launch resumes it, never
  // the closed segment.
  try {
    await endChatSession({session, logStore, pluginHost: options.pluginHost});
    await next.markActive();
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
