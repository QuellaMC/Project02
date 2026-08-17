import {
  roleModelToolRoundsExhaustedRejectionReason,
  type AcceptedRoleModelDecisionResult,
  type CharacterDecision,
  type ParsedRoleModelDecisionSnapshot,
  type RejectedRoleModelDecisionResult,
  type RoleModelDecisionRejection,
  type ConversationToolRound,
  type RoleModelInputEnvelope,
  type RoleModelIOSnapshot,
} from '../api/contracts.ts';
import {createRejectedRoleModelDecisionResult} from '../api/decision.ts';
import {type ModelToolCall} from '../api/model-tools.ts';
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
  /** The parser's verdict on the last round; accepted when only the budget refused. */
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
  readonly rejection: RoleModelDecisionRejection;
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
  readonly rounds: readonly RoleModelLoopRound[];
};

export type RoleModelLoopResult =
  AcceptedRoleModelLoopResult | RejectedRoleModelLoopResult;

export type RoleModelLoopState = {
  readonly rounds: RoleModelLoopRound[];
  readonly allPluginToolResults: RoleModelPluginToolRoutingEvidence[];
  /** Executable rounds spent so far, against maxToolRounds. */
  spentRounds: number;
  /** This turn's finished tool rounds: the model sees them on its next round. */
  toolRounds: readonly ConversationToolRound[];
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
  readonly rejection: RoleModelDecisionRejection;
  readonly rounds: readonly RoleModelLoopRound[];
}): RejectedRoleModelLoopResult {
  return Object.freeze({
    status: 'rejected',
    inputEnvelope: options.inputEnvelope,
    ioSnapshot: options.ioSnapshot,
    parsedDecisionSnapshot: options.parsedDecisionSnapshot,
    rejection: options.rejection,
    pluginToolResults: Object.freeze([...options.pluginToolResults]),
    rounds: Object.freeze([...options.rounds]),
  } satisfies RejectedRoleModelLoopResult);
}

export function executionVisibleReplyTexts(
  decision: CharacterDecision,
): readonly string[] {
  return Object.freeze(
    visibleReplyToolCalls(decision).map(call => call.input.text),
  );
}

/**
 * The loop's one rule for a round the parser refused. When the model wrote
 * something, the refusal goes back to the model as part of its next round,
 * and what it does with that is its own business; the round counts like any
 * other. When no output arrived at all — the provider failed — there is
 * nothing to hand back, and the turn ends. Either way the round is on record.
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

  const rejection = invokedRound.decisionResult.rejection;

  if (!invokedRound.modelOutput || state.spentRounds >= options.maxToolRounds) {
    return createRejectedRoleModelLoopResult({
      pluginToolResults: state.allPluginToolResults,
      inputEnvelope: invokedRound.inputEnvelope,
      ioSnapshot: invokedRound.ioSnapshot,
      parsedDecisionSnapshot: invokedRound.parsedDecisionSnapshot,
      rejection,
      rounds: state.rounds,
    });
  }

  state.unusableReplyNote = unusableReplyNote(
    rejection.details ?? rejection.reason,
  );
  state.spentRounds += 1;

  return 'continue';
}

/**
 * An accepted round either ends the turn (no executable calls), goes on to
 * its tool calls, or — the loop's only refusal of its own — runs out of
 * rounds. The budget refusal leaves the parser's accepted verdict as it is;
 * it is what the runtime records against the commit.
 */
export function terminalRoleModelLoopResult(options: {
  readonly state: RoleModelLoopState;
  readonly invokedRound: AcceptedRoundView;
  readonly round: number;
  readonly maxToolRounds: number;
}): RoleModelLoopResult | undefined {
  if (options.invokedRound.executableToolCalls.length === 0) {
    return terminalAcceptedRoleModelLoopResult(options);
  }

  if (options.state.spentRounds < options.maxToolRounds) {
    return undefined;
  }

  options.state.rounds.push(
    createRoleModelLoopRound({
      pluginToolResults: [],
      inputEnvelope: options.invokedRound.inputEnvelope,
      ioSnapshot: options.invokedRound.ioSnapshot,
      parsedDecisionSnapshot: options.invokedRound.parsedDecisionSnapshot,
      round: options.round,
    }),
  );

  return createRejectedRoleModelLoopResult({
    pluginToolResults: options.state.allPluginToolResults,
    inputEnvelope: options.invokedRound.inputEnvelope,
    ioSnapshot: options.invokedRound.ioSnapshot,
    parsedDecisionSnapshot: options.invokedRound.parsedDecisionSnapshot,
    rejection: createRejectedRoleModelDecisionResult(
      roleModelToolRoundsExhaustedRejectionReason,
      `Role model exceeded maximum executable tool rounds (${String(options.maxToolRounds)}).`,
    ).rejection,
    rounds: options.state.rounds,
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
