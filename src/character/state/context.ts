import {
  ASSISTANT_VISIBLE_REPLY_KIND,
  ASSISTANT_VISIBLE_REPLY_ROLE,
  DECISION_READY_FOR_COMMIT_STATUS,
  USER_MESSAGE,
  USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD,
  USER_VISIBLE_MESSAGE_KIND,
  USER_VISIBLE_MESSAGE_ROLE,
  VISIBLE_REPLY_ACTION,
  ContractValidationError,
  validateNormalizedUserMessageEvent,
  type UserMessageRuntimeEvent
} from '../../runtime/contracts.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../../runtime/schema.ts';
import {
  asRecord,
  getOwnField,
  rejectExtraKeys,
  requireLiteral,
  requireOptionalString,
  requireString,
  parseIso8601TimestampToUtcMicroseconds,
  validateIso8601Timestamp
} from '../../runtime/validation.ts';
import {
  buildActiveIncidentBrief,
  buildActiveIncidentRequest,
  buildCurrentCharacterStateRequest,
  buildInterruptedIncidentBrief,
  buildInterruptedIncidentRequest,
  buildLivingStateBrief,
  validateActiveIncidentBriefForEvent,
  validateInterruptedIncidentBriefForEvent,
  validateInterruptedIncidentSnapshot,
  validateLivingStateBriefForEvent,
  type ActiveIncidentBrief,
  type ActiveIncidentSource,
  type InterruptedIncidentBrief,
  type InterruptedIncidentSource,
  type CurrentCharacterStateSource,
  type LivingStateBrief
} from './current.ts';

export const USER_MESSAGE_VISIBLE_REPLY_CALL = 'user_message_visible_reply';
export const RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES = 24;
export const RECENT_VISIBLE_MESSAGES_MAX_MESSAGES = 6;
export const RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS = 1200;

export type RecentVisibleMessage = {
  schema_version: SchemaVersion;
  message_id: string;
  trace_id: string;
  source_event_id: string;
  conversation_id: string;
  role: typeof USER_VISIBLE_MESSAGE_ROLE | typeof ASSISTANT_VISIBLE_REPLY_ROLE;
  created_at: string;
  text: string;
};

export type RecentVisibleMessagesRequest = {
  schema_version: SchemaVersion;
  conversation_id: string;
  before_event_id: string;
  before_created_at: string;
  max_candidate_messages: number;
};

export type VisibleConversationRecordsRequest = {
  schema_version: SchemaVersion;
  conversation_id: string;
  before_event_id: string;
  before_created_at: string;
  max_candidate_records: number;
};

export type VisibleConversationRecord = Record<string, unknown>;

export type RecentVisibleMessagesSource = {
  readRecentVisibleMessages: (request: RecentVisibleMessagesRequest) => unknown;
};

export type VisibleConversationRecordSource = {
  readVisibleConversationRecords: (request: VisibleConversationRecordsRequest) => unknown;
};

export type DecisionContextSection = {
  schema_version: SchemaVersion;
  section_id: string;
  section_type: string;
  content: Record<string, unknown>;
  source_event_ids: string[];
};

export type DecisionContextSectionRequest = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  event_type: typeof USER_MESSAGE;
  created_at: string;
  conversation_id?: string;
};

export type DecisionContextSectionProvider = {
  id?: string;
  buildDecisionContextSections: (request: DecisionContextSectionRequest) => unknown;
};

export type DecisionContext = {
  schema_version: SchemaVersion;
  trace_id: string;
  event_id: string;
  character_snapshot: {
    recent_visible_messages: RecentVisibleMessage[];
    living_state_brief?: LivingStateBrief;
    active_incident?: ActiveIncidentBrief;
    interrupted_incident?: InterruptedIncidentBrief;
    [USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD]?: true;
  };
  context_sections?: DecisionContextSection[];
};

export type BuildCharacterDecisionContextOptions = {
  recentVisibleMessagesSource?: RecentVisibleMessagesSource;
  currentStateSource?: CurrentCharacterStateSource;
  activeIncidentSource?: ActiveIncidentSource;
  interruptedIncidentSource?: InterruptedIncidentSource;
  contextSectionProviders?: readonly DecisionContextSectionProvider[];
};

