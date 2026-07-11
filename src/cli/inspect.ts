import { pathToFileURL } from 'node:url';

import type { RoleModelDecisionResult } from '../role-model/contracts.ts';
import {
  isTerminalRawEventLogRecord,
  type ConversationLogRecord,
  type RawEventLogRecord,
  type RoleModelCommitValidationResult,
  type RuntimeTraceEntry,
  type RuntimeTurnStatus
} from '../runtime/log.ts';
import { createFileRuntimeLogStore } from '../runtime/storage/file-runtime-log-store.ts';
import {
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeSessionId,
  type LocalRuntimeSessionMetadata
} from '../runtime/storage/layout.ts';
import { createLocalRuntimeSessionStore } from '../runtime/storage/session-store.ts';
import type {
  RuntimePluginAccessMap,
  RuntimePluginContextItem,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginTurnEvidenceSnapshot
} from '../plugins/types.ts';
import {
  formatLocalRuntimeTerminalError,
  isLocalRuntimeTerminalError
} from '../runtime/terminal-errors.ts';
import {
  createRuntimeConfigInspectShape,
  diagnosticsHaveErrors,
  loadProject02RuntimeConfig,
  resolveConfiguredProject02PluginActivation,
  type Project02ConfiguredPluginActivation,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigInspectShape,
  type RuntimePluginFactoryDefinition
} from '../runtime/config/index.ts';
import {
  parseRuntimeLocationFlag,
  RuntimeLocationCliUsageError,
  type RuntimeLocationCliState
} from './runtime-location.ts';
import {
  defaultDotEnvForRuntimeLocation,
  loadRuntimeConfigEnvFile,
  readDefaultDotEnvFile,
  resolveRuntimeConfigActivationBeforeEnvFile,
  RuntimeEnvFileError,
  shouldReadDefaultDotEnvForRuntimeLocation
} from './runtime-env.ts';

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
    }
  | {
      readonly mode: 'session';
      readonly storeRoot?: string;
      readonly configPath?: string;
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
  readonly counts: {
    readonly traceEntries: number;
    readonly rawEvents: number;
    readonly conversationMessages: number;
  };
  readonly turns: readonly InspectTurnEvidence[];
};

type InspectConfiguredPlugin = {
  readonly pluginId: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly requestedAccess: RuntimePluginAccessMap;
  readonly grantedAccess: RuntimePluginAccessMap;
  readonly activationStatus: string;
  readonly activationReasons: readonly string[];
  readonly diagnostics: readonly unknown[];
  readonly config?: unknown;
};

type InspectRuntimeOptions = {
  readonly configEnv: NodeJS.ProcessEnv;
  readonly runtimeEnv: NodeJS.ProcessEnv;
  readonly runtimeEnvDefaults?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
};

type InspectTurnEvidence = {
  readonly eventId: string;
  readonly traceId: string;
  readonly status: RuntimeTurnStatus;
  readonly steps: readonly string[];
  readonly visibleMessages: readonly InspectVisibleMessage[];
  readonly modelRounds: readonly InspectRoleModelRoundEvidence[];
  readonly toolEvents: readonly InspectToolCallEvent[];
  readonly roleModelEvidence?: InspectRoleModelEvidence;
  readonly pluginEvidence?: InspectPluginEvidence;
  readonly reason?: string;
};

type InspectVisibleMessage = {
  readonly id: string;
  readonly role: ConversationLogRecord['role'];
  readonly speakerName: string;
  readonly text: string;
};

type InspectToolCallEvent = {
  readonly callId: string;
  readonly round: number;
  readonly toolName: string;
  readonly pluginId: string;
  readonly input?: unknown;
  readonly result?: InspectPluginToolInvocationResult;
  readonly pluginStoreRevision?: number;
};

type InspectRoleModelEvidence = {
  readonly input?: {
    readonly sessionId: string;
    readonly allowedTools: readonly string[];
    readonly outputContractVersion: string;
    readonly currentUserMessage: string;
    readonly recentVisibleMessages: readonly InspectVisibleMessage[];
    readonly runtimeNotes: readonly string[];
    readonly pluginContextItems: readonly InspectPluginContextItem[];
  };
  readonly output?: {
    readonly rawOutputText: string;
    readonly providerMetadata?: unknown;
    readonly providerExchange?: unknown;
  };
  readonly parsedDecision?: InspectParsedRoleModelDecision;
  readonly commitValidation?: InspectRoleModelCommitValidation;
};

