import { canonicalJsonStringify } from '../shared/canonical-json.ts';

import type { RoleModelDecisionResult } from '../role-model/contracts.ts';
import { runtimeEventIdentityKey } from '../runtime/event.ts';
import {
  isTerminalRawEventLogRecordKind,
  type ConversationLogRecord,
  type RawEventLogRecord,
  type RoleModelCommitValidationResult,
  type RuntimeDerivedTraceEntry,
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
  type Project02ConfiguredPluginActivation,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigInspectShape,
  type RuntimePluginFactoryDefinition
} from '../runtime/config/index.ts';
import { ownJsonRecordValue } from '../shared/json-boundary.ts';
import {
  parseRuntimeLocationFlag,
  RuntimeLocationCliUsageError,
  type RuntimeLocationCliState
} from './runtime-location.ts';
import { RuntimeEnvFileError } from './runtime-env.ts';
import { isMainModule } from './main-module.ts';
import { resolveRuntimeCliStartup } from './startup.ts';

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

type InspectTurnEvidence = {
  readonly eventId: string;
  readonly traceId: string;
  readonly status: RuntimeTurnStatus;
  readonly steps: readonly string[];
  readonly derivedSteps: readonly {
    readonly step: string;
    readonly source: 'terminal_raw_event';
    readonly reason: 'missing_persisted_trace_entry';
    readonly rawEventAnchor: {
      readonly eventId: string;
      readonly traceId: string;
      readonly createdAt: string;
      readonly kind: 'runtime_turn_completed' | 'runtime_turn_rejected';
    };
  }[];
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
    const startup = resolveRuntimeCliStartup({
      location: parsedArgs,
      ...(explicitEnv === undefined ? {} : { env: explicitEnv }),
      ...(options.factories === undefined
        ? {}
        : { factories: options.factories })
    });

    if (startup.status === 'config_invalid') {
      throw new InspectCliUsageError(
        startup.loadedConfig.diagnostics[0]?.message ??
          'Runtime config is invalid.'
      );
    }

    if (parsedArgs.mode === 'sessions') {
      await writeSessionList(
        options.stdout,
        startup.activationPlan
      );
      return 0;
    }

    await writeSessionEvidence(
      parsedArgs,
      options.stdout,
      startup.activationPlan
    );
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
  stdout: NodeJS.WritableStream,
  runtimeConfig: Project02ConfiguredPluginActivation
): Promise<void> {
  const sessionStore = createLocalRuntimeSessionStore({
    storeRoot: runtimeConfig.resolvedConfig.project02.storeRoot
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
  runtimeConfig: Project02ConfiguredPluginActivation
): Promise<void> {
  const storage = {
    storeRoot: runtimeConfig.resolvedConfig.project02.storeRoot
  };
  const sessionStore = createLocalRuntimeSessionStore(storage);
  const session = await sessionStore.readSession(args.sessionId);
  const logStore = createFileRuntimeLogStore({
    ...storage,
    sessionId: session.sessionId
  });
  const evidence = logStore.readSessionEvidence();
  const { traceEntries, rawEvents, conversationMessages } = evidence.stored;

  writeJson(stdout, {
    runtimeConfig: createRuntimeConfigInspectShape(runtimeConfig.resolvedConfig),
    activationDiagnostics: Object.freeze([
      ...runtimeConfig.activation.diagnostics
    ]),
    plugins: inspectConfiguredPlugins(runtimeConfig),
    session,
    evidenceScopes: Object.freeze({
      runtimeConfig: 'current_at_inspection',
      activation: 'current_at_inspection',
      storedSessionEvidence: 'stored_history',
      derivedTraceEvidence: 'derived_not_persisted'
    }),
    counts: {
      traceEntries: traceEntries.length,
      derivedTraceEntries: evidence.derived.traceEntries.length,
      rawEvents: rawEvents.length,
      conversationMessages: conversationMessages.length
    },
    turns: createTurnEvidence({
      conversationMessages,
      derivedTraceEntries: evidence.derived.traceEntries,
      rawEvents,
      traceEntries
    })
  } satisfies InspectSessionOutput);
}

function inspectConfiguredPlugins(
  runtimeConfig: Project02ConfiguredPluginActivation
): readonly InspectConfiguredPlugin[] {
  return Object.freeze(
    runtimeConfig.activation.plugins.map((plugin) => {
      const config = ownJsonRecordValue(
        runtimeConfig.resolvedConfig.redactedPluginConfigs,
        plugin.pluginId
      );

      return Object.freeze({
        pluginId: plugin.pluginId,
        kind: plugin.kind,
        enabled: plugin.enabled,
        requestedAccess: plugin.requestedAccess,
        grantedAccess: plugin.grantedAccess,
        activationStatus: plugin.activationStatus,
        activationReasons: Object.freeze([...plugin.activationReasons]),
        diagnostics: Object.freeze([...plugin.diagnostics]),
        ...(config === undefined ? {} : { config })
      } satisfies InspectConfiguredPlugin);
    })
  );
}

function createTurnEvidence(options: {
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly derivedTraceEntries: readonly RuntimeDerivedTraceEntry[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
}): readonly InspectTurnEvidence[] {
  const indexes = createInspectEvidenceIndexes(options);

  return Object.freeze(
    indexes.terminalRawEvents.map((terminalRawEvent) =>
      createTurnEvidenceEntry({
        indexes,
        terminalRawEvent
      })
    )
  );
}

type InspectEvidenceIndexes = {
  readonly conversationById: ReadonlyMap<string, ConversationLogRecord>;
  readonly derivedTraceByIdentity: ReadonlyMap<
    string,
    readonly RuntimeDerivedTraceEntry[]
  >;
  readonly terminalRawEvents: readonly InspectTerminalRawEvent[];
  readonly turnProjectionsByIdentity: ReadonlyMap<
    string,
    InspectTurnRawEventProjection
  >;
  readonly traceEntriesByIdentity: ReadonlyMap<
    string,
    readonly RuntimeTraceEntry[]
  >;
};

type InspectTerminalRawEvent = {
  readonly rawEvent: RawEventLogRecord;
  readonly roleModelEvidence: {
    readonly roleModelEvidence?: InspectRoleModelEvidence;
  };
};

type InspectTurnRawEventProjection = {
  readonly modelRounds: readonly InspectRoleModelRoundEvidence[];
  readonly simplePluginEvidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly toolEvents: readonly InspectToolCallEvent[];
};

type MutableInspectTurnRawEventProjection = {
  readonly modelRounds: InspectRoleModelRoundEvidence[];
  readonly seenModelRoundEvidenceKeys: Set<string>;
  readonly simplePluginEvidence: RuntimePluginEvidenceSnapshot[];
  readonly toolEvents: InspectToolCallEvent[];
};

function createInspectEvidenceIndexes(options: {
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly derivedTraceEntries: readonly RuntimeDerivedTraceEntry[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
}): InspectEvidenceIndexes {
  const rawEventIndexes = createInspectRawEventIndexes(options.rawEvents);

  return Object.freeze({
    conversationById: new Map(
      options.conversationMessages.map((message) => [message.id, message])
    ),
    derivedTraceByIdentity: groupEvidenceByIdentity(
      options.derivedTraceEntries
    ),
    terminalRawEvents: rawEventIndexes.terminalRawEvents,
    turnProjectionsByIdentity: rawEventIndexes.turnProjectionsByIdentity,
    traceEntriesByIdentity: groupEvidenceByIdentity(options.traceEntries)
  });
}

function createInspectRawEventIndexes(
  rawEvents: readonly RawEventLogRecord[]
): Pick<
  InspectEvidenceIndexes,
  'terminalRawEvents' | 'turnProjectionsByIdentity'
> {
  const terminalRawEvents: InspectTerminalRawEvent[] = [];
  const mutableProjections = new Map<
    string,
    MutableInspectTurnRawEventProjection
  >();

  for (const rawEvent of rawEvents) {
    const identityKey = runtimeEventIdentityKey(rawEvent);
    const rawEventKind = rawEvent.kind;
    const projection = mutableInspectTurnProjection(
      mutableProjections,
      identityKey
    );
    const roleModelEvidence = roleModelEvidenceForRawEvent(rawEvent);

    appendInspectModelRound({
      projection,
      rawEventKind,
      roleModelEvidence
    });

    if (
      rawEvent.toolCallId !== undefined &&
      (rawEventKind === 'tool_call_started' ||
        rawEventKind === 'tool_call_finished')
    ) {
      projection.toolEvents.push(inspectToolCallEvent(rawEvent));
    }

    if (
      rawEventKind === 'after_turn_committed' ||
      isTerminalRawEventLogRecordKind(rawEventKind)
    ) {
      projection.simplePluginEvidence.push(
        ...(rawEvent.runtimePluginEvidence ?? [])
      );
    }

    if (isTerminalRawEventLogRecordKind(rawEventKind)) {
      terminalRawEvents.push(
        Object.freeze({
          rawEvent,
          roleModelEvidence
        } satisfies InspectTerminalRawEvent)
      );
    }
  }

  return Object.freeze({
    terminalRawEvents: Object.freeze(terminalRawEvents),
    turnProjectionsByIdentity: freezeInspectTurnProjections(mutableProjections)
  });
}

function mutableInspectTurnProjection(
  projections: Map<string, MutableInspectTurnRawEventProjection>,
  identityKey: string
): MutableInspectTurnRawEventProjection {
  const existing = projections.get(identityKey);

  if (existing !== undefined) {
    return existing;
  }

  const created: MutableInspectTurnRawEventProjection = {
    modelRounds: [],
    seenModelRoundEvidenceKeys: new Set(),
    simplePluginEvidence: [],
    toolEvents: []
  };
  projections.set(identityKey, created);
  return created;
}

function appendInspectModelRound(options: {
  readonly projection: MutableInspectTurnRawEventProjection;
  readonly rawEventKind: RawEventLogRecord['kind'];
  readonly roleModelEvidence: {
    readonly roleModelEvidence?: InspectRoleModelEvidence;
  };
}): void {
  const evidence = options.roleModelEvidence.roleModelEvidence;

  if (evidence === undefined) {
    return;
  }

  const evidenceKey = roleModelRoundEvidenceKey(evidence);

  if (options.projection.seenModelRoundEvidenceKeys.has(evidenceKey)) {
    return;
  }

  options.projection.seenModelRoundEvidenceKeys.add(evidenceKey);
  options.projection.modelRounds.push(
    Object.freeze({
      rawEventKind: options.rawEventKind,
      roleModelEvidence: evidence
    } satisfies InspectRoleModelRoundEvidence)
  );
}

function freezeInspectTurnProjections(
  mutableProjections: ReadonlyMap<
    string,
    MutableInspectTurnRawEventProjection
  >
): ReadonlyMap<string, InspectTurnRawEventProjection> {
  const projections = new Map<string, InspectTurnRawEventProjection>();

  for (const [identityKey, projection] of mutableProjections) {
    projections.set(
      identityKey,
      Object.freeze({
        modelRounds: Object.freeze(projection.modelRounds),
        simplePluginEvidence: Object.freeze(projection.simplePluginEvidence),
        toolEvents: Object.freeze(projection.toolEvents)
      } satisfies InspectTurnRawEventProjection)
    );
  }

  return projections;
}

function groupEvidenceByIdentity<T extends {
  readonly eventId: string;
  readonly traceId: string;
  readonly createdAt: string;
}>(records: readonly T[]): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();

  for (const record of records) {
    const key = runtimeEventIdentityKey(record);
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }

  return grouped;
}

function createTurnEvidenceEntry(options: {
  readonly indexes: InspectEvidenceIndexes;
  readonly terminalRawEvent: InspectTerminalRawEvent;
}): InspectTurnEvidence {
  const { rawEvent, roleModelEvidence } = options.terminalRawEvent;
  const visibleMessageIds = rawEvent.visibleMessageIds ?? [];
  const identityKey = runtimeEventIdentityKey(rawEvent);
  const projection = options.indexes.turnProjectionsByIdentity.get(identityKey);
  const storedTraceEntries =
    options.indexes.traceEntriesByIdentity.get(identityKey) ?? [];
  const derivedTraceEntries =
    options.indexes.derivedTraceByIdentity.get(identityKey) ?? [];

  return Object.freeze({
    eventId: rawEvent.eventId,
    traceId: rawEvent.traceId,
    status: terminalTurnStatus(rawEvent),
    steps: Object.freeze(
      storedTraceEntries.map((entry) => entry.step)
    ),
    derivedSteps: Object.freeze(
      derivedTraceEntries.map((entry) =>
        Object.freeze({
          step: entry.step,
          source: entry.provenance.source,
          reason: entry.provenance.reason,
          rawEventAnchor: entry.provenance.rawEventAnchor
        })
      )
    ),
    visibleMessages: Object.freeze(
      visibleMessageIds.flatMap((messageId) =>
        visibleMessagesForId(options.indexes.conversationById, messageId)
      )
    ),
    modelRounds: projection?.modelRounds ?? Object.freeze([]),
    toolEvents: toolEventsForTurn({
      toolEvents: projection?.toolEvents ?? [],
      terminalRawEvent: rawEvent
    }),
    ...roleModelEvidence,
    ...pluginEvidenceForTurn({
      simpleEvidence: projection?.simplePluginEvidence ?? [],
      turnEvidence: rawEvent.runtimePluginTurnEvidence
    }),
    ...(rawEvent.reason === undefined
      ? {}
      : { reason: rawEvent.reason })
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

function roleModelRoundEvidenceKey(
  evidence: InspectRoleModelEvidence
): string {
  return canonicalJsonStringify({
    input: evidence.input,
    output: evidence.output,
    parsedDecision: evidence.parsedDecision
  });
}

function toolEventsForTurn(options: {
  readonly toolEvents: readonly InspectToolCallEvent[];
  readonly terminalRawEvent: RawEventLogRecord;
}): readonly InspectToolCallEvent[] {
  const referencedCallIds = new Set(options.terminalRawEvent.toolCallIds ?? []);

  if (referencedCallIds.size === 0) {
    return Object.freeze([]);
  }

  return Object.freeze(
    options.toolEvents.filter((toolEvent) => referencedCallIds.has(toolEvent.callId))
  );
}

function inspectToolCallEvent(rawEvent: RawEventLogRecord): InspectToolCallEvent {
  return Object.freeze({
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
  } satisfies InspectToolCallEvent);
}

function pluginEvidenceForTurn(options: {
  readonly simpleEvidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly turnEvidence: RuntimePluginTurnEvidenceSnapshot | undefined;
}): { readonly pluginEvidence?: InspectPluginEvidence } {
  if (options.turnEvidence === undefined && options.simpleEvidence.length === 0) {
    return {};
  }

  const evidence = uniquePluginEvidenceSnapshots([
    ...options.simpleEvidence,
    ...(options.turnEvidence?.evidence ?? [])
  ]);

  return {
    pluginEvidence: Object.freeze({
      ...(options.turnEvidence === undefined
        ? {}
        : { contractVersion: options.turnEvidence.contractVersion }),
      plugins: pluginListings(options.turnEvidence),
      contextItems: pluginContextItems(options.turnEvidence),
      toolInvocations: pluginToolInvocations(options.turnEvidence),
      evidence: Object.freeze(evidence.map(pluginEvidenceSnapshot)),
      policyOutcomes: policyOutcomes(evidence),
      health: pluginHealthSnapshots(options.turnEvidence)
    } satisfies InspectPluginEvidence)
  };
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
  return pluginContextItemsFromSnapshots(turnEvidence?.contextItems ?? []);
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
  return canonicalJsonStringify({
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
  conversationById: ReadonlyMap<string, ConversationLogRecord>,
  messageId: string
): readonly InspectVisibleMessage[] {
  const message = conversationById.get(messageId);

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

if (isMainModule(import.meta.url)) {
  process.exitCode = await runInspectCliFromArgs(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr
  });
}
