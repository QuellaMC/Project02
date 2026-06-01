import {
  type LifeIncidentInterruptCommitResult,
  type LifeIncidentCancelCommitResult,
  type LifeIncidentCompleteCommitResult,
  type LifeIncidentStartCommitResult,
  type LivingStatePatchCommitResult,
  CONFLICTING_WRITE_ACTION_OPT_IN_CODE,
  WRITE_ACTION_OPT_IN_CONFLICT_MESSAGE,
  type UserTurnActionResult,
  type UserTurnActionResultFields,
  type UserTurnFailure,
  type UserTurnWriteActionModule,
  type UserTurnWriteActionRegistry
} from './user-turn-actions.ts';
import {
  USER_VISIBLE_MESSAGE_COMMITTED_STATUS,
  VISIBLE_REPLY_COMMITTED_STATUS,
  type UserVisibleMessageCommitResult,
  type UserVisibleMessageRejectResult,
  type VisibleConversationLog,
  type VisibleReplyCommitResult,
  type VisibleReplyRejectResult
} from '../commit-effects/visible-reply.ts';
import type {
  DecisionContextSectionProvider,
  RecentVisibleMessagesRequest,
  RecentVisibleMessagesSource,
  VisibleConversationRecordSource
} from '../character/state/context.ts';
import {
  type ActiveIncidentSource,
  type CurrentCharacterStateSource,
  type InterruptedIncidentSource
} from '../character/state/current.ts';
import {
  type RoleModelAdapter,
  type RoleModelOptions,
  type RoleModelTurnResult
} from '../role-model/loop.ts';
import {
  USER_MESSAGE,
  validateNormalizedUserMessageEvent,
  type UserMessageRuntimeEvent
} from './contracts.ts';
import {
  RuntimeValidationError,
  intakeRuntimeEvent,
  type RuntimeRouteResult
} from './kernel.ts';
import { SCHEMA_VERSION, type SchemaVersion } from './schema.ts';
import type { Clock, IdGenerator, RawEventLogEntry } from './logging.ts';
import {
  RuntimeAccess,
  type RuntimeOperationResult
} from './operation-registry.ts';
import { createRuntimeComponentRegistry, type RuntimeComponent } from './components.ts';
import { userTurnRuntimeComponents } from './built-in-components.ts';

export {
  CONFLICTING_WRITE_ACTION_OPT_IN_CODE,
  LIFE_INCIDENT_CANCEL_COMMIT_STOP,
  LIFE_INCIDENT_COMPLETE_COMMIT_STOP,
  LIFE_INCIDENT_INTERRUPT_COMMIT_STOP,
  LIFE_INCIDENT_START_COMMIT_STOP,
  LIVING_STATE_PATCH_COMMIT_STOP,
  MISSING_INCIDENT_CANCEL_SOURCE_CODE,
  MISSING_INCIDENT_COMPLETE_SOURCE_CODE,
  MISSING_INCIDENT_INTERRUPT_SOURCE_CODE
} from './user-turn-actions.ts';

export const USER_TURN_COMMITTED_STATUS = 'user_turn_committed';
export const USER_TURN_STOPPED_STATUS = 'user_turn_stopped';
export const USER_TURN_PREFLIGHT_STOP = 'user_turn_preflight';
export const USER_VISIBLE_MESSAGE_COMMIT_STOP = 'user_visible_message_commit';
export const VISIBLE_REPLY_COMMIT_STOP = 'visible_reply_commit';
export const USER_TURN_NEXT_STEP = 'user_turn';

