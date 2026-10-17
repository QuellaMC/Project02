import {readFlagValue} from '../shared/flags.ts';
import {writeJson} from '../shared/output.ts';
import type {CharacterProfile} from '../../core/index.ts';
import type {Conversation} from '../../core/index.ts';
import {
  createFileRuntimeLogStore,
  createLocalRuntimeConversationStore,
  createLocalRuntimeSessionStore,
  createProject02HomeLayout,
  normalizeConversationId,
  normalizeLocalRuntimeSessionId,
  parseSegmentSessionId,
  type LocalRuntimeSessionMetadata,
} from '../../runtime/storage/index.ts';
import {
  isCliTerminalError,
  formatCliTerminalErrorMessage,
} from '../shared/terminal-errors.ts';
import {
  formatRejectedRuntimeCliStartup,
  interpretRuntimeCliStartup,
} from '../shared/startup-outcome.ts';
import {
  createRuntimeConfigInspectShape,
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
  parseRuntimeStoreFlag,
  type RuntimeLocationCliState,
} from '../shared/runtime-location-flags.ts';
import {CliUsageError} from '../shared/usage-error.ts';
import {
  createTurnEvidence,
  type InspectTurnEvidence,
} from '../../runtime/evidence/index.ts';
import type {SessionContinuationSnapshot} from '../../runtime/index.ts';
import {
  inspectConfiguredConnectors,
  inspectConfiguredPlugins,
  type InspectConfiguredConnector,
  type InspectConfiguredPlugin,
} from '../../runtime/config/index.ts';
import {isMainModule} from '../shared/main-module.ts';

type InspectCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
};

type InspectCliLocationArgs = {
  readonly storeRoot?: string;
  readonly character?: string;
};

type InspectCliArgs =
  | (InspectCliLocationArgs & {readonly mode: 'sessions'})
  | (InspectCliLocationArgs & {
      readonly mode: 'session';
      readonly sessionId: string;
    })
  | (InspectCliLocationArgs & {readonly mode: 'conversations'})
  | (InspectCliLocationArgs & {
      readonly mode: 'conversation';
      readonly conversationId: string;
    });

type InspectConfiguration = {
  readonly runtimeConfig: RuntimeConfigInspectShape;
  readonly activationDiagnostics: readonly RuntimeConfigDiagnostic[];
  readonly plugins: readonly InspectConfiguredPlugin[];
  readonly connectors: readonly InspectConfiguredConnector[];
};

type InspectSessionListOutput = InspectConfiguration & {
  readonly sessions: readonly LocalRuntimeSessionMetadata[];
};

type InspectConversationListOutput = InspectConfiguration & {
  readonly conversations: readonly Conversation[];
};

type InspectConversationOutput = InspectConfiguration & {
  readonly conversation: Conversation;
  /** The configured character's segments of this conversation, in order. */
  readonly sessions: readonly LocalRuntimeSessionMetadata[];
};

