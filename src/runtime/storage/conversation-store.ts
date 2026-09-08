import {basename, dirname, join} from 'node:path';

import {
  conversationParticipantKindValues,
  ConversationValidationError,
  createConversation,
  sameConversationParticipants,
  type Conversation,
  type ConversationParticipant,
} from '../../core/index.ts';
import {
  listDirectoryEntries,
  makeDirectory,
  type Dirent,
} from '../../shared/file-system.ts';
import {isOneOf} from '../../shared/one-of.ts';
import {describeRealEntry} from '../../shared/real-path.ts';
import {atomicReplaceFileSync} from './atomic-file.ts';
import {
  assertProject02HomeAdoptableSync,
  ensureInitializedProject02Home,
} from './home.ts';
import {
  conversationFileName,
  createLocalRuntimeConversationPaths,
  createProject02HomeLayout,
  LocalRuntimeStorageContractError,
  normalizeConversationId,
  parseJsonObject,
  requiredRecordString,
  type Project02HomeLayout,
} from './layout-contract.ts';
import {
  acquireLocalRuntimeMutationLock,
  type LocalRuntimeMutationLockLease,
  type LocalRuntimeMutationLockOwnerToken,
} from './mutation-lock.ts';
import {readStorageSchemaMarker} from './schema-marker.ts';
import {readStoreText} from './store-file.ts';

const conversationsCatalogLockResourceKey = 'conversations-catalog';

type LocalRuntimeConversationStoreErrorCode =
  'conversation_already_exists' | 'conversation_not_found';

export class LocalRuntimeConversationStoreError extends Error {
  readonly code: LocalRuntimeConversationStoreErrorCode;

  constructor(code: LocalRuntimeConversationStoreErrorCode, message: string) {
    super(message);
    this.name = 'LocalRuntimeConversationStoreError';
    this.code = code;
  }
}

export type CreateLocalRuntimeConversationOptions = {
  readonly id?: string;
  readonly participants: readonly ConversationParticipant[];
  readonly createdAt?: string;
};

export type LocalRuntimeConversationStore = {
  readonly layout: Project02HomeLayout;
  createConversation(
    options: CreateLocalRuntimeConversationOptions,
  ): Promise<Conversation>;
  /** The one thread for this set of contacts, created on first use. */
  ensureConversationWith(
    participants: readonly ConversationParticipant[],
  ): Promise<Conversation>;
  findConversationWith(
    participants: readonly ConversationParticipant[],
  ): Promise<Conversation | undefined>;
  readConversation(conversationId: string): Promise<Conversation>;
  listConversations(): Promise<readonly Conversation[]>;
};

export type CreateLocalRuntimeConversationStoreOptions = {
  readonly homeRoot?: string;
  readonly now?: () => string;
};

/** One process owns an open conversation; reacquiring under the same owner
 * token is reentrant, anyone else is refused immediately. */
export async function acquireLocalRuntimeConversationWriterLease(options: {
  readonly homeRoot?: string;
  readonly conversationId: string;
  readonly ownerToken?: LocalRuntimeMutationLockOwnerToken;
}): Promise<LocalRuntimeMutationLockLease> {
  const layout = createProject02HomeLayout(
    options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot},
  );

  assertProject02HomeAdoptableSync({homeRoot: layout.homeRoot});

  return await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: `conversation-writer:${normalizeConversationId(
      options.conversationId,
    )}`,
    waitTimeoutMs: 0,
    busyCode: 'conversation_busy',
    ...(options.ownerToken === undefined
      ? {}
      : {ownerToken: options.ownerToken}),
  });
}

