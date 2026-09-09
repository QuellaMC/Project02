import {createDeterministicLocalRoleModelAdapter} from '../providers/local.ts';
import {
  type RuntimeEventIdentity,
  type UserMessageRuntimeEvent,
  type VisibleMessage,
} from '../../core/index.ts';
import {
  type CharacterDecision,
  type ConversationToolCall,
  type DecisionContext,
  type ParsedRoleModelDecisionSnapshot,
  type RoleModelPluginToolDefinition,
  type RoleModelCharacterRef,
  type RoleModelDecisionRejection,
  type RoleModelIOSnapshot,
} from '../api/contracts.ts';
import {
  assertRoleModelCharacterRefMatchesCharacter,
  createParsedRoleModelDecisionSnapshot,
  createRoleModelInputEnvelope,
  createRoleModelIOSnapshot,
} from '../api/decision.ts';
import {
  executableModelToolCalls,
  parseRoleModelExecutionDecision,
} from './decision-parser.ts';
import {
  providerExchangeOption,
  providerMetadataOption,
  validateRoleModelAdapterRawOutput,
} from './adapter-raw-output.ts';
import {type RoleModelPluginToolRoutingEvidence} from './routing-rejections.ts';
import type {RoleModelAdapter} from '../api/adapter.ts';
import {type ModelToolCall} from '../api/model-tools.ts';
import {measureRoleModelPromptSize} from '../prompt/prompt-size.ts';
import {renderRoleModelTurnContext} from '../prompt/render.ts';
import {
  assertConversationHistoryMatchesWindow,
  createConversationToolRound,
  type ConversationTurn,
} from '../api/conversation-history.ts';
import {type RuntimePluginContext} from '../../plugins/api/index.ts';
import {
  createReplyDrafts,
  type ReplyDrafts,
  type RoleModelReplyDeltaEvent,
  type RoleModelReplyWithdrawnEvent,
} from './reply-drafts.ts';
import {
  routeExecutableToolCalls,
  type RoleModelPluginToolCallCompletedEvent,
  type RoleModelPluginToolCallStartedEvent,
  type RoleModelPluginToolHost,
} from './tool-routing.ts';

export type RunRoleModelLoopOptions = {
  readonly event: UserMessageRuntimeEvent;
  readonly decisionContext: DecisionContext;
  readonly adapter?: RoleModelAdapter;
  readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
  readonly pluginToolHost: RoleModelPluginToolHost;
  readonly maxToolRounds?: number;
  /**
   * Fires once per model round, accepted or refused, as soon as the output
   * is parsed and before anything is delivered or dispatched: the round is
   * on record before its consequences are. Only the reply's draft precedes
   * it, spoken through onReplyDelta while the model is still writing.
   */
  readonly onRound: (event: RoleModelRoundEvent) => Promise<void> | void;
  readonly onPluginToolCallStarted?: (
    event: RoleModelPluginToolCallStartedEvent,
  ) => Promise<void> | void;
  readonly onPluginToolCallCompleted?: (
    event: RoleModelPluginToolCallCompletedEvent,
  ) => Promise<void> | void;
  readonly onPluginToolCallsRequested?: (
    event: RoleModelPluginToolCallsRequestedEvent,
  ) => Promise<void> | void;
  /**
   * Fires for interim and terminal replies alike; required because an
   * undelivered reply is user-facing text lost. A rejected round delivers
   * nothing. Returns the message as committed: a tool round replays to the
   * model what the person was told.
   */
  readonly onVisibleReply: (
    event: RoleModelVisibleReplyEvent,
  ) => Promise<VisibleMessage> | VisibleMessage;
  /** Hears the reply as the model writes it: a draft, never a message. */
  readonly onReplyDelta?: (event: RoleModelReplyDeltaEvent) => void;
  /** A draft that ended with nothing said: no commit named it before the round moved on. */
  readonly onReplyWithdrawn?: (event: RoleModelReplyWithdrawnEvent) => void;
  readonly runtimePluginContext: RuntimePluginContext;
  readonly personaSections?: readonly string[];
  /** The person's name, when configured; the prompt then addresses them by it. */
  readonly userDisplayName?: string;
  /** The prior turns to replay; must be the turns the decision context names. */
  readonly conversationHistory?: readonly ConversationTurn[];
  readonly characterRef?: RoleModelCharacterRef;
};

