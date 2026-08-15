import {
  assertCanonicalRuntimeTimestamp,
  type CharacterProfile,
  type RuntimeEventIdentity,
  type UserMessageRuntimeEvent,
} from '../../core/index.ts';

import {
  createRuntimePluginContextItem,
  createRuntimePluginCuratedContextSection,
  type RuntimePluginContextItem,
  type RuntimePluginCuratedContextSection,
} from '../../plugins/api/index.ts';
import {
  builtInModelToolDefinitions,
  freezeModelToolCalls,
  freezeModelToolDefinition,
  type ModelToolCall,
} from './model-tools.ts';
import {freezeRoleModelPromptSize} from './prompt-size.ts';
import {requiredRoleModelIdentifier} from './tool-names.ts';
import {
  createJsonBoundaryObjectSnapshot,
  createJsonBoundarySnapshot,
} from '../../shared/json-boundary.ts';
import {
  freezeProviderMetadata,
  freezeRoleModelProviderExchangeSnapshot,
} from './provider-exchange.ts';
import {createRoleModelPluginToolDefinitions} from './plugin-tool-definitions.ts';
import {
  roleModelDecisionContractVersion,
  roleModelDecisionOutputContract,
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type CreateDecisionContextOptions,
  type CreateParsedRoleModelDecisionSnapshotOptions,
  type CreateRoleModelInputEnvelopeOptions,
  type ConversationHistoryWindow,
  type CreateRoleModelIOSnapshotOptions,
  type DecisionContext,
  type DecisionRuntimeNote,
  type ParsedRoleModelDecisionSnapshot,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelCharacterRef,
  type RoleModelDecisionResult,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelOutputContract,
  type RoleModelToolObservation,
  type RoleModelToolObservationResult,
} from './contracts.ts';

export function createDecisionContext(
  options: CreateDecisionContextOptions,
): DecisionContext {
  return Object.freeze({
    sessionId: options.sessionId,
    characterSnapshot: freezeCharacterProfileSnapshot(
      options.characterSnapshot,
    ),
    historyWindow: freezeConversationHistoryWindow(
      options.historyWindow ?? {turnEventIds: []},
    ),
    ...(options.contextSummary === undefined
      ? {}
      : {contextSummary: requiredContextSummary(options.contextSummary)}),
    runtimeNotes: freezeDecisionRuntimeNotes(options.runtimeNotes ?? []),
    pluginContextItems: freezePluginContextItems(
      options.pluginContextItems ?? [],
    ),
    curatedContextSections: freezeCuratedContextSections(
      options.curatedContextSections ?? [],
    ),
  } satisfies DecisionContext);
}

/**
 * The built-in tools come first and are always offered: visible_reply is how
 * the character speaks, so no configuration can take it away. Plugin tools
 * follow; a plugin cannot provide a built-in name, so the names are unique.
 */
export function createRoleModelInputEnvelope(
  options: CreateRoleModelInputEnvelopeOptions,
): RoleModelInputEnvelope {
  const pluginToolDefinitions = createRoleModelPluginToolDefinitions(
    options.pluginToolDefinitions,
  );
  const toolDefinitions = Object.freeze([
    ...builtInModelToolDefinitions,
    ...pluginToolDefinitions.map(freezeModelToolDefinition),
  ]);

  return Object.freeze({
    event: freezeUserMessageRuntimeEventSnapshot(options.event),
    decisionContext: createDecisionContext(options.decisionContext),
    allowedTools: Object.freeze(
      toolDefinitions.map(definition => definition.name),
    ),
    toolDefinitions,
    pluginToolDefinitions,
    toolObservations: freezeRoleModelToolObservations(
      options.toolObservations ?? [],
    ),
    outputContract: freezeRoleModelOutputContract(
      options.outputContract ?? roleModelDecisionOutputContract,
    ),
  } satisfies RoleModelInputEnvelope);
}

export function createRoleModelToolObservation(
  observation: RoleModelToolObservation,
): RoleModelToolObservation {
  return freezeRoleModelToolObservation(observation);
}

export function createCharacterDecision(
  toolCalls: readonly ModelToolCall[],
  text?: string,
): CharacterDecision {
  return freezeCharacterDecision({
    version: roleModelDecisionContractVersion,
    toolCalls,
    ...(text === undefined ? {} : {text}),
  });
}

export function createAcceptedRoleModelDecisionResult(
  decision: CharacterDecision,
): AcceptedRoleModelDecisionResult {
  return Object.freeze({
    status: 'accepted',
    decision: freezeCharacterDecision(decision),
  } satisfies AcceptedRoleModelDecisionResult);
}

