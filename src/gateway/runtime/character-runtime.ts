import {
  activateProject02Character,
  configuredPluginConstructionCleanupSessionId,
  createConfiguredProject02PluginHostFromPlan,
  listProject02Characters,
  type Project02Home,
  type RuntimeCliStartupResult,
} from '../../app/index.ts';
import type {CharacterProfile} from '../../core/index.ts';
import {
  runBestEffortPluginSessionEnd,
  runBestEffortPluginShutdown,
  type RuntimePluginHost,
  type RuntimePluginToolConfirmationHandler,
} from '../../plugins/index.ts';
import {
  createSelectedRoleModelAdapter,
  selectChatProvider,
  type ChatProviderName,
  type RoleModelAdapter,
  type RoleModelCharacterRef,
} from '../../role-model/index.ts';
import {
  deliverUserMessage,
  endSession,
  openConversation,
  type ActiveConversation,
  type SegmentRotation,
  type UserMessageDelivery,
} from '../../runtime/index.ts';
import {LocalRuntimeStorageContractError} from '../../runtime/storage/index.ts';
import type {
  CharacterRuntime,
  CharacterRuntimeHealth,
  CharacterRuntimeState,
  GatewayEvent,
  GatewayEventListener,
  GatewayMessage,
  GatewayRefusalReason,
  MaintenanceFailure,
  OpenOutcome,
  PendingConfirmation,
  TurnOutcome,
  Unsubscribe,
} from '../api/contract.ts';
import {
  createConfirmationBroker,
  type ConfirmationBroker,
} from './confirmation-broker.ts';

export type LocalCharacterRuntimeOptions = {
  /** Loaded fresh per assembly, so config fixes reach retries. */
  readonly loadHome: () => Project02Home;
  readonly characterId: string;
  /**
   * Test and dev injection; a production start constructs everything. The
   * factory receives this runtime's confirmation seam, so an injected host
   * parks confirmations exactly like a constructed one.
   */
  readonly createPluginHost?: (
    confirmations: RuntimePluginToolConfirmationHandler,
  ) => RuntimePluginHost;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly provider?: ChatProviderName;
};

export type LocalCharacterRuntime = CharacterRuntime & {
  /** Open-or-resume the user DM; idempotent while the runtime is ready. */
  openDirectConversation(): Promise<OpenOutcome>;
};

type AssembledCharacter = {
  readonly profile: CharacterProfile;
  readonly host: RuntimePluginHost;
  readonly ownsHost: boolean;
  readonly adapter?: RoleModelAdapter;
  readonly personaSections: readonly string[];
  readonly characterRef: RoleModelCharacterRef;
  readonly contextWindowTokens: number;
  readonly userDisplayName: string;
  readonly storeRoot: string;
};

type RuntimeContext = {
  readonly options: LocalCharacterRuntimeOptions;
  readonly characterId: string;
  readonly listeners: Set<GatewayEventListener>;
  readonly conversations: Map<string, ActiveConversation>;
  readonly broker: ConfirmationBroker;
  state: CharacterRuntimeState;
  failure: string | undefined;
  maintenance: MaintenanceFailure | undefined;
  assembled: AssembledCharacter | undefined;
  queue: Promise<unknown>;
  opening: Promise<OpenOutcome> | undefined;
  stopping: Promise<void> | undefined;
  releasing: Promise<string[]> | undefined;
};

const hostShutdownMessage = 'character runtime plugin host lifetime ended';

function disabledMessage(characterId: string): string {
  return (
    `Character "${characterId}" is disabled. Set project02.enabled to ` +
    'true in its character config, or remove the global project02.enabled.'
  );
}
const constructionFailureMessage =
  'Configured plugin construction failed before creating a durable session.';

