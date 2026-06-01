import {
  type DecisionContextSectionProvider,
  type DecisionContextSectionRequest,
  type RecentVisibleMessagesRequest,
  VisibleConversationRecentMessagesSource,
  validateDecisionContextSections,
  validateRecentVisibleMessagesRequest,
  type VisibleConversationRecordSource
} from '../character/state/context.ts';
import type {
  ActiveIncidentSource,
  CurrentCharacterStateSource,
  InterruptedIncidentSource
} from '../character/state/current.ts';
import {
  commitLifeIncidentCompletionEvent,
  LIFE_INCIDENT_COMPLETED_STATUS,
  LIFE_INCIDENT_COMPLETE_REJECTED_STATUS,
  LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS,
  type LifeIncidentCompleteFinalizer
} from '../commit-effects/incident-complete.ts';
import {
  LIFE_INCIDENT_CANCELLED_STATUS,
  LIFE_INCIDENT_CANCEL_REJECTED_STATUS,
  LIFE_INCIDENT_CANCEL_SKIPPED_STATUS
} from '../commit-effects/incident-cancel.ts';
import {
  LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS,
  LIFE_INCIDENT_INTERRUPTED_STATUS,
  LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS,
  LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS,
  LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS
} from '../commit-effects/incident-interrupt.ts';
import {
  LIFE_INCIDENT_STARTED_STATUS,
  LIFE_INCIDENT_START_REJECTED_STATUS,
  LIFE_INCIDENT_START_SKIPPED_STATUS
} from '../commit-effects/incident-start.ts';
import {
  LIVING_STATE_PATCH_COMMITTED_STATUS,
  LIVING_STATE_PATCH_REJECTED_STATUS,
  LIVING_STATE_PATCH_SKIPPED_STATUS
} from '../commit-effects/living-state.ts';
import {
  commitUserVisibleMessage,
  commitVisibleReply,
  USER_VISIBLE_MESSAGE_COMMITTED_STATUS,
  USER_VISIBLE_MESSAGE_REJECTED_STATUS,
  VISIBLE_REPLY_COMMITTED_STATUS,
  VISIBLE_REPLY_REJECTED_STATUS,
  type VisibleConversationLog
} from '../commit-effects/visible-reply.ts';
import {
  runRoleModelTurn,
  type RoleModelAdapter,
  type RoleModelOptions,
  type RoleModelTurnResult
} from '../role-model/loop.ts';
import {
  DECISION_READY_FOR_COMMIT_STATUS,
  INCIDENT_COMPLETION,
  USER_MESSAGE,
  validateNormalizedIncidentCompletionEvent,
  validateNormalizedUserMessageEvent,
  type IncidentCompletionRuntimeEvent,
  type UserMessageRuntimeEvent
} from './contracts.ts';
import type { Clock, IdGenerator, RawEventLogEntry } from './logging.ts';
import { SCHEMA_VERSION } from './schema.ts';
import type { RuntimeComponent } from './components.ts';
import {
  RuntimeOperationExecutionError,
  type RuntimeOperationDefinition,
  type RuntimeOperationRequest
} from './operation-registry.ts';
import type { UserTurnWriteActionModule } from './user-turn-actions.ts';

type RawEventLog = {
  append: (entry: RawEventLogEntry) => void;
};

export type VisibleConversationBoundary = VisibleConversationLog &
  VisibleConversationRecordSource;

export type UserTurnRuntimeComponentOptions = {
  adapter: RoleModelAdapter;
  rawEventLog: RawEventLog;
  visibleConversation: VisibleConversationBoundary;
  idGenerator: IdGenerator;
  clock: Clock;
  currentStateSource?: CurrentCharacterStateSource | undefined;
  activeIncidentSource?: ActiveIncidentSource | undefined;
  interruptedIncidentSource?: InterruptedIncidentSource | undefined;
  writeActions?: readonly UserTurnWriteActionModule[];
  contextSectionProviders?: readonly DecisionContextSectionProvider[];
  contextSectionProviderSource?: (() => readonly DecisionContextSectionProvider[]) | undefined;
};

