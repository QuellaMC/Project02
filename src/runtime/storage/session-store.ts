import {join} from 'node:path';
import {
  listDirectoryEntries,
  listDirectoryNamesSync,
  makeDirectory,
  readTextFile,
  readTextFileSync,
  removeDirectory,
  removePathSync,
  type Dirent,
} from '../../shared/file-system.ts';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {readUndamagedJsonLines} from './json-lines.ts';
import {readStoreJsonLines} from './store-file.ts';
import {describeRealEntry, type RealEntry} from '../../shared/real-path.ts';

import {
  createSession as createCoreSession,
  type CharacterProfile,
  type Session,
  type SpeakerIdentity,
  type VisibleMessage,
} from '../../core/index.ts';
import {
  createLocalRuntimeSessionMetadata,
  createLocalRuntimeSessionPaths,
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError,
  normalizeConversationId,
  normalizeLocalRuntimeSessionId,
  parseSegmentSessionId,
  rawEventsFileName,
  segmentSessionId,
  type LocalRuntimeSessionMetadata,
  type LocalRuntimeSessionPathsOptions,
  type LocalRuntimeStorageLayout,
  type LocalRuntimeStorageLayoutOptions,
} from './layout-contract.ts';
import {isRecord} from './layout-contract.ts';
import type {ConversationLogRecord} from '../evidence/records.ts';
import {atomicReplaceFileSync} from './atomic-file.ts';
import {
  assertCharacterDataDirAdoptable,
  assertCharacterDataDirReadable,
  ensureCharacterDataMarker,
  requireCharacterDataMarker,
} from './character-data.ts';
import {
  acquireLocalRuntimeMutationLock,
  type LocalRuntimeMutationLockLease,
  type LocalRuntimeMutationLockOwnerToken,
} from './mutation-lock.ts';

type LocalRuntimeSessionStoreErrorCode =
  | 'conversation_log_reader_unavailable'
  | 'session_already_exists'
  | 'session_not_empty'
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
  readConversationEvidence(
    sessionId: string,
  ):
    | Promise<LocalRuntimeSessionConversationEvidence>
    | LocalRuntimeSessionConversationEvidence;
};

export type LocalRuntimeSessionConversationEvidence = {
  readonly character: CharacterProfile;
  readonly userSpeaker?: SpeakerIdentity;
  readonly messages: readonly ConversationLogRecord[];
};

type CreateLocalRuntimeSessionStoreOptions =
  LocalRuntimeStorageLayoutOptions & {
    readonly characterId: string;
    readonly now?: () => string;
    readonly conversationLogReader?: LocalRuntimeSessionConversationLogReader;
  };

type AssertLocalRuntimeSessionReadableOptions =
  LocalRuntimeStorageLayoutOptions & {
    readonly sessionId: string;
    readonly characterId?: string;
  };

type CreateLocalRuntimeSessionOptions = {
  readonly conversationId: string;
  readonly createdAt?: string;
};

type CreateContinuedLocalRuntimeSessionOptions = {
  readonly continuedFrom: string;
  readonly createdAt?: string;
};

type RehydrateLocalRuntimeSessionOptions = {
  readonly conversationLogReader?: LocalRuntimeSessionConversationLogReader;
};

export type LocalRuntimeSessionStore = {
  readonly layout: LocalRuntimeStorageLayout;
  /** Opens a conversation's first segment, "<conversationId>.1". */
  createSession(
    options: CreateLocalRuntimeSessionOptions,
  ): Promise<LocalRuntimeSessionMetadata>;
  /** Opens the segment after `continuedFrom`, which must be the latest. */
  createContinuedSession(
    options: CreateContinuedLocalRuntimeSessionOptions,
  ): Promise<LocalRuntimeSessionMetadata>;
  /**
   * Removes a session that never received a record — the rollback for a
   * continuation whose opening record could not be written. A session that
   * holds any evidence is refused.
   */
  discardEmptySession(sessionId: string): Promise<void>;
  listSessions(): Promise<readonly LocalRuntimeSessionMetadata[]>;
  /** The conversation's current segment, if it has any. */
  latestSegment(
    conversationId: string,
  ): Promise<LocalRuntimeSessionMetadata | undefined>;
  readSession(sessionId: string): Promise<LocalRuntimeSessionMetadata>;
  rehydrateSession(
    sessionId: string,
    options?: RehydrateLocalRuntimeSessionOptions,
  ): Promise<Session>;
};

