import {runtimeEventIdentityKey} from '../../core/index.ts';
import type {
  ConversationLogRecord,
  RawEventLogRecord,
  RuntimeTraceEntry,
  RuntimeTurnStatus,
} from './records.ts';
import {isTerminalRawEventLogRecordKind} from './records.ts';
import {canonicalJsonStringify} from '../../shared/canonical-json.ts';
import {LocalRuntimeStorageContractError} from '../storage/layout-contract.ts';
import type {RoleModelDecisionResult} from '../../role-model/index.ts';
import type {RoleModelCommitValidationResult} from './records.ts';
import type {
  RuntimePluginContextItem,
  RuntimePluginEvidenceSnapshot,
  RuntimePluginTurnEvidenceSnapshot,
} from '../../plugins/api/index.ts';
import type {
  InspectTurnEvidence,
  InspectVisibleMessage,
  InspectToolCallEvent,
  InspectRoleModelEvidence,
  InspectRoleModelRoundEvidence,
  InspectParsedRoleModelDecision,
  InspectModelToolCall,
  InspectNonCommittedTopLevelText,
  InspectRoleModelCommitValidation,
  InspectPluginEvidence,
  InspectPluginListing,
  InspectPluginToolListing,
  InspectPluginContextItem,
  InspectPluginToolInvocation,
  InspectPluginToolInvocationResult,
  InspectPluginEvidenceSnapshot,
  InspectPluginHealthSnapshot,
  InspectPluginSourceReference,
} from './turn-projection-contract.ts';

export function createTurnEvidence(options: {
  readonly conversationMessages: readonly ConversationLogRecord[];
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
}): readonly InspectTurnEvidence[] {
  const indexes = createInspectEvidenceIndexes(options);

  return Object.freeze(
    indexes.terminalRawEvents.map(terminalRawEvent =>
      createTurnEvidenceEntry({
        indexes,
        terminalRawEvent,
      }),
    ),
  );
}

type InspectEvidenceIndexes = {
  readonly conversationById: ReadonlyMap<string, ConversationLogRecord>;
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
  readonly rawEvents: readonly RawEventLogRecord[];
  readonly traceEntries: readonly RuntimeTraceEntry[];
}): InspectEvidenceIndexes {
  const rawEventIndexes = createInspectRawEventIndexes(options.rawEvents);

  return Object.freeze({
    conversationById: new Map(
      options.conversationMessages.map(message => [message.id, message]),
    ),
    terminalRawEvents: rawEventIndexes.terminalRawEvents,
    turnProjectionsByIdentity: rawEventIndexes.turnProjectionsByIdentity,
    traceEntriesByIdentity: groupEvidenceByIdentity(options.traceEntries),
  });
}

function createInspectRawEventIndexes(
  rawEvents: readonly RawEventLogRecord[],
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
      identityKey,
    );
    const roleModelEvidence = roleModelEvidenceForRawEvent(rawEvent);

    appendInspectModelRound({
      projection,
      rawEventKind,
      roleModelEvidence,
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
        ...(rawEvent.runtimePluginEvidence ?? []),
      );
    }

    if (isTerminalRawEventLogRecordKind(rawEventKind)) {
      terminalRawEvents.push(
        Object.freeze({
          rawEvent,
          roleModelEvidence,
        } satisfies InspectTerminalRawEvent),
      );
    }
  }

  return Object.freeze({
    terminalRawEvents: Object.freeze(terminalRawEvents),
    turnProjectionsByIdentity: freezeInspectTurnProjections(mutableProjections),
  });
}

function mutableInspectTurnProjection(
  projections: Map<string, MutableInspectTurnRawEventProjection>,
  identityKey: string,
): MutableInspectTurnRawEventProjection {
  const existing = projections.get(identityKey);

  if (existing !== undefined) {
    return existing;
  }

  const created: MutableInspectTurnRawEventProjection = {
    modelRounds: [],
    seenModelRoundEvidenceKeys: new Set(),
    simplePluginEvidence: [],
    toolEvents: [],
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
      roleModelEvidence: evidence,
    } satisfies InspectRoleModelRoundEvidence),
  );
}

function freezeInspectTurnProjections(
  mutableProjections: ReadonlyMap<string, MutableInspectTurnRawEventProjection>,
): ReadonlyMap<string, InspectTurnRawEventProjection> {
  const projections = new Map<string, InspectTurnRawEventProjection>();

  for (const [identityKey, projection] of mutableProjections) {
    projections.set(
      identityKey,
      Object.freeze({
        modelRounds: Object.freeze(projection.modelRounds),
        simplePluginEvidence: Object.freeze(projection.simplePluginEvidence),
        toolEvents: Object.freeze(projection.toolEvents),
      } satisfies InspectTurnRawEventProjection),
    );
  }

  return projections;
}