export type IncidentCompletionRuntimeComponentOptions = {
  activeIncidentSource: ActiveIncidentSource;
  lifeIncidentCompleteFinalizer: LifeIncidentCompleteFinalizer;
  rawEventLog: RawEventLog;
  idGenerator: IdGenerator;
  clock: Clock;
};

export function userTurnRuntimeComponents({
  adapter,
  rawEventLog,
  visibleConversation,
  idGenerator,
  clock,
  writeActions = [],
  contextSectionProviders = [],
  contextSectionProviderSource
}: UserTurnRuntimeComponentOptions): RuntimeComponent[] {
  return [
    {
      id: 'visible_conversation',
      version: '0.1',
      enabled: true,
      operations: [
        userVisibleMessageOperation({
          visibleConversation,
          rawEventLog,
          idGenerator,
          clock
        }),
        visibleReplyOperation({
          visibleConversation,
          rawEventLog,
          idGenerator,
          clock
        }),
        visibleConversationReadRecentMessagesOperation({
          visibleConversation
        })
      ]
    },
    {
      id: 'role_model',
      version: '0.1',
      enabled: true,
      operations: [roleModelRunTurnOperation({ adapter, rawEventLog, idGenerator, clock })]
    },
    {
      id: 'context_sections',
      version: '0.1',
      enabled: true,
      operations: [
        characterContextBuildSectionsOperation({
          contextSectionProviders,
          contextSectionProviderSource
        })
      ],
      contextSectionProviders
    },
    ...userTurnActionRuntimeComponents(writeActions, {
      rawEventLog,
      idGenerator,
      clock
    })
  ];
}

export function incidentCompletionRuntimeComponents({
  activeIncidentSource,
  lifeIncidentCompleteFinalizer,
  rawEventLog,
  idGenerator,
  clock
}: IncidentCompletionRuntimeComponentOptions): RuntimeComponent[] {
  return [
    {
      id: 'incident_lifecycle',
      version: '0.1',
      enabled: true,
      operations: [
        incidentCompleteFromEventOperation({
          activeIncidentSource,
          lifeIncidentCompleteFinalizer,
          rawEventLog,
          idGenerator,
          clock
        })
      ]
    }
  ];
}

function userVisibleMessageOperation({
  visibleConversation,
  rawEventLog,
  idGenerator,
  clock
}: {
  visibleConversation: VisibleConversationBoundary;
  rawEventLog: RawEventLog;
  idGenerator: IdGenerator;
  clock: Clock;
}): RuntimeOperationDefinition {
  return operationDefinition({
    op: 'visible_conversation.commit_user_message',
    ownerComponentId: 'visible_conversation',
    category: 'visible_effect',
    inputPrivacy: 'redacted',
    outputPrivacy: 'redacted',
    transactionMode: 'existing_commit_effect_atomic',
    validateInput: (request) => ({
      event: validateNormalizedUserMessageEvent(request.input, 'operation.input')
    }),
    validateOutput: (output, request) =>
      validateStatusOutput(output, request, [
        USER_VISIBLE_MESSAGE_COMMITTED_STATUS,
        USER_VISIBLE_MESSAGE_REJECTED_STATUS
      ]),
    handler: (_request, input) =>
      commitUserVisibleMessage((input as { event: UserMessageRuntimeEvent }).event, {
        visibleConversationLog: visibleConversation,
        rawEventLog,
        idGenerator,
        clock
      })
  });
}

function roleModelRunTurnOperation({
  adapter,
  rawEventLog,
  idGenerator,
  clock
}: {
  adapter: RoleModelAdapter;
  rawEventLog: RawEventLog;
  idGenerator: IdGenerator;
  clock: Clock;
}): RuntimeOperationDefinition {
  return operationDefinition({
    op: 'role_model.run_turn',
    ownerComponentId: 'role_model',
    category: 'model_call',
    inputPrivacy: 'omitted',
    outputPrivacy: 'omitted',
    transactionMode: 'none',
    validateInput: (request) => {
      const input = requireRecord(request.input, 'operation.input');
      return {
        event: validateNormalizedUserMessageEvent(input['event'], 'operation.input.event'),
        options: (input['options'] ?? {}) as RoleModelOptions
      };
    },
    validateOutput: (output, request) =>
      validateStatusOutput(output, request, [DECISION_READY_FOR_COMMIT_STATUS]),
    handler: (_request, input) => {
      const roleModelInput = input as {
        event: UserMessageRuntimeEvent;
        options: RoleModelOptions;
      };
      return runRoleModelTurn(roleModelInput.event, {
        ...roleModelInput.options,
        adapter,
        rawEventLog,
        idGenerator,
        clock
      });
    }
  });
}

