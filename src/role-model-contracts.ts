import type { CharacterProfile, VisibleMessage } from './conversation.ts';
import {
  createLivingStateBrief,
  type LivingStateBrief
} from './character-state.ts';
import {
  characterStatePatchModelToolName,
  createCharacterStatePatchModelToolCall,
  createVisibleReplyModelToolCall,
  findCharacterStatePatchModelToolCall,
  findVisibleReplyModelToolCall,
  freezeBuiltInModelToolCall,
  freezeBuiltInModelToolCalls,
  isBuiltInModelToolName,
  userTurnBuiltInModelToolNames,
  visibleReplyModelToolName,
  type BuiltInModelToolCall,
  type BuiltInModelToolName,
  type CharacterStatePatchModelToolCall,
  type VisibleReplyModelToolCall
} from './model-tools.ts';
import type {
  RuntimeEventIdentity,
  UserMessageRuntimeEvent
} from './runtime-event.ts';

export const roleModelDecisionContractVersion = 'mvp-006.tool_calls.v1';
export const roleModelLegacyDecisionContractVersion = 'mvp-005.visible_reply.v1';
export const roleModelVisibleReplyActionName = visibleReplyModelToolName;
export const roleModelCharacterStatePatchToolName =
  characterStatePatchModelToolName;

export type RoleModelAllowedToolName = BuiltInModelToolName;
export type RoleModelAllowedActionName = RoleModelAllowedToolName;

export const roleModelAllowedToolNames = userTurnBuiltInModelToolNames;
export const roleModelAllowedActionNames = roleModelAllowedToolNames;

export function isRoleModelAllowedToolName(
  value: unknown
): value is RoleModelAllowedToolName {
  return isBuiltInModelToolName(value);
}

export const isRoleModelAllowedActionName = isRoleModelAllowedToolName;

export const roleModelDecisionOutputContractText =
  'Return exactly one complete valid JSON CharacterDecision object with version "mvp-006.tool_calls.v1" and ordered toolCalls. Required call shape: {"name":"visible_reply","input":{"text":"one visible reply line"}}. Each toolCalls item must use string field "name", not "tool" or "type", and object field "input". For a user turn, include one visible_reply call with input.text. Include character_state.patch only when it is listed in allowedTools and toolDefinitions.';

export type RoleModelOutputContract = {
  readonly version: string;
  readonly text: string;
};

export type RoleModelProviderMetadata = {
  readonly provider: 'local' | 'nvidia';
  readonly model?: string;
  readonly request?: {
    readonly endpoint?: string;
    readonly messageCount?: number;
    readonly stream: false;
  };
  readonly response?: {
    readonly status?: number;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
};

export const roleModelDecisionOutputContract = Object.freeze({
  version: roleModelDecisionContractVersion,
  text: roleModelDecisionOutputContractText
} satisfies RoleModelOutputContract);

export type DecisionContext = {
  readonly sessionId: string;
  readonly characterSnapshot: CharacterProfile;
  readonly recentVisibleMessages: readonly VisibleMessage[];
  readonly runtimeNotes: readonly string[];
  readonly livingStateBrief?: LivingStateBrief;
};

export type CreateDecisionContextOptions = {
  readonly sessionId: string;
  readonly characterSnapshot: CharacterProfile;
  readonly recentVisibleMessages?: readonly VisibleMessage[];
  readonly runtimeNotes?: readonly string[];
  readonly livingStateBrief?: LivingStateBrief;
};

export type RoleModelInputEnvelope = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly outputContract: RoleModelOutputContract;
};

export type CreateRoleModelInputEnvelopeOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly allowedTools?: readonly RoleModelAllowedToolName[];
  readonly allowedActions?: readonly RoleModelAllowedActionName[];
  readonly outputContract?: RoleModelOutputContract;
};

export type RoleModelVisibleReplyAction = {
  readonly type: typeof roleModelVisibleReplyActionName;
  readonly text: string;
};

export type CharacterDecision = {
  readonly version: typeof roleModelDecisionContractVersion;
  readonly toolCalls: readonly BuiltInModelToolCall[];
};

export const roleModelMalformedOutputRejectionReason = 'malformed_output';
export const roleModelMalformedToolCallRejectionReason = 'malformed_tool_call';
export const roleModelUnknownToolRejectionReason = 'unknown_tool';
export const roleModelDisallowedToolRejectionReason = 'disallowed_tool';
export const roleModelDuplicateToolCallRejectionReason =
  'duplicate_tool_call';