export function createLocalCharacterRuntime(
  options: LocalCharacterRuntimeOptions,
): LocalCharacterRuntime {
  const {characterId} = options;
  const listeners = new Set<GatewayEventListener>();
  const context: RuntimeContext = {
    options,
    characterId,
    listeners,
    conversations: new Map(),
    broker: createConfirmationBroker({
      characterId,
      emit: event => {
        emit(listeners, event);
      },
      onSettled: (id, decision) => {
        emit(listeners, {
          kind: 'confirmation_settled',
          characterId,
          id,
          decision,
        });
      },
    }),
    state: 'stopped',
    failure: undefined,
    maintenance: undefined,
    assembled: undefined,
    queue: Promise.resolve(),
    opening: undefined,
    stopping: undefined,
    releasing: undefined,
  };

  return Object.freeze({
    characterId,
    start: () => startRuntime(context),
    async stop(): Promise<void> {
      context.stopping ??= stopRuntime(context);
      await context.stopping;
    },
    reactivate: () => reactivateRuntime(context),
    deliver: (message: GatewayMessage) => deliverMessage(context, message),
    pendingConfirmations(): readonly PendingConfirmation[] {
      return Object.freeze(
        context.broker
          .pending()
          .map(parked => Object.freeze({characterId, ...parked})),
      );
    },
    answerConfirmation(id, decision) {
      return context.broker.answer(id, decision);
    },
    health(): CharacterRuntimeHealth {
      return Object.freeze({
        characterId,
        state: context.state,
        openConversationIds: Object.freeze([...context.conversations.keys()]),
        ...(context.failure === undefined ? {} : {failure: context.failure}),
        ...(context.maintenance === undefined
          ? {}
          : {maintenance: context.maintenance}),
      });
    },
    events(listener: GatewayEventListener): Unsubscribe {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    openDirectConversation(): Promise<OpenOutcome> {
      // A cached attachment is only as alive as the runtime: off ready,
      // the outcome explains the state instead of handing back a stale ref.
      if (lifecycleLeft(context, 'ready')) {
        return Promise.resolve(unavailableOutcome(context));
      }

      // Only an opened thread is worth remembering: a refusal or a failure
      // clears the memo so the next attach tries again.
      context.opening ??= openDirect(context).then(
        outcome => {
          if (outcome.status !== 'opened') {
            context.opening = undefined;
          }

          return outcome;
        },
        (error: unknown) => {
          context.opening = undefined;
          throw error;
        },
      );

      return context.opening;
    },
  });
}

// A client rendering bug must not break a character's turn: listener
// failures stay the listener's problem.
function emit(
  listeners: ReadonlySet<GatewayEventListener>,
  event: GatewayEvent,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // Isolation is the rule; there is no one to report a listener to.
    }
  }
}

function setState(
  context: RuntimeContext,
  next: CharacterRuntimeState,
  message?: string,
): void {
  context.state = next;
  context.failure = next === 'failed' ? message : undefined;
  emit(context.listeners, {
    kind: 'state_changed',
    characterId: context.characterId,
    state: next,
    ...(message === undefined ? {} : {message}),
  });
}