type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export type VisibleConversationBoundary = VisibleConversationLog &
  VisibleConversationRecordSource;

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
  contextSectionProviders?: readonly DecisionContextSectionProvider[];
  writeActions?: UserTurnWriteActionRegistry;
  runtimeComponents?: readonly RuntimeComponent[];
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
    contextSectionProviders = [],
    writeActions = [],
    runtimeComponents = []
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
  const userMessageEvent = validateNormalizedUserMessageEvent(event);
  const registryContextSectionProviders: {
    current: readonly DecisionContextSectionProvider[];
  } = { current: contextSectionProviders };
  const componentRegistry = createRuntimeComponentRegistry([
    ...userTurnRuntimeComponents({
      adapter,
      rawEventLog,
      visibleConversation,
      idGenerator,
      clock,
      currentStateSource,
      activeIncidentSource,
      interruptedIncidentSource,
      writeActions,
      contextSectionProviders,
      contextSectionProviderSource: () => registryContextSectionProviders.current
    }),
    ...runtimeComponents
  ]);
  registryContextSectionProviders.current = componentRegistry.contextSectionProviders;
  const runtimeAccess = new RuntimeAccess(componentRegistry.operationRegistry, {
    rawEventLog,
    idGenerator,
    clock
  });
  const registryWriteActions = componentRegistry.userTurnActions;
  const modelActionSpecsById = new Map(
    componentRegistry.modelActionSpecs.map((spec) => [spec.id, spec])
  );

  if (registryWriteActions.length > 1) {
    return buildStoppedResult(userMessageEvent, route, {
      stoppedAt: USER_TURN_PREFLIGHT_STOP,
      failure: {
        stage: USER_TURN_PREFLIGHT_STOP,
        code: CONFLICTING_WRITE_ACTION_OPT_IN_CODE,
        message: WRITE_ACTION_OPT_IN_CONFLICT_MESSAGE
      }
    });
  }
  for (const action of registryWriteActions) {
    const failure = action.preflightFailure?.();
    if (failure !== undefined) {
      return buildStoppedResult(userMessageEvent, route, {
        stoppedAt: USER_TURN_PREFLIGHT_STOP,
        failure
      });
    }
  }

  const userVisibleMessageOperationResult = runtimeAccess.execute(
    userTurnOperationRequest(
      userMessageEvent,
      'visible_conversation.commit_user_message',
      userMessageEvent
    )
  );
  if (userVisibleMessageOperationResult.status === 'rejected') {
    return buildStoppedResult(userMessageEvent, route, {
      stoppedAt: USER_VISIBLE_MESSAGE_COMMIT_STOP,
      failure: operationResultFailure(userVisibleMessageOperationResult)
    });
  }
  const userVisibleMessageResult =
    userVisibleMessageOperationResult.output as
      | UserVisibleMessageCommitResult
      | UserVisibleMessageRejectResult;
  if (userVisibleMessageResult.status !== USER_VISIBLE_MESSAGE_COMMITTED_STATUS) {
    return buildStoppedResult(userMessageEvent, route, {
      stoppedAt: USER_VISIBLE_MESSAGE_COMMIT_STOP,
      failure: userVisibleMessageResult.failure,
      userVisibleMessageResult
    });
  }

  let actionResultFields: UserTurnActionResultFields = {};
  let incidentContextSources = optionalIncidentSources(
    activeIncidentSource,
    interruptedIncidentSource
  );
  const beforeRoleModelActions = registryWriteActions.filter(
    (action) => action.phase === 'before_role_model'
  );
  const afterRoleModelActions = registryWriteActions.filter(
    (action) => action.phase === 'after_role_model'
  );
  for (const action of beforeRoleModelActions) {
    const actionExecution = executeUserTurnAction(runtimeAccess, userMessageEvent, action);
    if (actionExecution.status === 'rejected') {
      return buildStoppedResult(userMessageEvent, route, {
        stoppedAt: action.stop,
        failure: actionExecution.failure,
        userVisibleMessageResult,
        actionResultFields
      });
    }
    const actionResult = actionExecution.actionResult;
    actionResultFields = mergeActionResultFields(
      actionResultFields,
      action.resultFields(actionResult)
    );
    if (action.isRejected(actionResult)) {
      return buildStoppedResult(userMessageEvent, route, {
        stoppedAt: action.stop,
        failure: action.failure(actionResult),
        userVisibleMessageResult,
        actionResultFields
      });
    }
    if (action.contextSourcesAfterCommit !== undefined) {
      incidentContextSources = action.contextSourcesAfterCommit(
        actionResult,
        incidentContextSources
      );
    }
  }

  const roleModelOptions: RoleModelOptions = {
    recentVisibleMessagesSource: operationBackedRecentVisibleMessagesSource(
      runtimeAccess,
      userMessageEvent
    )
  };
  const contextSectionProvider = operationBackedContextSectionProvider(
    runtimeAccess,
    userMessageEvent,
    componentRegistry.contextSectionProviders
  );
  if (contextSectionProvider !== undefined) {
    roleModelOptions.contextSectionProviders = [contextSectionProvider];
  }
  if (currentStateSource !== undefined) {
    roleModelOptions.currentStateSource = currentStateSource;
  }
  if (incidentContextSources.activeIncidentSource !== undefined) {
    roleModelOptions.activeIncidentSource = incidentContextSources.activeIncidentSource;
  }
  if (incidentContextSources.interruptedIncidentSource !== undefined) {
    roleModelOptions.interruptedIncidentSource =
      incidentContextSources.interruptedIncidentSource;
  }
  for (const action of afterRoleModelActions) {
    if (action.modelActionSpec !== undefined) {
      roleModelOptions.modelActionSpec =
        modelActionSpecsById.get(action.modelActionSpec.id) ?? action.modelActionSpec;
    }
    const contextOptions = action.roleModelContextOptions?.();
    if (contextOptions?.currentStateSource !== undefined) {
      roleModelOptions.currentStateSource = contextOptions.currentStateSource;
    }
    if (contextOptions?.activeIncidentSource !== undefined) {
      roleModelOptions.activeIncidentSource = contextOptions.activeIncidentSource;
    }
    if (contextOptions?.interruptedIncidentSource !== undefined) {
      roleModelOptions.interruptedIncidentSource = contextOptions.interruptedIncidentSource;
    }
  }
  const roleModelOperationResult = runtimeAccess.execute(
    userTurnOperationRequest(userMessageEvent, 'role_model.run_turn', {
      event: userMessageEvent,
      options: roleModelOptions
    })
  );
  if (roleModelOperationResult.status === 'rejected') {
    return buildStoppedResult(userMessageEvent, route, {
      stoppedAt: 'role_model_run_turn',
      failure: operationResultFailure(roleModelOperationResult),
      userVisibleMessageResult,
      actionResultFields
    });
  }
  const roleModelResult = roleModelOperationResult.output as RoleModelTurnResult;

  for (const action of afterRoleModelActions) {
    const actionExecution = executeUserTurnAction(
      runtimeAccess,
      userMessageEvent,
      action,
      roleModelResult
    );
    if (actionExecution.status === 'rejected') {
      return buildStoppedResult(userMessageEvent, route, {
        stoppedAt: action.stop,
        failure: actionExecution.failure,
        userVisibleMessageResult,
        roleModelResult,
        actionResultFields
      });
    }
    const actionResult = actionExecution.actionResult;
    actionResultFields = mergeActionResultFields(
      actionResultFields,
      action.resultFields(actionResult)
    );
    if (action.isRejected(actionResult)) {
      return buildStoppedResult(userMessageEvent, route, {
        stoppedAt: action.stop,
        failure: action.failure(actionResult),
        userVisibleMessageResult,
        roleModelResult,
        actionResultFields
      });
    }
  }

  const visibleReplyOperationResult = runtimeAccess.execute(
    userTurnOperationRequest(userMessageEvent, 'visible_conversation.commit_visible_reply', {
      event: userMessageEvent,
      roleModelResult: projectVisibleReplyRoleModelResult(roleModelResult)
    })
  );
  if (visibleReplyOperationResult.status === 'rejected') {
    return buildStoppedResult(userMessageEvent, route, {
      stoppedAt: VISIBLE_REPLY_COMMIT_STOP,
      failure: operationResultFailure(visibleReplyOperationResult),
      userVisibleMessageResult,
      roleModelResult,
      actionResultFields
    });
  }
  const visibleReplyResult =
    visibleReplyOperationResult.output as VisibleReplyCommitResult | VisibleReplyRejectResult;
  if (visibleReplyResult.status !== VISIBLE_REPLY_COMMITTED_STATUS) {
    return buildStoppedResult(userMessageEvent, route, {
      stoppedAt: VISIBLE_REPLY_COMMIT_STOP,
      failure: visibleReplyResult.failure,
      userVisibleMessageResult,
      roleModelResult,
      actionResultFields,
      visibleReplyResult
    });
  }

  const result: UserMessageTurnCommittedResult = {
    schema_version: SCHEMA_VERSION,
    trace_id: userMessageEvent.trace_id,
    event_id: userMessageEvent.event_id,
    event_type: USER_MESSAGE,
    status: USER_TURN_COMMITTED_STATUS,
    kernel_route: structuredClone(route),
    user_visible_message_result: structuredClone(userVisibleMessageResult),
    role_model_result: structuredClone(roleModelResult),
    visible_reply_result: structuredClone(visibleReplyResult),
    visible_record_ids: {
      user_message_id: userVisibleMessageResult.message.message_id,
      assistant_output_id: visibleReplyResult.output.output_id
    },
    ...cloneActionResultFields(actionResultFields)
  };
  return result;
}

