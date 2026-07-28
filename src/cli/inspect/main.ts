import {readFlagValue} from '../shared/flags.ts';
import type {CharacterProfile} from '../../core/index.ts';
import {
  createFileRuntimeLogStore,
  createLocalRuntimeSessionStore,
  createProject02HomeLayout,
  type LocalRuntimeSessionMetadata,
  normalizeLocalRuntimeSessionId,
} from '../../runtime/storage/index.ts';
import {
  isLocalRuntimeTerminalError,
  formatCliTerminalErrorMessage,
} from '../shared/terminal-errors.ts';
import {
  formatRejectedRuntimeCliStartup,
  interpretRuntimeCliStartup,
} from '../shared/startup-outcome.ts';
import {
  createRuntimeConfigInspectShape,
  RuntimeEnvFileError,
  type ResolvedProject02RuntimeLocation,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigInspectShape,
} from '../../runtime/config/index.ts';
import {
  resolveRuntimeCliStartup,
  type Project02ConfiguredPluginActivation,
  type RuntimePluginFactoryDefinition,
} from '../../app/index.ts';
import {
  emptyRuntimeStoreCliState,
  parseRuntimeStoreFlag,
  RuntimeLocationCliUsageError,
  type RuntimeStoreCliState,
} from '../shared/runtime-location-flags.ts';
import {
  assertProject02StoreConsent,
  Project02StoreConsentError,
} from '../shared/store-consent.ts';
import {
  createTurnEvidence,
  type InspectTurnEvidence,
} from '../../runtime/evidence/index.ts';
import {
  inspectConfiguredPlugins,
  type InspectConfiguredPlugin,
} from '../../runtime/config/index.ts';
import {isMainModule} from '../shared/main-module.ts';

class InspectCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectCliUsageError';
  }
}

type InspectCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /** Only read to ask whether an absent store should be created. */
  readonly stdin?: NodeJS.ReadableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
};

type InspectCliArgs =
  | {
      readonly mode: 'sessions';
      readonly storeRoot?: string;
      readonly configPath?: string;
      readonly character?: string;
      readonly init: boolean;
    }
  | {
      readonly mode: 'session';
      readonly storeRoot?: string;
      readonly configPath?: string;
      readonly character?: string;
      readonly init: boolean;
      readonly sessionId: string;
    };

type InspectSessionListOutput = {
  readonly runtimeConfig: RuntimeConfigInspectShape;
  readonly activationDiagnostics: readonly RuntimeConfigDiagnostic[];
  readonly plugins: readonly InspectConfiguredPlugin[];
  readonly sessions: readonly LocalRuntimeSessionMetadata[];
};

type InspectSessionOutput = {
  readonly runtimeConfig: RuntimeConfigInspectShape;
  readonly activationDiagnostics: readonly RuntimeConfigDiagnostic[];
  readonly plugins: readonly InspectConfiguredPlugin[];
  readonly session: LocalRuntimeSessionMetadata;
  readonly evidenceScopes: {
    readonly runtimeConfig: 'current_at_inspection';
    readonly activation: 'current_at_inspection';
    readonly storedSessionEvidence: 'stored_history';
    readonly derivedTraceEvidence: 'derived_not_persisted';
  };
  readonly counts: {
    readonly traceEntries: number;
    readonly derivedTraceEntries: number;
    readonly rawEvents: number;
    readonly conversationMessages: number;
  };
  readonly turns: readonly InspectTurnEvidence[];
};