export function createLocalRuntimeConversationStore(
  options: CreateLocalRuntimeConversationStoreOptions = {},
): LocalRuntimeConversationStore {
  const layout = createProject02HomeLayout(
    options.homeRoot === undefined ? {} : {homeRoot: options.homeRoot},
  );
  const now = options.now ?? (() => new Date().toISOString());

  async function createConversationInStore(
    createOptions: CreateLocalRuntimeConversationOptions,
  ): Promise<Conversation> {
    return await withConversationsCatalogLock(layout, async () => {
      return await insertConversation(layout, createOptions, now);
    });
  }

  async function ensureConversationWith(
    participants: readonly ConversationParticipant[],
  ): Promise<Conversation> {
    return await withConversationsCatalogLock(layout, async () => {
      const existing = findByParticipants(
        await readConversationsCatalog(layout),
        participants,
      );

      return (
        existing ?? (await insertConversation(layout, {participants}, now))
      );
    });
  }

  async function findConversationWith(
    participants: readonly ConversationParticipant[],
  ): Promise<Conversation | undefined> {
    return findByParticipants(
      await readConversationsCatalog(layout),
      participants,
    );
  }

  async function readConversation(
    conversationId: string,
  ): Promise<Conversation> {
    const paths = createLocalRuntimeConversationPaths({
      homeRoot: layout.homeRoot,
      conversationId,
    });

    const conversation = assertConversationsReadable(layout)
      ? decodeConversationDirectory(paths.conversationRoot)
      : undefined;

    if (conversation === undefined) {
      throw new LocalRuntimeConversationStoreError(
        'conversation_not_found',
        `Conversation "${paths.conversationId}" does not exist.`,
      );
    }

    // The read is synchronous; the store's callers still receive a promise,
    // and a failure above still reaches them as a rejection.
    return Promise.resolve(conversation);
  }

  async function listConversations(): Promise<readonly Conversation[]> {
    const conversations = [...(await readConversationsCatalog(layout))];

    conversations.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    );

    return Object.freeze(conversations);
  }

  return Object.freeze({
    layout,
    createConversation: createConversationInStore,
    ensureConversationWith,
    findConversationWith,
    readConversation,
    listConversations,
  } satisfies LocalRuntimeConversationStore);
}

async function insertConversation(
  layout: Project02HomeLayout,
  options: CreateLocalRuntimeConversationOptions,
  now: () => string,
): Promise<Conversation> {
  const conversations = await readConversationsCatalog(layout);
  const duplicate = findByParticipants(conversations, options.participants);

  if (duplicate !== undefined) {
    throw new LocalRuntimeConversationStoreError(
      'conversation_already_exists',
      `Conversation "${duplicate.id}" already exists for these participants.`,
    );
  }

  let conversation: Conversation;

  try {
    conversation = createConversation({
      id:
        options.id === undefined
          ? generatedConversationId()
          : normalizeConversationId(options.id),
      participants: options.participants,
      createdAt: options.createdAt ?? now(),
    });
  } catch (error: unknown) {
    if (error instanceof ConversationValidationError) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        error.message,
      );
    }

    throw error;
  }

  const paths = createLocalRuntimeConversationPaths({
    homeRoot: layout.homeRoot,
    conversationId: conversation.id,
  });

  // A conversation exists once its file does: a directory without one is an
  // interrupted create, and writing the file completes it.
  if (decodeConversationDirectory(paths.conversationRoot) !== undefined) {
    throw new LocalRuntimeConversationStoreError(
      'conversation_already_exists',
      `Conversation "${conversation.id}" already exists.`,
    );
  }

  await ensureInitializedProject02Home({homeRoot: layout.homeRoot});

  try {
    await makeDirectory(paths.conversationRoot, {recursive: true});
    atomicReplaceFileSync({
      targetPath: paths.conversationPath,
      content: `${JSON.stringify(conversation)}\n`,
      mode: 0o600,
    });
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'write_failed',
      `Could not write local runtime conversation: ${paths.conversationPath}.`,
      {cause: error},
    );
  }

  return conversation;
}

function generatedConversationId(): string {
  return `conv_${crypto.randomUUID()}`;
}

function findByParticipants(
  conversations: readonly Conversation[],
  participants: readonly ConversationParticipant[],
): Conversation | undefined {
  return conversations.find(conversation =>
    sameConversationParticipants(conversation.participants, participants),
  );
}

async function withConversationsCatalogLock<Result>(
  layout: Project02HomeLayout,
  operation: () => Promise<Result>,
): Promise<Result> {
  assertProject02HomeAdoptableSync({homeRoot: layout.homeRoot});

  const lease = await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: conversationsCatalogLockResourceKey,
  });

  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

/**
 * The directory scan is the catalog: one file per conversation, no second
 * index to drift. An interrupted create (directory without its file) is
 * invisible; anything else malformed fails closed.
 */