function groupEvidenceByIdentity<
  T extends {
    readonly eventId: string;
    readonly traceId: string;
    readonly createdAt: string;
  },
>(records: readonly T[]): ReadonlyMap<string, readonly T[]> {
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
  const {rawEvent, roleModelEvidence} = options.terminalRawEvent;
  const visibleMessageIds = rawEvent.visibleMessageIds ?? [];
  const identityKey = runtimeEventIdentityKey(rawEvent);
  const projection = options.indexes.turnProjectionsByIdentity.get(identityKey);
  const traceEntries =
    options.indexes.traceEntriesByIdentity.get(identityKey) ?? [];

  return Object.freeze({
    eventId: rawEvent.eventId,
    traceId: rawEvent.traceId,
    status: terminalTurnStatus(rawEvent),
    steps: Object.freeze(traceEntries.map(entry => entry.step)),
    visibleMessages: Object.freeze(
      visibleMessageIds.flatMap(messageId =>
        visibleMessagesForId(options.indexes.conversationById, messageId),
      ),
    ),
    modelRounds: projection?.modelRounds ?? Object.freeze([]),
    toolEvents: toolEventsForTurn({
      toolEvents: projection?.toolEvents ?? [],
      terminalRawEvent: rawEvent,
    }),
    ...roleModelEvidence,
    ...pluginEvidenceForTurn({
      simpleEvidence: projection?.simplePluginEvidence ?? [],
      turnEvidence: rawEvent.runtimePluginTurnEvidence,
    }),
    ...(rawEvent.reason === undefined ? {} : {reason: rawEvent.reason}),
  } satisfies InspectTurnEvidence);
}

function roleModelEvidenceForRawEvent(rawEvent: RawEventLogRecord): {
  readonly roleModelEvidence?: InspectRoleModelEvidence;
} {
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
                  visibleMessageFromSnapshot,
                ),
              ),
              runtimeNotes: Object.freeze([
                ...inputEnvelope.decisionContext.runtimeNotes,
              ]),
              pluginContextItems: pluginContextItemsFromSnapshots(
                inputEnvelope.decisionContext.pluginContextItems,
              ),
            }),
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
                      rawEvent.roleModelIOSnapshot.providerMetadata,
                  }),
              ...(rawEvent.roleModelIOSnapshot.providerExchange === undefined
                ? {}
                : {
                    providerExchange:
                      rawEvent.roleModelIOSnapshot.providerExchange,
                  }),
            }),
          }),
      ...(parsedDecision === undefined
        ? {}
        : {parsedDecision: parsedRoleModelDecision(parsedDecision)}),
      ...(commitValidation === undefined
        ? {}
        : {
            commitValidation: roleModelCommitValidation(commitValidation),
          }),
    } satisfies InspectRoleModelEvidence),
  };
}

