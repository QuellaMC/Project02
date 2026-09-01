import {
  listProject02Characters,
  loadProject02Home,
  prepareProject02CharacterActivation,
  type Project02Home,
  type Project02HomeOptions,
} from '../app/index.ts';
import type {RuntimePluginHost} from '../plugins/index.ts';
import type {ChatProviderName, RoleModelAdapter} from '../role-model/index.ts';
import type {
  CharacterSummary,
  ConversationRef,
  Gateway,
  GatewayEvent,
  GatewayEventListener,
  GatewayMessage,
  TurnOutcome,
  Unsubscribe,
} from './api/contract.ts';
import {
  createLocalCharacterRuntime,
  type LocalCharacterRuntime,
} from './runtime/character-runtime.ts';

export type CreateGatewayOptions = Project02HomeOptions & {
  /** Test and dev injection, applied to every character this gateway starts. */
  readonly provider?: ChatProviderName;
  readonly roleModelAdapter?: RoleModelAdapter;
  readonly createPluginHost?: (characterId: string) => RuntimePluginHost;
};

/**
 * The one object a client holds: the registry of character runtimes and the
 * routing between them. Boot problems are per-character states, visible in
 * characters() and the event stream, never throws — the exceptions are
 * client mistakes (starting a disabled character, attaching before start).
 */
export function createGateway(options: CreateGatewayOptions = {}): Gateway {
  // Loaded per use, never snapshotted: a config fix the operator makes
  // between a failed boot and the retry must reach that retry.
  const loadHome = (): Project02Home => loadProject02Home(options);
  const runtimes = new Map<string, LocalCharacterRuntime>();
  // The routing table the gateway builds by attaching clients to
  // conversations: conversation → the character runtime holding it. Room
  // policy replaces this single-participant lookup when groups arrive.
  const conversationRoutes = new Map<string, string>();
  const listeners = new Set<GatewayEventListener>();
  const lastStates = new Map<string, string>();
  const startsInFlight = new Map<string, Promise<void>>();
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

  const runtimeFor = (characterId: string): LocalCharacterRuntime => {
    const existing = runtimes.get(characterId);

    if (existing !== undefined) {
      return existing;
    }

    const runtime = createLocalCharacterRuntime({
      loadHome,
      characterId,
      ...(options.provider === undefined ? {} : {provider: options.provider}),
      ...(options.roleModelAdapter === undefined
        ? {}
        : {roleModelAdapter: options.roleModelAdapter}),
      ...(options.createPluginHost === undefined
        ? {}
        : {pluginHost: options.createPluginHost(characterId)}),
    });

    runtime.events(event => {
      if (event.kind === 'state_changed') {
        const previous = lastStates.get(event.characterId);

        lastStates.set(event.characterId, event.state);

        // One automatic restart, and only for a fatal turn: a boot failure
        // arrives from 'starting' and stays failed rather than crash-looping.
        // Registered like an explicit start, so a retry or attach that lands
        // mid-recovery joins it instead of resolving early.
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

      emit(event);
    });
    runtimes.set(characterId, runtime);

    return runtime;
  };

  return Object.freeze({
    characters(): readonly CharacterSummary[] {
      return Object.freeze(
        listProject02Characters(loadHome()).map(character => {
          const health = runtimes.get(character.id)?.health();

          return Object.freeze({
            id: character.id,
            enabled: character.enabled,
            state: health?.state ?? ('not_started' as const),
            ...(health?.failure === undefined
              ? {}
              : {diagnostic: health.failure}),
          });
        }),
      );
    },
    async startCharacter(characterId: string): Promise<void> {
      if (stopped) {
        throw new TypeError('The gateway is stopped.');
      }

      // The same resolution activation will use: a typo'd id fails fast with
      // the discovered roster instead of a runtime characters() never lists,
      // and a broken package reports its own diagnostic instead of posing as
      // not installed. The enabled decision belongs to the runtime's own
      // assembly, where reactivation passes too.
      const resolution = prepareProject02CharacterActivation({
        storeRoot: loadHome().runtimeLocation.homeRoot,
        configuredCharacterId: characterId,
      });

      if (resolution.status === 'failed') {
        throw new TypeError(resolution.messages.join(' '));
      }

      const runtime = runtimeFor(characterId);
      // A second caller joins the start already in flight instead of
      // resolving before the character is ready.
      const pending = startsInFlight.get(characterId);

      if (pending !== undefined) {
        return pending;
      }

      const state = runtime.health().state;

      if (state !== 'stopped' && state !== 'failed') {
        return;
      }

      // Boot problems are states, not throws, so an explicit start is the
      // operator's retry of a failed character; automatic restarts stay
      // one-shot. Reactivation releases what the failure left behind.
      const start = (
        state === 'failed' ? runtime.reactivate() : runtime.start()
      ).finally(() => {
        startsInFlight.delete(characterId);
      });

      startsInFlight.set(characterId, start);

      return start;
    },
    async openDirectConversation(
      characterId: string,
    ): Promise<ConversationRef> {
      const runtime = runtimes.get(characterId);

      if (runtime === undefined) {
        throw new TypeError(`Character "${characterId}" has not been started.`);
      }

      const ref = await runtime.openDirectConversation();

      conversationRoutes.set(ref.conversationId, characterId);

      return ref;
    },
    async deliver(message: GatewayMessage): Promise<TurnOutcome> {
      const characterId = conversationRoutes.get(message.conversationId);
      const runtime =
        characterId === undefined ? undefined : runtimes.get(characterId);

      if (runtime === undefined) {
        return Object.freeze({
          status: 'refused' as const,
          reason: 'unknown_conversation' as const,
          message:
            'The gateway holds no open conversation ' +
            `"${message.conversationId}".`,
        });
      }

      return runtime.deliver(message);
    },
    answerConfirmation(id, decision) {
      // Ids are gateway-unique and a miss is a benign no-op, so routing is
      // asking everyone.
      for (const runtime of runtimes.values()) {
        runtime.answerConfirmation(id, decision);
      }
    },
    events(listener: GatewayEventListener): Unsubscribe {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    async stop(): Promise<void> {
      // Terminal by design: no new starts. Runtimes are signalled first so
      // a start or recovery in flight is overtaken — refused at the door,
      // drained, discarded — never finished into a ready character during
      // shutdown; the joins then confirm those promises settled.
      stopped = true;
      await Promise.all([...runtimes.values()].map(runtime => runtime.stop()));
      await Promise.all(
        [...startsInFlight.values()].map(start => start.catch(() => undefined)),
      );
    },
  });
}
