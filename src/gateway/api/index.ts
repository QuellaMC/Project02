/**
 * The contract, as a client imports it: every shape that crosses the
 * socket, and nothing of the daemon behind it. This barrel value-imports
 * nothing (arch rule `clients-see-only-the-wire`).
 */
export {
  gatewayLoopbackHostnames,
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
  type GatewayReady,
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
  type TurnIdentity,
  type TurnOutcome,
  type Unsubscribe,
} from './contract.ts';
