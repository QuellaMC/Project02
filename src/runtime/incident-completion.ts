import {
  type ActiveIncidentSource
} from '../character/state/current.ts';
import type {
  LifeIncidentCompleteCommitResult,
  LifeIncidentCompleteFinalizer
} from '../commit-effects/incident-complete.ts';
import {
  INCIDENT_COMPLETION,
  validateNormalizedIncidentCompletionEvent,
  type IncidentCompletionRuntimeEvent
} from './contracts.ts';
import {
  RuntimeValidationError,
  intakeRuntimeEvent,
  type RuntimeRouteResult
} from './kernel.ts';
import type { Clock, IdGenerator, RawEventLogEntry } from './logging.ts';
import { SCHEMA_VERSION, type SchemaVersion } from './schema.ts';
import { RuntimeAccess, type RuntimeOperationResult } from './operation-registry.ts';
import { createRuntimeComponentRegistry } from './components.ts';
import { incidentCompletionRuntimeComponents } from './built-in-components.ts';

type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export const INCIDENT_COMPLETION_COMMITTED_STATUS = 'incident_completion_committed';
export const INCIDENT_COMPLETION_STOPPED_STATUS = 'incident_completion_stopped';

type IncidentCompletionBase = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof INCIDENT_COMPLETION;
  kernel_route: RuntimeRouteResult;
};

export type IncidentCompletionCommittedResult = IncidentCompletionBase & {
  status: typeof INCIDENT_COMPLETION_COMMITTED_STATUS;
  incident_complete_result: LifeIncidentCompleteCommitResult;
};

export type IncidentCompletionStoppedResult = IncidentCompletionBase & {
  status: typeof INCIDENT_COMPLETION_STOPPED_STATUS;
  failure: {
    stage: string;
    code: string;
    message: string;
  };
  incident_complete_result?: LifeIncidentCompleteCommitResult;
};

export type IncidentCompletionResult =
  | IncidentCompletionCommittedResult
  | IncidentCompletionStoppedResult;

export type RunIncidentCompletionEventOptions = {
  rawEventLog: RawEventLog;
  idGenerator: IdGenerator;
  clock: Clock;
  activeIncidentSource: ActiveIncidentSource;
  lifeIncidentCompleteFinalizer: LifeIncidentCompleteFinalizer;
};

export function runIncidentCompletionEvent(
  eventInput: unknown,
  {
    rawEventLog,
    idGenerator,
    clock,
    activeIncidentSource,
    lifeIncidentCompleteFinalizer
  }: RunIncidentCompletionEventOptions
): IncidentCompletionResult {
  const intakeResult = intakeRuntimeEvent(eventInput, {
    rawEventLog,
    idGenerator,
    clock
  });
  const route = intakeResult.route;
  requireIncidentCompletionRoute(route);
  const event = validateNormalizedIncidentCompletionEvent(intakeResult.event);
  const componentRegistry = createRuntimeComponentRegistry(
    incidentCompletionRuntimeComponents({
      activeIncidentSource,
      lifeIncidentCompleteFinalizer,
      rawEventLog,
      idGenerator,
      clock
    })
  );
  const runtimeAccess = new RuntimeAccess(componentRegistry.operationRegistry, {
    rawEventLog,
    idGenerator,
    clock
  });
  const operationResult = runtimeAccess.execute(
    incidentCompletionOperationRequest(event, 'incident.complete_from_event', event)
  );
  if (operationResult.status === 'rejected') {
    return {
      schema_version: SCHEMA_VERSION,
      trace_id: event.trace_id,
      event_id: event.event_id,
      event_type: INCIDENT_COMPLETION,
      status: INCIDENT_COMPLETION_STOPPED_STATUS,
      kernel_route: structuredClone(route),
      failure: operationFailure(operationResult)
    };
  }
  const incidentCompleteResult =
    operationResult.output as LifeIncidentCompleteCommitResult;
  if (incidentCompleteResult.status === 'life_incident_complete_rejected') {
    return {
      schema_version: SCHEMA_VERSION,
      trace_id: event.trace_id,
      event_id: event.event_id,
      event_type: INCIDENT_COMPLETION,
      status: INCIDENT_COMPLETION_STOPPED_STATUS,
      kernel_route: structuredClone(route),
      failure: structuredClone(incidentCompleteResult.failure),
      incident_complete_result: structuredClone(incidentCompleteResult)
    };
  }
  return {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: INCIDENT_COMPLETION,
    status: INCIDENT_COMPLETION_COMMITTED_STATUS,
    kernel_route: structuredClone(route),
    incident_complete_result: structuredClone(incidentCompleteResult)
  };
}

function incidentCompletionOperationRequest(
  event: IncidentCompletionRuntimeEvent,
  op: string,
  input: unknown
) {
  return {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: INCIDENT_COMPLETION,
    caller: {
      component_id: 'runtime.kernel',
      call_type: 'deterministic_event_commit'
    },
    op,
    input
  } as const;
}

function requireIncidentCompletionRoute(route: {
  event_type: string;
  model_needed: boolean;
  next_step: string;
}): void {
  if (
    route.event_type !== INCIDENT_COMPLETION ||
    route.model_needed ||
    route.next_step !== 'incident_completion_commit'
  ) {
    throw new RuntimeValidationError(
      "INCIDENT_COMPLETION route must skip model work with next_step 'incident_completion_commit'."
    );
  }
}

function operationFailure(result: RuntimeOperationResult): {
  stage: string;
  code: string;
  message: string;
} {
  if (result.failure !== undefined) {
    return structuredClone(result.failure);
  }
  return {
    stage: 'runtime_operation',
    code: 'runtime_operation_rejected',
    message: `operation ${result.op} was rejected.`
  };
}
