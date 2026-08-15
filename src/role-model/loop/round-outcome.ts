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
import {type RoleModelChatMessage} from '../api/chat-wire.ts';
import {unusableReplyNote} from '../prompt/prompt-text.ts';
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
  /** What the runtime could not use of the last reply; shown to the model once, on its next round. */
  unusableReplyNote: string | undefined;
};

type AcceptedRoundView = {
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: AcceptedRoleModelDecisionResult;
  readonly executableToolCalls: readonly ModelToolCall[];
};

type RejectedRoundView = {
  readonly inputEnvelope: RoleModelInputEnvelope;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly decisionResult: RejectedRoleModelDecisionResult;
  /**
   * Whether the model wrote anything this round: a refused reply goes back to
   * the model, but nothing can go back when no output arrived at all.
   */
  readonly modelOutput: boolean;
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

/**
 * The loop's one rule for a round it cannot use. When the model wrote
 * something the runtime refuses — whether the parser, the loop, or the
 * adapter refused it — the error goes back to the model as part of its next
 * round, and what it does with that is its own business; the round counts
 * like any other. When no output arrived at all — the adapter failed, the
 * provider failed — there is nothing to hand back, and the turn ends. Either
 * way the round is on record.
 */
export function settleRejectedRound(options: {
  readonly state: RoleModelLoopState;
  readonly invokedRound: RejectedRoundView;
  readonly round: number;
  readonly maxToolRounds: number;
}): RejectedRoleModelLoopResult | 'continue' {
  const {state, invokedRound} = options;

  state.rounds.push(
    createRoleModelLoopRound({
      pluginToolResults: [],
      inputEnvelope: invokedRound.inputEnvelope,
      ioSnapshot: invokedRound.ioSnapshot,
      parsedDecisionSnapshot: invokedRound.parsedDecisionSnapshot,
      round: options.round,
    }),
  );

  if (!invokedRound.modelOutput || state.toolRounds >= options.maxToolRounds) {
    return createRejectedRoleModelLoopResult({
      pluginToolResults: state.allPluginToolResults,
      inputEnvelope: invokedRound.inputEnvelope,
      ioSnapshot: invokedRound.ioSnapshot,
      parsedDecisionSnapshot: invokedRound.parsedDecisionSnapshot,
      rounds: state.rounds,
    });
  }

  const rejection = invokedRound.decisionResult.rejection;

  state.unusableReplyNote = unusableReplyNote(
    rejection.details ?? rejection.reason,
  );
  state.toolRounds += 1;

  return 'continue';
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
    return settleRejectedRound({
      state: options.state,
      invokedRound: rejectedRoundView(options, gate),
      round: options.round,
      maxToolRounds: options.maxToolRounds,
    });
  }

  if (isTerminalRound) {
    return terminalAcceptedRoleModelLoopResult(options);
  }

  if (options.state.toolRounds < options.maxToolRounds) {
    return undefined;
  }

  return settleRejectedRound({
    state: options.state,
    invokedRound: rejectedRoundView(
      options,
      createRejectedRoleModelDecisionResult(
        roleModelPluginToolRejectedRejectionReason,
        `Role model exceeded maximum executable tool rounds (${String(options.maxToolRounds)}).`,
        {
          requestedToolNames:
            options.invokedRound.decisionResult.decision.toolCalls.map(
              call => call.name,
            ),
        },
      ),
    ),
    round: options.round,
    maxToolRounds: options.maxToolRounds,
  });
}

/**
 * A round the parser accepted but the loop refuses is recorded as refused,
 * so evidence reads the way the model was treated.
 */
function rejectedRoundView(
  options: {
    readonly invokedRound: AcceptedRoundView;
    readonly identity: RuntimeEventIdentity;
    readonly sessionId: string;
  },
  decisionResult: RejectedRoleModelDecisionResult,
): RejectedRoundView {
  return {
    decisionResult,
    inputEnvelope: options.invokedRound.inputEnvelope,
    ioSnapshot: options.invokedRound.ioSnapshot,
    parsedDecisionSnapshot: createParsedRoleModelDecisionSnapshot({
      ...options.identity,
      sessionId: options.sessionId,
      result: decisionResult,
    }),
    modelOutput: true,
  };
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
): RejectedRoleModelDecisionResult | undefined {
  const visibleReplies = visibleReplyToolCalls(decisionResult.decision);
  const requestedToolNames = decisionResult.decision.toolCalls.map(
    call => call.name,
  );

  if (visibleReplies.length === 0) {
    return isTerminalRound && decisionResult.nonCommittedText === undefined
      ? createRejectedRoleModelDecisionResult(
          roleModelMalformedOutputRejectionReason,
          roleModelTerminalEmptyOutputRejectionDetails,
          {requestedToolNames},
        )
      : undefined;
  }

  for (const visibleReply of visibleReplies) {
    const text = visibleReply.input['text'];

    try {
      normalizeVisibleMessageText(typeof text === 'string' ? text : undefined);
    } catch {
      return createRejectedRoleModelDecisionResult(
        roleModelInvalidVisibleReplyRejectionReason,
        'visible_reply text must not be empty.',
        {requestedToolNames},
      );
    }
  }

  return undefined;
}