export function createRejectedRoleModelDecisionResult(
  reason: RoleModelDecisionRejectionReason,
  details?: string,
): RejectedRoleModelDecisionResult {
  return Object.freeze({
    status: 'rejected',
    rejection: freezeRoleModelDecisionRejection({
      reason,
      ...(details === undefined ? {} : {details}),
    }),
  } satisfies RejectedRoleModelDecisionResult);
}

export function createRoleModelIOSnapshot(
  options: CreateRoleModelIOSnapshotOptions,
): RoleModelIOSnapshot {
  const identity = freezeRuntimeEventIdentitySnapshot(options);
  const inputEnvelope = createRoleModelInputEnvelope(options.inputEnvelope);

  return Object.freeze({
    ...identity,
    kind: 'role_model_io_snapshot',
    sessionId: options.sessionId,
    inputEnvelope,
    rawOutputText: options.rawOutputText,
    ...(options.characterRef === undefined
      ? {}
      : {
          characterRef: freezeRoleModelCharacterRef(
            options.characterRef,
            inputEnvelope.decisionContext.characterSnapshot,
          ),
        }),
    ...(options.promptSize === undefined
      ? {}
      : {promptSize: freezeRoleModelPromptSize(options.promptSize)}),
    ...(options.providerMetadata === undefined
      ? {}
      : {providerMetadata: freezeProviderMetadata(options.providerMetadata)}),
    ...(options.providerExchange === undefined
      ? {}
      : {
          providerExchange: freezeRoleModelProviderExchangeSnapshot(
            options.providerExchange,
          ),
        }),
  } satisfies RoleModelIOSnapshot);
}

export function createParsedRoleModelDecisionSnapshot(
  options: CreateParsedRoleModelDecisionSnapshotOptions,
): ParsedRoleModelDecisionSnapshot {
  const identity = freezeRuntimeEventIdentitySnapshot(options);

  return Object.freeze({
    ...identity,
    kind: 'role_model_decision_snapshot',
    sessionId: options.sessionId,
    result: freezeRoleModelDecisionResult(options.result),
  } satisfies ParsedRoleModelDecisionSnapshot);
}

/**
 * On the snapshot, not the loop: the codec rebuilds durable evidence through
 * this constructor, so a hand-edited record is held to the same rule.
 */
export function assertRoleModelCharacterRefMatchesCharacter(
  characterRef: RoleModelCharacterRef,
  characterSnapshot: CharacterProfile,
): void {
  if (characterRef.id !== characterSnapshot.id) {
    throw new TypeError(
      'Role-model characterRef id must match the decision-context character.',
    );
  }
}

function freezeRoleModelCharacterRef(
  characterRef: RoleModelCharacterRef,
  characterSnapshot: CharacterProfile,
): RoleModelCharacterRef {
  assertRoleModelCharacterRefMatchesCharacter(characterRef, characterSnapshot);

  return Object.freeze({
    id: requiredCharacterRefText(characterRef.id, 'id'),
    version: requiredCharacterRefText(characterRef.version, 'version'),
    personaFingerprint: requiredCharacterRefText(
      characterRef.personaFingerprint,
      'personaFingerprint',
    ),
  } satisfies RoleModelCharacterRef);
}

function requiredCharacterRefText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(
      `Role-model characterRef ${field} must be a non-empty string.`,
    );
  }

  return value;
}

function freezeRuntimeEventIdentitySnapshot(
  identity: RuntimeEventIdentity,
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    createdAt: assertCanonicalRuntimeTimestamp(
      identity.createdAt,
      'Role-model evidence createdAt',
    ),
  } satisfies RuntimeEventIdentity);
}

function freezeUserMessageRuntimeEventSnapshot(
  event: UserMessageRuntimeEvent,
): UserMessageRuntimeEvent {
  const identity = freezeRuntimeEventIdentitySnapshot(event);

  return Object.freeze({
    ...identity,
    type: event.type,
    payload: Object.freeze({
      currentUserMessage: event.payload.currentUserMessage,
    }),
  } satisfies UserMessageRuntimeEvent);
}

function freezeCharacterProfileSnapshot(
  character: CharacterProfile,
): CharacterProfile {
  return Object.freeze({
    id: character.id,
    displayName: character.displayName,
  } satisfies CharacterProfile);
}

