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
  readonly nativeToolCallArgumentErrors?: readonly RoleModelNativeToolCallArgumentError[];
};

export type RoleModelNativeToolCallArgumentError = {
  readonly executableIndex: number;
  readonly toolName: string;
  readonly reason: string;
  readonly message: string;
};

export type RoleModelAdapterInvocation = {
  readonly turnContext: RoleModelTurnContext;
  /** The prior turns the window replays, structured; the wire form is in turnContext. */
  readonly conversationHistory: readonly ConversationTurn[];
};

export type RoleModelAdapter = {
  invoke(
    inputEnvelope: RoleModelInputEnvelope,
    invocation: RoleModelAdapterInvocation,
  ): Promise<RoleModelAdapterRawOutput> | RoleModelAdapterRawOutput;
};

export function createRoleModelAdapterRawOutput(
  rawOutputText: string,
): RoleModelAdapterRawOutput {
  return Object.freeze({
    rawOutputText,
  } satisfies RoleModelAdapterRawOutput);
}