export type DecisionContextValidationEvent = {
  trace_id: string;
  event_id: string;
  created_at: string;
  conversation_id?: string;
};

export class VisibleConversationRecentMessagesSource {
  readonly #visibleConversationRecordSource: VisibleConversationRecordSource;

  constructor(visibleConversationRecordSource: VisibleConversationRecordSource) {
    this.#visibleConversationRecordSource = visibleConversationRecordSource;
  }

  readRecentVisibleMessages(request: RecentVisibleMessagesRequest): RecentVisibleMessage[] {
    const validatedRequest = validateRecentVisibleMessagesRequest(request);
    const recordRequest = buildVisibleConversationRecordsRequest(validatedRequest);
    const records = this.#visibleConversationRecordSource.readVisibleConversationRecords(
      structuredClone(recordRequest)
    );
    if (!Array.isArray(records)) {
      throw new ContractValidationError('VisibleConversationRecordSource must return a list.');
    }
    if (records.length > validatedRequest.max_candidate_messages) {
      throw new ContractValidationError(
        'VisibleConversationRecordSource returned too many records.'
      );
    }
    return records.map((record) =>
      structuredClone(
        mapVisibleConversationRecord(record, {
          conversationId: validatedRequest.conversation_id
        })
      )
    );
  }
}

export function buildCharacterDecisionContext(
  event: UserMessageRuntimeEvent,
  {
    recentVisibleMessagesSource,
    currentStateSource,
    activeIncidentSource,
    interruptedIncidentSource,
    contextSectionProviders
  }: BuildCharacterDecisionContextOptions = {}
): DecisionContext {
  const normalizedEvent = validateNormalizedUserMessageEvent(event, 'event');
  const recentVisibleMessages = readRecentVisibleMessages(normalizedEvent, {
    recentVisibleMessagesSource
  });
  const livingStateBrief = readLivingStateBrief(normalizedEvent, { currentStateSource });
  const activeIncidentBrief = readActiveIncidentBrief(normalizedEvent, { activeIncidentSource });
  const interruptedIncidentBrief =
    activeIncidentBrief === undefined
      ? readInterruptedIncidentBrief(normalizedEvent, { interruptedIncidentSource })
      : undefined;

  const characterSnapshot: DecisionContext['character_snapshot'] = {
    recent_visible_messages: recentVisibleMessages
  };
  if (livingStateBrief !== undefined) {
    characterSnapshot.living_state_brief = livingStateBrief;
  }
  if (activeIncidentBrief !== undefined) {
    characterSnapshot.active_incident = activeIncidentBrief;
    characterSnapshot[USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD] = true;
  }
  if (interruptedIncidentBrief !== undefined) {
    characterSnapshot.interrupted_incident = interruptedIncidentBrief;
  }
  const context: DecisionContext = {
    schema_version: SCHEMA_VERSION,
    trace_id: normalizedEvent.trace_id,
    event_id: normalizedEvent.event_id,
    character_snapshot: characterSnapshot
  };
  const contextSections = readDecisionContextSections(normalizedEvent, {
    contextSectionProviders
  });
  if (contextSections.length > 0) {
    context.context_sections = contextSections;
  }
  return context;
}

export function validateCharacterDecisionContextForEvent(
  decisionContext: unknown,
  { event }: { event: DecisionContextValidationEvent }
): DecisionContext {
  const contextRecord = asRecord(decisionContext, 'DecisionContext');
  rejectExtraKeys(
    contextRecord,
    ['schema_version', 'trace_id', 'event_id', 'character_snapshot', 'context_sections'],
    'DecisionContext'
  );
  requireLiteral(getOwnField(contextRecord, 'schema_version'), SCHEMA_VERSION, 'schema_version');
  const traceId = requireString(getOwnField(contextRecord, 'trace_id'), 'trace_id');
  const eventId = requireString(getOwnField(contextRecord, 'event_id'), 'event_id');
  const characterSnapshot = validateCharacterSnapshotForEvent(
    getOwnField(contextRecord, 'character_snapshot'),
    {
      conversationId: event.conversation_id,
      eventCreatedAt: event.created_at,
      eventId
    }
  );
  const normalizedContext: DecisionContext = {
    schema_version: SCHEMA_VERSION,
    trace_id: traceId,
    event_id: eventId,
    character_snapshot: characterSnapshot
  };
  if (Object.hasOwn(contextRecord, 'context_sections')) {
    const contextSections = validateDecisionContextSections(
      getOwnField(contextRecord, 'context_sections')
    );
    if (contextSections.length > 0) {
      normalizedContext.context_sections = contextSections;
    }
  }
  return normalizedContext;
}

