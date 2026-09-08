import {
  listProject02Characters,
  loadProject02Home,
  prepareProject02CharacterActivation,
  reloadProject02Home,
  type Project02CharacterListing,
  type Project02Home,
  type Project02HomeOptions,
} from '../app/index.ts';
import {isValidClientStamp} from '../core/index.ts';
import type {
  RuntimePluginHost,
  RuntimePluginToolConfirmationHandler,
} from '../plugins/index.ts';
import type {ChatProviderName, RoleModelAdapter} from '../role-model/index.ts';
import {
  gatewayProtocolVersion,
  type AnswerOutcome,
  type CharacterRuntimeHealth,
  type CharacterSummary,
  type Gateway,
  type GatewayEvent,
  type GatewayEventListener,
  type GatewayHealth,
  type GatewayMessage,
  type HistoryOutcome,
  type HistoryPage,
  type OpenOutcome,
  type PendingConfirmation,
  type ReconcilePlan,
  type StartOutcome,
  type TurnOutcome,
  type Unsubscribe,
} from './api/contract.ts';
import {
  createLocalCharacterRuntime,
  type LocalCharacterRuntime,
} from './runtime/character-runtime.ts';
import {readConversationHistory} from './history.ts';
import {createReconciler} from './reconcile.ts';
import {createSubmissionLedger} from './submissions.ts';

export type CreateGatewayOptions = Project02HomeOptions & {
  /** Test and dev injection, applied to every character this gateway starts. */
  readonly provider?: ChatProviderName;
  readonly roleModelAdapter?: RoleModelAdapter;
  /** Receives the character's confirmation seam, so injected hosts park confirmations too. */
  readonly createPluginHost?: (
    characterId: string,
    confirmations: RuntimePluginToolConfirmationHandler,
  ) => RuntimePluginHost;
};

type Runtimes = ReadonlyMap<string, LocalCharacterRuntime>;

/**
 * The façade the daemon holds behind its socket: the registry of character
 * runtimes and the routing between them. Boot problems are per-character
 * states, visible in health() and the event stream, never throws; a client
 * mistake (opening a character that was never started, starting on a
 * stopped gateway) is a refused outcome.
 */
