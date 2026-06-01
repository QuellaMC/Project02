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
  type ActiveIncidentSnapshot,
  type ActiveIncidentSource,
  type CurrentCharacterStateSource,
  type InterruptedIncidentSnapshot,
  type InterruptedIncidentSource
} from '../character/state/current.ts';
import {
  INCIDENT_CANCEL_MODEL_ACTION_SPEC,
  INCIDENT_COMPLETE_MODEL_ACTION_SPEC,
  INCIDENT_START_MODEL_ACTION_SPEC,
  STATE_PATCH_MODEL_ACTION_SPEC,
  type ModelActionSpec,
  type RoleModelTurnResult
} from '../role-model/loop.ts';
import type { UserMessageRuntimeEvent } from './contracts.ts';
import type { Clock, IdGenerator, RawEventLogEntry } from './logging.ts';

export type {
  LivingStatePatchCommitResult,
  LifeIncidentInterruptCommitResult,
  LifeIncidentStartCommitResult,
  LifeIncidentCancelCommitResult,
  LifeIncidentCompleteCommitResult
};

export const LIVING_STATE_PATCH_COMMIT_STOP = 'living_state_patch_commit';
export const LIFE_INCIDENT_START_COMMIT_STOP = 'life_incident_start_commit';
export const LIFE_INCIDENT_CANCEL_COMMIT_STOP = 'life_incident_cancel_commit';
export const LIFE_INCIDENT_COMPLETE_COMMIT_STOP = 'life_incident_complete_commit';
export const LIFE_INCIDENT_INTERRUPT_COMMIT_STOP = 'life_incident_interrupt_commit';
export const CONFLICTING_WRITE_ACTION_OPT_IN_CODE = 'conflicting_write_action_opt_in';
export const MISSING_INCIDENT_CANCEL_SOURCE_CODE = 'missing_incident_cancel_source';
export const MISSING_INCIDENT_COMPLETE_SOURCE_CODE = 'missing_incident_complete_source';
export const MISSING_INCIDENT_INTERRUPT_SOURCE_CODE = 'missing_incident_interrupt_source';

export const WRITE_ACTION_OPT_IN_CONFLICT_MESSAGE =
  'Only one write-action opt-in may be enabled for a USER_MESSAGE turn: ' +
  'state_patch, start_incident, cancel_incident, complete_incident, or interrupt_incident.';

type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export type UserTurnFailure = {
  stage: string;
  code: string;
  message: string;
};

export type UserTurnActionResult =
  | LivingStatePatchCommitResult
  | LifeIncidentInterruptCommitResult
  | LifeIncidentStartCommitResult
  | LifeIncidentCancelCommitResult
  | LifeIncidentCompleteCommitResult;

export type UserTurnActionResultFields = {
  living_state_patch_result?: LivingStatePatchCommitResult;
  life_incident_interrupt_result?: LifeIncidentInterruptCommitResult;
  life_incident_start_result?: LifeIncidentStartCommitResult;
  life_incident_cancel_result?: LifeIncidentCancelCommitResult;
  life_incident_complete_result?: LifeIncidentCompleteCommitResult;
};

export type IncidentContextSources = {
  activeIncidentSource?: ActiveIncidentSource;
  interruptedIncidentSource?: InterruptedIncidentSource;
};

type UserTurnRoleModelContextOptions = {
  currentStateSource?: CurrentCharacterStateSource;
  activeIncidentSource?: ActiveIncidentSource;
  interruptedIncidentSource?: InterruptedIncidentSource;
};

type UserTurnWriteActionCommitContext = {
  event: UserMessageRuntimeEvent;
  roleModelResult?: RoleModelTurnResult;
  rawEventLog: RawEventLog;
  idGenerator: IdGenerator;
  clock: Clock;
};

export type UserTurnWriteActionModule = {
  id: string;
  operation?: string;
  phase: 'before_role_model' | 'after_role_model';
  stop: string;
  modelActionSpec?: ModelActionSpec;
  preflightFailure?: () => UserTurnFailure | undefined;
  roleModelContextOptions?: () => UserTurnRoleModelContextOptions;
  commit: (context: UserTurnWriteActionCommitContext) => UserTurnActionResult;
  isRejected: (result: UserTurnActionResult) => boolean;
  failure: (result: UserTurnActionResult) => UserTurnFailure;
  resultFields: (result: UserTurnActionResult) => UserTurnActionResultFields;
  contextSourcesAfterCommit?: (
    result: UserTurnActionResult,
    fallback: IncidentContextSources
  ) => IncidentContextSources;
};