type InspectRoleModelRoundEvidence = {
  readonly rawEventKind: string;
  readonly roleModelEvidence: InspectRoleModelEvidence;
};

type InspectParsedRoleModelDecision =
  | {
      readonly status: 'accepted';
      readonly toolCalls: readonly InspectModelToolCall[];
      readonly nonCommittedTopLevelText?: InspectNonCommittedTopLevelText;
    }
  | {
      readonly status: 'rejected';
      readonly rejectionReason: string;
      readonly rejectionDetails?: string;
    };

type InspectModelToolCall = {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
};

type InspectNonCommittedTopLevelText = {
  readonly source: 'model_top_level_text';
  readonly committed: false;
  readonly text: string;
};

type InspectRoleModelCommitValidation =
  | {
      readonly status: 'accepted';
      readonly acceptedVisibleReplyText?: string;
    }
  | {
      readonly status: 'rejected';
      readonly rejectionReason: string;
      readonly rejectionDetails?: string;
    };

type InspectPluginEvidence = {
  readonly contractVersion?: string;
  readonly plugins: readonly InspectPluginListing[];
  readonly contextItems: readonly InspectPluginContextItem[];
  readonly toolInvocations: readonly InspectPluginToolInvocation[];
  readonly evidence: readonly InspectPluginEvidenceSnapshot[];
  readonly policyOutcomes: readonly string[];
  readonly health: readonly InspectPluginHealthSnapshot[];
};

type InspectPluginListing = {
  readonly pluginId: string;
  readonly displayName: string;
  readonly version: string;
  readonly kind: string;
  readonly localTrustLevel: string;
  readonly installed: boolean;
  readonly registered: boolean;
  readonly enabled: boolean;
  readonly availableForTurn: boolean;
  readonly requestedAccess: RuntimePluginAccessMap;
  readonly grantedAccess: RuntimePluginAccessMap;
  readonly providedTools: readonly InspectPluginToolListing[];
  readonly registeredLifecycleHooks: readonly string[];
  readonly redactionLabels: readonly string[];
  readonly configFingerprint?: string;
  readonly healthStatus?: string;
};

type InspectPluginToolListing = {
  readonly name: string;
  readonly validationOwner: string;
  readonly sideEffectLevel: string;
  readonly requiresConfirmation: boolean;
  readonly sourceReferencesRequired: boolean;
};

type InspectPluginContextItem = {
  readonly pluginId: string;
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly budget: {
    readonly estimatedTokens: number;
    readonly priority: number;
  };
  readonly sourceReferences: readonly InspectPluginSourceReference[];
  readonly redactionLabels: readonly string[];
  readonly confidence?: number;
};

type InspectPluginToolInvocation = {
  readonly pluginId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly result: InspectPluginToolInvocationResult;
};

type InspectPluginToolInvocationResult =
  | {
      readonly status: 'accepted';
      readonly output: unknown;
      readonly evidence: readonly InspectPluginEvidenceSnapshot[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      readonly message: string;
      readonly evidence: readonly InspectPluginEvidenceSnapshot[];
    };

type InspectPluginEvidenceSnapshot = {
  readonly pluginId: string;
  readonly evidenceKind: string;
  readonly status: string;
  readonly summary: string;
  readonly redactionLabels: readonly string[];
  readonly policyOutcome?: string;
  readonly sourceReferences?: readonly InspectPluginSourceReference[];
  readonly configFingerprint?: string;
};

type InspectPluginHealthSnapshot = {
  readonly pluginId: string;
  readonly status: string;
  readonly checkedAt: string;
  readonly summary: string;
  readonly redactionLabels: readonly string[];
};

type InspectPluginSourceReference = {
  readonly kind: string;
  readonly id: string;
  readonly title?: string;
  readonly uri?: string;
};

class InspectCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectCliUsageError';
  }
}