export const roleModelMissingRequiredToolCallRejectionReason =
  'missing_required_tool_call';
export const roleModelUnsupportedEffectRejectionReason = 'unsupported_effect';
export const roleModelInvalidVisibleReplyRejectionReason = 'invalid_visible_reply';
export const roleModelInvalidCharacterStatePatchRejectionReason =
  'invalid_character_state_patch';
export const roleModelProviderErrorRejectionReason = 'provider_error';
export const roleModelCommitValidationFailureRejectionReason =
  'commit_validation_failure';
export const roleModelAdapterRawOutputMissingTextRejectionDetails =
  'Adapter raw output must include string rawOutputText.';

export type RoleModelDecisionRejectionReason =
  | typeof roleModelMalformedOutputRejectionReason
  | typeof roleModelMalformedToolCallRejectionReason
  | typeof roleModelUnknownToolRejectionReason
  | typeof roleModelDisallowedToolRejectionReason
  | typeof roleModelDuplicateToolCallRejectionReason
  | typeof roleModelMissingRequiredToolCallRejectionReason
  | typeof roleModelUnsupportedEffectRejectionReason
  | typeof roleModelInvalidVisibleReplyRejectionReason
  | typeof roleModelInvalidCharacterStatePatchRejectionReason
  | typeof roleModelProviderErrorRejectionReason
  | typeof roleModelCommitValidationFailureRejectionReason;

export const roleModelDecisionRejectionReasons = Object.freeze([
  roleModelMalformedOutputRejectionReason,
  roleModelMalformedToolCallRejectionReason,
  roleModelUnknownToolRejectionReason,
  roleModelDisallowedToolRejectionReason,
  roleModelDuplicateToolCallRejectionReason,
  roleModelMissingRequiredToolCallRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelInvalidCharacterStatePatchRejectionReason,
  roleModelProviderErrorRejectionReason,
  roleModelCommitValidationFailureRejectionReason
] satisfies readonly RoleModelDecisionRejectionReason[]);

export type RoleModelDecisionRejection = {
  readonly reason: RoleModelDecisionRejectionReason;
  readonly details?: string;
};

export type AcceptedRoleModelDecisionResult = {
  readonly status: 'accepted';
  readonly decision: CharacterDecision;
};

export type RejectedRoleModelDecisionResult = {
  readonly status: 'rejected';
  readonly rejection: RoleModelDecisionRejection;
};

export type RoleModelDecisionResult =
  | AcceptedRoleModelDecisionResult
  | RejectedRoleModelDecisionResult;

export type RoleModelIOSnapshot = RuntimeEventIdentity & {
  readonly kind: 'role_model_io_snapshot';
  readonly sessionId: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly rawOutputText: string;
  readonly providerMetadata?: RoleModelProviderMetadata;
};

export type CreateRoleModelIOSnapshotOptions = RuntimeEventIdentity & {
  readonly sessionId: string;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly rawOutputText: string;
  readonly providerMetadata?: RoleModelProviderMetadata;
};

export type ParsedRoleModelDecisionSnapshot = RuntimeEventIdentity & {
  readonly kind: 'role_model_decision_snapshot';
  readonly sessionId: string;
  readonly result: RoleModelDecisionResult;
};

export type CreateParsedRoleModelDecisionSnapshotOptions =
  RuntimeEventIdentity & {
    readonly sessionId: string;
    readonly result: RoleModelDecisionResult;
  };

export function createDecisionContext(
  options: CreateDecisionContextOptions
): DecisionContext {
  return Object.freeze({
    sessionId: options.sessionId,
    characterSnapshot: freezeCharacterProfileSnapshot(options.characterSnapshot),
    recentVisibleMessages: freezeVisibleMessageSnapshots(
      options.recentVisibleMessages ?? []
    ),
    runtimeNotes: Object.freeze([...(options.runtimeNotes ?? [])]),
    ...(options.livingStateBrief === undefined
      ? {}
      : { livingStateBrief: createLivingStateBriefFromBrief(options.livingStateBrief) })
  } satisfies DecisionContext);
}