type InspectSessionOutput = InspectConfiguration & {
  readonly session: LocalRuntimeSessionMetadata;
  /** The opening record of a session that continues another. */
  readonly continuation?: SessionContinuationSnapshot;
  readonly evidenceScopes: {
    readonly runtimeConfig: 'current_at_inspection';
    readonly activation: 'current_at_inspection';
    readonly storedSessionEvidence: 'stored_history';
    readonly traceEvidence: 'derived_from_event_log';
  };
  readonly counts: {
    readonly traceEntries: number;
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
    const parsedArgs = parseInspectCliArgs(args);
    validateInspectCliArgs(parsedArgs);
    // Inspect reports on a store and never creates one; no consent gate.
    const startup = resolveRuntimeCliStartup({
      stage: 'report',
      location: parsedArgs,
      ...(options.factories === undefined
        ? {}
        : {factories: options.factories}),
    });
    const interpreted = interpretRuntimeCliStartup(startup);

    if (interpreted.outcome === 'rejected') {
      throw new CliUsageError(formatRejectedRuntimeCliStartup(interpreted));
    }

    // Warnings go to stderr: the stdout JSON contract stays intact.
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

    if (parsedArgs.mode === 'conversations') {
      await writeConversationList(
        options.stdout,
        usable.activationPlan,
        usable.runtimeLocation,
      );
      return 0;
    }

    if (parsedArgs.mode === 'conversation') {
      await writeConversationSegments(
        parsedArgs,
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
    if (isCliTerminalError(error)) {
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
  let conversationsMode = false;
  let conversationId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === '--') {
      continue;
    }

    // Saying why the flag does not apply beats an unknown-option report.
    if (arg === '--init') {
      throw new CliUsageError(
        'inspect never creates a store, so --init does not apply. ' +
          'Run serve with --init to create one.',
      );
    }

    const storeResult = parseRuntimeStoreFlag({
      args,
      index,
      location,
    });

    if (storeResult.status === 'matched') {
      location = storeResult.location;
      index = storeResult.nextIndex;
      continue;
    }

    if (arg === '--sessions') {
      if (sessionsMode) {
        throw new CliUsageError('--sessions can only be provided once.');
      }

      sessionsMode = true;
      continue;
    }

    if (arg === '--session') {
      if (sessionId !== undefined) {
        throw new CliUsageError('--session can only be provided once.');
      }

      sessionId = readFlagValue(args, index, '--session');
      index += 1;
      continue;
    }

    if (arg === '--conversations') {
      if (conversationsMode) {
        throw new CliUsageError('--conversations can only be provided once.');
      }

      conversationsMode = true;
      continue;
    }

    if (arg === '--conversation') {
      if (conversationId !== undefined) {
        throw new CliUsageError('--conversation can only be provided once.');
      }

      conversationId = readFlagValue(args, index, '--conversation');
      index += 1;
      continue;
    }

    throw new CliUsageError(`Unknown inspect option: ${arg}.`);
  }

  return resolveInspectMode(
    {sessionsMode, sessionId, conversationsMode, conversationId},
    location,
  );
}

function resolveInspectMode(
  modes: {
    readonly sessionsMode: boolean;
    readonly sessionId: string | undefined;
    readonly conversationsMode: boolean;
    readonly conversationId: string | undefined;
  },
  location: RuntimeLocationCliState,
): InspectCliArgs {
  const modeCount = [
    modes.sessionsMode,
    modes.sessionId !== undefined,
    modes.conversationsMode,
    modes.conversationId !== undefined,
  ].filter(Boolean).length;

  if (modeCount > 1) {
    throw new CliUsageError(
      'Use exactly one of --sessions, --session, --conversations, or --conversation.',
    );
  }

  const locationArgs = {
    ...(location.storeRoot === undefined
      ? {}
      : {storeRoot: location.storeRoot}),
    ...(location.character === undefined
      ? {}
      : {character: location.character}),
  } satisfies InspectCliLocationArgs;

  if (modes.sessionsMode) {
    return {mode: 'sessions', ...locationArgs} satisfies InspectCliArgs;
  }

  if (modes.conversationsMode) {
    return {mode: 'conversations', ...locationArgs} satisfies InspectCliArgs;
  }

  if (modes.conversationId !== undefined) {
    return {
      mode: 'conversation',
      conversationId: modes.conversationId,
      ...locationArgs,
    } satisfies InspectCliArgs;
  }

  if (modes.sessionId === undefined) {
    throw new CliUsageError(
      'Use --sessions, --session <session-id>, --conversations, or --conversation <conversation-id>.',
    );
  }

  return {
    mode: 'session',
    sessionId: modes.sessionId,
    ...locationArgs,
  } satisfies InspectCliArgs;
}

function validateInspectCliArgs(args: InspectCliArgs): void {
  if (args.storeRoot !== undefined) {
    createProject02HomeLayout({homeRoot: args.storeRoot});
  }

  if (args.mode === 'session') {
    normalizeLocalRuntimeSessionId(args.sessionId);
  }

  if (args.mode === 'conversation') {
    normalizeConversationId(args.conversationId);
  }
}

function inspectConfiguration(
  runtimeConfig: Project02ConfiguredPluginActivation,
): InspectConfiguration {
  return {
    runtimeConfig: createRuntimeConfigInspectShape(
      runtimeConfig.resolvedConfig,
    ),
    activationDiagnostics: Object.freeze([
      ...runtimeConfig.activation.diagnostics,
    ]),
    plugins: inspectConfiguredPlugins(runtimeConfig),
    connectors: inspectConfiguredConnectors(runtimeConfig.resolvedConfig),
  };
}

async function writeConversationList(
  stdout: NodeJS.WritableStream,
  runtimeConfig: Project02ConfiguredPluginActivation,
  runtimeLocation: ResolvedProject02RuntimeLocation,
): Promise<void> {
  const conversationStore = createLocalRuntimeConversationStore({
    homeRoot: runtimeLocation.homeRoot,
  });

  writeJson(stdout, {
    ...inspectConfiguration(runtimeConfig),
    conversations: await conversationStore.listConversations(),
  } satisfies InspectConversationListOutput);
}

async function writeConversationSegments(
  args: InspectCliArgs & {readonly mode: 'conversation'},
  stdout: NodeJS.WritableStream,
  runtimeConfig: Project02ConfiguredPluginActivation,
  runtimeLocation: ResolvedProject02RuntimeLocation,
): Promise<void> {
  const conversationStore = createLocalRuntimeConversationStore({
    homeRoot: runtimeLocation.homeRoot,
  });
  const conversation = await conversationStore.readConversation(
    args.conversationId,
  );
  const sessionStore = createLocalRuntimeSessionStore({
    storeRoot: runtimeLocation.characterScope.dataRoot,
    characterId: runtimeLocation.characterScope.characterId,
  });
  const sessions = (await sessionStore.listSessions())
    .filter(
      metadata =>
        parseSegmentSessionId(metadata.sessionId).conversationId ===
        conversation.id,
    )
    .sort(
      (left, right) =>
        parseSegmentSessionId(left.sessionId).segment -
        parseSegmentSessionId(right.sessionId).segment,
    );

  writeJson(stdout, {
    ...inspectConfiguration(runtimeConfig),
    conversation,
    sessions,
  } satisfies InspectConversationOutput);
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
    ...inspectConfiguration(runtimeConfig),
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
  // boundCharacter catches a session naming a different character than
  // its directory; the user speaker id is one constant, so it is not bound.
  const logStore = createFileRuntimeLogStore({
    ...storage,
    sessionId: session.sessionId,
    characterId: runtimeLocation.characterScope.characterId,
    boundCharacter,
  });
  const {rawEvents, conversationMessages} = logStore.readSessionEvidence();
  const traceEntries = logStore.traceEntries();

  writeJson(stdout, {
    ...inspectConfiguration(runtimeConfig),
    session,
    ...(rawEvents[0]?.sessionContinuation === undefined
      ? {}
      : {continuation: rawEvents[0].sessionContinuation}),
    evidenceScopes: Object.freeze({
      runtimeConfig: 'current_at_inspection',
      activation: 'current_at_inspection',
      storedSessionEvidence: 'stored_history',
      traceEvidence: 'derived_from_event_log',
    }),
    counts: {
      traceEntries: traceEntries.length,
      rawEvents: rawEvents.length,
      conversationMessages: conversationMessages.length,
    },
    turns: createTurnEvidence({
      conversationMessages,
      rawEvents,
      traceEntries,
    }),
  } satisfies InspectSessionOutput);
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runInspectCliFromArgs(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