export async function runInspectCliFromArgs(
  args: readonly string[],
  options: InspectCliOptions
): Promise<number> {
  try {
    const explicitEnv =
      options.env === undefined || options.env === process.env
        ? undefined
        : options.env;
    const parsedArgs = parseInspectCliArgs(args);
    validateInspectCliArgs(parsedArgs);
    const defaultEnv =
      explicitEnv === undefined &&
      shouldReadDefaultDotEnvForRuntimeLocation({
        location: parsedArgs,
        env: process.env
      })
        ? defaultDotEnvForRuntimeLocation(readDefaultDotEnvFile(), parsedArgs)
        : undefined;
    const runtimeOptions = {
      configEnv: explicitEnv ?? { ...(defaultEnv ?? {}), ...process.env },
      runtimeEnv: explicitEnv ?? process.env,
      ...(defaultEnv === undefined
        ? {}
        : { runtimeEnvDefaults: defaultEnv }),
      ...(options.factories === undefined ? {} : { factories: options.factories })
    } satisfies InspectRuntimeOptions;

    if (parsedArgs.mode === 'sessions') {
      await writeSessionList(parsedArgs, options.stdout, runtimeOptions);
      return 0;
    }

    await writeSessionEvidence(parsedArgs, options.stdout, runtimeOptions);
    return 0;
  } catch (error: unknown) {
    if (
      error instanceof InspectCliUsageError ||
      error instanceof RuntimeLocationCliUsageError ||
      error instanceof RuntimeEnvFileError ||
      isLocalRuntimeTerminalError(error)
    ) {
      options.stderr.write(`Error: ${formatTerminalErrorMessage(error)}\n`);
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
      state: location
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

      sessionId = readFlagValue(args, index, '--session');
      index += 1;
      continue;
    }

    throw new InspectCliUsageError(`Unknown inspect option: ${arg}.`);
  }

  if (sessionsMode && sessionId !== undefined) {
    throw new InspectCliUsageError('Use either --sessions or --session, not both.');
  }

  if (sessionsMode) {
    return {
      mode: 'sessions',
      ...(location.storeRoot === undefined ? {} : { storeRoot: location.storeRoot }),
      ...(location.configPath === undefined ? {} : { configPath: location.configPath })
    } satisfies InspectCliArgs;
  }

  if (sessionId === undefined) {
    throw new InspectCliUsageError('Use --sessions or --session <session-id>.');
  }

  return {
    mode: 'session',
    sessionId,
    ...(location.storeRoot === undefined ? {} : { storeRoot: location.storeRoot }),
    ...(location.configPath === undefined ? {} : { configPath: location.configPath })
  } satisfies InspectCliArgs;
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new InspectCliUsageError(`${flag} requires a value.`);
  }

  return value;
}

function validateInspectCliArgs(args: InspectCliArgs): void {
  if (args.storeRoot !== undefined) {
    createLocalRuntimeStorageLayout({ storeRoot: args.storeRoot });
  }

  if (args.mode === 'session') {
    normalizeLocalRuntimeSessionId(args.sessionId);
  }
}

async function writeSessionList(
  args: InspectCliArgs & { readonly mode: 'sessions' },
  stdout: NodeJS.WritableStream,
  runtimeOptions: InspectRuntimeOptions
): Promise<void> {
  const runtimeConfig = inspectRuntimeConfig(args, runtimeOptions);
  const sessionStore = createLocalRuntimeSessionStore({
    storeRoot: runtimeConfig.resolvedConfig.storeRoot
  });
  const sessions = await sessionStore.listSessions();

  writeJson(stdout, {
    runtimeConfig: createRuntimeConfigInspectShape(runtimeConfig.resolvedConfig),
    activationDiagnostics: Object.freeze([
      ...runtimeConfig.activation.diagnostics
    ]),
    plugins: inspectConfiguredPlugins(runtimeConfig),
    sessions
  } satisfies InspectSessionListOutput);
}

async function writeSessionEvidence(
  args: InspectCliArgs & { readonly mode: 'session' },
  stdout: NodeJS.WritableStream,
  runtimeOptions: InspectRuntimeOptions
): Promise<void> {
  const runtimeConfig = inspectRuntimeConfig(args, runtimeOptions);
  const storage = {
    storeRoot: runtimeConfig.resolvedConfig.storeRoot
  };
  const sessionStore = createLocalRuntimeSessionStore(storage);
  const session = await sessionStore.readSession(args.sessionId);
  const logStore = createFileRuntimeLogStore({
    ...storage,
    sessionId: session.sessionId
  });
  const traceEntries = logStore.traceEntries();
  const rawEvents = logStore.rawEvents();
  const conversationMessages = logStore.conversationMessages();

  writeJson(stdout, {
    runtimeConfig: createRuntimeConfigInspectShape(runtimeConfig.resolvedConfig),
    activationDiagnostics: Object.freeze([
      ...runtimeConfig.activation.diagnostics
    ]),
    plugins: inspectConfiguredPlugins(runtimeConfig),
    session,
    counts: {
      traceEntries: traceEntries.length,
      rawEvents: rawEvents.length,
      conversationMessages: conversationMessages.length
    },
    turns: createTurnEvidence({
      conversationMessages,
      rawEvents,
      traceEntries
    })
  } satisfies InspectSessionOutput);
}

