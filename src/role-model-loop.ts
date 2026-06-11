import {
  createDeterministicCharacterAgent,
  validateCharacterAgentReply,
  type CharacterAgent
} from './conversation.ts';
import {
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createVisibleReplyCharacterDecision,
  parseRoleModelDecision,
  roleModelAdapterRawOutputMissingTextRejectionDetails,
  roleModelDecisionRejectionReasons,
  roleModelMalformedOutputRejectionReason,
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelProviderMetadata
} from './role-model-contracts.ts';
import type { RuntimeEventIdentity, UserMessageRuntimeEvent } from './runtime-event.ts';

export { parseRoleModelDecision } from './role-model-contracts.ts';

export type RoleModelAdapterRawOutput = {
  readonly rawOutputText: string;
  readonly providerMetadata?: RoleModelProviderMetadata;
  readonly rejection?: RoleModelDecisionRejection;
};

export type RoleModelAdapter = {
  invoke(
    inputEnvelope: RoleModelInputEnvelope
  ): Promise<RoleModelAdapterRawOutput> | RoleModelAdapterRawOutput;
};

export type RunRoleModelLoopOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly adapter?: RoleModelAdapter;
};

export type AcceptedRoleModelLoopResult = {
  readonly status: 'accepted';
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: AcceptedRoleModelDecisionResult;
  readonly decision: CharacterDecision;
};

export type RejectedRoleModelLoopResult = {
  readonly status: 'rejected';
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: RejectedRoleModelDecisionResult;
  readonly rejection: RoleModelDecisionRejection;
};

export type RoleModelLoopResult =
  | AcceptedRoleModelLoopResult
  | RejectedRoleModelLoopResult;

export function createDeterministicLocalRoleModelAdapter(): RoleModelAdapter {
  return createRoleModelAdapterFromCharacterAgent(
    createDeterministicCharacterAgent()
  );
}

export function createRoleModelAdapterFromCharacterAgent(
  agent: CharacterAgent
): RoleModelAdapter {
  return Object.freeze({
    async invoke(inputEnvelope) {
      const reply = await agent.reply({
        character: inputEnvelope.decisionContext.characterSnapshot,
        message: inputEnvelope.event.payload.currentUserMessage,
        recentVisibleMessages: inputEnvelope.decisionContext.recentVisibleMessages
      });
      const characterReply = validateCharacterAgentReply(reply);

      return createRoleModelAdapterRawOutput(
        JSON.stringify(createVisibleReplyCharacterDecision(characterReply.text))
      );
    }
  } satisfies RoleModelAdapter);
}

export async function runRoleModelLoop(
  options: RunRoleModelLoopOptions
): Promise<RoleModelLoopResult> {
  const inputEnvelope = createRoleModelInputEnvelope({
    event: options.event,
    decisionContext: options.decisionContext
  });
  const adapter = options.adapter ?? createDeterministicLocalRoleModelAdapter();
  const rawOutput: unknown = await adapter.invoke(inputEnvelope);
  const rawOutputValidation = validateRoleModelAdapterRawOutput(rawOutput);
  const identity = createSnapshotIdentity(inputEnvelope.event);
  const sessionId = inputEnvelope.decisionContext.sessionId;
  const ioSnapshot = createRoleModelIOSnapshot({
    ...identity,
    sessionId,
    inputEnvelope,
    rawOutputText: rawOutputValidation.rawOutputText,
    ...providerMetadataOption(rawOutputValidation.providerMetadata)
  });
  const decisionResult =
    rawOutputValidation.status === 'accepted'
      ? parseRoleModelDecision(
          rawOutputValidation.rawOutputText,
          inputEnvelope.allowedTools
        )
      : rawOutputValidation.decisionResult;
  const parsedDecisionSnapshot = createParsedRoleModelDecisionSnapshot({
    ...identity,
    sessionId,
    result: decisionResult
  });

  if (decisionResult.status === 'accepted') {
    return Object.freeze({
      status: 'accepted',
      inputEnvelope,
      ioSnapshot,
      parsedDecisionSnapshot,
      decisionResult,
      decision: decisionResult.decision
    } satisfies AcceptedRoleModelLoopResult);
  }

  return Object.freeze({
    status: 'rejected',
    inputEnvelope,
    ioSnapshot,
    parsedDecisionSnapshot,
    decisionResult,
    rejection: decisionResult.rejection
  } satisfies RejectedRoleModelLoopResult);
}

function createRoleModelAdapterRawOutput(
  rawOutputText: string
): RoleModelAdapterRawOutput {
  return Object.freeze({
    rawOutputText
  } satisfies RoleModelAdapterRawOutput);
}

