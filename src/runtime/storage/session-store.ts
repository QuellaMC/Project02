import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  CompleteJsonLinesError,
  splitCompleteJsonLines
} from '../../shared/json-lines.ts';
import { isNodeErrorWithCode } from '../../shared/node-error.ts';

import {
  createConversationSession,
  type CharacterProfile,
  type ConversationSession,
  type VisibleMessage
} from '../../core/conversation.ts';
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
  type LocalRuntimeSessionPathsOptions,
  type LocalRuntimeStorageLayout,
  type LocalRuntimeStorageLayoutOptions
} from './layout.ts';
import type { ConversationLogRecord } from '../log.ts';
import { atomicReplaceFile } from './atomic-file.ts';
import {
  acquireLocalRuntimeMutationLock,
  type LocalRuntimeMutationLockLease,
  type LocalRuntimeMutationLockOwnerToken
} from './mutation-lock.ts';

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
  readConversationEvidence?(
    sessionId: string
  ):
    | Promise<LocalRuntimeSessionConversationEvidence>
    | LocalRuntimeSessionConversationEvidence;
};

export type LocalRuntimeSessionConversationEvidence = {
  readonly character: CharacterProfile;
  readonly messages: readonly ConversationLogRecord[];
};

export type LocalRuntimeSessionReadinessValidator = {
  assertSessionReadable(sessionId: string): Promise<void> | void;
};

export type CreateLocalRuntimeSessionStoreOptions =
  LocalRuntimeStorageLayoutOptions & {
    readonly now?: () => string;
    readonly conversationLogReader?: LocalRuntimeSessionConversationLogReader;
    readonly sessionReadinessValidator?: LocalRuntimeSessionReadinessValidator;
  };

export type AssertLocalRuntimeSessionReadableOptions =
  LocalRuntimeStorageLayoutOptions & {
    readonly sessionId?: string;
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

export type AcquireLocalRuntimeSessionWriterLeaseOptions =
  LocalRuntimeSessionPathsOptions & {
    readonly ownerToken?: LocalRuntimeMutationLockOwnerToken;
  };

const defaultClock = (): string => new Date().toISOString();
const sessionDirectoryReconciliationConcurrency = 16;

export async function acquireLocalRuntimeSessionWriterLease(
  options: AcquireLocalRuntimeSessionWriterLeaseOptions = {}
): Promise<LocalRuntimeMutationLockLease> {
  const layout = createLocalRuntimeStorageLayout(options);
  const sessionId = normalizeLocalRuntimeSessionId(options.sessionId);

  await assertStoreRootCanHostMutationLock(layout);

  return await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: `session-writer:${sessionId}`,
    waitTimeoutMs: 0,
    busyCode: 'session_busy',
    ...(options.ownerToken === undefined
      ? {}
      : { ownerToken: options.ownerToken })
  });
}

export function assertLocalRuntimeSessionReadable(
  options: AssertLocalRuntimeSessionReadableOptions = {}
): LocalRuntimeSessionMetadata {
  const layout = createLocalRuntimeStorageLayout(options);
  const sessionId = normalizeLocalRuntimeSessionId(options.sessionId);

  readStorageSchemaMarkerSync(layout);

  const metadata = readSessionCatalogEntrySync(layout, sessionId);

  if (metadata === undefined) {
    throw new LocalRuntimeSessionStoreError(
      'session_not_found',
      `Local runtime session "${sessionId}" does not exist.`
    );
  }

  assertSessionDirectoryReadable(layout, sessionId);

  return metadata;
}