function visibleReplyOperation({
  visibleConversation,
  rawEventLog,
  idGenerator,
  clock
}: {
  visibleConversation: VisibleConversationBoundary;
  rawEventLog: RawEventLog;
  idGenerator: IdGenerator;
  clock: Clock;
}): RuntimeOperationDefinition {
  return operationDefinition({
    op: 'visible_conversation.commit_visible_reply',
    ownerComponentId: 'visible_conversation',
    category: 'visible_effect',
    inputPrivacy: 'redacted',
    outputPrivacy: 'redacted',
    transactionMode: 'existing_commit_effect_atomic',
    validateInput: (request) => {
      const input = requireRecord(request.input, 'operation.input');
      return {
        event: validateNormalizedUserMessageEvent(input['event'], 'operation.input.event'),
        roleModelResult: input['roleModelResult'] as RoleModelTurnResult
      };
    },
    validateOutput: (output, request) =>
      validateStatusOutput(output, request, [
        VISIBLE_REPLY_COMMITTED_STATUS,
        VISIBLE_REPLY_REJECTED_STATUS
      ]),
    handler: (_request, input) => {
      const visibleReplyInput = input as {
        event: UserMessageRuntimeEvent;
        roleModelResult: RoleModelTurnResult;
      };
      return commitVisibleReply(visibleReplyInput.event, visibleReplyInput.roleModelResult, {
        visibleConversationLog: visibleConversation,
        rawEventLog,
        idGenerator,
        clock
      });
    }
  });
}

function visibleConversationReadRecentMessagesOperation({
  visibleConversation
}: {
  visibleConversation: VisibleConversationBoundary;
}): RuntimeOperationDefinition {
  return operationDefinition({
    op: 'visible_conversation.read_recent_messages',
    ownerComponentId: 'visible_conversation',
    category: 'read',
    inputPrivacy: 'omitted',
    outputPrivacy: 'omitted',
    transactionMode: 'read_only',
    validateInput: (request) => validateRecentVisibleMessagesRequest(request.input),
    validateOutput: validateListOutput,
    handler: (_request, input) =>
      new VisibleConversationRecentMessagesSource(
        visibleConversation
      ).readRecentVisibleMessages(input as RecentVisibleMessagesRequest)
  });
}