function inspectRuntimeConfig(args: {
  readonly storeRoot?: string;
  readonly configPath?: string;
}, options: InspectRuntimeOptions): Project02ConfiguredPluginActivation {
  const loadedConfig = loadProject02RuntimeConfig({
    ...args,
    env: options.configEnv
  });

  if (diagnosticsHaveErrors(loadedConfig.diagnostics)) {
    throw new InspectCliUsageError(
      loadedConfig.diagnostics[0]?.message ?? 'Runtime config is invalid.'
    );
  }

  const activationBeforeEnv = resolveRuntimeConfigActivationBeforeEnvFile({
    loadedConfig,
    ...(args.storeRoot === undefined ? {} : { storeRoot: args.storeRoot }),
    env: options.configEnv,
    ...(options.factories === undefined ? {} : { factories: options.factories })
  });

  if (activationBeforeEnv !== undefined) {
    return activationBeforeEnv;
  }

  const runtimeEnv = loadRuntimeConfigEnvFile({
    loadedConfig,
    ...(args.storeRoot === undefined ? {} : { storeRoot: args.storeRoot }),
    env: options.runtimeEnv,
    ...(options.runtimeEnvDefaults === undefined
      ? {}
      : { envDefaults: options.runtimeEnvDefaults })
  });

  return resolveConfiguredProject02PluginActivation({
    loadedConfig,
    ...(args.storeRoot === undefined ? {} : { storeRoot: args.storeRoot }),
    env: runtimeEnv,
    ...(options.factories === undefined ? {} : { factories: options.factories })
  });
}

function inspectConfiguredPlugins(
  runtimeConfig: Project02ConfiguredPluginActivation
): readonly InspectConfiguredPlugin[] {
  return Object.freeze(
    runtimeConfig.activation.plugins.map((plugin) =>
      Object.freeze({
        pluginId: plugin.pluginId,
        kind: plugin.kind,
        enabled: plugin.enabled,
        requestedAccess: plugin.requestedAccess,
        grantedAccess: plugin.grantedAccess,
        activationStatus: plugin.activationStatus,
        activationReasons: Object.freeze([...plugin.activationReasons]),
        diagnostics: Object.freeze([...plugin.diagnostics]),
        ...(runtimeConfig.resolvedConfig.redactedPluginConfigs[plugin.pluginId] === undefined
          ? {}
          : {
              config:
                runtimeConfig.resolvedConfig.redactedPluginConfigs[plugin.pluginId]
            })
      } satisfies InspectConfiguredPlugin)
    )
  );
}

function createTurnEvidence(options: {
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
}): readonly InspectTurnEvidence[] {
  return Object.freeze(
    options.rawEvents
      .filter(isTerminalTurnRawEvent)
      .map((rawEvent) =>
        createTurnEvidenceEntry({
          conversationMessages: options.conversationMessages,
          rawEvents: options.rawEvents,
          rawEvent,
          traceEntries: options.traceEntries
        })
      )
  );
}

function createTurnEvidenceEntry(options: {
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly rawEvent: RawEventLogRecord;
  readonly traceEntries: readonly RuntimeTraceEntry[];
}): InspectTurnEvidence {
  const visibleMessageIds = options.rawEvent.visibleMessageIds ?? [];

  return Object.freeze({
    eventId: options.rawEvent.eventId,
    traceId: options.rawEvent.traceId,
    status: terminalTurnStatus(options.rawEvent),
    steps: Object.freeze(
      options.traceEntries
        .filter(
          (entry) =>
            entry.eventId === options.rawEvent.eventId &&
            entry.traceId === options.rawEvent.traceId
        )
        .map((entry) => entry.step)
    ),
    visibleMessages: Object.freeze(
      visibleMessageIds.flatMap((messageId) =>
        visibleMessagesForId(options.conversationMessages, messageId)
      )
    ),
    modelRounds: modelRoundsForTurn({
      rawEvents: options.rawEvents,
      terminalRawEvent: options.rawEvent
    }),
    toolEvents: toolEventsForTurn({
      rawEvents: options.rawEvents,
      terminalRawEvent: options.rawEvent
    }),
    ...roleModelEvidenceForRawEvent(options.rawEvent),
    ...pluginEvidenceForTurn({
      rawEvents: options.rawEvents,
      terminalRawEvent: options.rawEvent
    }),
    ...(options.rawEvent.reason === undefined
      ? {}
      : { reason: options.rawEvent.reason })
  } satisfies InspectTurnEvidence);
}

