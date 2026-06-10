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
  parseRoleModelDecision,
  roleModelAdapterRawOutputMissingTextRejectionDetails,
  roleModelMalformedOutputRejectionReason,
  roleModelVisibleReplyActionName,
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionRejection,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot
} from './role-model-contracts.ts';
import type { RuntimeEventIdentity, UserMessageRuntimeEvent } from './runtime-event.ts';

export { parseRoleModelDecision } from './role-model-contracts.ts';

export type RoleModelAdapterRawOutput = {
  readonly rawOutputText: string;
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
        JSON.stringify({
          action: {
            type: roleModelVisibleReplyActionName,
            text: characterReply.text
          }
        })
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
    rawOutputText: rawOutputValidation.rawOutputText
  });
  const decisionResult =
    rawOutputValidation.status === 'accepted'
      ? parseRoleModelDecision(rawOutputValidation.rawOutputText)
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
    }
  | {
      readonly status: 'rejected';
      readonly rawOutputText: string;
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

  return Object.freeze({
    status: 'accepted',
    rawOutputText
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
