import type {
  RoleModelDecisionRejection,
  RoleModelInputEnvelope,
  RoleModelProviderExchangeSnapshot,
  RoleModelProviderMetadata,
} from './contracts.ts';
import type {RoleModelAssistantChatMessage} from './chat-wire.ts';
import type {RoleModelTurnContext} from '../prompt/render.ts';
import type {ConversationTurn} from './conversation-history.ts';

export type RoleModelAdapterRawOutput = {
  readonly rawOutputText: string;
  readonly providerMetadata?: RoleModelProviderMetadata;
  readonly providerExchange?: RoleModelProviderExchangeSnapshot;
  readonly rejection?: RoleModelDecisionRejection;
  readonly nativeAssistantMessage?: RoleModelAssistantChatMessage;
};

export type RoleModelAdapterInvocation = {
  readonly turnContext: RoleModelTurnContext;
  /** The prior turns the window replays, structured; the wire form is in turnContext. */
  readonly conversationHistory: readonly ConversationTurn[];
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