function roleModelEvidenceForRawEvent(
  rawEvent: RawEventLogRecord
): { readonly roleModelEvidence?: InspectRoleModelEvidence } {
  if (
    rawEvent.roleModelIOSnapshot === undefined &&
    rawEvent.parsedRoleModelDecisionSnapshot === undefined &&
    rawEvent.commitValidation === undefined
  ) {
    return {};
  }

  const inputEnvelope = rawEvent.roleModelIOSnapshot?.inputEnvelope;
  const parsedDecision = rawEvent.parsedRoleModelDecisionSnapshot?.result;
  const commitValidation = rawEvent.commitValidation?.result;

  return {
    roleModelEvidence: Object.freeze({
      ...(inputEnvelope === undefined
        ? {}
        : {
            input: Object.freeze({
              sessionId: inputEnvelope.decisionContext.sessionId,
              allowedTools: Object.freeze([...inputEnvelope.allowedTools]),
              outputContractVersion: inputEnvelope.outputContract.version,
              currentUserMessage:
                inputEnvelope.event.payload.currentUserMessage,
              recentVisibleMessages: Object.freeze(
                inputEnvelope.decisionContext.recentVisibleMessages.map(
                  visibleMessageFromSnapshot
                )
              ),
              runtimeNotes: Object.freeze([
                ...inputEnvelope.decisionContext.runtimeNotes
              ]),
              pluginContextItems: pluginContextItemsFromSnapshots(
                inputEnvelope.decisionContext.pluginContextItems
              )
            })
          }),
      ...(rawEvent.roleModelIOSnapshot === undefined
        ? {}
        : {
            output: Object.freeze({
              rawOutputText: rawEvent.roleModelIOSnapshot.rawOutputText,
              ...(rawEvent.roleModelIOSnapshot.providerMetadata === undefined
                ? {}
                : {
                    providerMetadata:
                      rawEvent.roleModelIOSnapshot.providerMetadata
                  }),
              ...(rawEvent.roleModelIOSnapshot.providerExchange === undefined
                ? {}
                : {
                    providerExchange:
                      rawEvent.roleModelIOSnapshot.providerExchange
                  })
            })
          }),
      ...(parsedDecision === undefined
        ? {}
        : { parsedDecision: parsedRoleModelDecision(parsedDecision) }),
      ...(commitValidation === undefined
        ? {}
        : {
            commitValidation:
              roleModelCommitValidation(commitValidation)
          })
    } satisfies InspectRoleModelEvidence)
  };
}

function modelRoundsForTurn(options: {
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly terminalRawEvent: RawEventLogRecord;
}): readonly InspectRoleModelRoundEvidence[] {
  const seenEvidenceKeys = new Set<string>();
  const rounds: InspectRoleModelRoundEvidence[] = [];

  for (const rawEvent of options.rawEvents) {
    if (
      rawEvent.eventId !== options.terminalRawEvent.eventId ||
      rawEvent.traceId !== options.terminalRawEvent.traceId
    ) {
      continue;
    }

    const evidence = roleModelEvidenceForRawEvent(rawEvent).roleModelEvidence;

    if (evidence === undefined) {
      continue;
    }

    const evidenceKey = roleModelRoundEvidenceKey(evidence);

    if (seenEvidenceKeys.has(evidenceKey)) {
      continue;
    }

    seenEvidenceKeys.add(evidenceKey);
    rounds.push(
      Object.freeze({
        rawEventKind: rawEvent.kind,
        roleModelEvidence: evidence
      } satisfies InspectRoleModelRoundEvidence)
    );
  }

  return Object.freeze(rounds);
}

function roleModelRoundEvidenceKey(
  evidence: InspectRoleModelEvidence
): string {
  return JSON.stringify({
    input: evidence.input,
    output: evidence.output,
    parsedDecision: evidence.parsedDecision
  });
}