type RoleModelAdapterRawOutputValidationResult =
  | {
      readonly status: 'accepted';
      readonly rawOutputText: string;
      readonly providerMetadata?: RoleModelProviderMetadata;
    }
  | {
      readonly status: 'rejected';
      readonly rawOutputText: string;
      readonly providerMetadata?: RoleModelProviderMetadata;
      readonly decisionResult: RejectedRoleModelDecisionResult;
    };

function validateRoleModelAdapterRawOutput(
  rawOutput: unknown
): RoleModelAdapterRawOutputValidationResult {
  if (!isJsonRecord(rawOutput)) {
    return createMalformedAdapterRawOutputResult();
  }

  const rawOutputText = rawOutput['rawOutputText'];

  if (typeof rawOutputText !== 'string') {
    return createMalformedAdapterRawOutputResult();
  }

  const providerMetadata = optionalProviderMetadata(rawOutput['providerMetadata']);
  const rejection = optionalRoleModelDecisionRejection(rawOutput['rejection']);

  if (rejection !== undefined) {
    return Object.freeze({
      status: 'rejected',
      rawOutputText,
      ...providerMetadataOption(providerMetadata),
      decisionResult: createRejectedRoleModelDecisionResult(
        rejection.reason,
        rejection.details
      )
    } satisfies RoleModelAdapterRawOutputValidationResult);
  }

  return Object.freeze({
    status: 'accepted',
    rawOutputText,
    ...providerMetadataOption(providerMetadata)
  } satisfies RoleModelAdapterRawOutputValidationResult);
}

function createMalformedAdapterRawOutputResult(): RoleModelAdapterRawOutputValidationResult {
  return Object.freeze({
    status: 'rejected',
    rawOutputText: '',
    decisionResult: createRejectedRoleModelDecisionResult(
      roleModelMalformedOutputRejectionReason,
      roleModelAdapterRawOutputMissingTextRejectionDetails
    )
  } satisfies RoleModelAdapterRawOutputValidationResult);
}

function providerMetadataOption(
  providerMetadata: RoleModelProviderMetadata | undefined
): { readonly providerMetadata?: RoleModelProviderMetadata } {
  return providerMetadata === undefined ? {} : { providerMetadata };
}

function optionalProviderMetadata(
  value: unknown
): RoleModelProviderMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isJsonRecord(value)) {
    return undefined;
  }

  const provider = value['provider'];

  if (provider !== 'local' && provider !== 'nvidia') {
    return undefined;
  }

  const model = value['model'];
  const request = optionalProviderRequestMetadata(value['request']);
  const response = optionalProviderResponseMetadata(value['response']);
  const error = optionalProviderErrorMetadata(value['error']);

  return Object.freeze({
    provider,
    ...(typeof model === 'string' ? { model } : {}),
    ...(request === undefined ? {} : { request }),
    ...(response === undefined ? {} : { response }),
    ...(error === undefined ? {} : { error })
  } satisfies RoleModelProviderMetadata);
}

function optionalProviderRequestMetadata(
  value: unknown
): RoleModelProviderMetadata['request'] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const endpoint = value['endpoint'];
  const messageCount = value['messageCount'];

  return Object.freeze({
    ...(typeof endpoint === 'string' ? { endpoint } : {}),
    ...(typeof messageCount === 'number' ? { messageCount } : {}),
    stream: false
  });
}

function optionalProviderResponseMetadata(
  value: unknown
): RoleModelProviderMetadata['response'] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const status = value['status'];

  return Object.freeze({
    ...(typeof status === 'number' ? { status } : {})
  });
}

function optionalProviderErrorMetadata(
  value: unknown
): RoleModelProviderMetadata['error'] | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const code = value['code'];
  const message = value['message'];

  if (typeof code !== 'string' || typeof message !== 'string') {
    return undefined;
  }

  return Object.freeze({ code, message });
}

function optionalRoleModelDecisionRejection(
  value: unknown
): RoleModelDecisionRejection | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const reason = value['reason'];
  const details = value['details'];

  if (!isRoleModelDecisionRejectionReason(reason)) {
    return undefined;
  }

  return Object.freeze({
    reason,
    ...(typeof details === 'string' ? { details } : {})
  } satisfies RoleModelDecisionRejection);
}

function isRoleModelDecisionRejectionReason(
  value: unknown
): value is RoleModelDecisionRejectionReason {
  return (
    typeof value === 'string' &&
    roleModelDecisionRejectionReasons.includes(value as RoleModelDecisionRejectionReason)
  );
}

function createSnapshotIdentity(
  event: UserMessageRuntimeEvent
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: event.eventId,
    traceId: event.traceId,
    createdAt: event.createdAt
  } satisfies RuntimeEventIdentity);
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
