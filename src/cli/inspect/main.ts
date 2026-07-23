import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

import {readFlagValue} from '../shared/flags.ts';
import type {CharacterProfile} from '../../core/index.ts';
import {
  createFileRuntimeLogStore,
  createLocalRuntimeSessionStore,
  characterDataDirPath,
  createLocalRuntimeStorageLayout,
  assertCharacterDataDirReadable,
  createProject02HomeLayout,
  isLiveAtomicReplacementForAnyTarget,
  isMissingDefaultSessionStore,
  readCharacterBinding,
  type CharacterBindingReadResult,
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
  readonly characterBinding: CharacterBindingReadResult;
  readonly activationDiagnostics: readonly RuntimeConfigDiagnostic[];
  readonly plugins: readonly InspectConfiguredPlugin[];
  readonly sessions: readonly LocalRuntimeSessionMetadata[];
};

type InspectSessionOutput = {
  readonly runtimeConfig: RuntimeConfigInspectShape;
  readonly characterBinding: CharacterBindingReadResult;
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

    if (startup.status === 'character_invalid') {
      throw new InspectCliUsageError(
        (startup.characterActivation.status === 'failed'
          ? startup.characterActivation.messages[0]
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
      await writeSessionList(options.stdout, startup.activationPlan);
      return 0;
    }

    await writeSessionEvidence(
      parsedArgs,
      options.stdout,
      startup.activationPlan,
      startup.characterActivation.status === 'resolved'
        ? startup.characterActivation.profile
        : undefined,
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
): Promise<void> {
  const dataRoot = characterDataDirPath(
    runtimeConfig.resolvedConfig.project02.storeRoot,
    runtimeConfig.resolvedConfig.project02.character,
  );

  assertInspectedDataDirBinding(
    dataRoot,
    runtimeConfig.resolvedConfig.project02.character,
  );

  const sessionStore = createLocalRuntimeSessionStore({storeRoot: dataRoot});
  let sessions: readonly LocalRuntimeSessionMetadata[] = [];

  try {
    sessions = await sessionStore.listSessions();
  } catch (error: unknown) {
    // An absent data directory — or one holding only control state
    // (binding stamp, overlay, locks) from a config-only workflow — has
    // no sessions. Session artifacts without a listable catalog, or any
    // entry outside the control allowlist while the data marker is
    // missing, are corruption or foreign content, never an empty view.
    const layout = createLocalRuntimeStorageLayout({storeRoot: dataRoot});
    const hasSessionArtifacts =
      existsSync(layout.schemaPath) ||
      existsSync(layout.sessionCatalogPath) ||
      existsSync(layout.sessionsRoot);

    if (
      !isMissingDefaultSessionStore(error) ||
      hasSessionArtifacts ||
      !dataDirHoldsOnlyControlEntries(dataRoot)
    ) {
      throw error;
    }
  }

  writeJson(stdout, {
    runtimeConfig: createRuntimeConfigInspectShape(
      runtimeConfig.resolvedConfig,
    ),
    characterBinding: readCharacterBinding({
      storeRoot: characterDataDirPath(
        runtimeConfig.resolvedConfig.project02.storeRoot,
        runtimeConfig.resolvedConfig.project02.character,
      ),
    }),
    activationDiagnostics: Object.freeze([
      ...runtimeConfig.activation.diagnostics,
    ]),
    plugins: inspectConfiguredPlugins(runtimeConfig),
    sessions,
  } satisfies InspectSessionListOutput);
}

// The binding and adoptability rules hold at inspection: a data
// directory stamped for another character, or one the writers would
// refuse, fails read-only exactly as durable chat does.
function assertInspectedDataDirBinding(
  dataRoot: string,
  characterId: string,
): void {
  assertCharacterDataDirReadable({
    storageOptions: {storeRoot: dataRoot},
    characterId,
  });
}

// Entries a control-only data directory may hold besides sessions:
// the overlay config, the binding stamp, and the lock root.
function dataDirHoldsOnlyControlEntries(dataRoot: string): boolean {
  const layout = createLocalRuntimeStorageLayout({storeRoot: dataRoot});
  let entries: readonly string[];

  try {
    entries = readdirSync(dataRoot);
  } catch {
    // An unreadable or absent root holds nothing durable to hide; the
    // missing-store classification above already matched.
    return true;
  }

  return entries.every(entry => {
    const entryPath = join(dataRoot, entry);

    if (
      entryPath === layout.configPath ||
      entryPath === layout.locksRoot ||
      entryPath === layout.characterBindingPath
    ) {
      return true;
    }

    // A sibling initializer's live marker/overlay/stamp replacement is
    // not foreign; abandoned temps stay foreign.
    return isLiveAtomicReplacementForAnyTarget(entry, [
      layout.schemaPath,
      layout.configPath,
      layout.characterBindingPath,
    ]);
  });
}

async function writeSessionEvidence(
  args: InspectCliArgs & {readonly mode: 'session'},
  stdout: NodeJS.WritableStream,
  runtimeConfig: Project02ConfiguredPluginActivation,
  boundCharacter: CharacterProfile | undefined,
): Promise<void> {
  const storage = {
    storeRoot: characterDataDirPath(
      runtimeConfig.resolvedConfig.project02.storeRoot,
      runtimeConfig.resolvedConfig.project02.character,
    ),
  };
  assertInspectedDataDirBinding(
    storage.storeRoot,
    runtimeConfig.resolvedConfig.project02.character,
  );

  const sessionStore = createLocalRuntimeSessionStore(storage);
  const session = await sessionStore.readSession(args.sessionId);
  // The binding holds at inspection too: foreign evidence copied into a
  // bound data directory must fail here exactly as durable chat does.
  const logStore = createFileRuntimeLogStore({
    ...storage,
    sessionId: session.sessionId,
    ...(boundCharacter === undefined ? {} : {boundCharacter}),
  });
  const evidence = logStore.readSessionEvidence();
  const {traceEntries, rawEvents, conversationMessages} = evidence.stored;

  writeJson(stdout, {
    runtimeConfig: createRuntimeConfigInspectShape(
      runtimeConfig.resolvedConfig,
    ),
    characterBinding: readCharacterBinding({
      storeRoot: characterDataDirPath(
        runtimeConfig.resolvedConfig.project02.storeRoot,
        runtimeConfig.resolvedConfig.project02.character,
      ),
    }),
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
