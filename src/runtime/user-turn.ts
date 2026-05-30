import {
  commitLifeIncidentCancel,
  LIFE_INCIDENT_CANCEL_REJECTED_STATUS,
  type LifeIncidentCancelCommitResult,
  type LifeIncidentCancelFinalizer
} from '../commit-effects/incident-cancel.ts';
import {
  commitLifeIncidentComplete,
  LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
  type LifeIncidentCompleteCommitResult,
  type LifeIncidentCompleteFinalizer
} from '../commit-effects/incident-complete.ts';
import {
  commitLifeIncidentInterruption,
  LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS,
  LIFE_INCIDENT_INTERRUPTED_STATUS,
  LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS,
  LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS,
  LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS,
  type LifeIncidentInterruptCommitResult,
  type LifeIncidentInterruptFinalizer
} from '../commit-effects/incident-interrupt.ts';
import {
  commitLifeIncidentStart,
  LIFE_INCIDENT_START_REJECTED_STATUS,
  type LifeIncidentStartCommitResult,
  type LifeIncidentStartFinalizer
} from '../commit-effects/incident-start.ts';
import {
  commitLivingStatePatch,
  LIVING_STATE_PATCH_REJECTED_STATUS,
  type LivingStatePatchCommitResult,
  type LivingStatePatchFinalizer,
  type LivingStatePatchStore
} from '../commit-effects/living-state.ts';
import {
  commitUserVisibleMessage,
  commitVisibleReply,
  USER_VISIBLE_MESSAGE_COMMITTED_STATUS,
  VISIBLE_REPLY_COMMITTED_STATUS,
  type UserVisibleMessageCommitResult,
  type UserVisibleMessageRejectResult,
  type VisibleConversationLog,
  type VisibleReplyCommitResult,
  type VisibleReplyRejectResult
} from '../commit-effects/visible-reply.ts';
import {
  VisibleConversationRecentMessagesSource,
  type VisibleConversationRecordSource
} from '../character/state/context.ts';
import {
  type ActiveIncidentSnapshot,
  type ActiveIncidentSource,
  type CurrentCharacterStateSource,
  type InterruptedIncidentSnapshot,
  type InterruptedIncidentSource
} from '../character/state/current.ts';
import {
  runRoleModelTurn,
  type RoleModelAdapter,
  type RoleModelTurnResult
} from '../role-model/loop.ts';
import { USER_MESSAGE } from './contracts.ts';
import {
  RuntimeValidationError,
  intakeRuntimeEvent,
  type RuntimeRouteResult
} from './kernel.ts';
import { SCHEMA_VERSION, type SchemaVersion } from './schema.ts';
import type { Clock, IdGenerator, RawEventLogEntry } from './logging.ts';

export const USER_TURN_COMMITTED_STATUS = 'user_turn_committed';
export const USER_TURN_STOPPED_STATUS = 'user_turn_stopped';
export const USER_TURN_PREFLIGHT_STOP = 'user_turn_preflight';
export const USER_VISIBLE_MESSAGE_COMMIT_STOP = 'user_visible_message_commit';
export const LIVING_STATE_PATCH_COMMIT_STOP = 'living_state_patch_commit';
export const LIFE_INCIDENT_START_COMMIT_STOP = 'life_incident_start_commit';
export const LIFE_INCIDENT_CANCEL_COMMIT_STOP = 'life_incident_cancel_commit';
export const LIFE_INCIDENT_COMPLETE_COMMIT_STOP = 'life_incident_complete_commit';
export const LIFE_INCIDENT_INTERRUPT_COMMIT_STOP = 'life_incident_interrupt_commit';
export const VISIBLE_REPLY_COMMIT_STOP = 'visible_reply_commit';
export const USER_TURN_NEXT_STEP = 'user_turn';
export const CONFLICTING_WRITE_ACTION_OPT_IN_CODE = 'conflicting_write_action_opt_in';
export const MISSING_INCIDENT_CANCEL_SOURCE_CODE = 'missing_incident_cancel_source';
export const MISSING_INCIDENT_COMPLETE_SOURCE_CODE = 'missing_incident_complete_source';
export const MISSING_INCIDENT_INTERRUPT_SOURCE_CODE = 'missing_incident_interrupt_source';