export function createLocalRuntimeSessionStore(
  options: CreateLocalRuntimeSessionStoreOptions = {}
): LocalRuntimeSessionStore {
  const layout = createLocalRuntimeStorageLayout(options);
  const now = options.now ?? defaultClock;
  const configuredConversationLogReader = options.conversationLogReader;
  const configuredSessionReadinessValidator = options.sessionReadinessValidator;

  async function createSession(
    sessionOptions: CreateLocalRuntimeSessionOptions = {}
  ): Promise<LocalRuntimeSessionMetadata> {
    const sessionId = normalizeLocalRuntimeSessionId(sessionOptions.sessionId);
    const createdAt = sessionOptions.createdAt ?? now();

    return await withSessionCatalogMutationLock(layout, async () => {
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

      const sessionDirectory = await createSessionDirectory(layout, sessionId);
      sessions.set(sessionId, metadata);

      try {
        await rewriteSessionCatalog(layout, sessions);
      } catch (error: unknown) {
        if (sessionDirectory.created) {
          await rollbackCreatedSessionDirectory(sessionDirectory.path, error);
        }

        throw errorFromUnknown(error);
      }

      return metadata;
    });
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

    const metadata = await readSessionCatalogEntry(layout, normalizedSessionId);

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
    const normalizedSessionId = normalizeLocalRuntimeSessionId(sessionId);

    return await withSessionCatalogMutationLock(layout, async () => {
      await readStorageSchemaMarker(layout);
      const sessions = await readSessionCatalog(layout);
      const existing = sessions.get(normalizedSessionId);

      if (existing === undefined) {
        throw new LocalRuntimeSessionStoreError(
          'session_not_found',
          `Local runtime session "${normalizedSessionId}" does not exist.`
        );
      }

      await configuredSessionReadinessValidator?.assertSessionReadable(
        existing.sessionId
      );

      const selected = createLocalRuntimeSessionMetadata({
        sessionId: existing.sessionId,
        createdAt: existing.createdAt,
        updatedAt: selectOptions.updatedAt ?? now()
      });

      sessions.set(existing.sessionId, selected);
      await rewriteSessionCatalog(layout, sessions);

      return selected;
    });
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

    const conversationEvidence =
      await conversationLogReader.readConversationEvidence?.(
        metadata.sessionId
      );
    const persistedMessages =
      conversationEvidence?.messages ??
      (await conversationLogReader.readConversationMessages(metadata.sessionId));

    return createConversationSession({
      id: metadata.sessionId,
      ...(conversationEvidence === undefined
        ? {}
        : { character: conversationEvidence.character }),
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
  const storeHasExistingContent = await localRuntimeStoreHasExistingContent(layout);

  try {
    await readStorageSchemaMarker(layout);
  } catch (error: unknown) {
    if (!isLocalRuntimeStorageErrorCode(error, 'missing_file')) {
      throw error;
    }

    if (storeHasExistingContent) {
      throw error;
    }

    await createStoreRoot(layout);
    await writeStorageFile({
      filePath: layout.schemaPath,
      content: `${encodeStorageSchemaMarker(
        createLocalRuntimeStorageSchemaMarker({
          createdAt
        })
      )}\n`,
      failureMessage: `Could not write local runtime storage schema marker: ${layout.schemaPath}.`
    });
    await createSessionsRoot(layout);
    return;
  }

  await createSessionsRoot(layout);
}

async function createSessionsRoot(layout: LocalRuntimeStorageLayout): Promise<void> {
  try {
    await mkdir(layout.sessionsRoot, { recursive: true });
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime sessions directory: ${layout.sessionsRoot}.`
    );
  }
}

async function createStoreRoot(layout: LocalRuntimeStorageLayout): Promise<void> {
  try {
    await mkdir(layout.storeRoot, { recursive: true });
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime store root: ${layout.storeRoot}.`
    );
  }
}

async function localRuntimeStoreHasExistingContent(
  layout: LocalRuntimeStorageLayout
): Promise<boolean> {
  try {
    const entries = await readdir(layout.storeRoot, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(layout.storeRoot, entry.name);

      if (
        entry.isDirectory() &&
        entryPath === layout.sessionsRoot
      ) {
        if (await localRuntimeSessionsRootHasDurableEvidence(layout)) {
          return true;
        }

        continue;
      }

      if (
        isRuntimeHomeControlEntry(layout, entryPath) &&
        (entry.isFile() || entry.isSymbolicLink() || entry.isDirectory())
      ) {
        continue;
      }

      return true;
    }

    return false;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return false;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime store root: ${layout.storeRoot}.`
    );
  }
}

function isRuntimeHomeControlEntry(
  layout: LocalRuntimeStorageLayout,
  entryPath: string
): boolean {
  return (
    entryPath === layout.configPath ||
    entryPath === layout.envPath ||
    entryPath === layout.locksRoot
  );
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
  let catalog: string;

  try {
    catalog = await readFile(layout.sessionCatalogPath, 'utf8');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      if (await localRuntimeSessionsRootHasDurableEvidence(layout)) {
        throwMissingRequiredSessionCatalog(layout);
      }

      return new Map<string, LocalRuntimeSessionMetadata>();
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not read local runtime session catalog: ${layout.sessionCatalogPath}.`
    );
  }

  return await decodeSessionCatalogForLayout(layout, catalog);
}

async function readSessionCatalogEntry(
  layout: LocalRuntimeStorageLayout,
  sessionId: string
): Promise<LocalRuntimeSessionMetadata | undefined> {
  let catalog: string;

  try {
    catalog = await readFile(layout.sessionCatalogPath, 'utf8');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      await assertRequestedSessionIsNotMissingFromCatalog(layout, sessionId);
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not read local runtime session catalog: ${layout.sessionCatalogPath}.`
    );
  }

  const metadata = decodeRequestedSessionCatalogEntry(
    catalog,
    layout.sessionCatalogPath,
    sessionId
  );

  if (metadata === undefined) {
    await assertRequestedSessionIsNotMissingFromCatalog(layout, sessionId);
    return undefined;
  }

  await assertSessionDirectoryReadableAsync(layout, sessionId);
  return metadata;
}

function readStorageSchemaMarkerSync(layout: LocalRuntimeStorageLayout): void {
  const schema = readStorageFileSync({
    filePath: layout.schemaPath,
    missingFileCode: 'missing_file',
    failureMessage: `Could not read local runtime storage schema marker: ${layout.schemaPath}.`
  });

  decodeStorageSchemaMarker(schema);
}

function readSessionCatalogEntrySync(
  layout: LocalRuntimeStorageLayout,
  sessionId: string
): LocalRuntimeSessionMetadata | undefined {
  let catalog: string;

  try {
    catalog = readFileSync(layout.sessionCatalogPath, 'utf8');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      assertRequestedSessionIsNotMissingFromCatalogSync(layout, sessionId);
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not read local runtime session catalog: ${layout.sessionCatalogPath}.`
    );
  }

  const metadata = decodeRequestedSessionCatalogEntry(
    catalog,
    layout.sessionCatalogPath,
    sessionId
  );

  if (metadata === undefined) {
    assertRequestedSessionIsNotMissingFromCatalogSync(layout, sessionId);
    return undefined;
  }

  assertSessionDirectoryReadable(layout, sessionId);
  return metadata;
}

