import {
  appendFile,
  mkdir,
  readFile,
  writeFile
} from 'node:fs/promises';

import {
  createConversationSession,
  type ConversationSession,
  type VisibleMessage
} from './conversation.ts';
import {
  createLocalRuntimeSessionMetadata,
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  createLocalRuntimeStorageSchemaMarker,
  decodeStorageSchemaMarker,
  encodeStorageSchemaMarker,
  LocalRuntimeStorageContractError,
  normalizeLocalRuntimeSessionId,
  type LocalRuntimeSessionMetadata,
  type LocalRuntimeStorageLayout,
  type LocalRuntimeStorageLayoutOptions
} from './local-storage.ts';
import type { ConversationLogRecord } from './runtime-log.ts';

export type LocalRuntimeSessionStoreErrorCode =
  | 'conversation_log_reader_unavailable'
  | 'session_already_exists'
  | 'session_not_found';

export class LocalRuntimeSessionStoreError extends Error {
  readonly code: LocalRuntimeSessionStoreErrorCode;

  constructor(code: LocalRuntimeSessionStoreErrorCode, message: string) {
    super(message);
    this.name = 'LocalRuntimeSessionStoreError';
    this.code = code;
  }
}

export type LocalRuntimeSessionConversationLogReader = {
  readConversationMessages(
    sessionId: string
  ): Promise<readonly ConversationLogRecord[]> | readonly ConversationLogRecord[];
};

export type CreateLocalRuntimeSessionStoreOptions =
  LocalRuntimeStorageLayoutOptions & {
    readonly now?: () => string;
    readonly conversationLogReader?: LocalRuntimeSessionConversationLogReader;
  };

export type CreateLocalRuntimeSessionOptions = {
  readonly sessionId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

export type SelectLocalRuntimeSessionOptions = {
  readonly updatedAt?: string;
};

export type RehydrateLocalRuntimeConversationSessionOptions = {
  readonly conversationLogReader?: LocalRuntimeSessionConversationLogReader;
};

export type LocalRuntimeSessionStore = {
  readonly layout: LocalRuntimeStorageLayout;
  createSession(
    options?: CreateLocalRuntimeSessionOptions
  ): Promise<LocalRuntimeSessionMetadata>;
  listSessions(): Promise<readonly LocalRuntimeSessionMetadata[]>;
  readSession(sessionId?: string): Promise<LocalRuntimeSessionMetadata>;
  selectSession(
    sessionId?: string,
    options?: SelectLocalRuntimeSessionOptions
  ): Promise<LocalRuntimeSessionMetadata>;
  rehydrateConversationSession(
    sessionId?: string,
    options?: RehydrateLocalRuntimeConversationSessionOptions
  ): Promise<ConversationSession>;
};

const defaultClock = (): string => new Date().toISOString();

export function createLocalRuntimeSessionStore(
  options: CreateLocalRuntimeSessionStoreOptions = {}
): LocalRuntimeSessionStore {
  const layout = createLocalRuntimeStorageLayout(options);
  const now = options.now ?? defaultClock;
  const configuredConversationLogReader = options.conversationLogReader;

  async function createSession(
    sessionOptions: CreateLocalRuntimeSessionOptions = {}
  ): Promise<LocalRuntimeSessionMetadata> {
    const sessionId = normalizeLocalRuntimeSessionId(sessionOptions.sessionId);
    const createdAt = sessionOptions.createdAt ?? now();

    await ensureInitializedStore(layout, createdAt);

    const sessions = await readSessionCatalog(layout);

    if (sessions.has(sessionId)) {
      throw new LocalRuntimeSessionStoreError(
        'session_already_exists',
        `Local runtime session "${sessionId}" already exists.`
      );
    }

    const metadata = createLocalRuntimeSessionMetadata({
      sessionId,
      createdAt,
      updatedAt: sessionOptions.updatedAt ?? createdAt
    });

    await createSessionDirectory(layout, sessionId);
    await appendSessionMetadata(layout, metadata);

    return metadata;
  }

  async function listSessions(): Promise<readonly LocalRuntimeSessionMetadata[]> {
    await readStorageSchemaMarker(layout);

    const sessions = [...(await readSessionCatalog(layout)).values()];

    return Object.freeze(
      sessions.sort((left, right) => compareSessionMetadata(left, right))
    );
  }

  async function readSession(sessionId?: string): Promise<LocalRuntimeSessionMetadata> {
    const normalizedSessionId = normalizeLocalRuntimeSessionId(sessionId);

    await readStorageSchemaMarker(layout);

    const sessions = await readSessionCatalog(layout);
    const metadata = sessions.get(normalizedSessionId);

    if (metadata === undefined) {
      throw new LocalRuntimeSessionStoreError(
        'session_not_found',
        `Local runtime session "${normalizedSessionId}" does not exist.`
      );
    }

    return metadata;
  }

  async function selectSession(
    sessionId?: string,
    selectOptions: SelectLocalRuntimeSessionOptions = {}
  ): Promise<LocalRuntimeSessionMetadata> {
    const existing = await readSession(sessionId);
    const selected = createLocalRuntimeSessionMetadata({
      sessionId: existing.sessionId,
      createdAt: existing.createdAt,
      updatedAt: selectOptions.updatedAt ?? now()
    });

    await appendSessionMetadata(layout, selected);

    return selected;
  }

  async function rehydrateConversationSession(
    sessionId?: string,
    rehydrateOptions: RehydrateLocalRuntimeConversationSessionOptions = {}
  ): Promise<ConversationSession> {
    const metadata = await readSession(sessionId);
    const conversationLogReader =
      rehydrateOptions.conversationLogReader ?? configuredConversationLogReader;

    if (conversationLogReader === undefined) {
      throw new LocalRuntimeSessionStoreError(
        'conversation_log_reader_unavailable',
        'A CT-02 conversation log reader is required to rehydrate a local runtime session.'
      );
    }

    const persistedMessages = await conversationLogReader.readConversationMessages(
      metadata.sessionId
    );

    return createConversationSession({
      id: metadata.sessionId,
      visibleTranscript: persistedMessages.map((message) =>
        toVisibleMessage(message)
      )
    });
  }

  return Object.freeze({
    layout,
    createSession,
    listSessions,
    readSession,
    selectSession,
    rehydrateConversationSession
  } satisfies LocalRuntimeSessionStore);
}

async function ensureInitializedStore(
  layout: LocalRuntimeStorageLayout,
  createdAt: string
): Promise<void> {
  try {
    await mkdir(layout.sessionsRoot, { recursive: true });
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime sessions directory: ${layout.sessionsRoot}.`
    );
  }

  try {
    await readStorageSchemaMarker(layout);
  } catch (error: unknown) {
    if (!isLocalRuntimeStorageErrorCode(error, 'missing_file')) {
      throw error;
    }

    await writeStorageFile({
      filePath: layout.schemaPath,
      content: `${encodeStorageSchemaMarker(
        createLocalRuntimeStorageSchemaMarker({
          createdAt
        })
      )}\n`,
      failureMessage: `Could not write local runtime storage schema marker: ${layout.schemaPath}.`
    });
  }
}

async function readStorageSchemaMarker(
  layout: LocalRuntimeStorageLayout
): Promise<void> {
  const schema = await readStorageFile({
    filePath: layout.schemaPath,
    missingFileCode: 'missing_file',
    failureMessage: `Could not read local runtime storage schema marker: ${layout.schemaPath}.`
  });

  decodeStorageSchemaMarker(schema);
}

async function readSessionCatalog(
  layout: LocalRuntimeStorageLayout
): Promise<Map<string, LocalRuntimeSessionMetadata>> {
  const sessions = new Map<string, LocalRuntimeSessionMetadata>();
  let catalog: string;

  try {
    catalog = await readFile(layout.sessionCatalogPath, 'utf8');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return sessions;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not read local runtime session catalog: ${layout.sessionCatalogPath}.`
    );
  }

  for (const line of splitJsonLines(catalog, layout.sessionCatalogPath)) {
    const metadata = decodeSessionMetadata(line);

    sessions.set(metadata.sessionId, metadata);
  }

  return sessions;
}

