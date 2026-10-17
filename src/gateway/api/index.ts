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
  type ConfigChange,
  type ConfigChangeOutcome,
  type ConfigTarget,
  type ConfigView,
  type ConfirmationAnswerStatus,
  type ConfirmationCancelReason,
  type ConfirmationSettlement,
  type ConnectorConfigEntry,
  type ConnectorConfigView,
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
  type RunningDraft,
  type RunningTurn,
  type StartOutcome,
  type StorageFailure,
  type TurnIdentity,
  turnCommittedTheLine,
  type TurnOutcome,
  type Unsubscribe,
} from './contract.ts';
export {foldRunningTurns, type RunningTurns} from './running-turns.ts';
export type {
  RuntimeConfigDiagnostic,
  RuntimeConfigFieldInspectShape,
  RuntimeConfigSectionActivationShape,
  RuntimeConfigSectionInspectShape,
  RuntimeConfigSectionNamespace,
  RuntimeConfigValue,
} from '../../runtime/config/index.ts';
/** What `<home>/daemon.json` holds, for a reader that finds the daemon by it. */
export type {DaemonRecord} from '../../shared/daemon-record.ts';
