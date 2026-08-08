import {runtimePluginGrantsAccess} from '../policy/access-control.ts';
import type {
  RuntimePluginDatabaseOpener,
  RuntimePluginDatabaseProvider,
} from '../api/database-contract.ts';
import type {
  RuntimePluginFileStoreProvider,
  RuntimePluginFileStoreScope,
} from '../api/file-store-contract.ts';
import type {RuntimePluginSessionHistoryFeed} from '../api/session-history-contract.ts';
import type {
  RuntimePlugin,
  RuntimePluginAfterTurnCommittedContext,
  RuntimePluginContext,
  RuntimePluginFileStore,
} from '../api/types.ts';
import type {RuntimePluginAccessSnapshot} from '../api/contract.ts';

type PluginHookContextScope<TContext extends RuntimePluginContext> = {
  readonly context: TContext;
  readonly revokeFileStoreWrites: () => void;
};

type RevocableRuntimePluginFileStore = {
  readonly fileStore: RuntimePluginFileStore;
  revokeWrites(): void;
};

type PluginHookFileStoreOptions = {
  readonly access: RuntimePluginAccessSnapshot;
  readonly pluginId: string;
  readonly sessionId: string;
  readonly storeRoot?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly allowFileStoreWrites?: boolean | undefined;
  readonly createFileStore?:
    RuntimePluginFileStoreProvider['createFileStore'] | undefined;
};

type InheritedCapabilityContextFields =
  'fileStore' | 'characterFileStore' | 'sessionHistory' | 'pluginDatabase';

export function createPluginHookContext<
  TContext extends RuntimePluginContext,
>(options: {
  readonly context: TContext;
  readonly plugin: RuntimePlugin;
  readonly pluginId?: string | undefined;
  readonly access: RuntimePluginAccessSnapshot;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly storeRoot?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionIdentity?: object | undefined;
  readonly allowFileStoreWrites?: boolean | undefined;
  readonly createFileStore?:
    RuntimePluginFileStoreProvider['createFileStore'] | undefined;
  readonly sessionHistory?: RuntimePluginSessionHistoryFeed | undefined;
  readonly openPluginDatabase?:
    RuntimePluginDatabaseProvider['openPluginDatabase'] | undefined;
}): PluginHookContextScope<TContext> {
  const pluginId = options.pluginId ?? options.plugin.manifest.id;
  const fileStoreOptions: PluginHookFileStoreOptions = {
    access: options.access,
    pluginId,
    sessionId: options.sessionId ?? options.context.sessionId,
    storeRoot: options.storeRoot,
    sessionIdentity: options.sessionIdentity,
    allowFileStoreWrites: options.allowFileStoreWrites,
    createFileStore: options.createFileStore,
  };
  const fileStore = grantedRevocableRuntimePluginFileStore(
    fileStoreOptions,
    'file_store',
    'session',
  );
  const characterFileStore = grantedRevocableRuntimePluginFileStore(
    fileStoreOptions,
    'character_file_store',
    'character',
  );
  const sessionHistory = grantedSessionHistoryFeed(options);
  const pluginDatabase = grantedPluginDatabaseOpener(options, pluginId);
  const {
    fileStore: inheritedFileStore,
    characterFileStore: inheritedCharacterFileStore,
    sessionHistory: inheritedSessionHistory,
    pluginDatabase: inheritedPluginDatabase,
    ...contextWithoutInheritedFileStores
  } = options.context;

  void inheritedFileStore;
  void inheritedCharacterFileStore;
  void inheritedSessionHistory;
  void inheritedPluginDatabase;

  const contextWithScrubbedTurn = runtimePluginGrantsAccess({
    access: options.access,
    accessName: 'turn_context',
    requiredAccess: 'read',
  })
    ? contextWithoutInheritedFileStores
    : scrubRuntimePluginTurnContext(contextWithoutInheritedFileStores);
  // The cast preserves the hook context subtype; both stores stay
  // host-injected.
  const context = Object.freeze({
    ...contextWithScrubbedTurn,
    pluginId,
    deadlineAt: options.deadlineAt,
    signal: options.signal,
    ...(fileStore === undefined ? {} : {fileStore: fileStore.fileStore}),
    ...(characterFileStore === undefined
      ? {}
      : {characterFileStore: characterFileStore.fileStore}),
    ...(sessionHistory === undefined ? {} : {sessionHistory}),
    ...(pluginDatabase === undefined ? {} : {pluginDatabase}),
  }) as TContext;

  return Object.freeze({
    context,
    revokeFileStoreWrites: () => {
      fileStore?.revokeWrites();
      characterFileStore?.revokeWrites();
    },
  });
}

