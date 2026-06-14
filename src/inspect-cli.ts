import { pathToFileURL } from 'node:url';

import {
  createFileRuntimeLogStore,
  createLocalRuntimeSessionStore,
  createLocalRuntimeStorageLayout,
  isTerminalRawEventLogRecord,
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeSessionId,
  type ConversationLogRecord,
  type AgentCapabilityEvidenceSnapshot,
  type AgentCapabilityTurnEvidenceSnapshot,
  type LocalRuntimeSessionMetadata,
  type RawEventLogRecord,
  type RoleModelCommitValidationResult,
  type RoleModelDecisionResult,
  type RuntimeTraceEntry,
  type RuntimeTurnStatus
} from './index.ts';
import {
  formatLocalRuntimeTerminalError,
  isLocalRuntimeTerminalError
} from './terminal-errors.ts';

type InspectCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
};

type InspectCliArgs =
  | {
      readonly mode: 'sessions';
      readonly storeRoot?: string;
    }
  | {
      readonly mode: 'session';
      readonly storeRoot?: string;
      readonly sessionId: string;
    };

type InspectSessionListOutput = {
  readonly sessions: readonly LocalRuntimeSessionMetadata[];
};

type InspectSessionOutput = {
  readonly session: LocalRuntimeSessionMetadata;
  readonly counts: {
    readonly traceEntries: number;
    readonly rawEvents: number;
    readonly conversationMessages: number;
  };
  readonly turns: readonly InspectTurnEvidence[];
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
  readonly characterStatePatchEvidence?: InspectCharacterStatePatchEvidence;
  readonly capabilityEvidence?: InspectCapabilityEvidence;
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
  readonly result?: InspectCapabilityToolInvocationResult;
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
  };
  readonly output?: {
    readonly rawOutputText: string;
    readonly providerMetadata?: unknown;
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

type InspectCharacterStatePatchEvidence = {
  readonly status: 'accepted' | 'rejected';
  readonly patch?: unknown;
  readonly patchInput?: unknown;
  readonly before: unknown;
  readonly after?: unknown;
  readonly appliedChanges?: unknown;
  readonly rejection?: unknown;
};

type InspectCapabilityEvidence = {
  readonly contractVersion?: string;
  readonly capabilities: readonly InspectCapabilityListing[];
  readonly contextItems: readonly InspectCapabilityContextItem[];
  readonly toolInvocations: readonly InspectCapabilityToolInvocation[];
  readonly evidence: readonly InspectCapabilityEvidenceSnapshot[];
  readonly policyOutcomes: readonly string[];
  readonly health: readonly InspectCapabilityHealthSnapshot[];
};

type InspectCapabilityListing = {
  readonly capabilityId: string;
  readonly displayName: string;
  readonly version: string;
  readonly kind: string;
  readonly localTrustLevel: string;
  readonly installed: boolean;
  readonly registered: boolean;
  readonly enabled: boolean;
  readonly availableForTurn: boolean;
  readonly providedTools: readonly InspectCapabilityToolListing[];
  readonly registeredLifecycleHooks: readonly string[];
  readonly redactionLabels: readonly string[];
  readonly configFingerprint?: string;
  readonly healthStatus?: string;
};

type InspectCapabilityToolListing = {
  readonly name: string;
  readonly validationOwner: string;
  readonly sideEffectLevel: string;
  readonly requiresConfirmation: boolean;
  readonly sourceReferencesRequired: boolean;
};

type InspectCapabilityContextItem = {
  readonly capabilityId: string;
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly budget: {
    readonly estimatedTokens: number;
    readonly priority: number;
  };
  readonly sourceReferences: readonly InspectCapabilitySourceReference[];
  readonly redactionLabels: readonly string[];
  readonly confidence?: number;
};

type InspectCapabilityToolInvocation = {
  readonly capabilityId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly result: InspectCapabilityToolInvocationResult;
};

type InspectCapabilityToolInvocationResult =
  | {
      readonly status: 'accepted';
      readonly output: unknown;
      readonly evidence: readonly InspectCapabilityEvidenceSnapshot[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: string;
      readonly message: string;
      readonly evidence: readonly InspectCapabilityEvidenceSnapshot[];
    };

type InspectCapabilityEvidenceSnapshot = {
  readonly capabilityId: string;
  readonly evidenceKind: string;
  readonly status: string;
  readonly summary: string;
  readonly redactionLabels: readonly string[];
  readonly policyOutcome?: string;
  readonly sourceReferences?: readonly InspectCapabilitySourceReference[];
  readonly configFingerprint?: string;
};

type InspectCapabilityHealthSnapshot = {
  readonly capabilityId: string;
  readonly status: string;
  readonly checkedAt: string;
  readonly summary: string;
  readonly redactionLabels: readonly string[];
};

type InspectCapabilitySourceReference = {
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
    const parsedArgs = parseInspectCliArgs(args);

    validateInspectCliArgs(parsedArgs);

    if (parsedArgs.mode === 'sessions') {
      await writeSessionList(parsedArgs, options.stdout);
      return 0;
    }

    await writeSessionEvidence(parsedArgs, options.stdout);
    return 0;
  } catch (error: unknown) {
    if (
      error instanceof InspectCliUsageError ||
      isLocalRuntimeTerminalError(error)
    ) {
      options.stderr.write(`Error: ${formatTerminalErrorMessage(error)}\n`);
      return 1;
    }

    throw error;
  }
}

function parseInspectCliArgs(args: readonly string[]): InspectCliArgs {
  let storeRoot: string | undefined;
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

    if (arg === '--store') {
      if (storeRoot !== undefined) {
        throw new InspectCliUsageError('--store can only be provided once.');
      }

      storeRoot = readFlagValue(args, index, '--store');
      index += 1;
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
      ...(storeRoot === undefined ? {} : { storeRoot })
    } satisfies InspectCliArgs;
  }

  if (sessionId === undefined) {
    throw new InspectCliUsageError('Use --sessions or --session <session-id>.');
  }

  return {
    mode: 'session',
    sessionId,
    ...(storeRoot === undefined ? {} : { storeRoot })
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
  stdout: NodeJS.WritableStream
): Promise<void> {
  const sessionStore = createLocalRuntimeSessionStore(storageOptions(args));
  const sessions = await sessionStore.listSessions();

  writeJson(stdout, {
    sessions
  } satisfies InspectSessionListOutput);
}

async function writeSessionEvidence(
  args: InspectCliArgs & { readonly mode: 'session' },
  stdout: NodeJS.WritableStream
): Promise<void> {
  const sessionStore = createLocalRuntimeSessionStore(storageOptions(args));
  const session = await sessionStore.readSession(args.sessionId);
  const logStore = createFileRuntimeLogStore({
    ...storageOptions(args),
    sessionId: session.sessionId
  });
  const traceEntries = logStore.traceEntries();
  const rawEvents = logStore.rawEvents();
  const conversationMessages = logStore.conversationMessages();

  writeJson(stdout, {
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
    ...characterStatePatchEvidenceForRawEvent(options.rawEvent),
    ...capabilityEvidenceForRawEvent(options.rawEvent),
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
              ])
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

function characterStatePatchEvidenceForRawEvent(
  rawEvent: RawEventLogRecord
): {
  readonly characterStatePatchEvidence?: InspectCharacterStatePatchEvidence;
} {
  const snapshot = rawEvent.characterStatePatchSnapshot;

  if (snapshot === undefined) {
    return {};
  }

  const result = snapshot.result;

  if (result.status === 'accepted') {
    return {
      characterStatePatchEvidence: Object.freeze({
        status: 'accepted',
        patch: result.patch,
        before: result.before,
        after: result.after,
        appliedChanges: result.appliedChanges
      } satisfies InspectCharacterStatePatchEvidence)
    };
  }

  return {
    characterStatePatchEvidence: Object.freeze({
      status: 'rejected',
      patchInput: result.patchInput,
      before: result.before,
      rejection: result.rejection
    } satisfies InspectCharacterStatePatchEvidence)
  };
}

function modelRoundsForTurn(options: {
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly terminalRawEvent: RawEventLogRecord;
}): readonly InspectRoleModelRoundEvidence[] {
  return Object.freeze(
    options.rawEvents
      .filter(
        (rawEvent) =>
          rawEvent.eventId === options.terminalRawEvent.eventId &&
          rawEvent.traceId === options.terminalRawEvent.traceId
      )
      .flatMap((rawEvent) => {
        const evidence = roleModelEvidenceForRawEvent(rawEvent).roleModelEvidence;

        if (evidence === undefined) {
          return [];
        }

        return [
          Object.freeze({
            rawEventKind: rawEvent.kind,
            roleModelEvidence: evidence
          } satisfies InspectRoleModelRoundEvidence)
        ];
      })
  );
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
            : { result: capabilityToolInvocationResult(rawEvent.toolResult) }),
          ...(rawEvent.pluginStoreRevision === undefined
            ? {}
            : { pluginStoreRevision: rawEvent.pluginStoreRevision })
        } satisfies InspectToolCallEvent)
      )
  );
}