export function validateRecentVisibleMessagesRequest(
  request: unknown
): RecentVisibleMessagesRequest {
  const requestRecord = asRecord(request, 'RecentVisibleMessagesRequest');
  rejectExtraKeys(
    requestRecord,
    [
      'schema_version',
      'conversation_id',
      'before_event_id',
      'before_created_at',
      'max_candidate_messages'
    ],
    'RecentVisibleMessagesRequest'
  );
  requireLiteral(getOwnField(requestRecord, 'schema_version'), SCHEMA_VERSION, 'schema_version');
  const maxCandidateMessages = getOwnField(requestRecord, 'max_candidate_messages');
  if (
    typeof maxCandidateMessages !== 'number' ||
    !Number.isInteger(maxCandidateMessages) ||
    maxCandidateMessages < 1 ||
    maxCandidateMessages > RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES
  ) {
    throw new ContractValidationError(
      `max_candidate_messages must be an integer from 1 to ${String(
        RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES
      )}.`
    );
  }
  return {
    schema_version: SCHEMA_VERSION,
    conversation_id: requireString(
      getOwnField(requestRecord, 'conversation_id'),
      'conversation_id'
    ),
    before_event_id: requireString(
      getOwnField(requestRecord, 'before_event_id'),
      'before_event_id'
    ),
    before_created_at: validateIso8601Timestamp(
      getOwnField(requestRecord, 'before_created_at'),
      'before_created_at'
    ),
    max_candidate_messages: maxCandidateMessages
  };
}

export function approximateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function readRecentVisibleMessages(
  event: UserMessageRuntimeEvent,
  {
    recentVisibleMessagesSource
  }: { recentVisibleMessagesSource: RecentVisibleMessagesSource | undefined }
): RecentVisibleMessage[] {
  const conversationId = event.payload.conversation_id;
  if (
    conversationId === undefined ||
    conversationId.length === 0 ||
    recentVisibleMessagesSource === undefined
  ) {
    return [];
  }
  const request = buildRecentVisibleMessagesRequest(event, conversationId);
  const rawMessages = recentVisibleMessagesSource.readRecentVisibleMessages(
    structuredClone(request)
  );
  if (!Array.isArray(rawMessages)) {
    throw new ContractValidationError('RecentVisibleMessagesSource must return a list.');
  }
  if (rawMessages.length > RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES) {
    throw new ContractValidationError('RecentVisibleMessagesSource returned too many records.');
  }

  const eventCreatedAt = parseSortableTimestamp(event.created_at);
  const normalizedMessages: Array<{ timestamp: bigint; message: RecentVisibleMessage }> = [];
  const seenMessageIds = new Set<string>();
  const seenSourceEventRoles = new Set<string>();
  for (const rawMessage of rawMessages) {
    const normalizedMessage = validateRecentVisibleMessage(rawMessage, { conversationId });
    if (isCurrentEventMessage(normalizedMessage, event.event_id)) {
      continue;
    }
    rejectDuplicateRecentMessageIdentity(normalizedMessage, {
      seenMessageIds,
      seenSourceEventRoles
    });
    const messageCreatedAt = parseRecentMessageTimestampBeforeEvent(normalizedMessage, {
      eventCreatedAt
    });
    normalizedMessages.push({ timestamp: messageCreatedAt, message: normalizedMessage });
  }
  return selectRecentVisibleMessages(normalizedMessages);
}

function readLivingStateBrief(
  event: UserMessageRuntimeEvent,
  { currentStateSource }: { currentStateSource: CurrentCharacterStateSource | undefined }
): LivingStateBrief | undefined {
  if (currentStateSource === undefined) {
    return undefined;
  }
  const request = buildCurrentCharacterStateRequest(event);
  const snapshot = currentStateSource.readCurrentState(structuredClone(request));
  const livingStateBrief = buildLivingStateBrief(snapshot);
  return validateLivingStateBriefForEvent(livingStateBrief, { eventId: event.event_id });
}