type AcquireLocalRuntimeSessionWriterLeaseOptions =
  LocalRuntimeSessionPathsOptions & {
    readonly ownerToken?: LocalRuntimeMutationLockOwnerToken;
  };

const defaultClock = (): string => new Date().toISOString();

export async function acquireLocalRuntimeSessionWriterLease(
  options: AcquireLocalRuntimeSessionWriterLeaseOptions,
): Promise<LocalRuntimeMutationLockLease> {
  const layout = createLocalRuntimeStorageLayout(options);
  const sessionId = normalizeLocalRuntimeSessionId(options.sessionId);

  assertStoreRootCanHostMutationLock(layout);

  return await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: `session-writer:${sessionId}`,
    waitTimeoutMs: 0,
    busyCode: 'session_busy',
    ...(options.ownerToken === undefined
      ? {}
      : {ownerToken: options.ownerToken}),
  });
}

export function assertLocalRuntimeSessionReadable(
  options: AssertLocalRuntimeSessionReadableOptions,
): LocalRuntimeSessionMetadata {
  const layout = createLocalRuntimeStorageLayout(options);
  const sessionId = normalizeLocalRuntimeSessionId(options.sessionId);

  requireCharacterDataMarker({
    storageOptions: options,
    ...(options.characterId === undefined
      ? {}
      : {characterId: options.characterId}),
  });

  const metadata = readSessionCatalogEntry(layout, sessionId);

  if (metadata === undefined) {
    throw new LocalRuntimeSessionStoreError(
      'session_not_found',
      `Local runtime session "${sessionId}" does not exist.`,
    );
  }

  assertSessionDirectoryReadable(layout, sessionId);

  return metadata;
}