function grantedRevocableRuntimePluginFileStore(
  options: PluginHookFileStoreOptions,
  accessName: 'file_store' | 'character_file_store',
  scope: RuntimePluginFileStoreScope,
): RevocableRuntimePluginFileStore | undefined {
  const granted = runtimePluginGrantsAccess({
    access: options.access,
    accessName,
    requiredAccess: 'read',
  });

  if (!granted) {
    return undefined;
  }

  const baseFileStore = options.createFileStore?.({
    ...(options.storeRoot === undefined ? {} : {storeRoot: options.storeRoot}),
    sessionId: options.sessionId,
    ...(options.sessionIdentity === undefined
      ? {}
      : {sessionIdentity: options.sessionIdentity}),
    pluginId: options.pluginId,
    scope,
  });

  if (baseFileStore === undefined) {
    throw new Error(
      `Plugin "${options.pluginId}" has ${accessName} access, but the ` +
        'host was created without a file-store provider.',
    );
  }

  const allowWrites =
    runtimePluginGrantsAccess({
      access: options.access,
      accessName,
      requiredAccess: 'write',
    }) &&
    (options.allowFileStoreWrites ?? true);

  return createRevocableRuntimePluginFileStore(baseFileStore, {allowWrites});
}

function grantedSessionHistoryFeed(options: {
  readonly access: RuntimePluginAccessSnapshot;
  readonly sessionHistory?: RuntimePluginSessionHistoryFeed | undefined;
}): RuntimePluginSessionHistoryFeed | undefined {
  if (
    !runtimePluginGrantsAccess({
      access: options.access,
      accessName: 'session_history',
      requiredAccess: 'read',
    })
  ) {
    return undefined;
  }

  // A host without a feed (minimal test hosts) yields an absent
  // capability; the plugin answers with its own unavailable rejection.
  return options.sessionHistory;
}

function grantedPluginDatabaseOpener(
  options: {
    readonly access: RuntimePluginAccessSnapshot;
    readonly openPluginDatabase?:
      RuntimePluginDatabaseProvider['openPluginDatabase'] | undefined;
  },
  pluginId: string,
): RuntimePluginDatabaseOpener | undefined {
  if (
    !runtimePluginGrantsAccess({
      access: options.access,
      accessName: 'plugin_database',
      requiredAccess: 'write',
    })
  ) {
    return undefined;
  }

  const openPluginDatabase = options.openPluginDatabase;

  if (openPluginDatabase === undefined) {
    return undefined;
  }

  return databaseOptions => openPluginDatabase({...databaseOptions, pluginId});
}

const scrubbedRuntimePluginCurrentUserMessage = '';

function scrubRuntimePluginTurnContext<TContext extends RuntimePluginContext>(
  context: Omit<TContext, InheritedCapabilityContextFields>,
): Omit<TContext, InheritedCapabilityContextFields> {
  // Empty currentUserMessage represents no turn_context.read grant.
  const baseContext = {
    ...context,
    currentUserMessage: scrubbedRuntimePluginCurrentUserMessage,
  };

  if ('committedTurn' in context) {
    const committedTurn = (context as RuntimePluginAfterTurnCommittedContext)
      .committedTurn;

    return Object.freeze({
      ...baseContext,
      committedTurn: Object.freeze({
        ...committedTurn,
        visibleMessageIds: Object.freeze([]),
        visibleMessages: Object.freeze([]),
      }),
    }) as unknown as Omit<TContext, InheritedCapabilityContextFields>;
  }

  return Object.freeze(baseContext) as unknown as Omit<
    TContext,
    InheritedCapabilityContextFields
  >;
}

function createRevocableRuntimePluginFileStore(
  fileStore: RuntimePluginFileStore,
  options: {readonly allowWrites: boolean},
): RevocableRuntimePluginFileStore {
  let writesRevoked = false;

  return Object.freeze({
    fileStore: Object.freeze({
      readJson(path) {
        return fileStore.readJson(path);
      },
      readJsonl(path) {
        return fileStore.readJsonl(path);
      },
      writeJsonAtomic(path, value) {
        assertPluginFileStoreWritesAllowed({
          allowWrites: options.allowWrites,
          writesRevoked,
        });
        fileStore.writeJsonAtomic(path, value);
      },
      appendJsonl(path, value) {
        assertPluginFileStoreWritesAllowed({
          allowWrites: options.allowWrites,
          writesRevoked,
        });
        fileStore.appendJsonl(path, value);
      },
      revision() {
        return fileStore.revision();
      },
    } satisfies RuntimePluginFileStore),
    revokeWrites() {
      writesRevoked = true;
    },
  } satisfies RevocableRuntimePluginFileStore);
}

function assertPluginFileStoreWritesAllowed(options: {
  readonly allowWrites: boolean;
  readonly writesRevoked: boolean;
}): void {
  if (!options.allowWrites) {
    throw new Error(
      'Plugin fileStore writes are not allowed for read-only tool invocations.',
    );
  }

  if (options.writesRevoked) {
    throw new Error(
      'Plugin fileStore writes are no longer allowed after hook completion.',
    );
  }
}