function readActiveIncidentBrief(
  event: UserMessageRuntimeEvent,
  { activeIncidentSource }: { activeIncidentSource: ActiveIncidentSource | undefined }
): ActiveIncidentBrief | undefined {
  if (activeIncidentSource === undefined) {
    return undefined;
  }
  const request = buildActiveIncidentRequest(event);
  const snapshot = activeIncidentSource.readActiveIncident(structuredClone(request));
  if (snapshot === null || snapshot === undefined) {
    return undefined;
  }
  const activeIncidentBrief = buildActiveIncidentBrief(snapshot);
  return validateActiveIncidentBriefForEvent(activeIncidentBrief, { eventId: event.event_id });
}

function readInterruptedIncidentBrief(
  event: UserMessageRuntimeEvent,
  {
    interruptedIncidentSource
  }: { interruptedIncidentSource: InterruptedIncidentSource | undefined }
): InterruptedIncidentBrief | undefined {
  if (interruptedIncidentSource === undefined) {
    return undefined;
  }
  const request = buildInterruptedIncidentRequest(event);
  const snapshot = interruptedIncidentSource.readInterruptedIncident(structuredClone(request));
  if (snapshot === null || snapshot === undefined) {
    return undefined;
  }
  const validatedSnapshot = validateInterruptedIncidentSnapshot(snapshot);
  if (!validatedSnapshot.source_event_ids.includes(event.event_id)) {
    return undefined;
  }
  const interruptedIncidentBrief = buildInterruptedIncidentBrief(validatedSnapshot);
  return validateInterruptedIncidentBriefForEvent(interruptedIncidentBrief, {
    eventId: event.event_id
  });
}

function readDecisionContextSections(
  event: UserMessageRuntimeEvent,
  {
    contextSectionProviders
  }: { contextSectionProviders: readonly DecisionContextSectionProvider[] | undefined }
): DecisionContextSection[] {
  if (contextSectionProviders === undefined || contextSectionProviders.length === 0) {
    return [];
  }
  const request = buildDecisionContextSectionRequest(event);
  const sections: DecisionContextSection[] = [];
  const seenSectionIds = new Set<string>();
  for (const provider of contextSectionProviders) {
    const rawSections = provider.buildDecisionContextSections(structuredClone(request));
    if (!Array.isArray(rawSections)) {
      throw new ContractValidationError('DecisionContextSectionProvider must return a list.');
    }
    for (const rawSection of rawSections) {
      const section = validateDecisionContextSection(rawSection);
      rejectDuplicateDecisionContextSectionId(section, { seenSectionIds });
      sections.push(section);
    }
  }
  return sections;
}

function buildRecentVisibleMessagesRequest(
  event: UserMessageRuntimeEvent,
  conversationId: string
): RecentVisibleMessagesRequest {
  return {
    schema_version: SCHEMA_VERSION,
    conversation_id: conversationId,
    before_event_id: event.event_id,
    before_created_at: event.created_at,
    max_candidate_messages: RECENT_VISIBLE_MESSAGES_MAX_CANDIDATES
  };
}

function buildDecisionContextSectionRequest(
  event: UserMessageRuntimeEvent
): DecisionContextSectionRequest {
  const request: DecisionContextSectionRequest = {
    schema_version: SCHEMA_VERSION,
    trace_id: event.trace_id,
    event_id: event.event_id,
    event_type: USER_MESSAGE,
    created_at: event.created_at
  };
  if (event.payload.conversation_id !== undefined) {
    request.conversation_id = event.payload.conversation_id;
  }
  return request;
}

function buildVisibleConversationRecordsRequest(
  request: RecentVisibleMessagesRequest
): VisibleConversationRecordsRequest {
  return {
    schema_version: SCHEMA_VERSION,
    conversation_id: request.conversation_id,
    before_event_id: request.before_event_id,
    before_created_at: request.before_created_at,
    max_candidate_records: request.max_candidate_messages
  };
}