async function decodeSessionCatalogForLayout(
  layout: LocalRuntimeStorageLayout,
  catalog: string
): Promise<Map<string, LocalRuntimeSessionMetadata>> {
  if (catalog.length === 0 && (await localRuntimeSessionsRootHasDurableEvidence(layout))) {
    throwMissingRequiredSessionCatalog(layout);
  }

  const sessions = decodeSessionCatalog(catalog, layout.sessionCatalogPath);

  await assertSessionCatalogCoversDurableSessionDirectories(layout, sessions);
  await assertSessionCatalogEntriesHaveReadableDirectories(layout, sessions);

  return sessions;
}

function decodeSessionCatalog(
  catalog: string,
  filePath: string
): Map<string, LocalRuntimeSessionMetadata> {
  const sessions = new Map<string, LocalRuntimeSessionMetadata>();

  for (const line of splitJsonLines(catalog, filePath)) {
    const metadata = decodeSessionMetadata(line);

    sessions.set(metadata.sessionId, metadata);
  }

  return sessions;
}

function decodeRequestedSessionCatalogEntry(
  catalog: string,
  filePath: string,
  sessionId: string
): LocalRuntimeSessionMetadata | undefined {
  let metadata: LocalRuntimeSessionMetadata | undefined;

  for (const line of splitJsonLines(catalog, filePath)) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (isRecord(parsed) && parsed['sessionId'] === sessionId) {
      metadata = decodeSessionMetadata(line);
    }
  }

  return metadata;
}

async function assertRequestedSessionIsNotMissingFromCatalog(
  layout: LocalRuntimeStorageLayout,
  sessionId: string
): Promise<void> {
  const sessionRoot = createLocalRuntimeSessionPaths({
    storeRoot: layout.storeRoot,
    sessionId
  }).sessionRoot;

  if (await localRuntimeSessionDirectoryHasDurableEvidence(sessionRoot)) {
    throwMissingSessionCatalogEntry(sessionRoot);
  }
}

function assertRequestedSessionIsNotMissingFromCatalogSync(
  layout: LocalRuntimeStorageLayout,
  sessionId: string
): void {
  const sessionRoot = createLocalRuntimeSessionPaths({
    storeRoot: layout.storeRoot,
    sessionId
  }).sessionRoot;

  if (localRuntimeSessionDirectoryHasDurableEvidenceSync(sessionRoot)) {
    throwMissingSessionCatalogEntry(sessionRoot);
  }
}

function throwMissingRequiredSessionCatalog(
  layout: LocalRuntimeStorageLayout
): never {
  throw new LocalRuntimeStorageContractError(
    'missing_file',
    `Required local runtime session catalog is missing or empty while session evidence exists: ${layout.sessionCatalogPath}.`
  );
}