export function createLocalRuntimeSessionStore(
  options: CreateLocalRuntimeSessionStoreOptions,
): LocalRuntimeSessionStore {
  const layout = createLocalRuntimeStorageLayout(options);
  const characterId = options.characterId;
  const now = options.now ?? defaultClock;
  const configuredConversationLogReader = options.conversationLogReader;

  async function createSession(
    sessionOptions: CreateLocalRuntimeSessionOptions,
  ): Promise<LocalRuntimeSessionMetadata> {
    const sessionId = segmentSessionId(sessionOptions.conversationId, 1);
    const createdAt = sessionOptions.createdAt ?? now();

    return await withSessionCatalogMutationLock(layout, async () => {
      await ensureInitializedStore(layout, characterId, createdAt);

      const sessions = await readSessionCatalog(layout);
      if (sessions.has(sessionId)) {
        throw new LocalRuntimeSessionStoreError(
          'session_already_exists',
          `Local runtime session "${sessionId}" already exists.`,
        );
      }

      return await insertSession(layout, sessions, {sessionId, createdAt});
    });
  }

  // The segment number is chosen and written under the same lock, so two
  // windows continuing one conversation cannot pick one name for two
  // sessions.
  async function createContinuedSession(
    continuation: CreateContinuedLocalRuntimeSessionOptions,
  ): Promise<LocalRuntimeSessionMetadata> {
    const continuedFrom = parseSegmentSessionId(
      normalizeLocalRuntimeSessionId(continuation.continuedFrom),
    );
    const createdAt = continuation.createdAt ?? now();

    return await withSessionCatalogMutationLock(layout, async () => {
      const sessions = await readSessionCatalog(layout);
      const latest = latestSegmentOf(sessions, continuedFrom.conversationId);

      if (
        latest === undefined ||
        parseSegmentSessionId(latest.sessionId).segment !==
          continuedFrom.segment
      ) {
        throw new LocalRuntimeSessionStoreError(
          'session_not_found',
          `Local runtime session "${segmentSessionId(
            continuedFrom.conversationId,
            continuedFrom.segment,
          )}" is not the latest segment of its conversation.`,
        );
      }

      return await insertSession(layout, sessions, {
        sessionId: segmentSessionId(
          continuedFrom.conversationId,
          continuedFrom.segment + 1,
        ),
        createdAt,
      });
    });
  }

  async function discardEmptySession(sessionId: string): Promise<void> {
    await discardEmptySessionFromCatalog(
      layout,
      normalizeLocalRuntimeSessionId(sessionId),
    );
  }

  async function latestSegment(
    conversationId: string,
  ): Promise<LocalRuntimeSessionMetadata | undefined> {
    return latestSegmentOf(
      new Map(
        (await listSessions()).map(metadata => [metadata.sessionId, metadata]),
      ),
      normalizeConversationId(conversationId),
    );
  }

  async function listSessions(): Promise<
    readonly LocalRuntimeSessionMetadata[]
  > {
    const marker = assertCharacterDataDirReadable({
      storageOptions: options,
      characterId,
    });

    if (marker === undefined) {
      return Object.freeze([]);
    }

    const sessions = [...(await readSessionCatalog(layout)).values()];

    return Object.freeze(
      sessions.sort((left, right) => compareSessionMetadata(left, right)),
    );
  }

  async function readSession(
    sessionId: string,
  ): Promise<LocalRuntimeSessionMetadata> {
    const normalizedSessionId = normalizeLocalRuntimeSessionId(sessionId);

    requireCharacterDataMarker({
      storageOptions: options,
      characterId,
    });

    const metadata = readSessionCatalogEntry(layout, normalizedSessionId);

    if (metadata === undefined) {
      throw new LocalRuntimeSessionStoreError(
        'session_not_found',
        `Local runtime session "${normalizedSessionId}" does not exist.`,
      );
    }

    // The read is synchronous; the store's callers still receive a promise,
    // and a failure above still reaches them as a rejection.
    return Promise.resolve(metadata);
  }

  async function rehydrateSession(
    sessionId: string,
    rehydrateOptions: RehydrateLocalRuntimeSessionOptions = {},
  ): Promise<Session> {
    const metadata = await readSession(sessionId);
    const conversationLogReader =
      rehydrateOptions.conversationLogReader ?? configuredConversationLogReader;

    if (conversationLogReader === undefined) {
      throw new LocalRuntimeSessionStoreError(
        'conversation_log_reader_unavailable',
        'A CT-02 conversation log reader is required to rehydrate a local runtime session.',
      );
    }

    const conversationEvidence =
      await conversationLogReader.readConversationEvidence(metadata.sessionId);

    return createCoreSession({
      id: metadata.sessionId,
      character: conversationEvidence.character,
      ...(conversationEvidence.userSpeaker === undefined
        ? {}
        : {userDisplayName: conversationEvidence.userSpeaker.displayName}),
      visibleTranscript: conversationEvidence.messages.map(message =>
        toVisibleMessage(message),
      ),
    });
  }

  return Object.freeze({
    layout,
    createSession,
    createContinuedSession,
    discardEmptySession,
    listSessions,
    latestSegment,
    readSession,
    rehydrateSession,
  } satisfies LocalRuntimeSessionStore);
}

async function ensureInitializedStore(
  layout: LocalRuntimeStorageLayout,
  characterId: string,
  createdAt: string,
): Promise<void> {
  const marker = assertCharacterDataDirReadable({
    storageOptions: {storeRoot: layout.storeRoot},
    characterId,
  });

  if (marker === undefined) {
    await createStoreRoot(layout);
    await ensureCharacterDataMarker({
      storageOptions: {storeRoot: layout.storeRoot},
      characterId,
      now: () => createdAt,
    });
  }

  await createSessionsRoot(layout);
}

