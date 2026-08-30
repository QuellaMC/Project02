/**
 * Cross-module imports of gateway land here; arch:check rule 5 accepts
 * first- and second-level barrels.
 */
export type {
  CharacterRuntime,
  CharacterRuntimeHealth,
  CharacterRuntimeState,
  CharacterSummary,
  ConversationRef,
  Gateway,
  GatewayConfirmationDecision,
  GatewayEvent,
  GatewayEventListener,
  GatewayMessage,
  GatewayRefusalReason,
  GatewayVisibleMessage,
  TurnOutcome,
  Unsubscribe,
} from './api/contract.ts';