async function appendSessionMetadata(
  layout: LocalRuntimeStorageLayout,
  metadata: LocalRuntimeSessionMetadata
): Promise<void> {
  try {
    await appendFile(
      layout.sessionCatalogPath,
      `${JSON.stringify(metadata)}\n`,
      'utf8'
    );
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not append local runtime session catalog: ${layout.sessionCatalogPath}.`
    );
  }
}

function decodeSessionMetadata(line: string): LocalRuntimeSessionMetadata {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Stored local runtime session metadata is not valid JSON.'
    );
  }

  if (!isRecord(parsed)) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Stored local runtime session metadata must be an object.'
    );
  }

  return createLocalRuntimeSessionMetadata({
    sessionId: readRecordString(parsed, 'sessionId'),
    createdAt: readRecordString(parsed, 'createdAt'),
    updatedAt: readRecordString(parsed, 'updatedAt')
  });
}

function splitJsonLines(content: string, filePath: string): readonly string[] {
  if (content.length === 0) {
    return [];
  }

  if (!content.endsWith('\n')) {
    throw new LocalRuntimeStorageContractError(
      'partial_write',
      `Local runtime JSONL file ended without a complete record: ${filePath}.`
    );
  }

  const lines = content.split(/\r?\n/u);

  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== 'string' || value.length === 0) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Stored local runtime session metadata field "${key}" must be a non-empty string.`
    );
  }

  return value;
}

function toVisibleMessage(record: ConversationLogRecord): VisibleMessage {
  return {
    id: record.id,
    role: record.role,
    speakerId: record.speakerId,
    speakerName: record.speakerName,
    text: record.text
  };
}

function compareSessionMetadata(
  left: LocalRuntimeSessionMetadata,
  right: LocalRuntimeSessionMetadata
): number {
  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);

  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.sessionId.localeCompare(right.sessionId);
}

async function createSessionDirectory(
  layout: LocalRuntimeStorageLayout,
  sessionId: string
): Promise<void> {
  const sessionRoot = createLocalRuntimeSessionPaths({
    storeRoot: layout.storeRoot,
    sessionId
  }).sessionRoot;

  try {
    await mkdir(sessionRoot, { recursive: true });
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime session directory: ${sessionRoot}.`
    );
  }
}

async function readStorageFile(options: {
  readonly filePath: string;
  readonly missingFileCode: 'missing_file';
  readonly failureMessage: string;
}): Promise<string> {
  try {
    return await readFile(options.filePath, 'utf8');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      throw new LocalRuntimeStorageContractError(
        options.missingFileCode,
        `Required local runtime storage file is missing: ${options.filePath}.`
      );
    }

    throw new LocalRuntimeStorageContractError('read_failed', options.failureMessage);
  }
}

async function writeStorageFile(options: {
  readonly filePath: string;
  readonly content: string;
  readonly failureMessage: string;
}): Promise<void> {
  try {
    await writeFile(options.filePath, options.content, 'utf8');
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      options.failureMessage
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalRuntimeStorageErrorCode(
  error: unknown,
  code: LocalRuntimeStorageContractError['code']
): error is LocalRuntimeStorageContractError {
  return error instanceof LocalRuntimeStorageContractError && error.code === code;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