export async function runInspectCliFromArgs(
  args: readonly string[],
  options: InspectCliOptions,
): Promise<number> {
  try {
    const explicitEnv =
      options.env === undefined || options.env === process.env
        ? undefined
        : options.env;
    const parsedArgs = parseInspectCliArgs(args);
    validateInspectCliArgs(parsedArgs);
    // Inspect reports on a store; it has no business making one. The
    // startup below would, so the question is asked before it runs.
    await assertProject02StoreConsent({
      location: parsedArgs,
      init: parsedArgs.init,
      stdout: options.stdout,
      ...(options.stdin === undefined ? {} : {stdin: options.stdin}),
      ...(explicitEnv === undefined ? {} : {env: explicitEnv}),
    });
    const startup = await resolveRuntimeCliStartup({
      location: parsedArgs,
      ...(explicitEnv === undefined ? {} : {env: explicitEnv}),
      ...(options.factories === undefined
        ? {}
        : {factories: options.factories}),
    });
    const interpreted = interpretRuntimeCliStartup(startup);

    if (interpreted.outcome === 'rejected') {
      throw new InspectCliUsageError(
        formatRejectedRuntimeCliStartup(interpreted),
      );
    }

    // A broken unrelated character package leaves the selected one
    // usable. Reporting healthy state without saying so would give the
    // operator no indication the installed package needs fixing, so the
    // warnings go to stderr and leave the stdout JSON contract intact.
    for (const warning of interpreted.warnings) {
      options.stderr.write(`Warning: ${warning}\n`);
    }

    const usable = interpreted.startup;

    if (parsedArgs.mode === 'sessions') {
      await writeSessionList(
        options.stdout,
        usable.activationPlan,
        usable.runtimeLocation,
      );
      return 0;
    }

    await writeSessionEvidence(
      parsedArgs,
      options.stdout,
      usable.activationPlan,
      usable.characterActivation.profile,
      usable.runtimeLocation,
    );
    return 0;
  } catch (error: unknown) {
    if (
      error instanceof InspectCliUsageError ||
      error instanceof RuntimeLocationCliUsageError ||
      error instanceof Project02StoreConsentError ||
      error instanceof RuntimeEnvFileError ||
      isLocalRuntimeTerminalError(error)
    ) {
      options.stderr.write(`Error: ${formatCliTerminalErrorMessage(error)}\n`);
      return 1;
    }

    throw error;
  }
}

function parseInspectCliArgs(args: readonly string[]): InspectCliArgs {
  let store: RuntimeStoreCliState = emptyRuntimeStoreCliState;
  let sessionsMode = false;
  let sessionId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === '--') {
      continue;
    }

    const storeResult = parseRuntimeStoreFlag({
      args,
      index,
      state: store,
    });

    if (storeResult.status === 'matched') {
      store = storeResult.state;
      index = storeResult.nextIndex;
      continue;
    }

    if (arg === '--sessions') {
      if (sessionsMode) {
        throw new InspectCliUsageError('--sessions can only be provided once.');
      }

      sessionsMode = true;
      continue;
    }

    if (arg === '--session') {
      if (sessionId !== undefined) {
        throw new InspectCliUsageError('--session can only be provided once.');
      }

      sessionId = readFlagValue(
        args,
        index,
        '--session',
        message => new InspectCliUsageError(message),
      );
      index += 1;
      continue;
    }

    throw new InspectCliUsageError(`Unknown inspect option: ${arg}.`);
  }

  if (sessionsMode && sessionId !== undefined) {
    throw new InspectCliUsageError(
      'Use either --sessions or --session, not both.',
    );
  }

  const {location} = store;

  if (sessionsMode) {
    return {
      mode: 'sessions',
      init: store.init,
      ...(location.storeRoot === undefined
        ? {}
        : {storeRoot: location.storeRoot}),
      ...(location.configPath === undefined
        ? {}
        : {configPath: location.configPath}),
      ...(location.character === undefined
        ? {}
        : {character: location.character}),
    } satisfies InspectCliArgs;
  }

  if (sessionId === undefined) {
    throw new InspectCliUsageError('Use --sessions or --session <session-id>.');
  }

  return {
    mode: 'session',
    sessionId,
    init: store.init,
    ...(location.storeRoot === undefined
      ? {}
      : {storeRoot: location.storeRoot}),
    ...(location.configPath === undefined
      ? {}
      : {configPath: location.configPath}),
    ...(location.character === undefined
      ? {}
      : {character: location.character}),
  } satisfies InspectCliArgs;
}