export function createGateway(options: CreateGatewayOptions = {}): Gateway {
  // The home identity binds once; only its config document reloads per
  // use. A config fix reaches the retry, while an env or store redirect
  // made later cannot split the gateway across two homes.
  const boundHome = loadProject02Home(options);
  const loadHome = (): Project02Home => reloadProject02Home(boundHome);
  const runtimes = new Map<string, LocalCharacterRuntime>();
  // The routing table the gateway builds by attaching clients to
  // conversations: conversation → the character runtime holding it. Room
  // policy replaces this single-participant lookup when groups arrive.
  const conversationRoutes = new Map<string, string>();
  const listeners = new Set<GatewayEventListener>();
  const startsInFlight = new Map<string, Promise<void>>();
  const submissions = createSubmissionLedger();
  let stopped = false;

  // A client rendering bug must not break a character's turn: listener
  // failures stay the listener's problem.
  const emit = (event: GatewayEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Isolation is the rule; there is no one to report a listener to.
      }
    }
  };

  const runtimeFor = createRuntimeFactory({
    options,
    loadHome,
    runtimes,
    startsInFlight,
    emit,
  });
  const reconciler = createReconciler({
    roster: () => listProject02Characters(loadHome()).characters,
    running: () => [...runtimes.keys()],
    stateOf: characterId =>
      runtimes.get(characterId)?.health().state ?? 'not_started',
    start: startCharacter,
    stop: async characterId => {
      await runtimes.get(characterId)?.stop();
    },
  });

  return Object.freeze({
    health(): GatewayHealth {
      return readHealth(loadHome(), runtimes);
    },
    history(
      conversationId: string,
      page?: HistoryPage,
    ): Promise<HistoryOutcome> {
      return readConversationHistory({
        homeRoot: boundHome.runtimeLocation.homeRoot,
        conversationId,
        ...(page === undefined ? {} : {page}),
      });
    },
    startCharacter,
    reconcile: (): Promise<ReconcilePlan> => reconciler.reconcile(),
    async openDirectConversation(characterId: string): Promise<OpenOutcome> {
      const runtime = runtimes.get(characterId);
      // The roster is the truth about what is installed: a runtime kept
      // after its package left is stopped, not a character to reach.
      const roster = listProject02Characters(loadHome()).characters;

      if (
        runtime === undefined ||
        !roster.some(character => character.id === characterId)
      ) {
        return notStartedOutcome(characterId, roster);
      }

      // A start or automatic recovery in flight is joined first, so an
      // attach that follows a fatal turn lands on the restarted character.
      await startsInFlight.get(characterId)?.catch(() => undefined);

      const outcome = await runtime.openDirectConversation();

      if (outcome.status === 'opened') {
        conversationRoutes.set(outcome.conversationId, characterId);
      }

      return outcome;
    },
    async deliver(message: GatewayMessage): Promise<TurnOutcome> {
      // Refused before the runtime, so a malformed stamp never reaches a
      // commit record — the codec would refuse it there, fatally.
      if (
        !isValidClientStamp(message.source) ||
        !isValidClientStamp(message.clientMessageId)
      ) {
        return refusedTurn(
          'invalid_message',
          'A message names its source and its own id as single tokens: ' +
            'letters, digits, and any of ":._-", at most 64 characters.',
        );
      }

      const characterId = conversationRoutes.get(message.conversationId);
      const runtime =
        characterId === undefined ? undefined : runtimes.get(characterId);

      if (characterId === undefined || runtime === undefined) {
        return refusedTurn(
          'unknown_conversation',
          'The gateway holds no open conversation ' +
            `"${message.conversationId}".`,
        );
      }

      return submissions.submit(message, async () => {
        // A recovery lets the thread go; a client that opened it must not
        // have to notice. The thread is held again here, joining a start
        // or recovery in flight first, so the turn lands on the character
        // that is back — the open is memoized, so a held thread costs
        // nothing.
        await startsInFlight.get(characterId)?.catch(() => undefined);

        const held = await runtime.openDirectConversation();
        const outcome =
          held.status === 'opened'
            ? await runtime.deliver(message)
            : turnNotRun(characterId, message, held);

        // How the turn ended reaches every surface, whether the character
        // ran it or the thread could not be held for it.
        emit(turnCompleted(characterId, message, outcome));

        return outcome;
      });
    },
    pendingConfirmations(): readonly PendingConfirmation[] {
      return Object.freeze(
        [...runtimes.values()].flatMap(runtime =>
          runtime.pendingConfirmations(),
        ),
      );
    },
    answerConfirmation(id, decision): AnswerOutcome {
      // Ids are gateway-unique, so routing is asking everyone; the one
      // runtime that parked the id has the answer.
      for (const runtime of runtimes.values()) {
        const status = runtime.answerConfirmation(id, decision);

        if (status !== 'unknown') {
          return Object.freeze({status});
        }
      }

      return Object.freeze({status: 'unknown' as const});
    },
    events(listener: GatewayEventListener): Unsubscribe {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    async stop(): Promise<void> {
      // Terminal by design: no new starts. A reconcile pass in flight sees
      // its starts refused and finishes its stops first; then the runtimes
      // are signalled, so a start or recovery in flight is overtaken —
      // refused at the door, drained, discarded — never finished into a
      // ready character during shutdown; the joins then confirm those
      // promises settled.
      stopped = true;
      await reconciler.settled();
      await Promise.all([...runtimes.values()].map(runtime => runtime.stop()));
      await Promise.all(
        [...startsInFlight.values()].map(start => start.catch(() => undefined)),
      );
    },
  });

  async function startCharacter(characterId: string): Promise<StartOutcome> {
    if (stopped) {
      return refusedStart('gateway_stopped', 'The gateway is stopped.');
    }

    // The same resolution activation will use: a typo'd id fails fast with
    // the discovered roster instead of a runtime health() never lists,
    // and a broken package reports its own diagnostic instead of posing as
    // not installed. The enabled decision belongs to the runtime's own
    // assembly, where reactivation passes too.
    const resolution = prepareProject02CharacterActivation({
      storeRoot: loadHome().runtimeLocation.homeRoot,
      configuredCharacterId: characterId,
    });

    if (resolution.status === 'failed') {
      return refusedStart('unknown_character', resolution.messages.join(' '));
    }

    const runtime = runtimeFor(characterId);

    await startOrJoin(runtime);

    return Object.freeze({
      status: 'settled' as const,
      character: settledSummary(
        loadHome(),
        runtime,
        resolution.profile.displayName,
      ),
    });
  }

  /**
   * A second caller joins the start already in flight instead of resolving
   * before the character is ready. Boot problems are states, not throws,
   * so an explicit start is the operator's retry of a failed character;
   * automatic restarts stay one-shot. Reactivation releases what the
   * failure left behind.
   */
  function startOrJoin(runtime: LocalCharacterRuntime): Promise<void> {
    const pending = startsInFlight.get(runtime.characterId);

    if (pending !== undefined) {
      return pending;
    }

    const state = runtime.health().state;

    if (state !== 'stopped' && state !== 'failed') {
      return Promise.resolve();
    }

    const start = (
      state === 'failed' ? runtime.reactivate() : runtime.start()
    ).finally(() => {
      startsInFlight.delete(runtime.characterId);
    });

    startsInFlight.set(runtime.characterId, start);

    return start;
  }
}

/**
 * Construct-once runtimes, each wired for one automatic restart after a
 * fatal turn: a boot failure arrives from 'starting' and stays failed
 * rather than crash-looping. The recovery is registered like an explicit
 * start, so a retry or attach that lands mid-recovery joins it instead of
 * resolving early.
 */