function capabilityEvidenceForRawEvent(
  rawEvent: RawEventLogRecord
): { readonly capabilityEvidence?: InspectCapabilityEvidence } {
  const turnEvidence = rawEvent.agentCapabilityTurnEvidence;
  const simpleEvidence = rawEvent.agentCapabilityEvidence ?? [];

  if (turnEvidence === undefined && simpleEvidence.length === 0) {
    return {};
  }

  const evidence = uniqueCapabilityEvidenceSnapshots([
    ...simpleEvidence,
    ...(turnEvidence?.evidence ?? [])
  ]);

  return {
    capabilityEvidence: Object.freeze({
      ...(turnEvidence === undefined
        ? {}
        : { contractVersion: turnEvidence.contractVersion }),
      capabilities: capabilityListings(turnEvidence),
      contextItems: capabilityContextItems(turnEvidence),
      toolInvocations: capabilityToolInvocations(turnEvidence),
      evidence: Object.freeze(evidence.map(capabilityEvidenceSnapshot)),
      policyOutcomes: policyOutcomes(evidence),
      health: capabilityHealthSnapshots(turnEvidence)
    } satisfies InspectCapabilityEvidence)
  };
}

function capabilityListings(
  turnEvidence: AgentCapabilityTurnEvidenceSnapshot | undefined
): readonly InspectCapabilityListing[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.capabilities.map((capability) =>
      Object.freeze({
        capabilityId: capability.capabilityId,
        displayName: capability.manifest.displayName,
        version: capability.manifest.version,
        kind: capability.manifest.kind,
        localTrustLevel: capability.manifest.localTrustLevel,
        installed: capability.installed,
        registered: capability.registered,
        enabled: capability.enabled,
        availableForTurn: capability.availableForTurn,
        providedTools: Object.freeze(
          capability.providedTools.map((tool) =>
            Object.freeze({
              name: tool.name,
              validationOwner: tool.validationOwner,
              sideEffectLevel: tool.sideEffectLevel,
              requiresConfirmation: tool.requiresConfirmation,
              sourceReferencesRequired: tool.sourceReferencesRequired
            } satisfies InspectCapabilityToolListing)
          )
        ),
        registeredLifecycleHooks: Object.freeze([
          ...capability.registeredLifecycleHooks
        ]),
        redactionLabels: Object.freeze([...capability.redactionLabels]),
        ...(capability.configFingerprint === undefined
          ? {}
          : { configFingerprint: capability.configFingerprint }),
        ...(capability.healthStatus === undefined
          ? {}
          : { healthStatus: capability.healthStatus })
      } satisfies InspectCapabilityListing)
    )
  );
}