export function createRoleModelInputEnvelope(
  options: CreateRoleModelInputEnvelopeOptions
): RoleModelInputEnvelope {
  return Object.freeze({
    event: freezeUserMessageRuntimeEventSnapshot(options.event),
    decisionContext: createDecisionContext(options.decisionContext),
    allowedTools: freezeAllowedTools(
      options.allowedTools ?? options.allowedActions ?? roleModelAllowedToolNames
    ),
    outputContract: freezeRoleModelOutputContract(
      options.outputContract ?? roleModelDecisionOutputContract
    )
  } satisfies RoleModelInputEnvelope);
}

export function createCharacterDecision(
  toolCalls: readonly BuiltInModelToolCall[]
): CharacterDecision {
  assertUserTurnToolCallCardinality(toolCalls);

  return freezeCharacterDecision({
    version: roleModelDecisionContractVersion,
    toolCalls
  });
}

export function createVisibleReplyCharacterDecision(
  text: string
): CharacterDecision {
  return createCharacterDecision([createVisibleReplyModelToolCall(text)]);
}

export function createAcceptedRoleModelDecisionResult(
  decision: CharacterDecision
): AcceptedRoleModelDecisionResult {
  return Object.freeze({
    status: 'accepted',
    decision: freezeCharacterDecision(decision)
  } satisfies AcceptedRoleModelDecisionResult);
}

export function createRejectedRoleModelDecisionResult(
  reason: RoleModelDecisionRejectionReason,
  details?: string
): RejectedRoleModelDecisionResult {
  return Object.freeze({
    status: 'rejected',
    rejection: freezeRoleModelDecisionRejection({
      reason,
      ...(details === undefined ? {} : { details })
    })
  } satisfies RejectedRoleModelDecisionResult);
}

export function createRoleModelIOSnapshot(
  options: CreateRoleModelIOSnapshotOptions
): RoleModelIOSnapshot {
  const identity = freezeRuntimeEventIdentitySnapshot(options);

  return Object.freeze({
    ...identity,
    kind: 'role_model_io_snapshot',
    sessionId: options.sessionId,
    inputEnvelope: createRoleModelInputEnvelope(options.inputEnvelope),
    rawOutputText: options.rawOutputText,
    ...(options.providerMetadata === undefined
      ? {}
      : { providerMetadata: freezeProviderMetadata(options.providerMetadata) })
  } satisfies RoleModelIOSnapshot);
}

export function createParsedRoleModelDecisionSnapshot(
  options: CreateParsedRoleModelDecisionSnapshotOptions
): ParsedRoleModelDecisionSnapshot {
  const identity = freezeRuntimeEventIdentitySnapshot(options);

  return Object.freeze({
    ...identity,
    kind: 'role_model_decision_snapshot',
    sessionId: options.sessionId,
    result: freezeRoleModelDecisionResult(options.result)
  } satisfies ParsedRoleModelDecisionSnapshot);
}

export function parseRoleModelDecision(
  rawOutputText: string,
  allowedTools: readonly RoleModelAllowedToolName[] = roleModelAllowedToolNames
): RoleModelDecisionResult {
  let parsedOutput: unknown;

  try {
    parsedOutput = JSON.parse(rawOutputText);
  } catch {
    return createMalformedOutputResult('Adapter output must be valid JSON.');
  }

  return parseRoleModelDecisionObject(parsedOutput, allowedTools);
}

export function getRequiredVisibleReplyText(
  decision: CharacterDecision
): string {
  const visibleReply = getVisibleReplyToolCall(decision);

  if (visibleReply === undefined) {
    throw new TypeError('CharacterDecision must include visible_reply.');
  }

  return visibleReply.input.text;
}

export function getVisibleReplyToolCall(
  decision: CharacterDecision
): VisibleReplyModelToolCall | undefined {
  return findVisibleReplyModelToolCall(decision.toolCalls);
}

export function getCharacterStatePatchToolCall(
  decision: CharacterDecision
): CharacterStatePatchModelToolCall | undefined {
  return findCharacterStatePatchModelToolCall(decision.toolCalls);
}