function createRuntimeFactory(seams: {
  readonly options: CreateGatewayOptions;
  readonly loadHome: () => Project02Home;
  readonly runtimes: Map<string, LocalCharacterRuntime>;
  readonly startsInFlight: Map<string, Promise<void>>;
  readonly emit: (event: GatewayEvent) => void;
}): (characterId: string) => LocalCharacterRuntime {
  const {options, runtimes, startsInFlight} = seams;
  const lastStates = new Map<string, string>();

  return characterId => {
    const existing = runtimes.get(characterId);

    if (existing !== undefined) {
      return existing;
    }

    const {createPluginHost} = options;
    const runtime = createLocalCharacterRuntime({
      loadHome: seams.loadHome,
      characterId,
      ...(options.provider === undefined ? {} : {provider: options.provider}),
      ...(options.roleModelAdapter === undefined
        ? {}
        : {roleModelAdapter: options.roleModelAdapter}),
      ...(createPluginHost === undefined
        ? {}
        : {
            createPluginHost: (
              confirmations: RuntimePluginToolConfirmationHandler,
            ) => createPluginHost(characterId, confirmations),
          }),
    });

    runtime.events(event => {
      if (event.kind === 'state_changed') {
        const previous = lastStates.get(event.characterId);

        lastStates.set(event.characterId, event.state);

        if (event.state === 'failed' && previous === 'ready') {
          const recovery = runtime
            .reactivate()
            .catch(() => {
              // The failure is already visible in health; a reactivate lost
              // to a racing lifecycle change has nothing further to report.
            })
            .finally(() => {
              startsInFlight.delete(event.characterId);
            });

          startsInFlight.set(event.characterId, recovery);
        }
      }

      seams.emit(event);
    });
    runtimes.set(characterId, runtime);

    return runtime;
  };
}

function readHealth(home: Project02Home, runtimes: Runtimes): GatewayHealth {
  const roster = listProject02Characters(home);

  return Object.freeze({
    protocolVersion: gatewayProtocolVersion,
    homeRoot: home.runtimeLocation.homeRoot,
    config: Object.freeze({diagnostics: home.loadedConfig.diagnostics}),
    packages: Object.freeze({diagnostics: roster.diagnostics}),
    characters: Object.freeze(
      roster.characters.map(character =>
        summarize(character, runtimes.get(character.id)?.health()),
      ),
    ),
  });
}

function summarize(
  character: Project02CharacterListing,
  health: CharacterRuntimeHealth | undefined,
): CharacterSummary {
  return Object.freeze({
    id: character.id,
    displayName: character.displayName,
    enabled: character.enabled,
    state: health?.state ?? ('not_started' as const),
    ...(health?.failure === undefined ? {} : {diagnostic: health.failure}),
    ...(health?.maintenance === undefined
      ? {}
      : {maintenance: health.maintenance}),
  });
}

/** A turn whose thread could not be held again ends the way the open did. */
function turnNotRun(
  characterId: string,
  message: GatewayMessage,
  held: Exclude<OpenOutcome, {status: 'opened'}>,
): TurnOutcome {
  return held.status === 'refused'
    ? refusedTurn(held.reason, held.message)
    : Object.freeze({
        status: 'failed' as const,
        characterId,
        conversationId: message.conversationId,
        message: held.message,
      });
}

/** The sender has the outcome; every other surface hears how the turn ended. */
function turnCompleted(
  characterId: string,
  message: GatewayMessage,
  outcome: TurnOutcome,
): GatewayEvent {
  return Object.freeze({
    kind: 'turn_completed' as const,
    characterId,
    conversationId: message.conversationId,
    source: message.source,
    clientMessageId: message.clientMessageId,
    status: outcome.status,
    ...(outcome.status === 'rejected' || outcome.status === 'refused'
      ? {reason: outcome.reason, message: outcome.message}
      : {}),
    ...(outcome.status === 'failed' ? {message: outcome.message} : {}),
  });
}

/**
 * The roster is read again after the start settled, so the summary carries
 * the enabled flag as it stands now; a package that vanished meanwhile
 * still gets its runtime's own state.
 */
function settledSummary(
  home: Project02Home,
  runtime: LocalCharacterRuntime,
  displayName: string,
): CharacterSummary {
  const listed = listProject02Characters(home).characters.find(
    character => character.id === runtime.characterId,
  );

  return summarize(
    listed ?? {id: runtime.characterId, displayName, enabled: true},
    runtime.health(),
  );
}

function refusedTurn(
  reason: Extract<TurnOutcome, {status: 'refused'}>['reason'],
  message: string,
): TurnOutcome {
  return Object.freeze({status: 'refused' as const, reason, message});
}

function refusedStart(
  reason: Extract<StartOutcome, {status: 'refused'}>['reason'],
  message: string,
): StartOutcome {
  return Object.freeze({status: 'refused' as const, reason, message});
}

/** Installed but never started is a different answer from not installed. */
function notStartedOutcome(
  characterId: string,
  roster: readonly Project02CharacterListing[],
): OpenOutcome {
  const installed = roster.some(character => character.id === characterId);

  return Object.freeze({
    status: 'refused' as const,
    reason: installed
      ? ('character_unavailable' as const)
      : ('unknown_character' as const),
    message: installed
      ? `Character "${characterId}" has not been started.`
      : `Character "${characterId}" is not installed. Installed characters: ` +
        `${roster.length === 0 ? '(none)' : roster.map(character => character.id).join(', ')}.`,
  });
}
