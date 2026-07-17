/**
 * Public API of src/runtime.
 *
 * Cross-module imports of runtime land here or on the submodule barrels
 * (config/, storage/, evidence/, turn/ each expose their own index.ts —
 * arch:check rule 5 accepts both levels). This barrel carries the
 * root-level surface: the local turn entrypoint and the evidence record
 * contract.
 */
export {
  recordLocalUserMessageInputRejection,
  runLocalUserMessageEvent,
  type LocalRuntimeTurnProgressEvent,
  type LocalRuntimeUserMessageInputRejectedResult,
  type LocalRuntimeUserMessageResult
} from './turn/local.ts';
export {
  createRoleModelCommitValidationSnapshot,
  isTerminalRawEventLogRecord,
  isTerminalRawEventLogRecordKind,
  rawEventLogRecordKindValues,
  runtimeTraceStepValues,
  runtimeTurnStatusValues,
  type ConversationLogRecord,
  type ConversationLogRecordInput,
  type RawEventLogPayloadSummary,
  type RawEventLogRecord,
  type RawEventLogRecordInput,
  type RawEventLogRecordKind,
  type RoleModelCommitValidationResult,
  type RoleModelCommitValidationSnapshot,
  type RuntimeDerivedSessionEvidence,
  type RuntimeDerivedTraceEntry,
  type RuntimeLogStore,
  type RuntimeSessionEvidenceSnapshot,
  type RuntimeStoredSessionEvidence,
  type RuntimeTraceEntry,
  type RuntimeTraceEntryInput,
  type RuntimeTraceStepName,
  type RuntimeTurnStatus
} from './evidence/records.ts';