export type UserTurnWriteActionRegistry = readonly UserTurnWriteActionModule[];

export function userTurnWriteActionRegistry(
  ...actions: UserTurnWriteActionModule[]
): UserTurnWriteActionRegistry {
  return Object.freeze([...actions]);
}

export function livingStatePatchUserTurnAction({
  currentStateSource,
  store,
  finalizer
}: {
  currentStateSource: CurrentCharacterStateSource;
  store: LivingStatePatchStore;
  finalizer: LivingStatePatchFinalizer;
}): UserTurnWriteActionModule {
  return {
    id: 'state_patch',
    operation: 'living_state.commit_patch',
    phase: 'after_role_model',
    stop: LIVING_STATE_PATCH_COMMIT_STOP,
    modelActionSpec: STATE_PATCH_MODEL_ACTION_SPEC,
    roleModelContextOptions: () => ({ currentStateSource }),
    commit: ({ event, roleModelResult, rawEventLog, idGenerator, clock }) =>
      commitLivingStatePatch(event, requireRoleModelResult(roleModelResult), {
        livingStatePatchStore: store,
        livingStatePatchFinalizer: finalizer,
        rawEventLog,
        idGenerator,
        clock
      }),
    isRejected: (result) => result.status === LIVING_STATE_PATCH_REJECTED_STATUS,
    failure: (result) => requireFailure(result),
    resultFields: (result) => ({
      living_state_patch_result: result as LivingStatePatchCommitResult
    })
  };
}

export function incidentStartUserTurnAction({
  finalizer
}: {
  finalizer: LifeIncidentStartFinalizer;
}): UserTurnWriteActionModule {
  return {
    id: 'start_incident',
    operation: 'incident.start_from_model',
    phase: 'after_role_model',
    stop: LIFE_INCIDENT_START_COMMIT_STOP,
    modelActionSpec: INCIDENT_START_MODEL_ACTION_SPEC,
    commit: ({ event, roleModelResult, rawEventLog, idGenerator, clock }) =>
      commitLifeIncidentStart(event, requireRoleModelResult(roleModelResult), {
        lifeIncidentStartFinalizer: finalizer,
        rawEventLog,
        idGenerator,
        clock
      }),
    isRejected: (result) => result.status === LIFE_INCIDENT_START_REJECTED_STATUS,
    failure: (result) => requireFailure(result),
    resultFields: (result) => ({
      life_incident_start_result: result as LifeIncidentStartCommitResult
    })
  };
}

export function incidentCancelUserTurnAction({
  activeIncidentSource,
  finalizer
}: {
  activeIncidentSource: ActiveIncidentSource | undefined;
  finalizer: LifeIncidentCancelFinalizer;
}): UserTurnWriteActionModule {
  return {
    id: 'cancel_incident',
    operation: 'incident.cancel_from_model',
    phase: 'after_role_model',
    stop: LIFE_INCIDENT_CANCEL_COMMIT_STOP,
    modelActionSpec: INCIDENT_CANCEL_MODEL_ACTION_SPEC,
    preflightFailure: () =>
      missingActiveIncidentSourceFailure(
        activeIncidentSource,
        MISSING_INCIDENT_CANCEL_SOURCE_CODE,
        'incident cancel requires active_incident_source.'
      ),
    roleModelContextOptions: () =>
      activeIncidentSource === undefined ? {} : { activeIncidentSource },
    commit: ({ event, roleModelResult, rawEventLog, idGenerator, clock }) =>
      commitLifeIncidentCancel(event, requireRoleModelResult(roleModelResult), {
        activeIncidentSource: requireConfiguredActiveIncidentSource(activeIncidentSource),
        lifeIncidentCancelFinalizer: finalizer,
        rawEventLog,
        idGenerator,
        clock
      }),
    isRejected: (result) => result.status === LIFE_INCIDENT_CANCEL_REJECTED_STATUS,
    failure: (result) => requireFailure(result),
    resultFields: (result) => ({
      life_incident_cancel_result: result as LifeIncidentCancelCommitResult
    })
  };
}