async function createSessionsRoot(
  layout: LocalRuntimeStorageLayout,
): Promise<void> {
  try {
    await makeDirectory(layout.sessionsRoot, {recursive: true});
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime sessions directory: ${layout.sessionsRoot}.`,
    );
  }
}

async function createStoreRoot(
  layout: LocalRuntimeStorageLayout,
): Promise<void> {
  try {
    await makeDirectory(layout.storeRoot, {recursive: true});
  } catch {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime store root: ${layout.storeRoot}.`,
    );
  }
}

async function readSessionCatalog(
  layout: LocalRuntimeStorageLayout,
): Promise<Map<string, LocalRuntimeSessionMetadata>> {
  let catalog: string;

  try {
    catalog = await readTextFile(layout.sessionCatalogPath);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      if (await localRuntimeSessionsRootHasDurableEvidence(layout)) {
        throwMissingRequiredSessionCatalog(layout);
      }

      return new Map<string, LocalRuntimeSessionMetadata>();
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not read local runtime session catalog: ${layout.sessionCatalogPath}.`,
    );
  }

  return await decodeSessionCatalogForLayout(layout, catalog);
}

function readSessionCatalogEntry(
  layout: LocalRuntimeStorageLayout,
  sessionId: string,
): LocalRuntimeSessionMetadata | undefined {
  let catalog: string;

  try {
    catalog = readTextFileSync(layout.sessionCatalogPath);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      assertRequestedSessionIsNotMissingFromCatalog(layout, sessionId);
      return undefined;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not read local runtime session catalog: ${layout.sessionCatalogPath}.`,
    );
  }

  const metadata = decodeRequestedSessionCatalogEntry(catalog, sessionId);

  if (metadata === undefined) {
    assertRequestedSessionIsNotMissingFromCatalog(layout, sessionId);
    return undefined;
  }

  assertSessionDirectoryReadable(layout, sessionId);
  return metadata;
}

async function decodeSessionCatalogForLayout(
  layout: LocalRuntimeStorageLayout,
  catalog: string,
): Promise<Map<string, LocalRuntimeSessionMetadata>> {
  if (
    catalog.length === 0 &&
    (await localRuntimeSessionsRootHasDurableEvidence(layout))
  ) {
    throwMissingRequiredSessionCatalog(layout);
  }

  const sessions = decodeSessionCatalog(catalog, layout.sessionCatalogPath);

  await assertSessionCatalogCoversDurableSessionDirectories(layout, sessions);

  for (const sessionId of sessions.keys()) {
    assertSessionDirectoryReadable(layout, sessionId);
  }

  return sessions;
}

/** A damaged row fails the read; a crash-truncated tail row is skipped. */
function decodeSessionCatalog(
  catalog: string,
  filePath: string,
): Map<string, LocalRuntimeSessionMetadata> {
  const sessions = new Map<string, LocalRuntimeSessionMetadata>();

  for (const line of readStoreJsonLines(filePath, catalog)) {
    const metadata = decodeSessionMetadata(line);

    sessions.set(metadata.sessionId, metadata);
  }

  return sessions;
}

/**
 * A damaged row for another session is skipped: opening one session must
 * not depend on every other entry being intact.
 */
function decodeRequestedSessionCatalogEntry(
  catalog: string,
  sessionId: string,
): LocalRuntimeSessionMetadata | undefined {
  let metadata: LocalRuntimeSessionMetadata | undefined;

  for (const line of readUndamagedJsonLines(catalog)) {
    const parsed: unknown = JSON.parse(line);

    if (isRecord(parsed) && parsed['sessionId'] === sessionId) {
      metadata = decodeSessionMetadata(line);
    }
  }

  return metadata;
}

function assertRequestedSessionIsNotMissingFromCatalog(
  layout: LocalRuntimeStorageLayout,
  sessionId: string,
): void {
  const sessionRoot = createLocalRuntimeSessionPaths({
    storeRoot: layout.storeRoot,
    sessionId,
  }).sessionRoot;

  if (localRuntimeSessionDirectoryHasDurableEvidence(sessionRoot)) {
    throwMissingSessionCatalogEntry(sessionRoot);
  }
}