function validateInspectCliArgs(args: InspectCliArgs): void {
  if (args.storeRoot !== undefined) {
    createProject02HomeLayout({homeRoot: args.storeRoot});
  }

  if (args.mode === 'session') {
    normalizeLocalRuntimeSessionId(args.sessionId);
  }
}

async function writeSessionList(
  stdout: NodeJS.WritableStream,
  runtimeConfig: Project02ConfiguredPluginActivation,
  runtimeLocation: ResolvedProject02RuntimeLocation,
): Promise<void> {
  const sessionStore = createLocalRuntimeSessionStore({
    storeRoot: runtimeLocation.characterScope.dataRoot,
    characterId: runtimeLocation.characterScope.characterId,
  });
  const sessions = await sessionStore.listSessions();

  writeJson(stdout, {
    runtimeConfig: createRuntimeConfigInspectShape(
      runtimeConfig.resolvedConfig,
    ),
    activationDiagnostics: Object.freeze([
      ...runtimeConfig.activation.diagnostics,
    ]),
    plugins: inspectConfiguredPlugins(runtimeConfig),
    sessions,
  } satisfies InspectSessionListOutput);
}

async function writeSessionEvidence(
  args: InspectCliArgs & {readonly mode: 'session'},
  stdout: NodeJS.WritableStream,
  runtimeConfig: Project02ConfiguredPluginActivation,
  boundCharacter: CharacterProfile,
  runtimeLocation: ResolvedProject02RuntimeLocation,
): Promise<void> {
  const storage = {
    storeRoot: runtimeLocation.characterScope.dataRoot,
  };
  const sessionStore = createLocalRuntimeSessionStore({
    ...storage,
    characterId: runtimeLocation.characterScope.characterId,
  });
  const session = await sessionStore.readSession(args.sessionId);
  // boundCharacter is passed for a wrong-answer check, not a security
  // one: there is no attacker in a local app. It catches a session whose
  // evidence names a different character than the directory it sits in —
  // reachable by a bug in our own write path, an interrupted migration,
  // or a home folder synced between machines. Unchecked, inspect would
  // print another character's transcript as if it were this one, and the
  // operator would have no way to tell.
  //
  // No boundUserSpeaker, though: the user speaker id is the same constant
  // for every record in a single-user app, so binding it would compare
  // that constant to itself.
  const logStore = createFileRuntimeLogStore({
    ...storage,
    sessionId: session.sessionId,
    characterId: runtimeLocation.characterScope.characterId,
    boundCharacter,
  });
  const evidence = logStore.readSessionEvidence();
  const {traceEntries, rawEvents, conversationMessages} = evidence.stored;

  writeJson(stdout, {
    runtimeConfig: createRuntimeConfigInspectShape(
      runtimeConfig.resolvedConfig,
    ),
    activationDiagnostics: Object.freeze([
      ...runtimeConfig.activation.diagnostics,
    ]),
    plugins: inspectConfiguredPlugins(runtimeConfig),
    session,
    evidenceScopes: Object.freeze({
      runtimeConfig: 'current_at_inspection',
      activation: 'current_at_inspection',
      storedSessionEvidence: 'stored_history',
      derivedTraceEvidence: 'derived_not_persisted',
    }),
    counts: {
      traceEntries: traceEntries.length,
      derivedTraceEntries: evidence.derived.traceEntries.length,
      rawEvents: rawEvents.length,
      conversationMessages: conversationMessages.length,
    },
    turns: createTurnEvidence({
      conversationMessages,
      derivedTraceEntries: evidence.derived.traceEntries,
      rawEvents,
      traceEntries,
    }),
  } satisfies InspectSessionOutput);
}

function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runInspectCliFromArgs(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