export function incidentCompleteUserTurnAction({
  activeIncidentSource,
  finalizer
}: {
  activeIncidentSource: ActiveIncidentSource | undefined;
  finalizer: LifeIncidentCompleteFinalizer;
}): UserTurnWriteActionModule {
  return {
    id: 'complete_incident',
    operation: 'incident.complete_from_model',
    phase: 'after_role_model',
    stop: LIFE_INCIDENT_COMPLETE_COMMIT_STOP,
    modelActionSpec: INCIDENT_COMPLETE_MODEL_ACTION_SPEC,
    preflightFailure: () =>
      missingActiveIncidentSourceFailure(
        activeIncidentSource,
        MISSING_INCIDENT_COMPLETE_SOURCE_CODE,
        'incident complete requires active_incident_source.'
      ),
    roleModelContextOptions: () =>
      activeIncidentSource === undefined ? {} : { activeIncidentSource },
    commit: ({ event, roleModelResult, rawEventLog, idGenerator, clock }) =>
      commitLifeIncidentComplete(event, requireRoleModelResult(roleModelResult), {
        activeIncidentSource: requireConfiguredActiveIncidentSource(activeIncidentSource),
        lifeIncidentCompleteFinalizer: finalizer,
        rawEventLog,
        idGenerator,
        clock
      }),
    isRejected: (result) => result.status === LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
    failure: (result) => requireFailure(result),
    resultFields: (result) => ({
      life_incident_complete_result: result as LifeIncidentCompleteCommitResult
    })
  };
}

export function incidentInterruptUserTurnAction({
  activeIncidentSource,
  finalizer
}: {
  activeIncidentSource: ActiveIncidentSource | undefined;
  finalizer: LifeIncidentInterruptFinalizer;
}): UserTurnWriteActionModule {
  return {
    id: 'interrupt_incident',
    operation: 'incident.interrupt_active',
    phase: 'before_role_model',
    stop: LIFE_INCIDENT_INTERRUPT_COMMIT_STOP,
    preflightFailure: () =>
      missingActiveIncidentSourceFailure(
        activeIncidentSource,
        MISSING_INCIDENT_INTERRUPT_SOURCE_CODE,
        'incident interrupt requires active_incident_source.'
      ),
    commit: ({ event, rawEventLog, idGenerator, clock }) =>
      commitLifeIncidentInterruption(event, {
        activeIncidentSource: requireConfiguredActiveIncidentSource(activeIncidentSource),
        lifeIncidentInterruptFinalizer: finalizer,
        rawEventLog,
        idGenerator,
        clock
      }),
    isRejected: (result) => result.status === LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS,
    failure: (result) => requireFailure(result),
    resultFields: (result) => ({
      life_incident_interrupt_result: result as LifeIncidentInterruptCommitResult
    }),
    contextSourcesAfterCommit: (result, fallback) =>
      incidentContextSourcesAfterInterrupt(result as LifeIncidentInterruptCommitResult, fallback)
  };
}

function missingActiveIncidentSourceFailure(
  activeIncidentSource: ActiveIncidentSource | undefined,
  code: string,
  message: string
): UserTurnFailure | undefined {
  if (activeIncidentSource !== undefined) {
    return undefined;
  }
  return {
    stage: 'user_turn_preflight',
    code,
    message
  };
}

function incidentContextSourcesAfterInterrupt(
  result: LifeIncidentInterruptCommitResult,
  fallback: IncidentContextSources
): IncidentContextSources {
  if (result.status === LIFE_INCIDENT_INTERRUPTED_STATUS) {
    return {
      interruptedIncidentSource: new SnapshotIncidentSource(result.interrupted_incident)
    };
  }
  if (
    result.status === LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS ||
    result.status === LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS
  ) {
    return {
      activeIncidentSource: new SnapshotIncidentSource(result.active_incident)
    };
  }
  if (result.status === LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS) {
    return {};
  }
  return fallback;
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

function requireRoleModelResult(
  roleModelResult: RoleModelTurnResult | undefined
): RoleModelTurnResult {
  if (roleModelResult === undefined) {
    throw new Error('write action requires role_model_result.');
  }
  return roleModelResult;
}

function requireConfiguredActiveIncidentSource(
  activeIncidentSource: ActiveIncidentSource | undefined
): ActiveIncidentSource {
  if (activeIncidentSource === undefined) {
    throw new Error('incident action preflight failed unexpectedly.');
  }
  return activeIncidentSource;
}

function requireFailure(result: UserTurnActionResult): UserTurnFailure {
  if ('failure' in result) {
    return result.failure;
  }
  throw new Error('rejected write action result must include failure.');
}