const WRITE_ACTION_OPT_IN_CONFLICT_MESSAGE =
  'Only one write-action opt-in may be enabled for a USER_MESSAGE turn: ' +
  'state_patch, start_incident, cancel_incident, complete_incident, or interrupt_incident.';

type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export type VisibleConversationBoundary = VisibleConversationLog &
  VisibleConversationRecordSource;

type UserTurnFailure = {
  stage: string;
  code: string;
  message: string;
};

type UserMessageTurnBase = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
};

export type UserMessageTurnCommittedResult = UserMessageTurnBase & {
  status: typeof USER_TURN_COMMITTED_STATUS;
  kernel_route: RuntimeRouteResult;
  user_visible_message_result: UserVisibleMessageCommitResult;
  role_model_result: RoleModelTurnResult;
  visible_reply_result: VisibleReplyCommitResult;
  visible_record_ids: {
    user_message_id: string;
    assistant_output_id: string;
  };
  living_state_patch_result?: LivingStatePatchCommitResult;
  life_incident_interrupt_result?: LifeIncidentInterruptCommitResult;
  life_incident_start_result?: LifeIncidentStartCommitResult;
  life_incident_cancel_result?: LifeIncidentCancelCommitResult;
  life_incident_complete_result?: LifeIncidentCompleteCommitResult;
};

export type UserMessageTurnStoppedResult = UserMessageTurnBase & {
  status: typeof USER_TURN_STOPPED_STATUS;
  stopped_at: string;
  kernel_route: RuntimeRouteResult;
  failure: UserTurnFailure;
  user_visible_message_result?: UserVisibleMessageCommitResult | UserVisibleMessageRejectResult;
  role_model_result?: RoleModelTurnResult;
  life_incident_interrupt_result?: LifeIncidentInterruptCommitResult;
  living_state_patch_result?: LivingStatePatchCommitResult;
  life_incident_start_result?: LifeIncidentStartCommitResult;
  life_incident_cancel_result?: LifeIncidentCancelCommitResult;
  life_incident_complete_result?: LifeIncidentCompleteCommitResult;
  visible_reply_result?: VisibleReplyCommitResult | VisibleReplyRejectResult;
};

export type UserMessageTurnResult =
  | UserMessageTurnCommittedResult
  | UserMessageTurnStoppedResult;

export type RunUserMessageTurnOptions = {
  adapter: RoleModelAdapter;
  rawEventLog: RawEventLog;
  visibleConversation: VisibleConversationBoundary;
  idGenerator: IdGenerator;
  clock: Clock;
  currentStateSource?: CurrentCharacterStateSource;
  activeIncidentSource?: ActiveIncidentSource;
  interruptedIncidentSource?: InterruptedIncidentSource;
  livingStatePatchStore?: LivingStatePatchStore;
  livingStatePatchFinalizer?: LivingStatePatchFinalizer;
  lifeIncidentStartFinalizer?: LifeIncidentStartFinalizer;
  lifeIncidentCancelFinalizer?: LifeIncidentCancelFinalizer;
  lifeIncidentCompleteFinalizer?: LifeIncidentCompleteFinalizer;
  lifeIncidentInterruptFinalizer?: LifeIncidentInterruptFinalizer;
};

