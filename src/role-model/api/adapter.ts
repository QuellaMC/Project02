import type {
  RoleModelDecisionRejection,
  RoleModelInputEnvelope,
  RoleModelProviderExchangeSnapshot,
  RoleModelProviderMetadata,
} from './contracts.ts';
import type {RoleModelTurnContext} from '../prompt/render.ts';
import type {ConversationTurn} from './conversation-history.ts';

export type RoleModelAdapterRawOutput = {
  readonly rawOutputText: string;
  readonly providerMetadata?: RoleModelProviderMetadata;
  readonly providerExchange?: RoleModelProviderExchangeSnapshot;
  readonly rejection?: RoleModelDecisionRejection;
  /**
   * For each visible reply of the decision, in order, the draft it was
   * spoken as: distinct draft numbers, one per reply. Absent — or not that
   * — draft n is reply n. A draft named here is replaced by its commit;
   * every other draft the adapter spoke, such as a note the model wrote
   * beside a tool call, is withdrawn. Never recorded.
   */
  readonly replyDrafts?: readonly number[];
};

export type RoleModelReplyDelta = {
  /** The adapter's number for the draft, in the order drafts begin. */
  readonly reply: number;
  /** The next piece of that draft, appended to what came before. */
  readonly text: string;
};

export type RoleModelAdapterInvocation = {
  readonly turnContext: RoleModelTurnContext;
  /** The prior turns the window replays, structured; the wire form is in turnContext. */
  readonly conversationHistory: readonly ConversationTurn[];
  /**
   * Hears the reply as the model writes it: a draft, synchronous, never
   * awaited. The whole output still arrives at the end, and it alone is
   * judged. Absent when no one listens.
   */
  readonly onReplyDelta?: (delta: RoleModelReplyDelta) => void;
};

export type RoleModelTextCompletionRequest = {
  readonly instructions: string;
  readonly input: string;
  readonly maxOutputChars: number;
};

export type RoleModelTextCompletionResult =
  | {
      readonly status: 'completed';
      readonly text: string;
      readonly provider: {readonly name: string; readonly model?: string};
    }
  | {readonly status: 'failed'; readonly reason: string};

export type RoleModelAdapter = {
  invoke(
    inputEnvelope: RoleModelInputEnvelope,
    invocation: RoleModelAdapterInvocation,
  ): Promise<RoleModelAdapterRawOutput> | RoleModelAdapterRawOutput;
  /**
   * A plain completion on the same model, no tools and no persona; the
   * runtime uses it to condense conversation. Absent when the provider has no
   * model to ask. Provider failures come back as a failed result, never a throw.
   */
  completeText?(
    request: RoleModelTextCompletionRequest,
  ): Promise<RoleModelTextCompletionResult>;
};

export function createRoleModelAdapterRawOutput(
  rawOutputText: string,
): RoleModelAdapterRawOutput {
  return Object.freeze({
    rawOutputText,
  } satisfies RoleModelAdapterRawOutput);
}
