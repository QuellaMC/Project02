import {
  normalizeVisibleMessageText,
  type RuntimeEventIdentity,
} from '../../core/index.ts';
import {
  roleModelInvalidVisibleReplyRejectionReason,
  roleModelMalformedOutputRejectionReason,
  roleModelPluginToolRejectedRejectionReason,
  roleModelTerminalEmptyOutputRejectionDetails,
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type ParsedRoleModelDecisionSnapshot,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionRejection,
  type RoleModelDecisionRejectionReason,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
  type RoleModelToolObservation,
} from '../api/contracts.ts';
import {
  createParsedRoleModelDecisionSnapshot,
  createRejectedRoleModelDecisionResult,
} from '../api/decision.ts';
import {
  visibleReplyModelToolName,
  type ModelToolCall,
} from '../api/model-tools.ts';
import {
  freezeRoleModelChatMessage,
  type RoleModelChatMessage,
} from '../api/chat-wire.ts';
import {visibleReplyToolCalls} from './decision-parser.ts';
import {type RoleModelPluginToolRoutingEvidence} from './routing-rejections.ts';

export type RoleModelLoopRound = {
  readonly round: number;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
};

export type AcceptedRoleModelLoopResult = {
  readonly status: 'accepted';
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: AcceptedRoleModelDecisionResult;
  readonly decision: CharacterDecision;
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
  readonly rounds: readonly RoleModelLoopRound[];
};

export type RejectedRoleModelLoopResult = {
  readonly status: 'rejected';
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: RejectedRoleModelDecisionResult;
  readonly rejection: RoleModelDecisionRejection;
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
  readonly rounds: readonly RoleModelLoopRound[];
};

export type RoleModelLoopResult =
  AcceptedRoleModelLoopResult | RejectedRoleModelLoopResult;

export type RoleModelLoopState = {
  readonly rounds: RoleModelLoopRound[];
  readonly allPluginToolResults: RoleModelPluginToolRoutingEvidence[];
  toolRounds: number;
  toolObservations: readonly RoleModelToolObservation[];
  nativeAdditionalMessages: readonly RoleModelChatMessage[];
};

export type AcceptedRoundView = {
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: AcceptedRoleModelDecisionResult;
  readonly executableToolCalls: readonly ModelToolCall[];
};

export type RejectedRoundView = {
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: RejectedRoleModelDecisionResult;
};

export function createRoleModelLoopRound(options: {
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly round: number;
}): RoleModelLoopRound {
  return Object.freeze({
    round: options.round,
    inputEnvelope: options.inputEnvelope,
    ioSnapshot: options.ioSnapshot,
    parsedDecisionSnapshot: options.parsedDecisionSnapshot,
    pluginToolResults: Object.freeze([...options.pluginToolResults]),
  } satisfies RoleModelLoopRound);
}

function createRejectedRoleModelLoopResult(options: {
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly rounds: readonly RoleModelLoopRound[];
}): RejectedRoleModelLoopResult {
  const decisionResult = options.parsedDecisionSnapshot.result;

  if (decisionResult.status !== 'rejected') {
    throw new TypeError(
      'Rejected role-model execution decision must produce rejected public evidence.',
    );
  }

  return Object.freeze({
    status: 'rejected',
    inputEnvelope: options.inputEnvelope,
    ioSnapshot: options.ioSnapshot,
    parsedDecisionSnapshot: options.parsedDecisionSnapshot,
    decisionResult,
    rejection: decisionResult.rejection,
    pluginToolResults: Object.freeze([...options.pluginToolResults]),
    rounds: Object.freeze([...options.rounds]),
  } satisfies RejectedRoleModelLoopResult);
}

export function executionVisibleReplyTexts(
  decision: CharacterDecision,
): readonly string[] {
  return Object.freeze(
    decision.toolCalls
      .filter(call => call.name === visibleReplyModelToolName)
      .map(call => call.input['text'])
      .filter((text): text is string => typeof text === 'string'),
  );
}

/** A rejected decision ends the turn: nothing retries a parse failure. */
export function appendRejectedRoleModelLoopRound(options: {
  readonly state: RoleModelLoopState;
  readonly invokedRound: RejectedRoundView;
  readonly round: number;
}): RejectedRoleModelLoopResult {
  const loopRound = createRoleModelLoopRound({
    pluginToolResults: [],
    inputEnvelope: options.invokedRound.inputEnvelope,
    ioSnapshot: options.invokedRound.ioSnapshot,
    parsedDecisionSnapshot: options.invokedRound.parsedDecisionSnapshot,
    round: options.round,
  });

  options.state.rounds.push(loopRound);

  return createRejectedRoleModelLoopResult({
    pluginToolResults: options.state.allPluginToolResults,
    inputEnvelope: options.invokedRound.inputEnvelope,
    ioSnapshot: options.invokedRound.ioSnapshot,
    parsedDecisionSnapshot: options.invokedRound.parsedDecisionSnapshot,
    rounds: options.state.rounds,
  });
}

function recordDecisionErrorFeedbackRound(options: {
  readonly state: RoleModelLoopState;
  readonly round: number;
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly note: string;
}): void {
  options.state.rounds.push(
    createRoleModelLoopRound({
      pluginToolResults: [],
      inputEnvelope: options.inputEnvelope,
      ioSnapshot: options.ioSnapshot,
      parsedDecisionSnapshot: options.parsedDecisionSnapshot,
      round: options.round,
    }),
  );
  options.state.nativeAdditionalMessages = Object.freeze([
    ...options.state.nativeAdditionalMessages,
    freezeRoleModelChatMessage({role: 'system', content: options.note}),
  ]);
  options.state.toolRounds += 1;
}

