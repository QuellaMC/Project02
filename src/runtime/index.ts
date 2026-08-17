/**
 * Cross-module imports of runtime land here or on the submodule barrels;
 * arch:check rule 5 accepts both levels.
 */
export {
  recordLocalUserMessageInputRejection,
  runLocalUserMessageEvent,
  type LocalRuntimeTurnProgressEvent,
  type LocalRuntimeUserMessageInputRejectedResult,
  type LocalRuntimeUserMessageResult,
} from './turn/local.ts';
export type {
  RawEventLogRecord,
  RuntimeTraceEntry,
  SessionContinuationSnapshot,
} from './evidence/records.ts';
export type {RuntimeLogStore} from './evidence/contract.ts';