function capabilityContextItems(
  turnEvidence: AgentCapabilityTurnEvidenceSnapshot | undefined
): readonly InspectCapabilityContextItem[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.contextItems.map((item) =>
      Object.freeze({
        capabilityId: item.capabilityId,
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
      } satisfies InspectCapabilityContextItem)
    )
  );
}

function capabilityToolInvocations(
  turnEvidence: AgentCapabilityTurnEvidenceSnapshot | undefined
): readonly InspectCapabilityToolInvocation[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.toolInvocations.map((invocation) =>
      Object.freeze({
        capabilityId: invocation.capabilityId,
        toolName: invocation.toolName,
        input: invocation.input,
        result: capabilityToolInvocationResult(invocation.result)
      } satisfies InspectCapabilityToolInvocation)
    )
  );
}

function capabilityToolInvocationResult(
  result: AgentCapabilityTurnEvidenceSnapshot['toolInvocations'][number]['result']
): InspectCapabilityToolInvocationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: result.output,
      evidence: Object.freeze(result.evidence.map(capabilityEvidenceSnapshot))
    } satisfies InspectCapabilityToolInvocationResult);
  }

  return Object.freeze({
    status: 'rejected',
    reason: result.reason,
    message: result.message,
    evidence: Object.freeze(result.evidence.map(capabilityEvidenceSnapshot))
  } satisfies InspectCapabilityToolInvocationResult);
}