function userTurnActionRuntimeComponents(
  writeActions: readonly UserTurnWriteActionModule[],
  dependencies: {
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RuntimeComponent[] {
  const actionsByOwner = new Map<string, UserTurnWriteActionModule[]>();
  for (const action of writeActions) {
    const ownerComponentId = ownerComponentIdForActionOperation(requireActionOperation(action));
    const ownerActions = actionsByOwner.get(ownerComponentId) ?? [];
    ownerActions.push(action);
    actionsByOwner.set(ownerComponentId, ownerActions);
  }

  return [...actionsByOwner.entries()].map(([ownerComponentId, ownerActions]) => ({
    id: ownerComponentId,
    version: '0.1',
    enabled: true,
    operations: ownerActions.map((action) =>
      userTurnWriteActionOperation(action, dependencies)
    ),
    userTurnActions: ownerActions,
    modelActionSpecs: ownerActions.flatMap((action) =>
      action.modelActionSpec === undefined ? [] : [action.modelActionSpec]
    )
  }));
}

function userTurnWriteActionOperation(
  action: UserTurnWriteActionModule,
  {
    rawEventLog,
    idGenerator,
    clock
  }: {
    rawEventLog: RawEventLog;
    idGenerator: IdGenerator;
    clock: Clock;
  }
): RuntimeOperationDefinition {
  const actionOperation = requireActionOperation(action);
  const ownerComponentId = ownerComponentIdForActionOperation(actionOperation);
  return operationDefinition({
    op: actionOperation,
    ownerComponentId,
    category: ownerComponentId === 'living_state' ? 'state_write' : 'life_action',
    inputPrivacy: 'redacted',
    outputPrivacy: 'redacted',
    transactionMode: 'existing_commit_effect_atomic',
    validateInput: (request) => {
      const input = requireRecord(request.input, 'operation.input');
      return {
        event: validateNormalizedUserMessageEvent(input['event'], 'operation.input.event'),
        roleModelResult: input['roleModelResult'] as RoleModelTurnResult | undefined
      };
    },
    validateOutput: (output, request) =>
      validateStatusOutput(output, request, statusesForActionOperation(actionOperation)),
    handler: (_request, input) => {
      const actionInput = input as {
        event: UserMessageRuntimeEvent;
        roleModelResult?: RoleModelTurnResult;
      };
      const commitContext = {
        event: actionInput.event,
        rawEventLog,
        idGenerator,
        clock
      };
      if (actionInput.roleModelResult !== undefined) {
        return action.commit({
          ...commitContext,
          roleModelResult: actionInput.roleModelResult
        });
      }
      return action.commit(commitContext);
    }
  });
}

function incidentCompleteFromEventOperation({
  activeIncidentSource,
  lifeIncidentCompleteFinalizer,
  rawEventLog,
  idGenerator,
  clock
}: IncidentCompletionRuntimeComponentOptions): RuntimeOperationDefinition {
  return operationDefinition({
    op: 'incident.complete_from_event',
    ownerComponentId: 'incident_lifecycle',
    category: 'life_action',
    inputPrivacy: 'redacted',
    outputPrivacy: 'redacted',
    transactionMode: 'existing_commit_effect_atomic',
    allowedCallers: ['runtime.kernel'],
    allowedCallTypes: ['deterministic_event_commit'],
    allowedEventTypes: [INCIDENT_COMPLETION],
    validateInput: (request) => ({
      event: validateNormalizedIncidentCompletionEvent(request.input, 'operation.input')
    }),
    validateOutput: (output, request) =>
      validateStatusOutput(output, request, [
        LIFE_INCIDENT_COMPLETED_STATUS,
        LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS,
        LIFE_INCIDENT_COMPLETE_REJECTED_STATUS
      ]),
    handler: (_request, input) =>
      commitLifeIncidentCompletionEvent((input as { event: IncidentCompletionRuntimeEvent }).event, {
        activeIncidentSource,
        lifeIncidentCompleteFinalizer,
        rawEventLog,
        idGenerator,
        clock
      })
  });
}

export function characterContextBuildSectionsOperation({
  contextSectionProviders = [],
  contextSectionProviderSource
}: {
  contextSectionProviders?: readonly DecisionContextSectionProvider[];
  contextSectionProviderSource?: (() => readonly DecisionContextSectionProvider[]) | undefined;
}): RuntimeOperationDefinition {
  return operationDefinition({
    op: 'character_context.build_sections',
    ownerComponentId: 'context_sections',
    category: 'context_build',
    inputPrivacy: 'omitted',
    outputPrivacy: 'omitted',
    transactionMode: 'none',
    validateInput: (request) =>
      validateDecisionContextSectionRequest(request.input, 'operation.input'),
    validateOutput: validateDecisionContextSectionsOutput,
    handler: (_request, input) => {
      const request = input as DecisionContextSectionRequest;
      const sections: unknown[] = [];
      const providers = contextSectionProviderSource?.() ?? contextSectionProviders;
      for (const provider of providers) {
        const rawSections = provider.buildDecisionContextSections(structuredClone(request));
        if (!isUnknownList(rawSections)) {
          throw new RuntimeOperationExecutionError(
            'DecisionContextSectionProvider must return a list.',
            {
              stage: 'handler',
              code: 'context_provider_malformed_output'
            }
          );
        }
        sections.push(...rawSections);
      }
      return sections;
    }
  });
}

function operationDefinition({
  op,
  ownerComponentId,
  category,
  inputPrivacy,
  outputPrivacy,
  transactionMode,
  validateInput,
  validateOutput,
  handler,
  allowedCallers = ['runtime.user_turn'],
  allowedCallTypes = ['user_turn'],
  allowedEventTypes = [USER_MESSAGE]
}: {
  op: string;
  ownerComponentId: string;
  category: RuntimeOperationDefinition['policy']['category'];
  inputPrivacy: RuntimeOperationDefinition['privacy']['input'];
  outputPrivacy: RuntimeOperationDefinition['privacy']['output'];
  transactionMode: RuntimeOperationDefinition['transaction']['mode'];
  validateInput: (request: RuntimeOperationRequest) => unknown;
  validateOutput: (output: unknown, request: RuntimeOperationRequest) => unknown;
  handler: (request: RuntimeOperationRequest, input: unknown) => unknown;
  allowedCallers?: RuntimeOperationDefinition['policy']['allowed_callers'];
  allowedCallTypes?: RuntimeOperationDefinition['policy']['allowed_call_types'];
  allowedEventTypes?: RuntimeOperationDefinition['policy']['allowed_event_types'];
}): RuntimeOperationDefinition {
  return {
    op,
    owner_component_id: ownerComponentId,
    input_contract_id: `${op}.input.v0.1`,
    output_contract_id: `${op}.output.v0.1`,
    validate_input: validateInput,
    validate_output: validateOutput,
    policy: {
      category,
      permission_policy_id: 'internal_runtime_only',
      allowed_callers: allowedCallers,
      allowed_call_types: allowedCallTypes,
      allowed_event_types: allowedEventTypes
    },
    privacy: {
      input: inputPrivacy,
      output: outputPrivacy
    },
    logging: {
      mode: 'required'
    },
    transaction: {
      mode: transactionMode
    },
    execution: {
      mode: 'sync_in_process'
    },
    handler
  };
}

function validateStatusOutput(
  output: unknown,
  request: RuntimeOperationRequest,
  allowedStatuses?: readonly string[]
): Record<string, unknown> {
  const outputRecord = requireRecord(output, 'operation.output');
  requireMatchingField(outputRecord, 'trace_id', request.trace_id, 'output_validation');
  requireMatchingField(outputRecord, 'event_id', request.event_id, 'output_validation');
  requireMatchingField(outputRecord, 'event_type', request.event_type, 'output_validation');
  const status = requireStringField(outputRecord, 'status', 'output_validation');
  if (allowedStatuses !== undefined && !allowedStatuses.includes(status)) {
    throw new RuntimeOperationExecutionError(
      `operation.output.status must be one of: ${allowedStatuses.join(', ')}.`,
      {
        stage: 'output_validation',
        code: 'malformed_output'
      }
    );
  }
  return cloneValidatedOutput(outputRecord);
}

function validateListOutput(output: unknown): unknown[] {
  if (!isUnknownList(output)) {
    throw new RuntimeOperationExecutionError('operation.output must be a list.', {
      stage: 'output_validation',
      code: 'malformed_output'
    });
  }
  return cloneValidatedOutput(output);
}

function validateDecisionContextSectionsOutput(output: unknown): unknown[] {
  return validateDecisionContextSections(output);
}

function cloneValidatedOutput<T>(output: T): T {
  try {
    return structuredClone(output);
  } catch {
    throw new RuntimeOperationExecutionError('operation.output must be structured-cloneable.', {
      stage: 'output_validation',
      code: 'malformed_output'
    });
  }
}

function isUnknownList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function validateDecisionContextSectionRequest(
  input: unknown,
  fieldName: string
): DecisionContextSectionRequest {
  const inputRecord = requireRecord(input, fieldName);
  rejectExtraFields(
    inputRecord,
    ['schema_version', 'trace_id', 'event_id', 'event_type', 'created_at', 'conversation_id'],
    fieldName,
    'input_validation'
  );
  const request: DecisionContextSectionRequest = {
    schema_version: requireLiteralField(
      inputRecord,
      'schema_version',
      SCHEMA_VERSION,
      'input_validation'
    ),
    trace_id: requireStringField(inputRecord, 'trace_id', 'input_validation'),
    event_id: requireStringField(inputRecord, 'event_id', 'input_validation'),
    event_type: requireLiteralField(inputRecord, 'event_type', USER_MESSAGE, 'input_validation'),
    created_at: requireStringField(inputRecord, 'created_at', 'input_validation')
  };
  if (Object.hasOwn(inputRecord, 'conversation_id')) {
    request.conversation_id = requireStringField(
      inputRecord,
      'conversation_id',
      'input_validation'
    );
  }
  return request;
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuntimeOperationExecutionError(`${fieldName} must be a mapping.`, {
      stage: 'input_validation',
      code: 'malformed_input'
    });
  }
  return value as Record<string, unknown>;
}

function rejectExtraFields(
  record: Record<string, unknown>,
  allowedFields: readonly string[],
  fieldName: string,
  stage: string
): void {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      throw new RuntimeOperationExecutionError(
        `${fieldName}.${field} is not supported.`,
        {
          stage,
          code: stage === 'output_validation' ? 'malformed_output' : 'malformed_input'
        }
      );
    }
  }
}

