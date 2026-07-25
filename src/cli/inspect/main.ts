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
  createRuntimeConfigInspectShape,
  runtimeConfigDiagnosticAttribution,
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
  parseRuntimeLocationFlag,
  RuntimeLocationCliUsageError,
  type RuntimeLocationCliState,
} from '../shared/runtime-location-flags.ts';
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
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
};

type InspectCliArgs =
  | {
      readonly mode: 'sessions';
      readonly storeRoot?: string;
      readonly configPath?: string;
      readonly character?: string;
    }
  | {
      readonly mode: 'session';
      readonly storeRoot?: string;
      readonly configPath?: string;
      readonly character?: string;
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
    const startup = await resolveRuntimeCliStartup({
      location: parsedArgs,
      ...(explicitEnv === undefined ? {} : {env: explicitEnv}),
      ...(options.factories === undefined
        ? {}
        : {factories: options.factories}),
    });
    const characterActivation = startup.characterActivation;

    if (
      startup.status === 'character_invalid' ||
      characterActivation.status === 'failed'
    ) {
      throw new InspectCliUsageError(
        (characterActivation.status === 'failed'
          ? characterActivation.messages[0]
          : undefined) ?? 'Character activation failed.',
      );
    }

    if (startup.status === 'config_invalid') {
      const configError =
        startup.activationPlan.resolvedConfig.diagnostics.find(
          diagnostic => diagnostic.severity === 'error',
        );

      throw new InspectCliUsageError(
        configError === undefined
          ? 'Runtime config is invalid.'
          : `${runtimeConfigDiagnosticAttribution(configError)}${
              configError.message
            }`,
      );
    }

    if (parsedArgs.mode === 'sessions') {
      await writeSessionList(
        options.stdout,
        startup.activationPlan,
        startup.runtimeLocation,
      );
      return 0;
    }

    await writeSessionEvidence(
      parsedArgs,
      options.stdout,
      startup.activationPlan,
      characterActivation.profile,
      startup.runtimeLocation,
    );
    return 0;
  } catch (error: unknown) {
    if (
      error instanceof InspectCliUsageError ||
      error instanceof RuntimeLocationCliUsageError ||
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
  let location: RuntimeLocationCliState = {};
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

    const locationResult = parseRuntimeLocationFlag({
      args,
      index,
      state: location,
    });

    if (locationResult.status === 'matched') {
      location = locationResult.state;
      index = locationResult.nextIndex;
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

  if (sessionsMode) {
    return {
      mode: 'sessions',
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
  // The character boundary holds at inspection too: foreign evidence
  // copied into a data directory must fail here exactly as durable chat does.
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
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