function mapVisibleConversationRecord(
  record: unknown,
  { conversationId }: { conversationId: string }
): RecentVisibleMessage {
  const recordRecord = asRecord(record, 'VisibleConversationRecord');
  const kind = requireString(getOwnField(recordRecord, 'kind'), 'kind');
  if (kind === USER_VISIBLE_MESSAGE_KIND) {
    return mapUserVisibleMessageRecord(recordRecord, { conversationId });
  }
  if (kind === ASSISTANT_VISIBLE_REPLY_KIND) {
    return mapAssistantVisibleReplyRecord(recordRecord, { conversationId });
  }
  throw new ContractValidationError(
    "kind must be 'user_visible_message' or 'assistant_visible_reply'."
  );
}

function mapUserVisibleMessageRecord(
  record: Record<string, unknown>,
  { conversationId }: { conversationId: string }
): RecentVisibleMessage {
  rejectExtraKeys(
    record,
    [
      'schema_version',
      'message_id',
      'trace_id',
      'source_event_id',
      'kind',
      'role',
      'conversation_id',
      'created_at',
      'text',
      'source',
      'user_id'
    ],
    'UserVisibleMessage'
  );
  validateUserVisibleMessageSource(getOwnField(record, 'source'));
  requireLiteral(getOwnField(record, 'kind'), USER_VISIBLE_MESSAGE_KIND, 'kind');
  requireLiteral(getOwnField(record, 'role'), USER_VISIBLE_MESSAGE_ROLE, 'role');
  validateHiddenOptionalUserId(record);
  return validateRecentVisibleMessage(
    {
      schema_version: validatedSchemaVersion(record),
      message_id: requireString(getOwnField(record, 'message_id'), 'message_id'),
      trace_id: requireString(getOwnField(record, 'trace_id'), 'trace_id'),
      source_event_id: requireString(getOwnField(record, 'source_event_id'), 'source_event_id'),
      conversation_id: requireLiteral(
        getOwnField(record, 'conversation_id'),
        conversationId,
        'conversation_id'
      ),
      role: USER_VISIBLE_MESSAGE_ROLE,
      created_at: validateIso8601Timestamp(getOwnField(record, 'created_at'), 'created_at'),
      text: requireString(getOwnField(record, 'text'), 'text')
    },
    { conversationId }
  );
}

function mapAssistantVisibleReplyRecord(
  record: Record<string, unknown>,
  { conversationId }: { conversationId: string }
): RecentVisibleMessage {
  rejectExtraKeys(
    record,
    [
      'schema_version',
      'output_id',
      'trace_id',
      'source_event_id',
      'kind',
      'conversation_id',
      'created_at',
      'text',
      'source',
      'user_id'
    ],
    'AssistantVisibleReply'
  );
  validateAssistantVisibleReplySource(getOwnField(record, 'source'));
  requireLiteral(getOwnField(record, 'kind'), ASSISTANT_VISIBLE_REPLY_KIND, 'kind');
  validateHiddenOptionalUserId(record);
  return validateRecentVisibleMessage(
    {
      schema_version: validatedSchemaVersion(record),
      message_id: requireString(getOwnField(record, 'output_id'), 'output_id'),
      trace_id: requireString(getOwnField(record, 'trace_id'), 'trace_id'),
      source_event_id: requireString(getOwnField(record, 'source_event_id'), 'source_event_id'),
      conversation_id: requireLiteral(
        getOwnField(record, 'conversation_id'),
        conversationId,
        'conversation_id'
      ),
      role: ASSISTANT_VISIBLE_REPLY_ROLE,
      created_at: validateIso8601Timestamp(getOwnField(record, 'created_at'), 'created_at'),
      text: requireString(getOwnField(record, 'text'), 'text')
    },
    { conversationId }
  );
}

function validatedSchemaVersion(record: Record<string, unknown>): SchemaVersion {
  return requireLiteral(getOwnField(record, 'schema_version'), SCHEMA_VERSION, 'schema_version');
}

function validateUserVisibleMessageSource(source: unknown): void {
  const sourceRecord = asRecord(source, 'source');
  rejectExtraKeys(sourceRecord, ['runtime_event_type'], 'UserVisibleMessage.source');
  requireLiteral(
    getOwnField(sourceRecord, 'runtime_event_type'),
    USER_MESSAGE,
    'source.runtime_event_type'
  );
}