function roleModelRoundEvidenceKey(evidence: InspectRoleModelEvidence): string {
  return canonicalJsonStringify({
    input: evidence.input,
    output: evidence.output,
    parsedDecision: evidence.parsedDecision,
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
    options.toolEvents.filter(toolEvent =>
      referencedCallIds.has(toolEvent.callId),
    ),
  );
}

function inspectToolCallEvent(
  rawEvent: RawEventLogRecord,
): InspectToolCallEvent {
  return Object.freeze({
    callId: rawEvent.toolCallId ?? '',
    round: rawEvent.toolRound ?? 0,
    toolName: rawEvent.toolName ?? '',
    pluginId: rawEvent.toolPluginId ?? '',
    ...(rawEvent.toolInput === undefined ? {} : {input: rawEvent.toolInput}),
    ...(rawEvent.toolResult === undefined
      ? {}
      : {result: pluginToolInvocationResult(rawEvent.toolResult)}),
    ...(rawEvent.pluginStoreRevision === undefined
      ? {}
      : {pluginStoreRevision: rawEvent.pluginStoreRevision}),
  } satisfies InspectToolCallEvent);
}

function pluginEvidenceForTurn(options: {
  readonly simpleEvidence: readonly RuntimePluginEvidenceSnapshot[];
  readonly turnEvidence: RuntimePluginTurnEvidenceSnapshot | undefined;
}): {readonly pluginEvidence?: InspectPluginEvidence} {
  if (
    options.turnEvidence === undefined &&
    options.simpleEvidence.length === 0
  ) {
    return {};
  }

  const evidence = uniquePluginEvidenceSnapshots([
    ...options.simpleEvidence,
    ...(options.turnEvidence?.evidence ?? []),
  ]);

  return {
    pluginEvidence: Object.freeze({
      ...(options.turnEvidence === undefined
        ? {}
        : {contractVersion: options.turnEvidence.contractVersion}),
      plugins: pluginListings(options.turnEvidence),
      contextItems: pluginContextItems(options.turnEvidence),
      toolInvocations: pluginToolInvocations(options.turnEvidence),
      evidence: Object.freeze(evidence.map(pluginEvidenceSnapshot)),
      policyOutcomes: policyOutcomes(evidence),
      health: pluginHealthSnapshots(options.turnEvidence),
    } satisfies InspectPluginEvidence),
  };
}

function pluginListings(
  turnEvidence: RuntimePluginTurnEvidenceSnapshot | undefined,
): readonly InspectPluginListing[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.plugins.map(plugin =>
      Object.freeze({
        pluginId: plugin.pluginId,
        displayName: plugin.manifest.displayName,
        version: plugin.manifest.version,
        kind: plugin.manifest.kind,
        firstParty: plugin.manifest.firstParty,
        installed: plugin.installed,
        registered: plugin.registered,
        enabled: plugin.enabled,
        availableForTurn: plugin.availableForTurn,
        requestedAccess: plugin.requestedAccess,
        grantedAccess: plugin.grantedAccess,
        providedTools: Object.freeze(
          plugin.providedTools.map(tool =>
            Object.freeze({
              name: tool.name,
              validationOwner: tool.validationOwner,
              requiresConfirmation: tool.requiresConfirmation,
              // Carried through rather than summarized: an audit needs
              // what the tool declared, including having declared nothing.
              ...(tool.annotations === undefined
                ? {}
                : {annotations: tool.annotations}),
              ...(tool.concurrency === undefined
                ? {}
                : {concurrency: tool.concurrency}),
            } satisfies InspectPluginToolListing),
          ),
        ),
        registeredLifecycleHooks: Object.freeze([
          ...plugin.registeredLifecycleHooks,
        ]),
        redactionLabels: Object.freeze([...plugin.redactionLabels]),
        ...(plugin.configFingerprint === undefined
          ? {}
          : {configFingerprint: plugin.configFingerprint}),
        ...(plugin.healthStatus === undefined
          ? {}
          : {healthStatus: plugin.healthStatus}),
      } satisfies InspectPluginListing),
    ),
  );
}

function pluginContextItemsFromSnapshots(
  items: readonly RuntimePluginContextItem[],
): readonly InspectPluginContextItem[] {
  return Object.freeze(
    items.map(item =>
      Object.freeze({
        pluginId: item.pluginId,
        id: item.id,
        kind: item.kind,
        text: item.text,
        budget: Object.freeze({
          estimatedTokens: item.budget.estimatedTokens,
          priority: item.budget.priority,
        }),
        sourceReferences: sourceReferences(item.sourceReferences),
        redactionLabels: Object.freeze([...item.redactionLabels]),
        ...(item.confidence === undefined ? {} : {confidence: item.confidence}),
      } satisfies InspectPluginContextItem),
    ),
  );
}

function pluginContextItems(
  turnEvidence: RuntimePluginTurnEvidenceSnapshot | undefined,
): readonly InspectPluginContextItem[] {
  return pluginContextItemsFromSnapshots(turnEvidence?.contextItems ?? []);
}

function pluginToolInvocations(
  turnEvidence: RuntimePluginTurnEvidenceSnapshot | undefined,
): readonly InspectPluginToolInvocation[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.toolInvocations.map(invocation =>
      Object.freeze({
        pluginId: invocation.pluginId,
        toolName: invocation.toolName,
        input: invocation.input,
        result: pluginToolInvocationResult(invocation.result),
      } satisfies InspectPluginToolInvocation),
    ),
  );
}

function pluginToolInvocationResult(
  result: RuntimePluginTurnEvidenceSnapshot['toolInvocations'][number]['result'],
): InspectPluginToolInvocationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: result.output,
      evidence: Object.freeze(result.evidence.map(pluginEvidenceSnapshot)),
    } satisfies InspectPluginToolInvocationResult);
  }

  return Object.freeze({
    status: 'rejected',
    reason: result.reason,
    message: result.message,
    evidence: Object.freeze(result.evidence.map(pluginEvidenceSnapshot)),
  } satisfies InspectPluginToolInvocationResult);
}