export function terminalRoleModelLoopResult(options: {
  readonly state: RoleModelLoopState;
  readonly invokedRound: AcceptedRoundView;
  readonly identity: RuntimeEventIdentity;
  readonly sessionId: string;
  readonly round: number;
  readonly maxToolRounds: number;
}): RoleModelLoopResult | 'continue' | undefined {
  const isTerminalRound = options.invokedRound.executableToolCalls.length === 0;
  const gate = visibleReplyGateRejection(
    options.invokedRound.decisionResult,
    isTerminalRound,
  );

  if (gate !== undefined) {
    return rejectOrFeedbackRound(options, gate);
  }

  if (isTerminalRound) {
    return terminalAcceptedRoleModelLoopResult(options);
  }

  if (options.state.toolRounds < options.maxToolRounds) {
    return undefined;
  }

  return rejectWithReason(options, {
    reason: roleModelPluginToolRejectedRejectionReason,
    details: `Role model exceeded maximum executable tool rounds (${String(options.maxToolRounds)}).`,
  });
}

function rejectOrFeedbackRound(
  options: {
    readonly state: RoleModelLoopState;
    readonly invokedRound: AcceptedRoundView;
    readonly identity: RuntimeEventIdentity;
    readonly sessionId: string;
    readonly round: number;
    readonly maxToolRounds: number;
  },
  gate: {
    readonly reason: RoleModelDecisionRejectionReason;
    readonly details: string;
  },
): RoleModelLoopResult | 'continue' {
  if (options.state.toolRounds < options.maxToolRounds) {
    recordDecisionErrorFeedbackRound({
      state: options.state,
      round: options.round,
      inputEnvelope: options.invokedRound.inputEnvelope,
      ioSnapshot: options.invokedRound.ioSnapshot,
      parsedDecisionSnapshot: options.invokedRound.parsedDecisionSnapshot,
      note: `Your previous response was rejected: ${gate.details} Respond again following the tool protocol.`,
    });

    return 'continue';
  }

  return rejectWithReason(options, gate);
}

function rejectWithReason(
  options: {
    readonly state: RoleModelLoopState;
    readonly invokedRound: AcceptedRoundView;
    readonly identity: RuntimeEventIdentity;
    readonly sessionId: string;
    readonly round: number;
  },
  gate: {
    readonly reason: RoleModelDecisionRejectionReason;
    readonly details: string;
  },
): RejectedRoleModelLoopResult {
  // Recorded here so no read path has to recover them by re-parsing raw output.
  const rejectedDecisionResult = createRejectedRoleModelDecisionResult(
    gate.reason,
    gate.details,
    {
      requestedToolNames:
        options.invokedRound.decisionResult.decision.toolCalls.map(
          call => call.name,
        ),
    },
  );
  const rejectedParsedDecisionSnapshot = createParsedRoleModelDecisionSnapshot({
    ...options.identity,
    sessionId: options.sessionId,
    result: rejectedDecisionResult,
  });

  return appendRejectedRoleModelLoopRound({
    state: options.state,
    invokedRound: {
      decisionResult: rejectedDecisionResult,
      inputEnvelope: options.invokedRound.inputEnvelope,
      ioSnapshot: options.invokedRound.ioSnapshot,
      parsedDecisionSnapshot: rejectedParsedDecisionSnapshot,
    },
    round: options.round,
  });
}

function terminalAcceptedRoleModelLoopResult(options: {
  readonly state: RoleModelLoopState;
  readonly invokedRound: AcceptedRoundView;
  readonly round: number;
}): AcceptedRoleModelLoopResult {
  const loopRound = createRoleModelLoopRound({
    pluginToolResults: [],
    inputEnvelope: options.invokedRound.inputEnvelope,
    ioSnapshot: options.invokedRound.ioSnapshot,
    parsedDecisionSnapshot: options.invokedRound.parsedDecisionSnapshot,
    round: options.round,
  });

  options.state.rounds.push(loopRound);

  const publicDecisionResult =
    options.invokedRound.parsedDecisionSnapshot.result;

  if (publicDecisionResult.status !== 'accepted') {
    throw new TypeError(
      'Accepted role-model execution decision must produce accepted public evidence.',
    );
  }

  return Object.freeze({
    status: 'accepted',
    inputEnvelope: options.invokedRound.inputEnvelope,
    ioSnapshot: options.invokedRound.ioSnapshot,
    parsedDecisionSnapshot: options.invokedRound.parsedDecisionSnapshot,
    decisionResult: publicDecisionResult,
    decision: publicDecisionResult.decision,
    pluginToolResults: Object.freeze([...options.state.allPluginToolResults]),
    rounds: Object.freeze([...options.state.rounds]),
  } satisfies AcceptedRoleModelLoopResult);
}

// Runs before anything is shown or committed; failures go back to the model.
function visibleReplyGateRejection(
  decisionResult: AcceptedRoleModelDecisionResult,
  isTerminalRound: boolean,
):
  | {
      readonly reason: RoleModelDecisionRejectionReason;
      readonly details: string;
    }
  | undefined {
  const visibleReplies = visibleReplyToolCalls(decisionResult.decision);

  if (visibleReplies.length === 0) {
    return isTerminalRound && decisionResult.nonCommittedText === undefined
      ? {
          reason: roleModelMalformedOutputRejectionReason,
          details: roleModelTerminalEmptyOutputRejectionDetails,
        }
      : undefined;
  }

  for (const visibleReply of visibleReplies) {
    const text = visibleReply.input['text'];

    try {
      normalizeVisibleMessageText(typeof text === 'string' ? text : undefined);
    } catch {
      return {
        reason: roleModelInvalidVisibleReplyRejectionReason,
        details: 'visible_reply text must not be empty.',
      };
    }
  }

  return undefined;
}