function requireMatchingField(
  record: Record<string, unknown>,
  fieldName: string,
  expected: string,
  stage: string
): void {
  const actual = requireStringField(record, fieldName, stage);
  if (actual !== expected) {
    throw new RuntimeOperationExecutionError(
      `operation.output.${fieldName} must match operation request ${fieldName}.`,
      {
        stage,
        code: 'malformed_output'
      }
    );
  }
}

function requireLiteralField<T extends string>(
  record: Record<string, unknown>,
  fieldName: string,
  expected: T,
  stage: string
): T {
  const actual = requireStringField(record, fieldName, stage);
  if (actual !== expected) {
    throw new RuntimeOperationExecutionError(
      `${fieldName} must be ${JSON.stringify(expected)}.`,
      {
        stage,
        code: stage === 'output_validation' ? 'malformed_output' : 'malformed_input'
      }
    );
  }
  return expected;
}

function requireStringField(
  record: Record<string, unknown>,
  fieldName: string,
  stage: string
): string {
  const value = record[fieldName];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeOperationExecutionError(`${fieldName} must be a non-empty string.`, {
      stage,
      code: stage === 'output_validation' ? 'malformed_output' : 'malformed_input'
    });
  }
  return value;
}

function requireActionOperation(action: UserTurnWriteActionModule): string {
  if (action.operation === undefined) {
    throw new RuntimeOperationExecutionError(
      `user-turn action ${action.id} does not declare an operation.`,
      {
        stage: 'input_validation',
        code: 'missing_action_operation'
      }
    );
  }
  return action.operation;
}