function userTurnOperationRequest(
  event: UserMessageRuntimeEvent,
  op: string,
  input: unknown
) {
  return {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: USER_MESSAGE,
    caller: {
      component_id: 'runtime.user_turn',
      call_type: 'user_turn'
    },
    op,
    input
  } as const;
}

type ExecutedUserTurnAction =
  | {
      status: 'succeeded';
      actionResult: UserTurnActionResult;
    }
  | {
      status: 'rejected';
      failure: UserTurnFailure;
    };

function executeUserTurnAction(
  runtimeAccess: RuntimeAccess,
  event: UserMessageRuntimeEvent,
  action: UserTurnWriteActionModule,
  roleModelResult?: RoleModelTurnResult
): ExecutedUserTurnAction {
  if (action.operation === undefined) {
    return {
      status: 'rejected',
      failure: {
        stage: action.stop,
        code: 'missing_action_operation',
        message: `User-turn action ${action.id} has no operation.`
      }
    };
  }
  const input: {
    event: UserMessageRuntimeEvent;
    roleModelResult?: RoleModelTurnResult;
  } = { event };
  if (roleModelResult !== undefined) {
    input.roleModelResult = roleModelResult;
  }
  const operationResult = runtimeAccess.execute(
    userTurnOperationRequest(event, action.operation, input)
  );
  if (operationResult.status === 'rejected') {
    return {
      status: 'rejected',
      failure: operationResultFailure(operationResult)
    };
  }
  return {
    status: 'succeeded',
    actionResult: operationResult.output as UserTurnActionResult
  };
}

