import {
  roleModelToolRoundsExhaustedRejectionReason,
  type CharacterDecision,
  type RoleModelDecisionRejection,
  type ConversationToolRound,
} from '../api/contracts.ts';
import {createRejectedRoleModelDecisionResult} from '../api/decision.ts';
import {type ModelToolCall} from '../api/model-tools.ts';
import {unusableReplyNote} from '../prompt/prompt-text.ts';
import {visibleReplyToolCalls} from './decision-parser.ts';
import {type RoleModelPluginToolRoutingEvidence} from './routing-rejections.ts';

/** How a turn's model rounds ended; every round itself went out through onRound. */
export type AcceptedRoleModelLoopResult = {
  readonly status: 'accepted';
  readonly round: number;
  readonly decision: CharacterDecision;
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
};

export type RejectedRoleModelLoopResult = {
  readonly status: 'rejected';
  readonly round: number;
  readonly rejection: RoleModelDecisionRejection;
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
};

export type RoleModelLoopResult =
  AcceptedRoleModelLoopResult | RejectedRoleModelLoopResult;

export type RoleModelLoopState = {
  readonly allPluginToolResults: RoleModelPluginToolRoutingEvidence[];
  /** Executable rounds spent so far, against maxToolRounds. */
  spentRounds: number;
  /** This turn's finished tool rounds: the model sees them on its next round. */
  toolRounds: readonly ConversationToolRound[];
  /** What the runtime could not use of the last reply; shown to the model once, on its next round. */
  unusableReplyNote: string | undefined;
};

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
  readonly rejection: RoleModelDecisionRejection;
  /**
   * Whether the model wrote anything this round: a refused reply goes back to
   * the model, but nothing can go back when no output arrived at all.
   */
  readonly modelOutput: boolean;
  readonly round: number;
  readonly maxToolRounds: number;
}): RejectedRoleModelLoopResult | 'continue' {
  const {state, rejection} = options;

  if (!options.modelOutput || state.spentRounds >= options.maxToolRounds) {
    return Object.freeze({
      status: 'rejected',
      round: options.round,
      rejection,
      pluginToolResults: Object.freeze([...state.allPluginToolResults]),
    } satisfies RejectedRoleModelLoopResult);
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
  readonly decision: CharacterDecision;
  readonly executableToolCalls: readonly ModelToolCall[];
  readonly round: number;
  readonly maxToolRounds: number;
}): RoleModelLoopResult | undefined {
  const pluginToolResults = Object.freeze([
    ...options.state.allPluginToolResults,
  ]);

  if (options.executableToolCalls.length === 0) {
    return Object.freeze({
      status: 'accepted',
      round: options.round,
      decision: options.decision,
      pluginToolResults,
    } satisfies AcceptedRoleModelLoopResult);
  }

  if (options.state.spentRounds < options.maxToolRounds) {
    return undefined;
  }

  return Object.freeze({
    status: 'rejected',
    round: options.round,
    rejection: createRejectedRoleModelDecisionResult(
      roleModelToolRoundsExhaustedRejectionReason,
      `Role model exceeded maximum executable tool rounds (${String(options.maxToolRounds)}).`,
    ).rejection,
    pluginToolResults,
  } satisfies RejectedRoleModelLoopResult);
}