function parseRoleModelDecisionObject(
  parsedOutput: unknown,
  allowedTools: readonly RoleModelAllowedToolName[]
): RoleModelDecisionResult {
  const frozenAllowedTools = freezeAllowedTools(allowedTools);

  if (!isJsonRecord(parsedOutput)) {
    return createMalformedOutputResult(
      'Adapter output must be a CharacterDecision JSON object.'
    );
  }

  if (hasEffectShape(parsedOutput)) {
    return createUnsupportedOutputResult(
      'Decision includes unsupported effect fields.'
    );
  }

  if (parsedOutput['action'] !== undefined) {
    return parseLegacyVisibleReplyDecision(parsedOutput, frozenAllowedTools);
  }

  const version = parsedOutput['version'];

  if (version !== roleModelDecisionContractVersion) {
    return createMalformedOutputResult(
      `Decision version must be "${roleModelDecisionContractVersion}".`
    );
  }

  const unsupportedTopLevelKeys = findUnsupportedKeys(parsedOutput, [
    'version',
    'toolCalls'
  ]);

  if (unsupportedTopLevelKeys.length > 0) {
    return createUnsupportedOutputResult(
      `Decision includes unsupported fields: ${unsupportedTopLevelKeys.join(', ')}.`
    );
  }

  const rawToolCalls = parsedOutput['toolCalls'];

  if (!Array.isArray(rawToolCalls)) {
    return createMalformedOutputResult('Decision toolCalls must be an array.');
  }

  const toolCalls: BuiltInModelToolCall[] = [];

  for (const [index, rawToolCall] of rawToolCalls.entries()) {
    const parsedToolCall = parseModelToolCall({
      allowedTools: frozenAllowedTools,
      index,
      rawToolCall
    });

    if (parsedToolCall.status === 'rejected') {
      return parsedToolCall.result;
    }

    toolCalls.push(parsedToolCall.toolCall);
  }

  const cardinalityResult = validateUserTurnToolCallCardinality(toolCalls);

  if (cardinalityResult !== undefined) {
    return cardinalityResult;
  }

  return createAcceptedRoleModelDecisionResult(createCharacterDecision(toolCalls));
}

function parseLegacyVisibleReplyDecision(
  parsedOutput: Readonly<Record<string, unknown>>,
  allowedTools: readonly RoleModelAllowedToolName[]
): RoleModelDecisionResult {
  const action = parsedOutput['action'];

  if (!isJsonRecord(action)) {
    return createMalformedOutputResult('Decision action must be an object.');
  }

  const actionType = action['type'];

  if (typeof actionType !== 'string') {
    return createMalformedOutputResult('Decision action.type must be a string.');
  }

  if (actionType !== roleModelVisibleReplyActionName) {
    return createUnsupportedOutputResult(
      `Decision action.type "${actionType}" is not supported.`
    );
  }

  if (!allowedTools.includes(roleModelVisibleReplyActionName)) {
    return createRejectedRoleModelDecisionResult(
      roleModelDisallowedToolRejectionReason,
      `Decision requested disallowed tool "${roleModelVisibleReplyActionName}".`
    );
  }

  const replyText = action['text'];

  if (typeof replyText !== 'string') {
    return createMalformedOutputResult('Decision action.text must be a string.');
  }

  const unsupportedTopLevelKeys = findUnsupportedKeys(parsedOutput, ['action']);

  if (unsupportedTopLevelKeys.length > 0) {
    return createUnsupportedOutputResult(
      `Decision includes unsupported fields: ${unsupportedTopLevelKeys.join(', ')}.`
    );
  }

  const unsupportedActionKeys = findUnsupportedKeys(action, ['type', 'text']);

  if (unsupportedActionKeys.length > 0) {
    return createUnsupportedOutputResult(
      `Decision action includes unsupported fields: ${unsupportedActionKeys.join(
        ', '
      )}.`
    );
  }

  return createAcceptedRoleModelDecisionResult(
    createVisibleReplyCharacterDecision(replyText)
  );
}

type ParsedToolCallResult =
  | {
      readonly status: 'accepted';
      readonly toolCall: BuiltInModelToolCall;
    }
  | {
      readonly status: 'rejected';
      readonly result: RejectedRoleModelDecisionResult;
    };