function operationBackedRecentVisibleMessagesSource(
  runtimeAccess: RuntimeAccess,
  event: UserMessageRuntimeEvent
): RecentVisibleMessagesSource {
  return {
    readRecentVisibleMessages: (request: RecentVisibleMessagesRequest): unknown => {
      const operationResult = runtimeAccess.execute(
        userTurnOperationRequest(
          event,
          'visible_conversation.read_recent_messages',
          structuredClone(request)
        )
      );
      if (operationResult.status === 'rejected') {
        throw new RuntimeValidationError(operationResultFailure(operationResult).message);
      }
      return operationResult.output;
    }
  };
}

function operationBackedContextSectionProvider(
  runtimeAccess: RuntimeAccess,
  event: UserMessageRuntimeEvent,
  contextSectionProviders: readonly DecisionContextSectionProvider[]
): DecisionContextSectionProvider | undefined {
  if (contextSectionProviders.length === 0) {
    return undefined;
  }
  return {
    id: 'runtime.operation_backed_context_sections',
    buildDecisionContextSections: (request): unknown => {
      const operationResult = runtimeAccess.execute(
        userTurnOperationRequest(
          event,
          'character_context.build_sections',
          structuredClone(request)
        )
      );
      if (operationResult.status === 'rejected') {
        throw new RuntimeValidationError(operationResultFailure(operationResult).message);
      }
      return operationResult.output;
    }
  };
}

function operationResultFailure(result: RuntimeOperationResult): UserTurnFailure {
  if (result.failure !== undefined) {
    return {
      stage: result.failure.stage,
      code: result.failure.code,
      message: result.failure.message
    };
  }
  return {
    stage: 'runtime_operation',
    code: 'runtime_operation_rejected',
    message: `operation ${result.op} was rejected.`
  };
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
    actionResultFields = {},
    visibleReplyResult
  }: {
    stoppedAt: string;
    failure: UserTurnFailure;
    userVisibleMessageResult?:
      | UserVisibleMessageCommitResult
      | UserVisibleMessageRejectResult
      | undefined;
    roleModelResult?: RoleModelTurnResult | undefined;
    actionResultFields?: UserTurnActionResultFields | undefined;
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
  Object.assign(result, cloneActionResultFields(actionResultFields));
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

function mergeActionResultFields(
  left: UserTurnActionResultFields,
  right: UserTurnActionResultFields
): UserTurnActionResultFields {
  return {
    ...left,
    ...right
  };
}

function cloneActionResultFields(
  fields: UserTurnActionResultFields
): UserTurnActionResultFields {
  const output: UserTurnActionResultFields = {};
  if (fields.living_state_patch_result !== undefined) {
    output.living_state_patch_result = structuredClone(fields.living_state_patch_result);
  }
  if (fields.life_incident_interrupt_result !== undefined) {
    output.life_incident_interrupt_result = structuredClone(
      fields.life_incident_interrupt_result
    );
  }
  if (fields.life_incident_start_result !== undefined) {
    output.life_incident_start_result = structuredClone(fields.life_incident_start_result);
  }
  if (fields.life_incident_cancel_result !== undefined) {
    output.life_incident_cancel_result = structuredClone(fields.life_incident_cancel_result);
  }
  if (fields.life_incident_complete_result !== undefined) {
    output.life_incident_complete_result = structuredClone(
      fields.life_incident_complete_result
    );
  }
  return output;
}
