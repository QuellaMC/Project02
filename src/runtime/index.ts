/**
 * Cross-module imports of runtime land here or on the submodule barrels;
 * arch:check rule 5 accepts both levels.
 */
export {
  deliverUserMessage,
  endSession,
  exitCommand,
  openConversation,
  type ActiveConversation,
  type DeliverUserMessageOptions,
  type OpenConversationOptions,
  type SegmentRotation,
  type UserMessageDelivery,
} from './conversation/index.ts';
export {
  recordLocalUserMessageInputRejection,
  runLocalUserMessageEvent,
  type LocalRuntimeTurnProgressEvent,
  type LocalRuntimeUserMessageInputRejectedResult,
  type LocalRuntimeUserMessageRejectionReason,
  type LocalRuntimeUserMessageResult,
} from './turn/local.ts';
export type {
  RawEventLogRecord,
  RuntimeTraceEntry,
  SessionContinuationSnapshot,
} from './evidence/records.ts';
export type {RuntimeLogStore} from './evidence/contract.ts';