function throwMissingRequiredSessionCatalog(
  layout: LocalRuntimeStorageLayout,
): never {
  throw new LocalRuntimeStorageContractError(
    'missing_file',
    `Required local runtime session catalog is missing or empty while session evidence exists: ${layout.sessionCatalogPath}.`,
  );
}

async function assertSessionCatalogCoversDurableSessionDirectories(
  layout: LocalRuntimeStorageLayout,
  sessions: ReadonlyMap<string, LocalRuntimeSessionMetadata>,
): Promise<void> {
  let entries: Dirent[];

  try {
    entries = await listDirectoryEntries(layout.sessionsRoot);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime sessions directory: ${layout.sessionsRoot}.`,
    );
  }

  for (const entry of entries) {
    if (isOperatingSystemMetadataEntry(entry.name)) {
      continue;
    }

    const sessionRoot = join(layout.sessionsRoot, entry.name);

    if (!entry.isDirectory()) {
      throwUnsupportedSessionRootEntry(sessionRoot);
    }

    if (
      !sessions.has(entry.name) &&
      localRuntimeSessionDirectoryHasDurableEvidence(sessionRoot)
    ) {
      throwMissingSessionCatalogEntry(sessionRoot);
    }
  }
}

/** Finder drops .DS_Store into any browsed directory; it is not evidence. */
function isOperatingSystemMetadataEntry(name: string): boolean {
  return name === '.DS_Store';
}

async function localRuntimeSessionsRootHasDurableEvidence(
  layout: LocalRuntimeStorageLayout,
): Promise<boolean> {
  try {
    const entries = await listDirectoryEntries(layout.sessionsRoot);

    for (const entry of entries) {
      if (isOperatingSystemMetadataEntry(entry.name)) {
        continue;
      }

      if (!entry.isDirectory()) {
        return true;
      }

      if (
        localRuntimeSessionDirectoryHasDurableEvidence(
          join(layout.sessionsRoot, entry.name),
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
      `Could not inspect local runtime sessions directory: ${layout.sessionsRoot}.`,
    );
  }
}

/**
 * Durable evidence means a committed record. An interrupted start or
 * discard leaves at most a raw-events file holding the torn tail of a
 * write that never completed, which no reader would return — every caller
 * treats such a directory as absent, so the cleanup finishes on the next
 * create or discard of the same id. Anything else in the directory is
 * evidence, and Finder metadata is ignored on both sides.
 */
function localRuntimeSessionDirectoryHasDurableEvidence(
  sessionRoot: string,
): boolean {
  let meaningful: readonly string[];

  try {
    meaningful = listDirectoryNamesSync(sessionRoot).filter(
      name => !isOperatingSystemMetadataEntry(name),
    );
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return false;
    }

    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect local runtime session directory: ${sessionRoot}.`,
    );
  }

  if (meaningful.length === 0) {
    return false;
  }

  if (meaningful.length > 1 || meaningful[0] !== rawEventsFileName) {
    return true;
  }

  return (
    readUndamagedJsonLines(
      readTextFileSync(join(sessionRoot, rawEventsFileName)),
    ).length > 0
  );
}

function throwMissingSessionCatalogEntry(sessionRoot: string): never {
  throw new LocalRuntimeStorageContractError(
    'missing_file',
    `Required local runtime session catalog entry is missing for durable session directory: ${sessionRoot}.`,
  );
}

function throwUnsupportedSessionRootEntry(entryPath: string): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    `Local runtime sessions directory contains an unsupported entry: ${entryPath}.`,
  );
}

/**
 * Callers must not cache this: a directory swapped for a link after the
 * first read would let later appends open evidence paths through the link.
 */
export function assertLocalRuntimeSessionDirectoryIsReal(
  options: AssertLocalRuntimeSessionReadableOptions,
): void {
  assertSessionDirectoryReadable(
    createLocalRuntimeStorageLayout(options),
    normalizeLocalRuntimeSessionId(options.sessionId),
  );
}

