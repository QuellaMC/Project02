import { runtimePluginGrantsAccess } from './access-control.ts';
import type {
  RuntimePluginFileStoreProvider,
  RuntimePluginFileStoreTransaction
} from './file-store/contracts.ts';
import { sideEffectLevelAllowsFileStoreWrites } from './tool-policy.ts';
import type {
  RuntimePlugin,
  RuntimePluginAfterTurnCommittedContext,
  RuntimePluginContext,
  RuntimePluginFileStore
} from './plugin-types.ts';
import type { RuntimePluginAccessSnapshot } from './contract.ts';

export type PluginHookContextScope<TContext extends RuntimePluginContext> = {
  readonly context: TContext;
  readonly revokeFileStoreWrites: () => void;
};

type RevocableRuntimePluginFileStore = {
  readonly fileStore: RuntimePluginFileStore;
  revokeWrites(): void;
};

export function createPluginHookContext<TContext extends RuntimePluginContext>(
  options: {
    readonly context: TContext;
    readonly plugin: RuntimePlugin;
    readonly access: RuntimePluginAccessSnapshot;
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
    readonly storeRoot?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly sessionIdentity?: object | undefined;
    readonly allowFileStoreWrites?: boolean | undefined;
    readonly fileStoreTransaction?: RuntimePluginFileStoreTransaction | undefined;
    readonly createFileStore?:
      | RuntimePluginFileStoreProvider['createFileStore']
      | undefined;
  }
): PluginHookContextScope<TContext> {
  const grantsFileStore = runtimePluginGrantsAccess({
    access: options.access,
    accessName: 'file_store',
    requiredAccess: 'read'
  });
  const sessionId = options.sessionId ?? options.context.sessionId;
  const allowWrites =
    runtimePluginGrantsAccess({
      access: options.access,
      accessName: 'file_store',
      requiredAccess: 'write'
    }) &&
    (options.allowFileStoreWrites ??
      sideEffectLevelAllowsFileStoreWrites(
        options.plugin.manifest.runtimePolicy.sideEffectLevel
      ));
  const baseFileStore = grantsFileStore
    ? (options.fileStoreTransaction?.fileStoreFor({
        ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
        sessionId,
        ...(options.sessionIdentity === undefined
          ? {}
          : { sessionIdentity: options.sessionIdentity }),
        pluginId: options.plugin.manifest.id
      }) ??
      options.createFileStore?.({
        ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
        sessionId,
        ...(options.sessionIdentity === undefined
          ? {}
          : { sessionIdentity: options.sessionIdentity }),
        pluginId: options.plugin.manifest.id
      }))
    : undefined;

  if (grantsFileStore && baseFileStore === undefined) {
    throw new Error(
      `Plugin "${options.plugin.manifest.id}" has file_store access, but the ` +
        'host was created without a file-store provider.'
    );
  }

  const fileStore =
    baseFileStore === undefined
      ? undefined
      : createRevocableRuntimePluginFileStore(baseFileStore, { allowWrites });
  const {
    fileStore: inheritedFileStore,
    ...contextWithoutInheritedFileStore
  } = options.context;
  void inheritedFileStore;
  const contextWithScrubbedTurn = runtimePluginGrantsAccess({
    access: options.access,
    accessName: 'turn_context',
    requiredAccess: 'read'
  })
    ? contextWithoutInheritedFileStore
    : scrubRuntimePluginTurnContext(contextWithoutInheritedFileStore);
  // Preserve the hook context subtype while making fileStore injection entirely host-controlled.
  const context = Object.freeze({
    ...contextWithScrubbedTurn,
    pluginId: options.plugin.manifest.id,
    deadlineAt: options.deadlineAt,
    signal: options.signal,
    ...(fileStore === undefined ? {} : { fileStore: fileStore.fileStore })
  }) as TContext;

  return Object.freeze({
    context,
    revokeFileStoreWrites: () => {
      fileStore?.revokeWrites();
    }
  });
}

export const scrubbedRuntimePluginCurrentUserMessage = '';

function scrubRuntimePluginTurnContext<TContext extends RuntimePluginContext>(
  context: Omit<TContext, 'fileStore'>
): Omit<TContext, 'fileStore'> {
  // Empty currentUserMessage intentionally represents no turn_context.read grant.
  const baseContext = {
    ...context,
    currentUserMessage: scrubbedRuntimePluginCurrentUserMessage
  };

  if ('committedTurn' in context) {
    const committedTurn = (context as RuntimePluginAfterTurnCommittedContext)
      .committedTurn;

    // Empty visible turn arrays intentionally represent no turn_context.read grant.
    return Object.freeze({
      ...baseContext,
      committedTurn: Object.freeze({
        ...committedTurn,
        visibleMessageIds: Object.freeze([]),
        visibleMessages: Object.freeze([])
      })
    }) as unknown as Omit<TContext, 'fileStore'>;
  }

  return Object.freeze(baseContext) as unknown as Omit<TContext, 'fileStore'>;
}

function createRevocableRuntimePluginFileStore(
  fileStore: RuntimePluginFileStore,
  options: { readonly allowWrites: boolean }
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
          writesRevoked
        });
        fileStore.writeJsonAtomic(path, value);
      },
      appendJsonl(path, value) {
        assertPluginFileStoreWritesAllowed({
          allowWrites: options.allowWrites,
          writesRevoked
        });
        fileStore.appendJsonl(path, value);
      },
      revision() {
        return fileStore.revision();
      }
    } satisfies RuntimePluginFileStore),
    revokeWrites() {
      writesRevoked = true;
    }
  } satisfies RevocableRuntimePluginFileStore);
}

function assertPluginFileStoreWritesAllowed(options: {
  readonly allowWrites: boolean;
  readonly writesRevoked: boolean;
}): void {
  if (!options.allowWrites) {
    throw new Error(
      'Plugin fileStore writes are not allowed for read-only tool invocations.'
    );
  }

  if (options.writesRevoked) {
    throw new Error(
      'Plugin fileStore writes are no longer allowed after hook completion.'
    );
  }
}
