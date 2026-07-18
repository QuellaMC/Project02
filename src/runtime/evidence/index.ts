/**
 * Public API of the runtime evidence module: the durable-evidence
 * transition machine, validation/recovery/cache over persisted session
 * evidence, and the in-memory RuntimeLogStore. Cross-module imports land
 * here (arch:check rule 5); runtime-internal files may import deeper.
 */
export {createRuntimeLogStore} from './memory-store.ts';
export {
  createRuntimeSessionEvidenceSnapshot,
  recoverAbandonedRuntimeWriterEvidence,
} from './recovery.ts';
export {
  createTraceSummary,
  sameTraceIdentity,
  terminalDecisionEvidenceRawEvent,
  type ChatTraceProviderSummary,
  type ChatTraceSummary,
  type TraceIdentity,
} from './trace-summary.ts';
export {createTurnEvidence} from './turn-projection.ts';
export {type InspectTurnEvidence} from './turn-projection-contract.ts';
