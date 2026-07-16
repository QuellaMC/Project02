/**
 * Public API of src/core.
 *
 * Cross-module imports of core must land here (arch:check rule 5). The
 * conversation/message surfaces join this barrel in Slice 3 of the
 * migration plan; until then their existing deep imports stay baselined.
 */
export {
  assertCanonicalRuntimeTimestamp,
  createRuntimeEventIdentity,
  createRuntimeEventIdentitySnapshot,
  createUserMessageRuntimeEvent,
  RuntimeEventInputError,
  runtimeEventIdentityKey,
  runtimeEventTypeValues,
  type RuntimeEventIdentity,
  type RuntimeEventIdentityOptions,
  type RuntimeEventType,
  type UserMessageRuntimeEvent,
  type UserMessageRuntimeEventPayload
} from './message-event.ts';