function requiredContextSummary(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Decision context summary must be non-empty.');
  }

  return value;
}

function freezeConversationHistoryWindow(
  window: ConversationHistoryWindow,
): ConversationHistoryWindow {
  for (const eventId of window.turnEventIds) {
    if (typeof eventId !== 'string' || eventId.length === 0) {
      throw new TypeError('History window turn ids must be non-empty strings.');
    }
  }

  return Object.freeze({
    turnEventIds: Object.freeze([...window.turnEventIds]),
  } satisfies ConversationHistoryWindow);
}

function freezeDecisionRuntimeNotes(
  runtimeNotes: readonly DecisionRuntimeNote[],
): readonly DecisionRuntimeNote[] {
  return Object.freeze(
    runtimeNotes.map(note => {
      if (typeof note.text !== 'string' || note.text.trim().length === 0) {
        throw new TypeError('Decision runtime note text must be non-empty.');
      }

      return Object.freeze({
        id: requiredRoleModelIdentifier(note.id, 'runtime note id'),
        text: note.text,
        ...(note.pluginId === undefined
          ? {}
          : {
              pluginId: requiredRoleModelIdentifier(
                note.pluginId,
                'runtime note pluginId',
              ),
            }),
      } satisfies DecisionRuntimeNote);
    }),
  );
}

function freezePluginContextItems(
  contextItems: readonly RuntimePluginContextItem[],
): readonly RuntimePluginContextItem[] {
  return Object.freeze(contextItems.map(createRuntimePluginContextItem));
}

function freezeCuratedContextSections(
  sections: readonly RuntimePluginCuratedContextSection[],
): readonly RuntimePluginCuratedContextSection[] {
  return Object.freeze(sections.map(createRuntimePluginCuratedContextSection));
}

function freezeRoleModelOutputContract(
  outputContract: RoleModelOutputContract,
): RoleModelOutputContract {
  return Object.freeze({
    version: outputContract.version,
    text: outputContract.text,
  } satisfies RoleModelOutputContract);
}

function freezeRoleModelToolObservations(
  observations: readonly RoleModelToolObservation[],
): readonly RoleModelToolObservation[] {
  return Object.freeze(observations.map(freezeRoleModelToolObservation));
}

function freezeRoleModelToolObservation(
  observation: RoleModelToolObservation,
): RoleModelToolObservation {
  if (!Number.isInteger(observation.round) || observation.round < 1) {
    throw new TypeError(
      'Role-model tool observation round must be a positive integer.',
    );
  }

  return Object.freeze({
    round: observation.round,
    pluginId: requiredRoleModelIdentifier(
      observation.pluginId,
      'tool observation pluginId',
    ),
    toolName: requiredRoleModelIdentifier(
      observation.toolName,
      'tool observation toolName',
    ),
    input: createJsonBoundaryObjectSnapshot(observation.input, {
      field: 'Role-model tool observation input',
      redact: true,
    }),
    result: freezeRoleModelToolObservationResult(observation.result),
  } satisfies RoleModelToolObservation);
}

function freezeRoleModelToolObservationResult(
  result: RoleModelToolObservationResult,
): RoleModelToolObservationResult {
  if (result.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      output: createJsonBoundarySnapshot(result.output, {
        field: 'Role-model tool observation output',
        redact: true,
      }),
    } satisfies RoleModelToolObservationResult);
  }

  return Object.freeze({
    status: 'rejected',
    reason: result.reason,
    message: result.message,
  } satisfies RoleModelToolObservationResult);
}

function freezeCharacterDecision(
  decision: CharacterDecision,
): CharacterDecision {
  return Object.freeze({
    version: roleModelDecisionContractVersion,
    toolCalls: freezeModelToolCalls(decision.toolCalls),
    ...(decision.text === undefined ? {} : {text: decision.text}),
  } satisfies CharacterDecision);
}

function freezeRoleModelDecisionRejection(
  rejection: RoleModelDecisionRejection,
): RoleModelDecisionRejection {
  return Object.freeze({
    reason: rejection.reason,
    ...(rejection.details === undefined ? {} : {details: rejection.details}),
  } satisfies RoleModelDecisionRejection);
}

function freezeRoleModelDecisionResult(
  result: RoleModelDecisionResult,
): RoleModelDecisionResult {
  if (result.status === 'accepted') {
    return createAcceptedRoleModelDecisionResult(result.decision);
  }

  return createRejectedRoleModelDecisionResult(
    result.rejection.reason,
    result.rejection.details,
  );
}