export function runUserMessageTurn(
  eventInput: unknown,
  {
    adapter,
    rawEventLog,
    visibleConversation,
    idGenerator,
    clock,
    currentStateSource,
    activeIncidentSource,
    interruptedIncidentSource,
    livingStatePatchStore,
    livingStatePatchFinalizer,
    lifeIncidentStartFinalizer,
    lifeIncidentCancelFinalizer,
    lifeIncidentCompleteFinalizer,
    lifeIncidentInterruptFinalizer
  }: RunUserMessageTurnOptions
): UserMessageTurnResult {
  const intakeResult = intakeRuntimeEvent(eventInput, {
    rawEventLog,
    idGenerator,
    clock
  });
  const event = intakeResult.event;
  const route = intakeResult.route;
  requireUserTurnRoute(route);

  const allowStatePatch =
    currentStateSource !== undefined &&
    livingStatePatchStore !== undefined &&
    livingStatePatchFinalizer !== undefined;
  const allowIncidentStart = lifeIncidentStartFinalizer !== undefined;
  const allowIncidentCancel = lifeIncidentCancelFinalizer !== undefined;
  const allowIncidentComplete = lifeIncidentCompleteFinalizer !== undefined;
  const allowIncidentInterrupt = lifeIncidentInterruptFinalizer !== undefined;

  const writeActionOptInCount = [
    allowStatePatch,
    allowIncidentStart,
    allowIncidentCancel,
    allowIncidentComplete,
    allowIncidentInterrupt
  ].filter(Boolean).length;
  if (writeActionOptInCount > 1) {
    return buildStoppedResult(event, route, {
      stoppedAt: USER_TURN_PREFLIGHT_STOP,
      failure: {
        stage: USER_TURN_PREFLIGHT_STOP,
        code: CONFLICTING_WRITE_ACTION_OPT_IN_CODE,
        message: WRITE_ACTION_OPT_IN_CONFLICT_MESSAGE
      }
    });
  }
  if (allowIncidentComplete && activeIncidentSource === undefined) {
    return buildStoppedResult(event, route, {
      stoppedAt: USER_TURN_PREFLIGHT_STOP,
      failure: {
        stage: USER_TURN_PREFLIGHT_STOP,
        code: MISSING_INCIDENT_COMPLETE_SOURCE_CODE,
        message: 'incident complete requires active_incident_source.'
      }
    });
  }
  if (allowIncidentCancel && activeIncidentSource === undefined) {
    return buildStoppedResult(event, route, {
      stoppedAt: USER_TURN_PREFLIGHT_STOP,
      failure: {
        stage: USER_TURN_PREFLIGHT_STOP,
        code: MISSING_INCIDENT_CANCEL_SOURCE_CODE,
        message: 'incident cancel requires active_incident_source.'
      }
    });
  }
  if (allowIncidentInterrupt && activeIncidentSource === undefined) {
    return buildStoppedResult(event, route, {
      stoppedAt: USER_TURN_PREFLIGHT_STOP,
      failure: {
        stage: USER_TURN_PREFLIGHT_STOP,
        code: MISSING_INCIDENT_INTERRUPT_SOURCE_CODE,
        message: 'incident interrupt requires active_incident_source.'
      }
    });
  }

  const userVisibleMessageResult = commitUserVisibleMessage(event, {
    visibleConversationLog: visibleConversation,
    rawEventLog,
    idGenerator,
    clock
  });
  if (userVisibleMessageResult.status !== USER_VISIBLE_MESSAGE_COMMITTED_STATUS) {
    return buildStoppedResult(event, route, {
      stoppedAt: USER_VISIBLE_MESSAGE_COMMIT_STOP,
      failure: userVisibleMessageResult.failure,
      userVisibleMessageResult
    });
  }

  let lifeIncidentInterruptResult: LifeIncidentInterruptCommitResult | undefined;
  if (allowIncidentInterrupt) {
    const requiredActiveIncidentSource = requireConfiguredDependency(
      activeIncidentSource,
      'incident interrupt preflight failed unexpectedly.'
    );
    lifeIncidentInterruptResult = commitLifeIncidentInterruption(event, {
      activeIncidentSource: requiredActiveIncidentSource,
      lifeIncidentInterruptFinalizer,
      rawEventLog,
      idGenerator,
      clock
    });
    if (lifeIncidentInterruptResult.status === LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS) {
      return buildStoppedResult(event, route, {
        stoppedAt: LIFE_INCIDENT_INTERRUPT_COMMIT_STOP,
        failure: lifeIncidentInterruptResult.failure,
        userVisibleMessageResult,
        lifeIncidentInterruptResult
      });
    }
  }

  const contextSources = buildContextIncidentSources({
    allowIncidentInterrupt,
    interruptResult: lifeIncidentInterruptResult,
    activeIncidentSource,
    interruptedIncidentSource
  });

  const roleModelOptions: Parameters<typeof runRoleModelTurn>[1] = {
    adapter,
    rawEventLog,
    idGenerator,
    clock,
    recentVisibleMessagesSource: new VisibleConversationRecentMessagesSource(
      visibleConversation
    ),
    allowStatePatch,
    allowIncidentStart,
    allowIncidentCancel,
    allowIncidentComplete
  };
  if (currentStateSource !== undefined) {
    roleModelOptions.currentStateSource = currentStateSource;
  }
  if (contextSources.activeIncidentSource !== undefined) {
    roleModelOptions.activeIncidentSource = contextSources.activeIncidentSource;
  }
  if (contextSources.interruptedIncidentSource !== undefined) {
    roleModelOptions.interruptedIncidentSource = contextSources.interruptedIncidentSource;
  }
  const roleModelResult = runRoleModelTurn(event, roleModelOptions);

  let livingStatePatchResult: LivingStatePatchCommitResult | undefined;
  if (allowStatePatch) {
    livingStatePatchResult = commitLivingStatePatch(event, roleModelResult, {
      livingStatePatchStore,
      livingStatePatchFinalizer,
      rawEventLog,
      idGenerator,
      clock
    });
    if (livingStatePatchResult.status === LIVING_STATE_PATCH_REJECTED_STATUS) {
      return buildStoppedResult(event, route, {
        stoppedAt: LIVING_STATE_PATCH_COMMIT_STOP,
        failure: livingStatePatchResult.failure,
        userVisibleMessageResult,
        roleModelResult,
        lifeIncidentInterruptResult,
        livingStatePatchResult
      });
    }
  }

  let lifeIncidentStartResult: LifeIncidentStartCommitResult | undefined;
  let lifeIncidentCancelResult: LifeIncidentCancelCommitResult | undefined;
  let lifeIncidentCompleteResult: LifeIncidentCompleteCommitResult | undefined;
  if (allowIncidentStart) {
    lifeIncidentStartResult = commitLifeIncidentStart(event, roleModelResult, {
      lifeIncidentStartFinalizer,
      rawEventLog,
      idGenerator,
      clock
    });
    if (lifeIncidentStartResult.status === LIFE_INCIDENT_START_REJECTED_STATUS) {
      return buildStoppedResult(event, route, {
        stoppedAt: LIFE_INCIDENT_START_COMMIT_STOP,
        failure: lifeIncidentStartResult.failure,
        userVisibleMessageResult,
        roleModelResult,
        lifeIncidentInterruptResult,
        livingStatePatchResult,
        lifeIncidentStartResult
      });
    }
  }
  if (allowIncidentCancel) {
    const requiredActiveIncidentSource = requireConfiguredDependency(
      activeIncidentSource,
      'incident cancel preflight failed unexpectedly.'
    );
    lifeIncidentCancelResult = commitLifeIncidentCancel(event, roleModelResult, {
      activeIncidentSource: requiredActiveIncidentSource,
      lifeIncidentCancelFinalizer,
      rawEventLog,
      idGenerator,
      clock
    });
    if (lifeIncidentCancelResult.status === LIFE_INCIDENT_CANCEL_REJECTED_STATUS) {
      return buildStoppedResult(event, route, {
        stoppedAt: LIFE_INCIDENT_CANCEL_COMMIT_STOP,
        failure: lifeIncidentCancelResult.failure,
        userVisibleMessageResult,
        roleModelResult,
        lifeIncidentInterruptResult,
        livingStatePatchResult,
        lifeIncidentStartResult,
        lifeIncidentCancelResult
      });
    }
  }
  if (allowIncidentComplete) {
    const requiredActiveIncidentSource = requireConfiguredDependency(
      activeIncidentSource,
      'incident complete preflight failed unexpectedly.'
    );
    lifeIncidentCompleteResult = commitLifeIncidentComplete(event, roleModelResult, {
      activeIncidentSource: requiredActiveIncidentSource,
      lifeIncidentCompleteFinalizer,
      rawEventLog,
      idGenerator,
      clock
    });
    if (lifeIncidentCompleteResult.status === LIFE_INCIDENT_COMPLETE_REJECTED_STATUS) {
      return buildStoppedResult(event, route, {
        stoppedAt: LIFE_INCIDENT_COMPLETE_COMMIT_STOP,
        failure: lifeIncidentCompleteResult.failure,
        userVisibleMessageResult,
        roleModelResult,
        lifeIncidentInterruptResult,
        livingStatePatchResult,
        lifeIncidentStartResult,
        lifeIncidentCancelResult,
        lifeIncidentCompleteResult
      });
    }
  }

  const visibleReplyResult = commitVisibleReply(
    event,
    projectVisibleReplyRoleModelResult(roleModelResult),
    {
      visibleConversationLog: visibleConversation,
      rawEventLog,
      idGenerator,
      clock
    }
  );
  if (visibleReplyResult.status !== VISIBLE_REPLY_COMMITTED_STATUS) {
    return buildStoppedResult(event, route, {
      stoppedAt: VISIBLE_REPLY_COMMIT_STOP,
      failure: visibleReplyResult.failure,
      userVisibleMessageResult,
      roleModelResult,
      lifeIncidentInterruptResult,
      livingStatePatchResult,
      lifeIncidentStartResult,
      lifeIncidentCancelResult,
      lifeIncidentCompleteResult,
      visibleReplyResult
    });
  }

  const result: UserMessageTurnCommittedResult = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: USER_MESSAGE,
    status: USER_TURN_COMMITTED_STATUS,
    kernel_route: structuredClone(route),
    user_visible_message_result: structuredClone(userVisibleMessageResult),
    role_model_result: structuredClone(roleModelResult),
    visible_reply_result: structuredClone(visibleReplyResult),
    visible_record_ids: {
      user_message_id: userVisibleMessageResult.message.message_id,
      assistant_output_id: visibleReplyResult.output.output_id
    }
  };
  if (livingStatePatchResult !== undefined) {
    result.living_state_patch_result = structuredClone(livingStatePatchResult);
  }
  if (lifeIncidentInterruptResult !== undefined) {
    result.life_incident_interrupt_result = structuredClone(lifeIncidentInterruptResult);
  }
  if (lifeIncidentStartResult !== undefined) {
    result.life_incident_start_result = structuredClone(lifeIncidentStartResult);
  }
  if (lifeIncidentCancelResult !== undefined) {
    result.life_incident_cancel_result = structuredClone(lifeIncidentCancelResult);
  }
  if (lifeIncidentCompleteResult !== undefined) {
    result.life_incident_complete_result = structuredClone(lifeIncidentCompleteResult);
  }
  return result;
}