export {type RoleModelPluginToolRoutingEvidence} from './routing-rejections.ts';
export {
  type RoleModelReplyDeltaEvent,
  type RoleModelReplyWithdrawnEvent,
} from './reply-drafts.ts';
export {
  type RoleModelPluginToolCallCompletedEvent,
  type RoleModelPluginToolCallStartedEvent,
  type RoleModelPluginToolHost,
} from './tool-routing.ts';

export type RoleModelRoundEvent = {
  readonly round: number;
  readonly ioSnapshot: RoleModelIOSnapshot;
  readonly parsedDecisionSnapshot: ParsedRoleModelDecisionSnapshot;
};

export type RoleModelVisibleReplyEvent = {
  readonly round: number;
  readonly text: string;
  /** The draft this reply replaces: the id its deltas carried, if any were spoken. */
  readonly draftId: string;
};

export type RoleModelPluginToolCallsRequestedEvent = {
  readonly round: number;
  readonly toolNames: readonly string[];
};

export {
  executionVisibleReplyTexts,
  settleRejectedRound,
  terminalRoleModelLoopResult,
  type AcceptedRoleModelLoopResult,
  type RejectedRoleModelLoopResult,
  type RoleModelLoopResult,
  type RoleModelLoopState,
} from './round-outcome.ts';
import {
  executionVisibleReplyTexts,
  settleRejectedRound,
  terminalRoleModelLoopResult,
  type RoleModelLoopResult,
  type RoleModelLoopState,
} from './round-outcome.ts';

export const defaultRoleModelMaxToolRounds = 99;

export async function runRoleModelLoop(
  options: RunRoleModelLoopOptions,
): Promise<RoleModelLoopResult> {
  // Checked again by the snapshot constructor; this keeps a bad ref off the wire.
  if (options.characterRef !== undefined) {
    assertRoleModelCharacterRefMatchesCharacter(
      options.characterRef,
      options.decisionContext.characterSnapshot,
    );
  }

  const conversationHistory = options.conversationHistory ?? [];
  assertConversationHistoryMatchesWindow(
    conversationHistory,
    options.decisionContext.historyWindow,
  );

  const adapter = options.adapter ?? createDeterministicLocalRoleModelAdapter();
  const maxToolRounds = normalizeMaxToolRounds(options.maxToolRounds);
  const identity = createSnapshotIdentity(options.event);
  const sessionId = options.decisionContext.sessionId;
  const state: RoleModelLoopState = {
    allPluginToolResults: [],
    spentRounds: 0,
    toolRounds: Object.freeze([]),
    unusableReplyNote: undefined,
  };

  for (let round = 1; ; round += 1) {
    // One ledger per round: every draft the round opens is settled by its
    // commit or withdrawn before the round moves on, whichever way it exits.
    const drafts = createReplyDrafts({
      round,
      ...(options.onReplyDelta === undefined
        ? {}
        : {onReplyDelta: options.onReplyDelta}),
      ...(options.onReplyWithdrawn === undefined
        ? {}
        : {onReplyWithdrawn: options.onReplyWithdrawn}),
    });

    try {
      const invokedRound = await invokeRoleModelLoopRound({
        options,
        adapter,
        identity,
        sessionId,
        round,
        state,
        drafts,
      });

      if (invokedRound.status === 'rejected') {
        const settled = settleRejectedRound({
          state,
          rejection: invokedRound.rejection,
          modelOutput: invokedRound.modelOutput,
          round,
          maxToolRounds,
        });

        if (settled === 'continue') {
          continue;
        }

        return settled;
      }

      const terminalResult = terminalRoleModelLoopResult({
        state,
        decision: invokedRound.decision,
        executableToolCalls: invokedRound.executableToolCalls,
        round,
        maxToolRounds,
      });

      if (terminalResult !== undefined) {
        if (terminalResult.status === 'accepted') {
          await deliverVisibleReply({
            options,
            round,
            decision: invokedRound.decision,
            drafts,
            ...(invokedRound.replyDrafts === undefined
              ? {}
              : {replyDrafts: invokedRound.replyDrafts}),
          });
        }

        return terminalResult;
      }

      const routed = await routeRoleModelLoopToolCalls({
        options,
        identity,
        invokedRound,
        round,
        drafts,
      });

      recordRoleModelLoopToolRound({
        state,
        invokedRound,
        ...routed,
        round,
      });
    } finally {
      drafts.close();
    }
  }
}