function capabilityEvidenceSnapshot(
  snapshot: AgentCapabilityEvidenceSnapshot
): InspectCapabilityEvidenceSnapshot {
  return Object.freeze({
    capabilityId: snapshot.capabilityId,
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
  } satisfies InspectCapabilityEvidenceSnapshot);
}

function uniqueCapabilityEvidenceSnapshots(
  snapshots: readonly AgentCapabilityEvidenceSnapshot[]
): readonly AgentCapabilityEvidenceSnapshot[] {
  const seen = new Set<string>();
  const uniqueSnapshots: AgentCapabilityEvidenceSnapshot[] = [];

  for (const snapshot of snapshots) {
    const key = capabilityEvidenceSnapshotKey(snapshot);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueSnapshots.push(snapshot);
  }

  return Object.freeze(uniqueSnapshots);
}

function capabilityEvidenceSnapshotKey(
  snapshot: AgentCapabilityEvidenceSnapshot
): string {
  return JSON.stringify({
    eventId: snapshot.eventId,
    traceId: snapshot.traceId,
    createdAt: snapshot.createdAt,
    kind: snapshot.kind,
    capabilityId: snapshot.capabilityId,
    evidenceKind: snapshot.evidenceKind,
    status: snapshot.status,
    summary: snapshot.summary,
    policyOutcome: snapshot.policyOutcome,
    sourceReferences: snapshot.sourceReferences,
    redactionLabels: snapshot.redactionLabels,
    configFingerprint: snapshot.configFingerprint
  });
}

function capabilityHealthSnapshots(
  turnEvidence: AgentCapabilityTurnEvidenceSnapshot | undefined
): readonly InspectCapabilityHealthSnapshot[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.health.map((snapshot) =>
      Object.freeze({
        capabilityId: snapshot.capabilityId,
        status: snapshot.status,
        checkedAt: snapshot.checkedAt,
        summary: snapshot.summary,
        redactionLabels: Object.freeze([...snapshot.redactionLabels])
      } satisfies InspectCapabilityHealthSnapshot)
    )
  );
}

function policyOutcomes(
  evidence: readonly AgentCapabilityEvidenceSnapshot[]
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
  references: readonly InspectCapabilitySourceReference[]
): readonly InspectCapabilitySourceReference[] {
  return Object.freeze(
    references.map((reference) =>
      Object.freeze({
        kind: reference.kind,
        id: reference.id,
        ...(reference.title === undefined ? {} : { title: reference.title }),
        ...(reference.uri === undefined ? {} : { uri: reference.uri })
      } satisfies InspectCapabilitySourceReference)
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

function storageOptions(args: { readonly storeRoot?: string }): { readonly storeRoot?: string } {
  return args.storeRoot === undefined ? {} : { storeRoot: args.storeRoot };
}

function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatTerminalErrorMessage(
  error: InspectCliUsageError | Parameters<typeof formatLocalRuntimeTerminalError>[0]
): string {
  if (error instanceof InspectCliUsageError) {
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