function requireUserTurnRoute(route: {
  event_type: string;
  model_needed: boolean;
  next_step: string;
}): void {
  if (
    route.event_type !== USER_MESSAGE ||
    !route.model_needed ||
    route.next_step !== USER_TURN_NEXT_STEP
  ) {
    throw new RuntimeValidationError(
      "USER_MESSAGE route must require model work with next_step 'user_turn'."
    );
  }
}

function buildStoppedResult(
  event: { trace_id: string; event_id: string },
  route: RuntimeRouteResult,
  {
    stoppedAt,
    failure,
    userVisibleMessageResult,
    roleModelResult,
    lifeIncidentInterruptResult,
    livingStatePatchResult,
    lifeIncidentStartResult,
    lifeIncidentCancelResult,
    lifeIncidentCompleteResult,
    visibleReplyResult
  }: {
    stoppedAt: string;
    failure: UserTurnFailure;
    userVisibleMessageResult?:
      | UserVisibleMessageCommitResult
      | UserVisibleMessageRejectResult
      | undefined;
    roleModelResult?: RoleModelTurnResult | undefined;
    lifeIncidentInterruptResult?: LifeIncidentInterruptCommitResult | undefined;
    livingStatePatchResult?: LivingStatePatchCommitResult | undefined;
    lifeIncidentStartResult?: LifeIncidentStartCommitResult | undefined;
    lifeIncidentCancelResult?: LifeIncidentCancelCommitResult | undefined;
    lifeIncidentCompleteResult?: LifeIncidentCompleteCommitResult | undefined;
    visibleReplyResult?: VisibleReplyCommitResult | VisibleReplyRejectResult | undefined;
  }
): UserMessageTurnStoppedResult {
  const result: UserMessageTurnStoppedResult = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: USER_MESSAGE,
    status: USER_TURN_STOPPED_STATUS,
    stopped_at: stoppedAt,
    kernel_route: structuredClone(route),
    failure: structuredClone(failure)
  };
  if (userVisibleMessageResult !== undefined) {
    result.user_visible_message_result = structuredClone(userVisibleMessageResult);
  }
  if (roleModelResult !== undefined) {
    result.role_model_result = structuredClone(roleModelResult);
  }
  if (lifeIncidentInterruptResult !== undefined) {
    result.life_incident_interrupt_result = structuredClone(lifeIncidentInterruptResult);
  }
  if (livingStatePatchResult !== undefined) {
    result.living_state_patch_result = structuredClone(livingStatePatchResult);
  }
  if (lifeIncidentStartResult !== undefined) {
    result.life_incident_start_result = structuredClone(lifeIncidentStartResult);
  }
  if (lifeIncidentCancelResult !== undefined) {
    result.life_incident_cancel_result = structuredClone(lifeIncidentCancelResult);
  }
  if (lifeIncidentCompleteResult !== undefined) {
    result.life_incident_complete_result = structuredClone(lifeIncidentCompleteResult);
  }
  if (visibleReplyResult !== undefined) {
    result.visible_reply_result = structuredClone(visibleReplyResult);
  }
  return result;
}