function statusesForActionOperation(operation: string): readonly string[] | undefined {
  switch (operation) {
    case 'living_state.commit_patch':
      return [
        LIVING_STATE_PATCH_COMMITTED_STATUS,
        LIVING_STATE_PATCH_SKIPPED_STATUS,
        LIVING_STATE_PATCH_REJECTED_STATUS
      ];
    case 'incident.start_from_model':
      return [
        LIFE_INCIDENT_STARTED_STATUS,
        LIFE_INCIDENT_START_SKIPPED_STATUS,
        LIFE_INCIDENT_START_REJECTED_STATUS
      ];
    case 'incident.cancel_from_model':
      return [
        LIFE_INCIDENT_CANCELLED_STATUS,
        LIFE_INCIDENT_CANCEL_SKIPPED_STATUS,
        LIFE_INCIDENT_CANCEL_REJECTED_STATUS
      ];
    case 'incident.complete_from_model':
      return [
        LIFE_INCIDENT_COMPLETED_STATUS,
        LIFE_INCIDENT_COMPLETE_SKIPPED_STATUS,
        LIFE_INCIDENT_COMPLETE_REJECTED_STATUS
      ];
    case 'incident.interrupt_active':
      return [
        LIFE_INCIDENT_INTERRUPTED_STATUS,
        LIFE_INCIDENT_CONTINUED_IN_BACKGROUND_STATUS,
        LIFE_INCIDENT_PROTECTED_FROM_INTERRUPTION_STATUS,
        LIFE_INCIDENT_INTERRUPT_SKIPPED_STATUS,
        LIFE_INCIDENT_INTERRUPT_REJECTED_STATUS
      ];
    default:
      return undefined;
  }
}

function ownerComponentIdForActionOperation(operation: string): string {
  if (operation.startsWith('living_state.')) {
    return 'living_state';
  }
  if (operation.startsWith('incident.')) {
    return 'incident_lifecycle';
  }
  return 'user_turn_actions';
}