function validateAssistantVisibleReplySource(source: unknown): void {
  const sourceRecord = asRecord(source, 'source');
  rejectExtraKeys(
    sourceRecord,
    ['decision_action', 'role_model_status'],
    'AssistantVisibleReply.source'
  );
  requireLiteral(
    getOwnField(sourceRecord, 'decision_action'),
    VISIBLE_REPLY_ACTION,
    'source.decision_action'
  );
  requireLiteral(
    getOwnField(sourceRecord, 'role_model_status'),
    DECISION_READY_FOR_COMMIT_STATUS,
    'source.role_model_status'
  );
}

function validateHiddenOptionalUserId(record: Record<string, unknown>): void {
  if (Object.hasOwn(record, 'user_id')) {
    requireOptionalString(getOwnField(record, 'user_id'), 'user_id');
  }
}

function validateRecentVisibleMessage(
  message: unknown,
  { conversationId }: { conversationId: string }
): RecentVisibleMessage {
  const messageRecord = asRecord(message, 'RecentVisibleMessage');
  rejectExtraKeys(
    messageRecord,
    [
      'schema_version',
      'message_id',
      'trace_id',
      'source_event_id',
      'conversation_id',
      'role',
      'created_at',
      'text'
    ],
    'RecentVisibleMessage'
  );
  requireLiteral(
    getOwnField(messageRecord, 'schema_version'),
    SCHEMA_VERSION,
    'schema_version'
  );
  requireLiteral(
    getOwnField(messageRecord, 'conversation_id'),
    conversationId,
    'conversation_id'
  );
  const role = requireString(getOwnField(messageRecord, 'role'), 'role');
  if (role !== USER_VISIBLE_MESSAGE_ROLE && role !== ASSISTANT_VISIBLE_REPLY_ROLE) {
    throw new ContractValidationError(
      `role must be '${USER_VISIBLE_MESSAGE_ROLE}' or '${ASSISTANT_VISIBLE_REPLY_ROLE}'.`
    );
  }
  return {
    schema_version: SCHEMA_VERSION,
    message_id: requireString(getOwnField(messageRecord, 'message_id'), 'message_id'),
    trace_id: requireString(getOwnField(messageRecord, 'trace_id'), 'trace_id'),
    source_event_id: requireString(
      getOwnField(messageRecord, 'source_event_id'),
      'source_event_id'
    ),
    conversation_id: conversationId,
    role,
    created_at: validateIso8601Timestamp(getOwnField(messageRecord, 'created_at'), 'created_at'),
    text: requireString(getOwnField(messageRecord, 'text'), 'text')
  };
}