async function readConversationsCatalog(
  layout: Project02HomeLayout,
): Promise<readonly Conversation[]> {
  if (!assertConversationsReadable(layout)) {
    return Object.freeze([]);
  }

  let entries;

  try {
    entries = await listDirectoryEntries(layout.conversationsRoot);
  } catch (error: unknown) {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Conversations root "${layout.conversationsRoot}" could not be read.`,
      {cause: error},
    );
  }

  const conversations: Conversation[] = [];

  for (const entry of entries) {
    if (isOperatingSystemMetadataEntry(entry)) {
      continue;
    }

    const conversationRoot = join(layout.conversationsRoot, entry.name);
    const conversation = decodeConversationDirectory(conversationRoot);

    if (conversation !== undefined) {
      conversations.push(conversation);
    }
  }

  return Object.freeze(conversations);
}

/** False means the home holds no conversations yet; version errors throw. */
function assertConversationsReadable(layout: Project02HomeLayout): boolean {
  const marker = readStorageSchemaMarker({schemaPath: layout.schemaPath});

  if (marker === undefined) {
    return false;
  }

  // The marker codec already fails closed on any other schema version.
  if (marker.scope !== 'home') {
    throw new LocalRuntimeStorageContractError(
      'malformed_schema_marker',
      `Directory "${layout.homeRoot}" is a "${marker.scope}" directory, not a Project02 home.`,
    );
  }

  const root = describeRealEntry(layout.conversationsRoot);

  if (root.kind === 'absent') {
    return false;
  }

  if (root.kind !== 'directory') {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Conversations root "${layout.conversationsRoot}" must be a real directory inside the home.`,
    );
  }

  return true;
}

/** Undefined: no such thread, or an interrupted create left no file. */
function decodeConversationDirectory(
  conversationRoot: string,
): Conversation | undefined {
  const root = describeRealEntry(conversationRoot);

  if (root.kind === 'absent') {
    return undefined;
  }

  if (root.kind !== 'directory') {
    throw new LocalRuntimeStorageContractError(
      'read_failed',
      `Conversation directory "${conversationRoot}" must be a real directory inside the home.`,
    );
  }

  const conversationPath = join(conversationRoot, conversationFileName);
  const file = describeRealEntry(conversationPath);

  if (file.kind === 'absent') {
    return undefined;
  }

  if (file.kind !== 'file') {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Conversation "${conversationRoot}" must hold ${conversationFileName} as a real file.`,
    );
  }

  return decodeConversation(conversationPath, readStoreText(conversationPath));
}

export function decodeConversation(
  conversationPath: string,
  content: string,
): Conversation {
  const record = parseJsonObject(content.trim(), 'malformed_record');
  const participants = record['participants'];

  if (
    !Array.isArray(participants) ||
    !participants.every(isConversationParticipantRecord)
  ) {
    throw new LocalRuntimeStorageContractError(
      'malformed_record',
      `Stored conversation "${conversationPath}" has malformed participants.`,
    );
  }

  try {
    const conversation = createConversation({
      id: requiredRecordString(record, 'id', 'malformed_record'),
      participants,
      createdAt: requiredRecordString(record, 'createdAt', 'malformed_record'),
    });

    if (conversation.id !== basename(dirname(conversationPath))) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Conversation record in "${conversationPath}" names "${conversation.id}", not its own directory.`,
      );
    }

    return conversation;
  } catch (error: unknown) {
    if (
      error instanceof ConversationValidationError ||
      error instanceof TypeError
    ) {
      throw new LocalRuntimeStorageContractError(
        'malformed_record',
        `Stored conversation "${conversationPath}" is malformed: ${error.message}`,
      );
    }

    throw error;
  }
}

function isConversationParticipantRecord(
  value: unknown,
): value is ConversationParticipant {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    isOneOf(record['kind'], conversationParticipantKindValues) &&
    typeof record['id'] === 'string' &&
    typeof record['displayName'] === 'string'
  );
}

/** Finder drops .DS_Store into any browsed directory; it is not a thread. */
function isOperatingSystemMetadataEntry(entry: Dirent): boolean {
  return entry.name === '.DS_Store';
}