function toolEventsForTurn(options: {
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly terminalRawEvent: RawEventLogRecord;
}): readonly InspectToolCallEvent[] {
  const referencedCallIds = new Set(options.terminalRawEvent.toolCallIds ?? []);

  if (referencedCallIds.size === 0) {
    return Object.freeze([]);
  }

  return Object.freeze(
    options.rawEvents
      .filter(
        (rawEvent) =>
          rawEvent.eventId === options.terminalRawEvent.eventId &&
          rawEvent.traceId === options.terminalRawEvent.traceId &&
          rawEvent.toolCallId !== undefined &&
          referencedCallIds.has(rawEvent.toolCallId) &&
          (rawEvent.kind === 'tool_call_started' ||
            rawEvent.kind === 'tool_call_finished')
      )
      .map((rawEvent) =>
        Object.freeze({
          callId: rawEvent.toolCallId ?? '',
          round: rawEvent.toolRound ?? 0,
          toolName: rawEvent.toolName ?? '',
          pluginId: rawEvent.toolPluginId ?? '',
          ...(rawEvent.toolInput === undefined ? {} : { input: rawEvent.toolInput }),
          ...(rawEvent.toolResult === undefined
            ? {}
            : { result: pluginToolInvocationResult(rawEvent.toolResult) }),
          ...(rawEvent.pluginStoreRevision === undefined
            ? {}
            : { pluginStoreRevision: rawEvent.pluginStoreRevision })
        } satisfies InspectToolCallEvent)
      )
  );
}

function pluginEvidenceForTurn(options: {
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly terminalRawEvent: RawEventLogRecord;
}): { readonly pluginEvidence?: InspectPluginEvidence } {
  const turnEvidence = options.terminalRawEvent.runtimePluginTurnEvidence;
  const simpleEvidence = options.rawEvents
    .filter((rawEvent) =>
      sameTurnPluginEvidenceRawEvent({
        rawEvent,
        terminalRawEvent: options.terminalRawEvent
      })
    )
    .flatMap((rawEvent) => rawEvent.runtimePluginEvidence ?? []);

  if (turnEvidence === undefined && simpleEvidence.length === 0) {
    return {};
  }

  const evidence = uniquePluginEvidenceSnapshots([
    ...simpleEvidence,
    ...(turnEvidence?.evidence ?? [])
  ]);

  return {
    pluginEvidence: Object.freeze({
      ...(turnEvidence === undefined
        ? {}
        : { contractVersion: turnEvidence.contractVersion }),
      plugins: pluginListings(turnEvidence),
      contextItems: pluginContextItems(turnEvidence),
      toolInvocations: pluginToolInvocations(turnEvidence),
      evidence: Object.freeze(evidence.map(pluginEvidenceSnapshot)),
      policyOutcomes: policyOutcomes(evidence),
      health: pluginHealthSnapshots(turnEvidence)
    } satisfies InspectPluginEvidence)
  };
}

function sameTurnPluginEvidenceRawEvent(options: {
  readonly rawEvent: RawEventLogRecord;
  readonly terminalRawEvent: RawEventLogRecord;
}): boolean {
  return (
    options.rawEvent.eventId === options.terminalRawEvent.eventId &&
    options.rawEvent.traceId === options.terminalRawEvent.traceId &&
    (options.rawEvent === options.terminalRawEvent ||
      options.rawEvent.kind === 'after_turn_committed')
  );
}

function pluginListings(
  turnEvidence: RuntimePluginTurnEvidenceSnapshot | undefined
): readonly InspectPluginListing[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.plugins.map((plugin) =>
      Object.freeze({
        pluginId: plugin.pluginId,
        displayName: plugin.manifest.displayName,
        version: plugin.manifest.version,
        kind: plugin.manifest.kind,
        localTrustLevel: plugin.manifest.localTrustLevel,
        installed: plugin.installed,
        registered: plugin.registered,
        enabled: plugin.enabled,
        availableForTurn: plugin.availableForTurn,
        requestedAccess: plugin.requestedAccess,
        grantedAccess: plugin.grantedAccess,
        providedTools: Object.freeze(
          plugin.providedTools.map((tool) =>
            Object.freeze({
              name: tool.name,
              validationOwner: tool.validationOwner,
              sideEffectLevel: tool.sideEffectLevel,
              requiresConfirmation: tool.requiresConfirmation,
              sourceReferencesRequired: tool.sourceReferencesRequired
            } satisfies InspectPluginToolListing)
          )
        ),
        registeredLifecycleHooks: Object.freeze([
          ...plugin.registeredLifecycleHooks
        ]),
        redactionLabels: Object.freeze([...plugin.redactionLabels]),
        ...(plugin.configFingerprint === undefined
          ? {}
          : { configFingerprint: plugin.configFingerprint }),
        ...(plugin.healthStatus === undefined
          ? {}
          : { healthStatus: plugin.healthStatus })
      } satisfies InspectPluginListing)
    )
  );
}

