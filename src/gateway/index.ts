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
  createGatewayServer,
  type GatewayServer,
  type GatewayServerOptions,
} from './http/server.ts';
export {
  createLocalCharacterRuntime,
  type LocalCharacterRuntime,
  type LocalCharacterRuntimeOptions,
} from './runtime/character-runtime.ts';
export {
  gatewayProtocolVersion,
  type AnswerOutcome,
  type CharacterRuntime,
  type CharacterRuntimeHealth,
  type CharacterRuntimeState,
  type CharacterSummary,
  type ConfirmationAnswerStatus,
  type Gateway,
  type GatewayConfirmationDecision,
  type GatewayErrorBody,
  type GatewayEvent,
  type GatewayEventListener,
  type GatewayHealth,
  type GatewayMessage,
  type GatewayRefusalReason,
  type GatewayVisibleMessage,
  type HistoryMessage,
  type HistoryOutcome,
  type HistoryPage,
  type MaintenanceFailure,
  type OpenOutcome,
  type PendingConfirmation,
  type ReconcilePlan,
  type StartOutcome,
  type StorageFailure,
  type TurnOutcome,
  type Unsubscribe,
} from './api/contract.ts';
