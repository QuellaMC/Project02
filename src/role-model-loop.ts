import {
  createDeterministicCharacterAgent,
  type CharacterAgent
} from './conversation.ts';
import {
  createAcceptedRoleModelDecisionResult,
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
  createVisibleReplyCharacterDecision,
  roleModelMalformedOutputRejectionReason,
  roleModelUnsupportedEffectRejectionReason,
  roleModelVisibleReplyActionName,
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionRejection,
  type RoleModelDecisionResult,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot
} from './role-model-contracts.ts';
import type { RuntimeEventIdentity, UserMessageRuntimeEvent } from './runtime-event.ts';

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

      return createRoleModelAdapterRawOutput(
        JSON.stringify({
          action: {
            type: roleModelVisibleReplyActionName,
            text: reply.text
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
  const rawOutput = await adapter.invoke(inputEnvelope);
  const identity = createSnapshotIdentity(inputEnvelope.event);
  const sessionId = inputEnvelope.decisionContext.sessionId;
  const ioSnapshot = createRoleModelIOSnapshot({
    ...identity,
    sessionId,
    inputEnvelope,
    rawOutputText: rawOutput.rawOutputText
  });
  const decisionResult = parseRoleModelDecision(rawOutput.rawOutputText);
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

export function parseRoleModelDecision(
  rawOutputText: string
): RoleModelDecisionResult {
  let parsedOutput: unknown;

  try {
    parsedOutput = JSON.parse(rawOutputText);
  } catch {
    return createMalformedOutputResult('Adapter output must be valid JSON.');
  }

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

function createRoleModelAdapterRawOutput(
  rawOutputText: string
): RoleModelAdapterRawOutput {
  return Object.freeze({
    rawOutputText
  } satisfies RoleModelAdapterRawOutput);
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

function hasEffectShape(record: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(record, 'effect') || Object.hasOwn(record, 'effects');
}

function findUnsupportedKeys(
  record: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[]
): string[] {
  return Object.keys(record).filter((key) => !allowedKeys.includes(key));
}