export function assertSessionDirectoryReadable(
  layout: LocalRuntimeStorageLayout,
  sessionId: string,
  onMissing: 'reject' | 'allow' = 'reject',
): void {
  const sessionRoot = createLocalRuntimeSessionPaths({
    storeRoot: layout.storeRoot,
    sessionId,
  }).sessionRoot;

  assertRealStorageDirectory({
    entry: describeRealEntry(sessionRoot),
    path: sessionRoot,
    label: 'session directory',
    onMissing,
  });
}

/**
 * Symlinked roots are refused before any read or lock, so evidence and
 * control files cannot be routed outside the character data root.
 */
function assertRealStorageDirectory(options: {
  readonly entry: RealEntry;
  readonly path: string;
  readonly label: string;
  readonly onMissing: 'reject' | 'allow';
}): void {
  const entry = options.entry;

  if (
    entry.kind === 'absent' ||
    (entry.kind === 'unreadable' && isNodeErrorWithCode(entry.error, 'ENOTDIR'))
  ) {
    if (options.onMissing === 'allow') {
      return;
    }

    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Required ${options.label} is missing: ${options.path}.`,
    );
  }

  if (entry.kind === 'unreadable') {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Could not inspect ${options.label}: ${options.path}.`,
    );
  }

  if (entry.kind !== 'directory') {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Local runtime ${options.label} must be a real directory: ${options.path}.`,
    );
  }
}

function rewriteSessionCatalog(
  layout: LocalRuntimeStorageLayout,
  sessions: ReadonlyMap<string, LocalRuntimeSessionMetadata>,
): void {
  try {
    const orderedSessions = [...sessions.values()].sort(compareSessionMetadata);

    atomicReplaceFileSync({
      targetPath: layout.sessionCatalogPath,
      content: orderedSessions
        .map(metadata => `${JSON.stringify(metadata)}\n`)
        .join(''),
      mode: 0o600,
    });
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not rewrite local runtime session catalog: ${layout.sessionCatalogPath}.`,
      {cause: error},
    );
  }
}

async function withSessionCatalogMutationLock<Result>(
  layout: LocalRuntimeStorageLayout,
  operation: () => Promise<Result>,
): Promise<Result> {
  assertStoreRootCanHostMutationLock(layout);
  const lease = await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: 'session-catalog',
  });

  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

function assertStoreRootCanHostMutationLock(
  layout: LocalRuntimeStorageLayout,
): void {
  // Runs before the lock root is prepared: acquiring the lock creates the
  // store root and `.locks` recursively, which under a symlinked parent
  // would land in the link target.
  assertCharacterDataDirAdoptable({storeRoot: layout.storeRoot});
}

export function decodeSessionMetadata(
  line: string,
): LocalRuntimeSessionMetadata {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Stored local runtime session metadata is not valid JSON.',
    );
  }

  if (!isRecord(parsed)) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      'Stored local runtime session metadata must be an object.',
    );
  }

  return createLocalRuntimeSessionMetadata({
    sessionId: readCanonicalStoredSessionId(parsed),
    createdAt: readRecordString(parsed, 'createdAt'),
  });
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
    'Stored local runtime session metadata field "sessionId" must be canonical.',
  );
}