function parseModelToolCall(options: {
  readonly allowedTools: readonly RoleModelAllowedToolName[];
  readonly index: number;
  readonly rawToolCall: unknown;
}): ParsedToolCallResult {
  if (!isJsonRecord(options.rawToolCall)) {
    return rejectToolCall(
      `Decision toolCalls[${String(options.index)}] must be an object.`
    );
  }

  const name = options.rawToolCall['name'];

  if (typeof name !== 'string') {
    return rejectToolCall(
      `Decision toolCalls[${String(options.index)}].name must be a string.`
    );
  }

  if (!isBuiltInModelToolName(name)) {
    return {
      status: 'rejected',
      result: createRejectedRoleModelDecisionResult(
        roleModelUnknownToolRejectionReason,
        `Decision requested unknown tool "${name}".`
      )
    };
  }

  if (!options.allowedTools.includes(name)) {
    return {
      status: 'rejected',
      result: createRejectedRoleModelDecisionResult(
        roleModelDisallowedToolRejectionReason,
        `Decision requested disallowed tool "${name}".`
      )
    };
  }

  const input = options.rawToolCall['input'];

  if (!isJsonRecord(input)) {
    return rejectToolCall(
      `Decision toolCalls[${String(options.index)}].input must be an object.`
    );
  }

  if (name === visibleReplyModelToolName) {
    return parseVisibleReplyToolCallInput(input, options.index);
  }

  return {
    status: 'accepted',
    toolCall: createCharacterStatePatchModelToolCall(input)
  };
}

function parseVisibleReplyToolCallInput(
  input: Readonly<Record<string, unknown>>,
  index: number
): ParsedToolCallResult {
  const text = input['text'];

  if (typeof text !== 'string') {
    return rejectToolCall(
      `Decision toolCalls[${String(index)}].input.text must be a string.`
    );
  }

  const unsupportedInputKeys = findUnsupportedKeys(input, ['text']);

  if (unsupportedInputKeys.length > 0) {
    return {
      status: 'rejected',
      result: createRejectedRoleModelDecisionResult(
        roleModelUnsupportedEffectRejectionReason,
        `visible_reply input includes unsupported fields: ${unsupportedInputKeys.join(
          ', '
        )}.`
      )
    };
  }

  return {
    status: 'accepted',
    toolCall: createVisibleReplyModelToolCall(text)
  };
}

function rejectToolCall(details: string): ParsedToolCallResult {
  return {
    status: 'rejected',
    result: createRejectedRoleModelDecisionResult(
      roleModelMalformedToolCallRejectionReason,
      details
    )
  };
}

function assertUserTurnToolCallCardinality(
  toolCalls: readonly BuiltInModelToolCall[]
): void {
  const result = validateUserTurnToolCallCardinality(toolCalls);

  if (result !== undefined) {
    throw new TypeError(result.rejection.details ?? result.rejection.reason);
  }
}

function validateUserTurnToolCallCardinality(
  toolCalls: readonly BuiltInModelToolCall[]
): RejectedRoleModelDecisionResult | undefined {
  const visibleReplyCount = toolCalls.filter(
    (call) => call.name === visibleReplyModelToolName
  ).length;
  const characterStatePatchCount = toolCalls.filter(
    (call) => call.name === characterStatePatchModelToolName
  ).length;

  if (visibleReplyCount === 0) {
    return createRejectedRoleModelDecisionResult(
      roleModelMissingRequiredToolCallRejectionReason,
      'Decision must include exactly one visible_reply tool call.'
    );
  }

  if (visibleReplyCount > 1) {
    return createRejectedRoleModelDecisionResult(
      roleModelDuplicateToolCallRejectionReason,
      'Decision must not include duplicate visible_reply tool calls.'
    );
  }

  if (characterStatePatchCount > 1) {
    return createRejectedRoleModelDecisionResult(
      roleModelDuplicateToolCallRejectionReason,
      'Decision must not include duplicate character_state.patch tool calls.'
    );
  }

  return undefined;
}

function createMalformedOutputResult(
  details: string
): RejectedRoleModelDecisionResult {
  return createRejectedRoleModelDecisionResult(
    roleModelMalformedOutputRejectionReason,
    details
  );
}

function createUnsupportedOutputResult(
  details: string
): RejectedRoleModelDecisionResult {
  return createRejectedRoleModelDecisionResult(
    roleModelUnsupportedEffectRejectionReason,
    details
  );
}

function freezeRuntimeEventIdentitySnapshot(
  identity: RuntimeEventIdentity
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: identity.eventId,
    traceId: identity.traceId,
    createdAt: identity.createdAt
  } satisfies RuntimeEventIdentity);
}

function freezeUserMessageRuntimeEventSnapshot(
  event: UserMessageRuntimeEvent
): UserMessageRuntimeEvent {
  const identity = freezeRuntimeEventIdentitySnapshot(event);

  return Object.freeze({
    ...identity,
    type: event.type,
    payload: Object.freeze({
      currentUserMessage: event.payload.currentUserMessage
    })
  } satisfies UserMessageRuntimeEvent);
}