function pluginEvidenceSnapshot(
  snapshot: RuntimePluginEvidenceSnapshot,
): InspectPluginEvidenceSnapshot {
  return Object.freeze({
    pluginId: snapshot.pluginId,
    evidenceKind: snapshot.evidenceKind,
    status: snapshot.status,
    summary: snapshot.summary,
    redactionLabels: Object.freeze([...snapshot.redactionLabels]),
    ...(snapshot.policyOutcome === undefined
      ? {}
      : {policyOutcome: snapshot.policyOutcome}),
    ...(snapshot.sourceReferences === undefined
      ? {}
      : {sourceReferences: sourceReferences(snapshot.sourceReferences)}),
    ...(snapshot.configFingerprint === undefined
      ? {}
      : {configFingerprint: snapshot.configFingerprint}),
  } satisfies InspectPluginEvidenceSnapshot);
}

function uniquePluginEvidenceSnapshots(
  snapshots: readonly RuntimePluginEvidenceSnapshot[],
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
  snapshot: RuntimePluginEvidenceSnapshot,
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
    configFingerprint: snapshot.configFingerprint,
  });
}

function pluginHealthSnapshots(
  turnEvidence: RuntimePluginTurnEvidenceSnapshot | undefined,
): readonly InspectPluginHealthSnapshot[] {
  if (turnEvidence === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    turnEvidence.health.map(snapshot =>
      Object.freeze({
        pluginId: snapshot.pluginId,
        status: snapshot.status,
        checkedAt: snapshot.checkedAt,
        summary: snapshot.summary,
        redactionLabels: Object.freeze([...snapshot.redactionLabels]),
      } satisfies InspectPluginHealthSnapshot),
    ),
  );
}

function policyOutcomes(
  evidence: readonly RuntimePluginEvidenceSnapshot[],
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
  references: readonly InspectPluginSourceReference[],
): readonly InspectPluginSourceReference[] {
  return Object.freeze(
    references.map(reference =>
      Object.freeze({
        kind: reference.kind,
        id: reference.id,
        ...(reference.title === undefined ? {} : {title: reference.title}),
        ...(reference.uri === undefined ? {} : {uri: reference.uri}),
      } satisfies InspectPluginSourceReference),
    ),
  );
}

function parsedRoleModelDecision(
  result: RoleModelDecisionResult,
): InspectParsedRoleModelDecision {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      toolCalls: Object.freeze(
        result.decision.toolCalls.map(toolCall =>
          Object.freeze({
            name: toolCall.name,
            input: Object.freeze({...toolCall.input}),
          } satisfies InspectModelToolCall),
        ),
      ),
      ...(result.nonCommittedText !== undefined
        ? {
            nonCommittedTopLevelText: Object.freeze({
              source: 'model_top_level_text',
              committed: false,
              text: result.nonCommittedText,
            } satisfies InspectNonCommittedTopLevelText),
          }
        : {}),
    } satisfies InspectParsedRoleModelDecision);
  }

  return Object.freeze({
    status: 'rejected',
    rejectionReason: result.rejection.reason,
    ...(result.rejection.details === undefined
      ? {}
      : {rejectionDetails: result.rejection.details}),
  } satisfies InspectParsedRoleModelDecision);
}

function roleModelCommitValidation(
  result: RoleModelCommitValidationResult,
): InspectRoleModelCommitValidation {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      ...(result.acceptedVisibleReplyText === undefined
        ? {}
        : {acceptedVisibleReplyText: result.acceptedVisibleReplyText}),
    } satisfies InspectRoleModelCommitValidation);
  }

  return Object.freeze({
    status: 'rejected',
    rejectionReason: result.rejection.reason,
    ...(result.rejection.details === undefined
      ? {}
      : {rejectionDetails: result.rejection.details}),
  } satisfies InspectRoleModelCommitValidation);
}

function terminalTurnStatus(record: RawEventLogRecord): RuntimeTurnStatus {
  if (record.status !== undefined) {
    return record.status;
  }

  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    'Stored terminal raw event is missing a turn status.',
  );
}

function visibleMessagesForId(
  conversationById: ReadonlyMap<string, ConversationLogRecord>,
  messageId: string,
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
      text: message.text,
    } satisfies InspectVisibleMessage),
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
    text: message.text,
  } satisfies InspectVisibleMessage);
}