function validateCharacterSnapshotForEvent(
  characterSnapshot: unknown,
  {
    conversationId,
    eventCreatedAt,
    eventId
  }: { conversationId: string | undefined; eventCreatedAt: string; eventId: string }
): DecisionContext['character_snapshot'] {
  const snapshotRecord = asRecord(characterSnapshot, 'DecisionContext.character_snapshot');
  rejectExtraKeys(
    snapshotRecord,
    [
      'recent_visible_messages',
      'living_state_brief',
      'active_incident',
      'interrupted_incident',
      USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD
    ],
    'DecisionContext.character_snapshot'
  );

  const normalizedSnapshot: DecisionContext['character_snapshot'] = {
    recent_visible_messages: []
  };
  if (Object.hasOwn(snapshotRecord, 'living_state_brief')) {
    normalizedSnapshot.living_state_brief = validateLivingStateBriefForEvent(
      getOwnField(snapshotRecord, 'living_state_brief'),
      { eventId }
    );
  }
  if (Object.hasOwn(snapshotRecord, 'active_incident')) {
    normalizedSnapshot.active_incident = validateActiveIncidentBriefForEvent(
      getOwnField(snapshotRecord, 'active_incident'),
      { eventId }
    );
  }
  if (Object.hasOwn(snapshotRecord, 'interrupted_incident')) {
    normalizedSnapshot.interrupted_incident = validateInterruptedIncidentBriefForEvent(
      getOwnField(snapshotRecord, 'interrupted_incident'),
      { eventId }
    );
  }
  if (
    normalizedSnapshot.active_incident !== undefined &&
    normalizedSnapshot.interrupted_incident !== undefined
  ) {
    throw new ContractValidationError(
      'character_snapshot must not include both active_incident and interrupted_incident.'
    );
  }
  if (Object.hasOwn(snapshotRecord, USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD)) {
    if (getOwnField(snapshotRecord, USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD) !== true) {
      throw new ContractValidationError(
        `${USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD} must be true when present.`
      );
    }
    if (normalizedSnapshot.active_incident === undefined) {
      throw new ContractValidationError(
        `${USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD} requires active_incident.`
      );
    }
    normalizedSnapshot[USER_MESSAGE_INTERRUPTED_ACTIVE_INCIDENT_FIELD] = true;
  }

  const recentVisibleMessages = getOwnField(snapshotRecord, 'recent_visible_messages');
  if (!Array.isArray(recentVisibleMessages)) {
    throw new ContractValidationError('recent_visible_messages must be a list.');
  }
  if (conversationId === undefined || conversationId.length === 0) {
    if (recentVisibleMessages.length > 0) {
      throw new ContractValidationError(
        'recent_visible_messages require a non-empty event.conversation_id.'
      );
    }
    return normalizedSnapshot;
  }

  const eventTimestamp = parseSortableTimestamp(eventCreatedAt);
  const normalizedMessages: Array<{ timestamp: bigint; message: RecentVisibleMessage }> = [];
  const seenMessageIds = new Set<string>();
  const seenSourceEventRoles = new Set<string>();
  for (const rawMessage of recentVisibleMessages) {
    const normalizedMessage = validateRecentVisibleMessage(rawMessage, {
      conversationId
    });
    if (isCurrentEventMessage(normalizedMessage, eventId)) {
      throw new ContractValidationError('recent_visible_messages must exclude current event.');
    }
    rejectDuplicateRecentMessageIdentity(normalizedMessage, {
      seenMessageIds,
      seenSourceEventRoles
    });
    const messageCreatedAt = parseRecentMessageTimestampBeforeEvent(normalizedMessage, {
      eventCreatedAt: eventTimestamp
    });
    normalizedMessages.push({ timestamp: messageCreatedAt, message: normalizedMessage });
  }
  const selectedMessages = selectRecentVisibleMessages(normalizedMessages);
  if (selectedMessages.length !== recentVisibleMessages.length) {
    throw new ContractValidationError('recent_visible_messages must fit the active budget.');
  }
  normalizedSnapshot.recent_visible_messages = selectedMessages;
  return normalizedSnapshot;
}

export function validateDecisionContextSections(sections: unknown): DecisionContextSection[] {
  if (!Array.isArray(sections)) {
    throw new ContractValidationError('context_sections must be a list.');
  }
  const normalizedSections: DecisionContextSection[] = [];
  const seenSectionIds = new Set<string>();
  for (const rawSection of sections) {
    const section = validateDecisionContextSection(rawSection);
    rejectDuplicateDecisionContextSectionId(section, { seenSectionIds });
    normalizedSections.push(section);
  }
  return normalizedSections;
}

function validateDecisionContextSection(section: unknown): DecisionContextSection {
  const sectionRecord = asRecord(section, 'DecisionContextSection');
  rejectExtraKeys(
    sectionRecord,
    ['schema_version', 'section_id', 'section_type', 'content', 'source_event_ids'],
    'DecisionContextSection'
  );
  requireLiteral(getOwnField(sectionRecord, 'schema_version'), SCHEMA_VERSION, 'schema_version');
  const content = asRecord(getOwnField(sectionRecord, 'content'), 'DecisionContextSection.content');
  return {
    schema_version: SCHEMA_VERSION,
    section_id: requireString(getOwnField(sectionRecord, 'section_id'), 'section_id'),
    section_type: requireString(getOwnField(sectionRecord, 'section_type'), 'section_type'),
    content: cloneDecisionContextSectionContent(content),
    source_event_ids: validateContextSectionSourceEventIds(
      getOwnField(sectionRecord, 'source_event_ids')
    )
  };
}