function projectVisibleReplyRoleModelResult(
  roleModelResult: RoleModelTurnResult
): RoleModelTurnResult {
  return {
    trace_id: roleModelResult.trace_id,
    event_id: roleModelResult.event_id,
    event_type: roleModelResult.event_type,
    model_called: true,
    status: roleModelResult.status,
    decision: {
      schema_version: roleModelResult.decision.schema_version,
      trace_id: roleModelResult.decision.trace_id,
      event_id: roleModelResult.decision.event_id,
      action: roleModelResult.decision.action,
      visible_reply: structuredClone(roleModelResult.decision.visible_reply)
    }
  };
}

function buildContextIncidentSources({
  allowIncidentInterrupt,
  interruptResult,
  activeIncidentSource,
  interruptedIncidentSource
}: {
  allowIncidentInterrupt: boolean;
  interruptResult: LifeIncidentInterruptCommitResult | undefined;
  activeIncidentSource: ActiveIncidentSource | undefined;
  interruptedIncidentSource: InterruptedIncidentSource | undefined;
}): {
  activeIncidentSource?: ActiveIncidentSource;
  interruptedIncidentSource?: InterruptedIncidentSource;
} {
  if (!allowIncidentInterrupt || interruptResult === undefined) {
    return optionalIncidentSources(activeIncidentSource, interruptedIncidentSource);
  }

  if (interruptResult.status === LIFE_INCIDENT_INTERRUPTED_STATUS) {
    return {
      interruptedIncidentSource: new SnapshotIncidentSource(
        interruptResult.interrupted_incident
      )
    };
  }
  if (
    interruptResult.status === LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS ||
    interruptResult.status === LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS
  ) {
    return {
      activeIncidentSource: new SnapshotIncidentSource(interruptResult.active_incident)
    };
  }
  if (interruptResult.status === LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS) {
    return {};
  }
  return optionalIncidentSources(activeIncidentSource, interruptedIncidentSource);
}