async function deliverVisibleReply(delivery: {
  readonly options: RunRoleModelLoopOptions;
  readonly round: number;
  readonly decision: CharacterDecision;
  readonly drafts: ReplyDrafts;
  /** The adapter's word on which draft each reply was spoken as; draft n is reply n without it. */
  readonly replyDrafts?: readonly number[];
}): Promise<readonly VisibleMessage[]> {
  const committed: VisibleMessage[] = [];

  for (const [reply, text] of executionVisibleReplyTexts(
    delivery.decision,
  ).entries()) {
    const draft = delivery.replyDrafts?.[reply] ?? reply;

    committed.push(
      await delivery.options.onVisibleReply({
        round: delivery.round,
        text,
        draftId: delivery.drafts.draftId(draft),
      }),
    );
    delivery.drafts.settle(draft);
  }

  // What the round drafted and did not commit ends here, before anything
  // else the round decided goes on.
  delivery.drafts.close();

  return Object.freeze(committed);
}

type InvokedRoleModelLoopRound =
  | {
      readonly status: 'rejected';
      readonly rejection: RoleModelDecisionRejection;
      /** Whether the model wrote anything: nothing can go back when no output arrived. */
      readonly modelOutput: boolean;
    }
  | {
      readonly status: 'accepted';
      readonly decision: CharacterDecision;
      readonly executableToolCalls: readonly ModelToolCall[];
      readonly pluginToolDefinitions: readonly RoleModelPluginToolDefinition[];
      readonly replyDrafts?: readonly number[];
    };

async function invokeRoleModelLoopRound(options: {
  readonly options: RunRoleModelLoopOptions;
  readonly adapter: RoleModelAdapter;
  readonly identity: RuntimeEventIdentity;
  readonly sessionId: string;
  readonly round: number;
  readonly state: RoleModelLoopState;
  readonly drafts: ReplyDrafts;
}): Promise<InvokedRoleModelLoopRound> {
  const inputEnvelope = createRoleModelInputEnvelope({
    event: options.options.event,
    decisionContext: options.options.decisionContext,
    pluginToolDefinitions: options.options.pluginToolDefinitions,
    toolRounds: options.state.toolRounds,
  });
  const conversationHistory = options.options.conversationHistory ?? [];
  // The note about an unusable reply rides exactly one round: the one the
  // model gets to respond to it in.
  const unusableReplyNote = options.state.unusableReplyNote;

  options.state.unusableReplyNote = undefined;
  const turnContext = renderRoleModelTurnContext(inputEnvelope, {
    ...(unusableReplyNote === undefined ? {} : {unusableReplyNote}),
    conversationHistory,
    ...(options.options.personaSections === undefined
      ? {}
      : {personaSections: options.options.personaSections}),
    ...(options.options.userDisplayName === undefined
      ? {}
      : {userDisplayName: options.options.userDisplayName}),
  });
  const rawOutput: unknown = await options.adapter.invoke(inputEnvelope, {
    turnContext,
    conversationHistory,
    onReplyDelta: delta => {
      options.drafts.speak(delta);
    },
  });
  const rawOutputValidation = validateRoleModelAdapterRawOutput(rawOutput);
  const ioSnapshot = createRoleModelIOSnapshot({
    ...options.identity,
    sessionId: options.sessionId,
    inputEnvelope,
    rawOutputText: rawOutputValidation.rawOutputText,
    ...(options.options.characterRef === undefined
      ? {}
      : {characterRef: options.options.characterRef}),
    promptSize: measureRoleModelPromptSize(turnContext),
    ...providerMetadataOption(rawOutputValidation.providerMetadata),
    ...providerExchangeOption(rawOutputValidation.providerExchange),
  });
  const decisionResult =
    rawOutputValidation.status === 'accepted'
      ? parseRoleModelExecutionDecision(rawOutputValidation.rawOutputText)
      : rawOutputValidation.decisionResult;
  const parsedDecisionSnapshot = createParsedRoleModelDecisionSnapshot({
    ...options.identity,
    sessionId: options.sessionId,
    result: decisionResult,
  });

  await options.options.onRound({
    round: options.round,
    ioSnapshot,
    parsedDecisionSnapshot,
  });

  if (decisionResult.status === 'rejected') {
    return {
      status: 'rejected',
      rejection: decisionResult.rejection,
      modelOutput: rawOutputValidation.rawOutputText.length > 0,
    };
  }

  const replyDrafts = replyDraftsFor(
    decisionResult.decision,
    rawOutputValidation.replyDrafts,
  );

  return {
    status: 'accepted',
    decision: decisionResult.decision,
    executableToolCalls: executableModelToolCalls(
      decisionResult.decision.toolCalls,
    ),
    pluginToolDefinitions: inputEnvelope.pluginToolDefinitions,
    ...(replyDrafts === undefined ? {} : {replyDrafts}),
  };
}