function enqueue<T>(
  context: RuntimeContext,
  job: () => Promise<T>,
): Promise<T> {
  const run = context.queue.then(job, job);

  context.queue = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

async function startRuntime(context: RuntimeContext): Promise<void> {
  if (context.state !== 'stopped') {
    throw new TypeError(
      `Character "${context.characterId}" cannot start from state ` +
        `"${context.state}".`,
    );
  }

  context.stopping = undefined;
  // A fresh boot re-arms the broker that the previous stop left cancelling.
  context.broker.arm();

  // Assembly rides the queue — enqueued before 'starting' is announced, so
  // even a stop issued from that event drains it: shutdown never resolves
  // while construction or its discard cleanup is still running.
  const run = enqueue(context, () => runStart(context));

  setState(context, 'starting');

  return run;
}

async function runStart(context: RuntimeContext): Promise<void> {
  let assembled: AssembledCharacter;

  try {
    assembled = await assemble(context);
  } catch (error: unknown) {
    // A stop that overtook the failing assembly wins: it already published
    // 'stopped', and a late 'failed' would outlive the shutdown.
    if (lifecycleLeft(context, 'starting')) {
      return;
    }

    setState(
      context,
      'failed',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  context.assembled = assembled;

  // A stop that arrived while assembly ran wins: what was built is handed
  // to the draining stop's release, which shuts it down like any assembled
  // host and reports what its cleanup could not free.
  if (lifecycleLeft(context, 'starting')) {
    return;
  }

  setState(context, 'ready');
}

/** True when the lifecycle moved off `expected` while an await ran. */
function lifecycleLeft(
  context: RuntimeContext,
  expected: CharacterRuntimeState,
): boolean {
  return context.state !== expected;
}

/** Failures throw: startRuntime is the one place that publishes them. */
async function assemble(context: RuntimeContext): Promise<AssembledCharacter> {
  const {options, characterId} = context;
  const home = options.loadHome();

  // The enabled decision lives on this seam so reactivation honors a
  // disable that landed while the character was running — and it runs
  // before activation, which materializes durable character state.
  const listed = listProject02Characters(home).characters.find(
    character => character.id === characterId,
  );

  if (listed?.enabled === false) {
    throw new Error(disabledMessage(characterId));
  }

  const startup = await activateProject02Character(home, {
    characterId,
    continueAfterActivationErrors: options.createPluginHost !== undefined,
    // Runs in the planning phase, so a bad provider value is refused
    // before any durable character state is written.
    validateRuntimeEnv: env => {
      selectChatProvider(options.provider, env);
    },
  });

  if (
    startup.status !== 'resolved' ||
    startup.characterActivation.status !== 'resolved'
  ) {
    throw new Error(startupFailureMessage(startup));
  }

  const activation = startup.characterActivation;
  const project02 = startup.activationPlan.resolvedConfig.project02;

  // The resolved plan has the final word on enabled: a disable that landed
  // between the listing read above and this activation still refuses.
  if (!project02.enabled) {
    throw new Error(disabledMessage(characterId));
  }

  const shared = {
    profile: activation.profile,
    personaSections: activation.personaSections,
    characterRef: activation.characterRef,
    contextWindowTokens: project02.contextWindowTokens,
    userDisplayName: project02.userDisplayName,
    storeRoot: project02.storeRoot,
  };
  // The selected provider wins; an injected adapter covers the rest.
  const adapter =
    createSelectedRoleModelAdapter(
      selectChatProvider(
        options.provider,
        startup.runtimeEnv,
        project02.roleModelProvider,
      ),
      startup.runtimeEnv,
    ) ?? options.roleModelAdapter;
  const adapterOption = adapter === undefined ? {} : {adapter};

  if (options.createPluginHost !== undefined) {
    return {
      ...shared,
      ...adapterOption,
      host: options.createPluginHost(context.broker.handler),
      ownsHost: false,
    };
  }

  const blocking = startup.activationPlan.activation.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (blocking !== undefined) {
    throw new Error(`Runtime config activation failed: ${blocking.message}`);
  }

  let configured;

  try {
    configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan: startup.activationPlan,
      toolConfirmationHandler: context.broker.handler,
    });
  } catch {
    throw new Error(constructionFailureMessage);
  }

  const constructed = configured.activation.diagnostics.find(
    diagnostic => diagnostic.severity === 'error',
  );

  if (constructed !== undefined) {
    await cleanUpHostAfterFailedStart(configured.host, activation.profile);
    throw new Error(`Runtime config activation failed: ${constructed.message}`);
  }

  return {...shared, ...adapterOption, host: configured.host, ownsHost: true};
}

async function openDirect(context: RuntimeContext): Promise<OpenOutcome> {
  const {assembled} = context;

  if (context.state !== 'ready' || assembled === undefined) {
    return unavailableOutcome(context);
  }

  let active: ActiveConversation;

  try {
    active = await openConversation({
      homeRoot: assembled.storeRoot,
      character: assembled.profile,
      userDisplayName: assembled.userDisplayName,
    });
  } catch (error: unknown) {
    // Another process holds the thread, or the store itself is broken:
    // both are the caller's to hear about, and neither is a bug.
    if (error instanceof LocalRuntimeStorageContractError) {
      return error.code === 'conversation_busy'
        ? refusedOpen('conversation_busy', error.message)
        : Object.freeze({
            status: 'failed' as const,
            code: error.code,
            message: error.message,
          });
    }

    throw error;
  }

  // Registered before the overtake check: a stop that arrived while the
  // thread opened releases it through the one release path, which retains
  // it like any conversation if that close fails.
  context.conversations.set(active.conversation.id, active);

  if (lifecycleLeft(context, 'ready')) {
    return refusedOpen(
      'character_unavailable',
      `Character "${context.characterId}" stopped while attaching.`,
    );
  }

  return Object.freeze({
    status: 'opened' as const,
    conversationId: active.conversation.id,
    characterId: context.characterId,
    userParticipantId: active.session.userSpeaker.id,
  });
}

function unavailableOutcome(context: RuntimeContext): OpenOutcome {
  return refusedOpen(
    'character_unavailable',
    `Character "${context.characterId}" is not ready (state ` +
      `"${context.state}").`,
  );
}

function refusedOpen(
  reason: Extract<OpenOutcome, {status: 'refused'}>['reason'],
  message: string,
): OpenOutcome {
  return Object.freeze({status: 'refused' as const, reason, message});
}

function deliverMessage(
  context: RuntimeContext,
  message: GatewayMessage,
): Promise<TurnOutcome> {
  if (context.state !== 'ready') {
    return Promise.resolve(
      refusedOutcome(
        'character_unavailable',
        `Character "${context.characterId}" is not ready (state ` +
          `"${context.state}").`,
      ),
    );
  }

  const active = context.conversations.get(message.conversationId);

  if (active === undefined) {
    return Promise.resolve(
      refusedOutcome(
        'unknown_conversation',
        `Character "${context.characterId}" holds no open conversation ` +
          `"${message.conversationId}".`,
      ),
    );
  }

  if (message.senderId !== active.session.userSpeaker.id) {
    return Promise.resolve(
      refusedOutcome(
        'sender_not_supported',
        `Conversation "${message.conversationId}" accepts messages from ` +
          `its local user only; "${message.senderId}" is not driven yet.`,
      ),
    );
  }

  return enqueue(context, () => runTurn(context, active, message));
}

async function runTurn(
  context: RuntimeContext,
  active: ActiveConversation,
  message: GatewayMessage,
): Promise<TurnOutcome> {
  const {assembled} = context;

  // A turn accepted while ready still drains during 'stopping'; only a
  // fatal turn ahead of it in the queue voids what is already queued.
  if (context.state === 'failed' || assembled === undefined) {
    return refusedOutcome(
      'character_unavailable',
      `Character "${context.characterId}" is not ready (state ` +
        `"${context.state}").`,
    );
  }

  let delivery: UserMessageDelivery;

  try {
    delivery = await deliverUserMessage({
      conversation: active,
      line: message.text,
      source: message.source,
      clientMessageId: message.clientMessageId,
      pluginHost: assembled.host,
      ...(assembled.adapter === undefined
        ? {}
        : {roleModelAdapter: assembled.adapter}),
      characterPersonaSections: assembled.personaSections,
      characterRef: assembled.characterRef,
      contextWindowTokens: assembled.contextWindowTokens,
      onProgress: progress => {
        emit(context.listeners, {
          kind: 'turn_progress',
          characterId: context.characterId,
          conversationId: message.conversationId,
          progress,
        });
      },
    });
  } catch (error: unknown) {
    return fatalOutcome(context, message.conversationId, error);
  }

  if (delivery.status === 'failed') {
    return fatalOutcome(context, message.conversationId, delivery.error);
  }

  if (delivery.status === 'completed') {
    recordMaintenance(context, delivery.rotation);

    return Object.freeze({
      status: 'completed' as const,
      characterId: context.characterId,
      conversationId: message.conversationId,
      messages: delivery.turn.conversationMessages.map(record =>
        Object.freeze({
          messageId: record.id,
          speakerId: record.speakerId,
          speakerName: record.speakerName,
          text: record.text,
        }),
      ),
    });
  }

  return Object.freeze({
    status: 'rejected' as const,
    characterId: context.characterId,
    conversationId: message.conversationId,
    reason: delivery.turn.reason,
    message: delivery.turn.message,
  });
}

/**
 * Rotation is the character's memory management, invisible to the
 * conversation: a failed rotation is planned again next turn, and a closed
 * segment's failed session end is already in its log. What the person can
 * do about either is know — through health and the stream, never as the
 * turn's outcome, which stays completed.
 */
function recordMaintenance(
  context: RuntimeContext,
  rotation: SegmentRotation | undefined,
): void {
  const message =
    rotation === undefined
      ? undefined
      : rotation.status === 'failed'
        ? rotation.message
        : rotation.endFailure;

  if (message === undefined) {
    return;
  }

  const failure = Object.freeze({at: new Date().toISOString(), message});

  context.maintenance = failure;
  emit(context.listeners, {
    kind: 'maintenance_failed',
    characterId: context.characterId,
    ...failure,
  });
}

function fatalOutcome(
  context: RuntimeContext,
  conversationId: string,
  error: unknown,
): TurnOutcome {
  const message = error instanceof Error ? error.message : String(error);

  setState(context, 'failed', message);

  return Object.freeze({
    status: 'failed' as const,
    characterId: context.characterId,
    conversationId,
    message,
  });
}

function refusedOutcome(
  reason: GatewayRefusalReason,
  message: string,
): TurnOutcome {
  return Object.freeze({status: 'refused' as const, reason, message});
}

async function stopRuntime(context: RuntimeContext): Promise<void> {
  if (context.state === 'stopped') {
    return;
  }

  setState(context, 'stopping');
  // A parked confirmation is part of the queue: cancel it first, so an
  // interrupted process drains promptly instead of waiting out the host's
  // approval deadline.
  context.broker.cancelAll();
  await quiesce(context);

  const problems = await releaseResourcesOnce(context);

  // A retained conversation still holds its lock, so 'stopped' would be a
  // lie: the runtime stays failed, and this stop — like a reactivate —
  // can be retried until the release lands.
  if (context.conversations.size > 0) {
    context.stopping = undefined;
    setState(
      context,
      'failed',
      `Stop could not release resources: ${problems.join('; ')}`,
    );
    return;
  }

  setState(
    context,
    'stopped',
    problems.length === 0 ? undefined : problems.join('; '),
  );
}

async function reactivateRuntime(context: RuntimeContext): Promise<void> {
  if (context.state !== 'failed') {
    throw new TypeError(
      `Character "${context.characterId}" cannot reactivate from state ` +
        `"${context.state}".`,
    );
  }

  // Deliveries queued behind the fatal turn drain first (each refused while
  // the state is failed); releasing under them would hand a closed
  // conversation to a turn that already holds the old reference.
  await quiesce(context);

  // A stop that completed while the queue drained wins over recovery.
  if (lifecycleLeft(context, 'failed')) {
    return;
  }

  const problems = await releaseResourcesOnce(context);

  // The same rule holds across the release await.
  if (lifecycleLeft(context, 'failed')) {
    return;
  }

  // A restart over unreleased resources would report ready with its DM
  // still locked; staying failed keeps the one-shot policy honest.
  if (problems.length > 0) {
    setState(
      context,
      'failed',
      `Recovery could not release resources: ${problems.join('; ')}`,
    );
    return;
  }

  context.state = 'stopped';
  await startRuntime(context);
}

/** Joins accepted turns and the attachment in flight before release. */
async function quiesce(context: RuntimeContext): Promise<void> {
  await context.queue.then(
    () => undefined,
    () => undefined,
  );
  // An attachment holds real leases while it opens; joined here, its own
  // overtake cleanup finishes before release snapshots the conversations.
  await context.opening?.catch(() => undefined);
}

/** Stop and recovery share one release, so cleanup never runs twice. */
function releaseResourcesOnce(context: RuntimeContext): Promise<string[]> {
  context.releasing ??= releaseResources(context).finally(() => {
    context.releasing = undefined;
  });

  return context.releasing;
}

async function releaseResources(context: RuntimeContext): Promise<string[]> {
  const {assembled, conversations} = context;
  const problems: string[] = [];
  const record = (error: unknown): void => {
    problems.push(error instanceof Error ? error.message : String(error));
  };

  context.broker.cancelAll();

  // Best-effort on every path: after a fatal turn the store may refuse the
  // records, but session-scoped providers still get their end hook.
  for (const active of conversations.values()) {
    if (assembled !== undefined) {
      try {
        await endSession({
          session: active.session,
          logStore: active.logStore,
          pluginHost: assembled.host,
        });
      } catch (error: unknown) {
        record(error);
      }
    }
  }

  // Shutdown hooks are read-only reporters and the phase itself retires
  // the plugin instances, so a shutdown problem is surfaced once — never
  // retried against the same host; a retry assembles a fresh one.
  if (assembled !== undefined && assembled.ownsHost) {
    const result = await runBestEffortPluginShutdown({
      pluginHost: assembled.host,
      sessionId:
        [...conversations.values()][0]?.session.id ??
        configuredPluginConstructionCleanupSessionId,
      currentUserMessage: hostShutdownMessage,
      character: assembled.profile,
    });

    if (result === undefined) {
      problems.push('Plugin host shutdown failed.');
    }

    for (const evidence of result?.evidence ?? []) {
      if (evidence.status !== 'accepted') {
        problems.push(`${evidence.pluginId}: ${evidence.summary}`);
      }
    }
  }

  // What failed to release stays referenced, so a retry frees it instead
  // of restarting over a live writer lock or host.
  for (const [conversationId, active] of conversations) {
    try {
      await active.close();
      conversations.delete(conversationId);
    } catch (error: unknown) {
      record(error);
    }
  }

  context.opening = undefined;
  context.assembled = undefined;

  return problems;
}

async function cleanUpHostAfterFailedStart(
  host: RuntimePluginHost,
  profile: CharacterProfile,
): Promise<void> {
  await runBestEffortPluginSessionEnd({
    pluginHost: host,
    sessionId: configuredPluginConstructionCleanupSessionId,
    currentUserMessage: constructionFailureMessage,
    character: profile,
    hookOptions: {allowFileStoreWrites: false},
  });
  await runBestEffortPluginShutdown({
    pluginHost: host,
    sessionId: configuredPluginConstructionCleanupSessionId,
    currentUserMessage: hostShutdownMessage,
    character: profile,
  });
}

function startupFailureMessage(startup: RuntimeCliStartupResult): string {
  if (
    startup.status === 'character_invalid' ||
    startup.characterActivation.status !== 'resolved'
  ) {
    return startup.characterActivation.status === 'failed'
      ? (startup.characterActivation.messages[0] ?? 'No character resolved.')
      : 'No character resolved.';
  }

  const blocking =
    startup.activationPlan.activation.diagnostics.find(
      diagnostic => diagnostic.severity === 'error',
    ) ??
    startup.loadedConfig.diagnostics.find(
      diagnostic => diagnostic.severity === 'error',
    );

  return (
    `Character activation failed (${startup.status}): ` +
    (blocking?.message ?? 'invalid runtime config.')
  );
}