function readRecordString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];

  if (typeof value !== 'string' || value.length === 0) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Stored local runtime session metadata field "${key}" must be a non-empty string.`,
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
    text: record.text,
  };
}

function latestSegmentOf(
  sessions: ReadonlyMap<string, LocalRuntimeSessionMetadata>,
  conversationId: string,
): LocalRuntimeSessionMetadata | undefined {
  let latest:
    {metadata: LocalRuntimeSessionMetadata; segment: number} | undefined;

  for (const metadata of sessions.values()) {
    const parsed = parseSegmentSessionId(metadata.sessionId);

    if (
      parsed.conversationId === conversationId &&
      (latest === undefined || parsed.segment > latest.segment)
    ) {
      latest = {metadata, segment: parsed.segment};
    }
  }

  return latest?.metadata;
}

async function insertSession(
  layout: LocalRuntimeStorageLayout,
  sessions: Map<string, LocalRuntimeSessionMetadata>,
  entry: {
    readonly sessionId: string;
    readonly createdAt: string;
  },
): Promise<LocalRuntimeSessionMetadata> {
  const metadata = createLocalRuntimeSessionMetadata({
    sessionId: entry.sessionId,
    createdAt: entry.createdAt,
  });
  const sessionDirectory = await createSessionDirectory(
    layout,
    entry.sessionId,
  );
  sessions.set(entry.sessionId, metadata);

  try {
    rewriteSessionCatalog(layout, sessions);
  } catch (error: unknown) {
    if (sessionDirectory.created) {
      await rollbackCreatedSessionDirectory(sessionDirectory.path, error);
    }

    throw errorFromUnknown(error);
  }

  return metadata;
}

async function discardEmptySessionFromCatalog(
  layout: LocalRuntimeStorageLayout,
  sessionId: string,
): Promise<void> {
  await withSessionCatalogMutationLock(layout, async () => {
    const sessions = await readSessionCatalog(layout);

    if (!sessions.has(sessionId)) {
      return;
    }

    const paths = createLocalRuntimeSessionPaths({
      storeRoot: layout.storeRoot,
      sessionId,
    });

    if (localRuntimeSessionDirectoryHasDurableEvidence(paths.sessionRoot)) {
      throw new LocalRuntimeSessionStoreError(
        'session_not_empty',
        `Local runtime session "${sessionId}" holds evidence and cannot be discarded.`,
      );
    }

    sessions.delete(sessionId);
    rewriteSessionCatalog(layout, sessions);
    // A torn opening record goes with the entry; an empty directory left
    // behind reads as an interrupted start, which the catalog tolerates.
    removePathSync(paths.rawEventsPath, {force: true});
    await removeDirectory(paths.sessionRoot);
  });
}

function compareSessionMetadata(
  left: LocalRuntimeSessionMetadata,
  right: LocalRuntimeSessionMetadata,
): number {
  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);

  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.sessionId.localeCompare(right.sessionId);
}

async function createSessionDirectory(
  layout: LocalRuntimeStorageLayout,
  sessionId: string,
): Promise<{readonly path: string; readonly created: boolean}> {
  const sessionRoot = createLocalRuntimeSessionPaths({
    storeRoot: layout.storeRoot,
    sessionId,
  }).sessionRoot;

  if (localRuntimeSessionDirectoryHasDurableEvidence(sessionRoot)) {
    throwMissingSessionCatalogEntry(sessionRoot);
  }

  try {
    await makeDirectory(sessionRoot);
    return {path: sessionRoot, created: true};
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'EEXIST')) {
      if (localRuntimeSessionDirectoryHasDurableEvidence(sessionRoot)) {
        throwMissingSessionCatalogEntry(sessionRoot);
      }

      return {path: sessionRoot, created: false};
    }

    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not prepare local runtime session directory: ${sessionRoot}.`,
      {cause: error},
    );
  }
}

async function rollbackCreatedSessionDirectory(
  sessionRoot: string,
  originalError: unknown,
): Promise<never> {
  try {
    await removeDirectory(sessionRoot);
  } catch (cleanupError: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not roll back local runtime session directory after catalog failure: ${sessionRoot}.`,
      {
        cause: new AggregateError(
          [cleanupError],
          'Session catalog rewrite failed and the new session directory could not be removed.',
          {cause: originalError},
        ),
      },
    );
  }

  throw errorFromUnknown(originalError);
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Local runtime session catalog rewrite failed.', {
        cause: error,
      });
}

function isLocalRuntimeStorageErrorCode(
  error: unknown,
  code: LocalRuntimeStorageContractError['code'],
): error is LocalRuntimeStorageContractError {
  return (
    error instanceof LocalRuntimeStorageContractError && error.code === code
  );
}