function optionalIncidentSources(
  activeIncidentSource: ActiveIncidentSource | undefined,
  interruptedIncidentSource: InterruptedIncidentSource | undefined
): {
  activeIncidentSource?: ActiveIncidentSource;
  interruptedIncidentSource?: InterruptedIncidentSource;
} {
  const output: {
    activeIncidentSource?: ActiveIncidentSource;
    interruptedIncidentSource?: InterruptedIncidentSource;
  } = {};
  if (activeIncidentSource !== undefined) {
    output.activeIncidentSource = activeIncidentSource;
  }
  if (interruptedIncidentSource !== undefined) {
    output.interruptedIncidentSource = interruptedIncidentSource;
  }
  return output;
}

class SnapshotIncidentSource implements ActiveIncidentSource, InterruptedIncidentSource {
  readonly #snapshot: ActiveIncidentSnapshot | InterruptedIncidentSnapshot;

  constructor(snapshot: ActiveIncidentSnapshot | InterruptedIncidentSnapshot) {
    this.#snapshot = structuredClone(snapshot);
  }

  readActiveIncident(): ActiveIncidentSnapshot | InterruptedIncidentSnapshot {
    return structuredClone(this.#snapshot);
  }

  readInterruptedIncident(): ActiveIncidentSnapshot | InterruptedIncidentSnapshot {
    return structuredClone(this.#snapshot);
  }
}

function requireConfiguredDependency<Value>(
  value: Value | undefined,
  message: string
): Value {
  if (value === undefined) {
    throw new RuntimeValidationError(message);
  }
  return value;
}