function freezeCharacterProfileSnapshot(
  character: CharacterProfile
): CharacterProfile {
  return Object.freeze({
    id: character.id,
    displayName: character.displayName
  } satisfies CharacterProfile);
}

function freezeVisibleMessageSnapshots(
  visibleMessages: readonly VisibleMessage[]
): readonly VisibleMessage[] {
  return Object.freeze(visibleMessages.map(freezeVisibleMessageSnapshot));
}

function freezeVisibleMessageSnapshot(message: VisibleMessage): VisibleMessage {
  return Object.freeze({
    id: message.id,
    role: message.role,
    speakerId: message.speakerId,
    speakerName: message.speakerName,
    text: message.text
  } satisfies VisibleMessage);
}

function createLivingStateBriefFromBrief(
  brief: LivingStateBrief
): LivingStateBrief {
  return createLivingStateBrief({
    version: 'mvp-006.character_state.v1',
    current: brief.current
  });
}

function freezeAllowedTools(
  allowedTools: readonly unknown[]
): readonly RoleModelAllowedToolName[] {
  const validatedTools: RoleModelAllowedToolName[] = [];

  for (const tool of allowedTools) {
    if (!isRoleModelAllowedToolName(tool)) {
      throw new TypeError(
        'Role-model allowedTools must contain only supported tools.'
      );
    }

    validatedTools.push(tool);
  }

  return Object.freeze(validatedTools);
}

function freezeRoleModelOutputContract(
  outputContract: RoleModelOutputContract
): RoleModelOutputContract {
  return Object.freeze({
    version: outputContract.version,
    text: outputContract.text
  } satisfies RoleModelOutputContract);
}

function freezeProviderMetadata(
  metadata: RoleModelProviderMetadata
): RoleModelProviderMetadata {
  return Object.freeze({
    provider: metadata.provider,
    ...(metadata.model === undefined ? {} : { model: metadata.model }),
    ...(metadata.request === undefined
      ? {}
      : {
          request: Object.freeze({
            ...(metadata.request.endpoint === undefined
              ? {}
              : { endpoint: metadata.request.endpoint }),
            ...(metadata.request.messageCount === undefined
              ? {}
              : { messageCount: metadata.request.messageCount }),
            stream: false
          })
        }),
    ...(metadata.response === undefined
      ? {}
      : {
          response: Object.freeze({
            ...(metadata.response.status === undefined
              ? {}
              : { status: metadata.response.status })
          })
        }),
    ...(metadata.error === undefined
      ? {}
      : {
          error: Object.freeze({
            code: metadata.error.code,
            message: metadata.error.message
          })
        })
  } satisfies RoleModelProviderMetadata);
}

function freezeCharacterDecision(decision: CharacterDecision): CharacterDecision {
  return Object.freeze({
    version: roleModelDecisionContractVersion,
    toolCalls: freezeBuiltInModelToolCalls(decision.toolCalls)
  } satisfies CharacterDecision);
}

function freezeRoleModelDecisionRejection(
  rejection: RoleModelDecisionRejection
): RoleModelDecisionRejection {
  return Object.freeze({
    reason: rejection.reason,
    ...(rejection.details === undefined ? {} : { details: rejection.details })
  } satisfies RoleModelDecisionRejection);
}

function freezeRoleModelDecisionResult(
  result: RoleModelDecisionResult
): RoleModelDecisionResult {
  if (result.status === 'accepted') {
    return createAcceptedRoleModelDecisionResult(result.decision);
  }

  return createRejectedRoleModelDecisionResult(
    result.rejection.reason,
    result.rejection.details
  );
}

function isJsonRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasEffectShape(record: Readonly<Record<string, unknown>>): boolean {
  return record['effect'] !== undefined || record['effects'] !== undefined;
}

function findUnsupportedKeys(
  record: Readonly<Record<string, unknown>>,
  supportedKeys: readonly string[]
): readonly string[] {
  return Object.keys(record).filter((key) => !supportedKeys.includes(key));
}

export { freezeBuiltInModelToolCall };
export type {
  BuiltInModelToolCall,
  BuiltInModelToolName,
  CharacterStatePatchModelToolCall,
  VisibleReplyModelToolCall
};
