/**
 * Cross-module imports of gateway land here; arch:check rule 5 accepts
 * first- and second-level barrels.
 */
export {createGateway, type CreateGatewayOptions} from './gateway.ts';
export {
  selectProject02CharacterId,
  type Project02CharacterSelection,
} from '../app/index.ts';
export {
  createLocalCharacterRuntime,
  type LocalCharacterRuntime,
  type LocalCharacterRuntimeOptions,
} from './runtime/character-runtime.ts';
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