function validateContextSectionSourceEventIds(sourceEventIds: unknown): string[] {
  if (!Array.isArray(sourceEventIds)) {
    throw new ContractValidationError('source_event_ids must be a list.');
  }
  return sourceEventIds.map((sourceEventId) =>
    requireString(sourceEventId, 'source_event_ids item')
  );
}

function cloneDecisionContextSectionContent(
  content: Record<string, unknown>
): Record<string, unknown> {
  try {
    return structuredClone(content);
  } catch {
    throw new ContractValidationError(
      'DecisionContextSection.content must be structured-cloneable.'
    );
  }
}

function rejectDuplicateDecisionContextSectionId(
  section: DecisionContextSection,
  { seenSectionIds }: { seenSectionIds: Set<string> }
): void {
  if (seenSectionIds.has(section.section_id)) {
    throw new ContractValidationError('DecisionContextSection.section_id must be unique.');
  }
  seenSectionIds.add(section.section_id);
}

function isCurrentEventMessage(message: RecentVisibleMessage, eventId: string): boolean {
  return message.message_id === eventId || message.source_event_id === eventId;
}

function parseRecentMessageTimestampBeforeEvent(
  message: RecentVisibleMessage,
  { eventCreatedAt }: { eventCreatedAt: bigint }
): bigint {
  const messageCreatedAt = parseSortableTimestamp(message.created_at);
  if (messageCreatedAt >= eventCreatedAt) {
    throw new ContractValidationError(
      'RecentVisibleMessage.created_at must be before event.created_at.'
    );
  }
  return messageCreatedAt;
}

function rejectDuplicateRecentMessageIdentity(
  message: RecentVisibleMessage,
  {
    seenMessageIds,
    seenSourceEventRoles
  }: { seenMessageIds: Set<string>; seenSourceEventRoles: Set<string> }
): void {
  if (seenMessageIds.has(message.message_id)) {
    throw new ContractValidationError('RecentVisibleMessage.message_id must be unique.');
  }
  seenMessageIds.add(message.message_id);
  const sourceEventRole = `${message.source_event_id}\u0000${message.role}`;
  if (seenSourceEventRoles.has(sourceEventRole)) {
    throw new ContractValidationError(
      'RecentVisibleMessage.source_event_id and role pair must be unique.'
    );
  }
  seenSourceEventRoles.add(sourceEventRole);
}

function selectRecentVisibleMessages(
  messages: Array<{ timestamp: bigint; message: RecentVisibleMessage }>
): RecentVisibleMessage[] {
  const selected: Array<{ timestamp: bigint; message: RecentVisibleMessage }> = [];
  let usedTokens = 0;
  const newestFirst = [...messages].sort(
    (left, right) =>
      compareSortableTimestamp(right.timestamp, left.timestamp) ||
      compareCodePointStrings(right.message.message_id, left.message.message_id)
  );
  for (const item of newestFirst) {
    if (selected.length >= RECENT_VISIBLE_MESSAGES_MAX_MESSAGES) {
      break;
    }
    const messageTokens = approximateTextTokens(item.message.text);
    if (usedTokens + messageTokens > RECENT_VISIBLE_MESSAGES_MAX_TEXT_TOKENS) {
      continue;
    }
    selected.push(item);
    usedTokens += messageTokens;
  }
  return selected
    .sort(
      (left, right) =>
        compareSortableTimestamp(left.timestamp, right.timestamp) ||
        compareCodePointStrings(left.message.message_id, right.message.message_id)
    )
    .map((item) => structuredClone(item.message));
}

function parseSortableTimestamp(value: string): bigint {
  return parseIso8601TimestampToUtcMicroseconds(value, 'timestamp');
}

function compareSortableTimestamp(left: bigint, right: bigint): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareCodePointStrings(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex);
    const rightCodePoint = right.codePointAt(rightIndex);
    if (leftCodePoint === undefined || rightCodePoint === undefined) {
      break;
    }
    if (leftCodePoint < rightCodePoint) {
      return -1;
    }
    if (leftCodePoint > rightCodePoint) {
      return 1;
    }
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }
  return compareSortableTimestamp(BigInt(left.length), BigInt(right.length));
}