function pluginContextItemsFromSnapshots(
  items: readonly RuntimePluginContextItem[]
): readonly InspectPluginContextItem[] {
  return Object.freeze(
    items.map((item) =>
      Object.freeze({
        pluginId: item.pluginId,
        id: item.id,
        kind: item.kind,
        text: item.text,
        budget: Object.freeze({
          estimatedTokens: item.budget.estimatedTokens,
          priority: item.budget.priority
        }),
        sourceReferences: sourceReferences(item.sourceReferences),
        redactionLabels: Object.freeze([...item.redactionLabels]),
        ...(item.confidence === undefined ? {} : { confidence: item.confidence })
      } satisfies InspectPluginContextItem)
    )
  );
}

function pluginContextItems(
  turnEvidence: RuntimePluginTurnEvidenceSnapshot | undefined
): readonly InspectPluginContextItem[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.contextItems.map((item) =>
      Object.freeze({
        pluginId: item.pluginId,
        id: item.id,
        kind: item.kind,
        text: item.text,
        budget: Object.freeze({
          estimatedTokens: item.budget.estimatedTokens,
          priority: item.budget.priority
        }),
        sourceReferences: sourceReferences(item.sourceReferences),
        redactionLabels: Object.freeze([...item.redactionLabels]),
        ...(item.confidence === undefined ? {} : { confidence: item.confidence })
      } satisfies InspectPluginContextItem)
    )
  );
}

function pluginToolInvocations(
  turnEvidence: RuntimePluginTurnEvidenceSnapshot | undefined
): readonly InspectPluginToolInvocation[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.toolInvocations.map((invocation) =>
      Object.freeze({
        pluginId: invocation.pluginId,
        toolName: invocation.toolName,
        input: invocation.input,
        result: pluginToolInvocationResult(invocation.result)
      } satisfies InspectPluginToolInvocation)
    )
  );
}

function pluginToolInvocationResult(
  result: RuntimePluginTurnEvidenceSnapshot['toolInvocations'][number]['result']
): InspectPluginToolInvocationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: result.output,
      evidence: Object.freeze(result.evidence.map(pluginEvidenceSnapshot))
    } satisfies InspectPluginToolInvocationResult);
  }

  return Object.freeze({
    status: 'rejected',
    reason: result.reason,
    message: result.message,
    evidence: Object.freeze(result.evidence.map(pluginEvidenceSnapshot))
  } satisfies InspectPluginToolInvocationResult);
}

function pluginEvidenceSnapshot(
  snapshot: RuntimePluginEvidenceSnapshot
): InspectPluginEvidenceSnapshot {
  return Object.freeze({
    pluginId: snapshot.pluginId,
    evidenceKind: snapshot.evidenceKind,
    status: snapshot.status,
    summary: snapshot.summary,
    redactionLabels: Object.freeze([...snapshot.redactionLabels]),
    ...(snapshot.policyOutcome === undefined
      ? {}
      : { policyOutcome: snapshot.policyOutcome }),
    ...(snapshot.sourceReferences === undefined
      ? {}
      : { sourceReferences: sourceReferences(snapshot.sourceReferences) }),
    ...(snapshot.configFingerprint === undefined
      ? {}
      : { configFingerprint: snapshot.configFingerprint })
  } satisfies InspectPluginEvidenceSnapshot);
}

function uniquePluginEvidenceSnapshots(
  snapshots: readonly RuntimePluginEvidenceSnapshot[]
): readonly RuntimePluginEvidenceSnapshot[] {
  const seen = new Set<string>();
  const uniqueSnapshots: RuntimePluginEvidenceSnapshot[] = [];

  for (const snapshot of snapshots) {
    const key = pluginEvidenceSnapshotKey(snapshot);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueSnapshots.push(snapshot);
  }

  return Object.freeze(uniqueSnapshots);
}

function pluginEvidenceSnapshotKey(
  snapshot: RuntimePluginEvidenceSnapshot
): string {
  return JSON.stringify({
    eventId: snapshot.eventId,
    traceId: snapshot.traceId,
    createdAt: snapshot.createdAt,
    kind: snapshot.kind,
    pluginId: snapshot.pluginId,
    evidenceKind: snapshot.evidenceKind,
    status: snapshot.status,
    summary: snapshot.summary,
    policyOutcome: snapshot.policyOutcome,
    sourceReferences: snapshot.sourceReferences,
    redactionLabels: snapshot.redactionLabels,
    configFingerprint: snapshot.configFingerprint
  });
}

function pluginHealthSnapshots(
  turnEvidence: RuntimePluginTurnEvidenceSnapshot | undefined
): readonly InspectPluginHealthSnapshot[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.health.map((snapshot) =>
      Object.freeze({
        pluginId: snapshot.pluginId,
        status: snapshot.status,
        checkedAt: snapshot.checkedAt,
        summary: snapshot.summary,
        redactionLabels: Object.freeze([...snapshot.redactionLabels])
      } satisfies InspectPluginHealthSnapshot)
    )
  );
}