async function assertSessionCatalogCoversDurableSessionDirectories(
  layout: LocalRuntimeStorageLayout,
  sessions: ReadonlyMap<string, LocalRuntimeSessionMetadata>
): Promise<void> {
  let entries: Dirent[];

  try {
    entries = await readdir(layout.sessionsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime sessions directory: ${layout.sessionsRoot}.`
    );
  }

  for (const entry of entries) {
    const sessionRoot = join(layout.sessionsRoot, entry.name);

    if (!entry.isDirectory()) {
      throwUnsupportedSessionRootEntry(sessionRoot);
    }

    if (
      !sessions.has(entry.name) &&
      await localRuntimeSessionDirectoryHasDurableEvidence(sessionRoot)
    ) {
      throwMissingSessionCatalogEntry(sessionRoot);
    }
  }
}

async function assertSessionCatalogEntriesHaveReadableDirectories(
  layout: LocalRuntimeStorageLayout,
  sessions: ReadonlyMap<string, LocalRuntimeSessionMetadata>
): Promise<void> {
  const sessionIds = [...sessions.keys()];
  let nextIndex = 0;
  const workerCount = Math.min(
    sessionDirectoryReconciliationConcurrency,
    sessionIds.length
  );

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const sessionId = sessionIds[nextIndex];
        nextIndex += 1;

        if (sessionId === undefined) {
          return;
        }

        await assertSessionDirectoryReadableAsync(layout, sessionId);
      }
    })
  );
}

async function localRuntimeSessionsRootHasDurableEvidence(
  layout: LocalRuntimeStorageLayout
): Promise<boolean> {
  try {
    const entries = await readdir(layout.sessionsRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        return true;
      }

      if (
        await localRuntimeSessionDirectoryHasDurableEvidence(
          join(layout.sessionsRoot, entry.name)
        )
      ) {
        return true;
      }
    }

    return false;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return false;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime sessions directory: ${layout.sessionsRoot}.`
    );
  }
}

async function localRuntimeSessionDirectoryHasDurableEvidence(
  sessionRoot: string
): Promise<boolean> {
  try {
    return (await readdir(sessionRoot)).length > 0;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return false;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime session directory: ${sessionRoot}.`
    );
  }
}

function localRuntimeSessionDirectoryHasDurableEvidenceSync(
  sessionRoot: string
): boolean {
  try {
    return readdirSync(sessionRoot).length > 0;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return false;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime session directory: ${sessionRoot}.`
    );
  }
}

function throwMissingSessionCatalogEntry(sessionRoot: string): never {
  throw new LocalRuntimeStorageContractError(
    'missing_file',
    `Required local runtime session catalog entry is missing for durable session directory: ${sessionRoot}.`
  );
}

function throwUnsupportedSessionRootEntry(entryPath: string): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    `Local runtime sessions directory contains an unsupported entry: ${entryPath}.`
  );
}

async function assertSessionDirectoryReadableAsync(
  layout: LocalRuntimeStorageLayout,
  sessionId: string
): Promise<void> {
  const sessionRoot = createLocalRuntimeSessionPaths({
    storeRoot: layout.storeRoot,
    sessionId
  }).sessionRoot;

  try {
    if (!(await stat(sessionRoot)).isDirectory()) {
      throw new LocalRuntimeStorageContractError(
        'read_failed',
        `Local runtime session path is not a directory: ${sessionRoot}.`
      );
    }
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeStorageContractError) {
      throw error;
    }

    if (isNodeErrorWithCode(error, 'ENOENT')) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Required local runtime session directory is missing: ${sessionRoot}.`
      );
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime session directory: ${sessionRoot}.`
    );
  }
}

function assertSessionDirectoryReadable(
  layout: LocalRuntimeStorageLayout,
  sessionId: string
): void {
  const sessionRoot = createLocalRuntimeSessionPaths({
    storeRoot: layout.storeRoot,
    sessionId
  }).sessionRoot;

  try {
    if (!statSync(sessionRoot).isDirectory()) {
      throw new LocalRuntimeStorageContractError(
        'read_failed',
        `Local runtime session path is not a directory: ${sessionRoot}.`
      );
    }
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeStorageContractError) {
      throw error;
    }

    if (isNodeErrorWithCode(error, 'ENOENT')) {
      throw new LocalRuntimeStorageContractError(
        'missing_file',
        `Required local runtime session directory is missing: ${sessionRoot}.`
      );
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime session directory: ${sessionRoot}.`
    );
  }
}

async function rewriteSessionCatalog(
  layout: LocalRuntimeStorageLayout,
  sessions: ReadonlyMap<string, LocalRuntimeSessionMetadata>
): Promise<void> {
  try {
    const orderedSessions = [...sessions.values()].sort(compareSessionMetadata);

    await atomicReplaceFile({
      targetPath: layout.sessionCatalogPath,
      content: orderedSessions
        .map((metadata) => `${JSON.stringify(metadata)}\n`)
        .join(''),
      mode: 0o600
    });
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not rewrite local runtime session catalog: ${layout.sessionCatalogPath}.`,
      { cause: error }
    );
  }
}