/**
 * The adapter's mapping counts only when it names a draft for every visible
 * reply: a shorter one would leave a reply to fall back on a number the
 * mapping may already have given away.
 */
function replyDraftsFor(
  decision: CharacterDecision,
  replyDrafts: readonly number[] | undefined,
): readonly number[] | undefined {
  return replyDrafts !== undefined &&
    replyDrafts.length === executionVisibleReplyTexts(decision).length
    ? replyDrafts
    : undefined;
}

async function routeRoleModelLoopToolCalls(options: {
  readonly options: RunRoleModelLoopOptions;
  readonly identity: RuntimeEventIdentity;
  readonly invokedRound: Extract<
    InvokedRoleModelLoopRound,
    {status: 'accepted'}
  >;
  readonly round: number;
  readonly drafts: ReplyDrafts;
}): Promise<{
  readonly interimReplies: readonly VisibleMessage[];
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
}> {
  const interimReplies = await deliverVisibleReply({
    options: options.options,
    round: options.round,
    decision: options.invokedRound.decision,
    drafts: options.drafts,
    ...(options.invokedRound.replyDrafts === undefined
      ? {}
      : {replyDrafts: options.invokedRound.replyDrafts}),
  });

  await options.options.onPluginToolCallsRequested?.({
    round: options.round,
    toolNames: options.invokedRound.executableToolCalls.map(call => call.name),
  });

  const pluginToolResults = await routeExecutableToolCalls({
    toolCalls: options.invokedRound.executableToolCalls,
    identity: options.identity,
    pluginToolDefinitions: options.invokedRound.pluginToolDefinitions,
    round: options.round,
    ...(options.options.onPluginToolCallStarted === undefined
      ? {}
      : {onPluginToolCallStarted: options.options.onPluginToolCallStarted}),
    ...(options.options.onPluginToolCallCompleted === undefined
      ? {}
      : {onPluginToolCallCompleted: options.options.onPluginToolCallCompleted}),
    pluginToolHost: options.options.pluginToolHost,
    runtimePluginContext: options.options.runtimePluginContext,
  });

  return {interimReplies, pluginToolResults};
}

function recordRoleModelLoopToolRound(options: {
  readonly state: RoleModelLoopState;
  readonly invokedRound: Extract<
    InvokedRoleModelLoopRound,
    {status: 'accepted'}
  >;
  readonly interimReplies: readonly VisibleMessage[];
  readonly pluginToolResults: readonly RoleModelPluginToolRoutingEvidence[];
  readonly round: number;
}): void {
  const {decision} = options.invokedRound;

  options.state.allPluginToolResults.push(...options.pluginToolResults);
  options.state.spentRounds += 1;
  options.state.toolRounds = Object.freeze([
    ...options.state.toolRounds,
    createConversationToolRound({
      round: options.round,
      ...(decision.text === undefined ? {} : {text: decision.text}),
      interimReplies: options.interimReplies,
      toolCalls: options.pluginToolResults.map(conversationToolCallFromRouting),
    }),
  ]);
}

function normalizeMaxToolRounds(value: number | undefined): number {
  const maxToolRounds = value ?? defaultRoleModelMaxToolRounds;

  if (!Number.isSafeInteger(maxToolRounds) || maxToolRounds < 0) {
    throw new TypeError('maxToolRounds must be a non-negative safe integer.');
  }

  return maxToolRounds;
}

function conversationToolCallFromRouting(
  routing: RoleModelPluginToolRoutingEvidence,
): ConversationToolCall {
  return {
    toolCallId: routing.callId,
    pluginId: routing.call.pluginId,
    toolName: routing.call.toolName,
    input: routing.call.input,
    result:
      routing.result.status === 'accepted'
        ? {status: 'accepted', output: routing.result.output}
        : {
            status: 'rejected',
            reason: routing.result.reason,
            message: routing.result.message,
          },
  };
}

function createSnapshotIdentity(
  event: UserMessageRuntimeEvent,
): RuntimeEventIdentity {
  return Object.freeze({
    eventId: event.eventId,
    traceId: event.traceId,
    createdAt: event.createdAt,
  } satisfies RuntimeEventIdentity);
}