function policyOutcomes(
  evidence: readonly RuntimePluginEvidenceSnapshot[]
): readonly string[] {
  const outcomes: string[] = [];

  for (const snapshot of evidence) {
    if (
      snapshot.policyOutcome !== undefined &&
      !outcomes.includes(snapshot.policyOutcome)
    ) {
      outcomes.push(snapshot.policyOutcome);
    }
  }

  return Object.freeze(outcomes);
}

function sourceReferences(
  references: readonly InspectPluginSourceReference[]
): readonly InspectPluginSourceReference[] {
  return Object.freeze(
    references.map((reference) =>
      Object.freeze({
        kind: reference.kind,
        id: reference.id,
        ...(reference.title === undefined ? {} : { title: reference.title }),
        ...(reference.uri === undefined ? {} : { uri: reference.uri })
      } satisfies InspectPluginSourceReference)
    )
  );
}

function parsedRoleModelDecision(
  result: RoleModelDecisionResult
): InspectParsedRoleModelDecision {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      toolCalls: Object.freeze(
        result.decision.toolCalls.map((toolCall) =>
          Object.freeze({
            name: toolCall.name,
            input: Object.freeze({ ...toolCall.input })
          } satisfies InspectModelToolCall)
        )
      ),
      ...(result.nonCommittedText !== undefined
        ? {
            nonCommittedTopLevelText: Object.freeze({
              source: 'model_top_level_text',
              committed: false,
              text: result.nonCommittedText
            } satisfies InspectNonCommittedTopLevelText)
          }
        : {})
    } satisfies InspectParsedRoleModelDecision);
  }

  return Object.freeze({
    status: 'rejected',
    rejectionReason: result.rejection.reason,
    ...(result.rejection.details === undefined
      ? {}
      : { rejectionDetails: result.rejection.details })
  } satisfies InspectParsedRoleModelDecision);
}

function roleModelCommitValidation(
  result: RoleModelCommitValidationResult
): InspectRoleModelCommitValidation {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      ...(result.acceptedVisibleReplyText === undefined
        ? {}
        : { acceptedVisibleReplyText: result.acceptedVisibleReplyText })
    } satisfies InspectRoleModelCommitValidation);
  }

  return Object.freeze({
    status: 'rejected',
    rejectionReason: result.rejection.reason,
    ...(result.rejection.details === undefined
      ? {}
      : { rejectionDetails: result.rejection.details })
  } satisfies InspectRoleModelCommitValidation);
}

function isTerminalTurnRawEvent(record: RawEventLogRecord): boolean {
  return isTerminalRawEventLogRecord(record);
}

function terminalTurnStatus(record: RawEventLogRecord): RuntimeTurnStatus {
  if (record.status !== undefined) {
    return record.status;
  }

  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    'Stored terminal raw event is missing a turn status.'
  );
}

function visibleMessagesForId(
  conversationMessages: readonly ConversationLogRecord[],
  messageId: string
): readonly InspectVisibleMessage[] {
  const message = conversationMessages.find((candidate) => candidate.id === messageId);

  if (message === undefined) {
    return [];
  }

  return [
    Object.freeze({
      id: message.id,
      role: message.role,
      speakerName: message.speakerName,
      text: message.text
    } satisfies InspectVisibleMessage)
  ];
}

function visibleMessageFromSnapshot(message: {
  readonly id: string;
  readonly role: ConversationLogRecord['role'];
  readonly speakerName: string;
  readonly text: string;
}): InspectVisibleMessage {
  return Object.freeze({
    id: message.id,
    role: message.role,
    speakerName: message.speakerName,
    text: message.text
  } satisfies InspectVisibleMessage);
}

function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatTerminalErrorMessage(
  error:
    | InspectCliUsageError
    | RuntimeLocationCliUsageError
    | RuntimeEnvFileError
    | Parameters<typeof formatLocalRuntimeTerminalError>[0]
): string {
  if (
    error instanceof InspectCliUsageError ||
    error instanceof RuntimeLocationCliUsageError ||
    error instanceof RuntimeEnvFileError
  ) {
    return error.message;
  }

  return formatLocalRuntimeTerminalError(error);
}

function isMainModule(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];

  if (scriptPath === undefined) {
    return false;
  }

  return pathToFileURL(scriptPath).href === moduleUrl;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runInspectCliFromArgs(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr
  });
}