async function withSessionCatalogMutationLock<Result>(
  layout: LocalRuntimeStorageLayout,
  operation: () => Promise<Result>
): Promise<Result> {
  await assertStoreRootCanHostMutationLock(layout);
  const lease = await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: 'session-catalog'
  });

  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

async function assertStoreRootCanHostMutationLock(
  layout: LocalRuntimeStorageLayout
): Promise<void> {
  try {
    if (!(await stat(layout.storeRoot)).isDirectory()) {
      throw new LocalRuntimeStorageContractError(
        'read_failed',
        `Local runtime store root is not a directory: ${layout.storeRoot}.`
      );
    }
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeStorageContractError) {
      throw error;
    }

    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime store root: ${layout.storeRoot}.`,
      { cause: error }
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

  const sessionId = readCanonicalStoredSessionId(parsed);
  const metadata = createLocalRuntimeSessionMetadata({
    sessionId,
    createdAt: readRecordString(parsed, 'createdAt'),
    updatedAt: readRecordString(parsed, 'updatedAt')
  });

  return metadata;
}

function readCanonicalStoredSessionId(record: Record<string, unknown>): string {
  const sessionId = readRecordString(record, 'sessionId');
  let normalizedSessionId: string;

  try {
    normalizedSessionId = normalizeLocalRuntimeSessionId(sessionId);
  } catch (error: unknown) {
    if (isLocalRuntimeStorageErrorCode(error, 'invalid_session_id')) {
      throwMalformedStoredSessionId();
    }

    throw error;
  }

  if (normalizedSessionId !== sessionId) {
    throwMalformedStoredSessionId();
  }

  return sessionId;
}

function throwMalformedStoredSessionId(): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    'Stored local runtime session metadata field "sessionId" must be canonical.'
  );
}

function splitJsonLines(content: string, filePath: string): readonly string[] {
  try {
    return splitCompleteJsonLines(content);
  } catch (error: unknown) {
    if (error instanceof CompleteJsonLinesError) {
      throw new LocalRuntimeStorageContractError(
        error.reason === 'missing_terminal_newline'
          ? 'partial_write'
          : 'malformed_record',
        error.reason === 'missing_terminal_newline'
          ? `Local runtime JSONL file ended without a complete record: ${filePath}.`
          : `Local runtime JSONL file contains a blank record: ${filePath}.`,
        { cause: error }
      );
    }

    throw error;
  }
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
): Promise<{ readonly path: string; readonly created: boolean }> {
  const sessionRoot = createLocalRuntimeSessionPaths({
    storeRoot: layout.storeRoot,
    sessionId
  }).sessionRoot;

  if (await localRuntimeSessionDirectoryHasDurableEvidence(sessionRoot)) {
    throwMissingSessionCatalogEntry(sessionRoot);
  }

  try {
    await mkdir(sessionRoot);
    return { path: sessionRoot, created: true };
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'EEXIST')) {
      if (await localRuntimeSessionDirectoryHasDurableEvidence(sessionRoot)) {
        throwMissingSessionCatalogEntry(sessionRoot);
      }

      return { path: sessionRoot, created: false };
    }

    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime session directory: ${sessionRoot}.`,
      { cause: error }
    );
  }
}

async function rollbackCreatedSessionDirectory(
  sessionRoot: string,
  originalError: unknown
): Promise<never> {
  try {
    await rmdir(sessionRoot);
  } catch (cleanupError: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not roll back local runtime session directory after catalog failure: ${sessionRoot}.`,
      {
        cause: new AggregateError(
          [cleanupError],
          'Session catalog rewrite failed and the new session directory could not be removed.',
          { cause: originalError }
        )
      }
    );
  }

  throw errorFromUnknown(originalError);
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Local runtime session catalog rewrite failed.', { cause: error });
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

function readStorageFileSync(options: {
  readonly filePath: string;
  readonly missingFileCode: 'missing_file';
  readonly failureMessage: string;
}): string {
  try {
    return readFileSync(options.filePath, 'utf8');
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
