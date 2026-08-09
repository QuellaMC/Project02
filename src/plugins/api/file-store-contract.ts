import type {RuntimePluginFileStore} from './types.ts';

export type RuntimePluginFileStoreScope = 'session' | 'character';

type RuntimePluginFileStoreIdentity = {
  readonly sessionId: string;
  readonly pluginId: string;
  /**
   * Placement: per-session scratch (the default) or the plugin's
   * character-scoped cross-session data directory. sessionId always names
   * the calling session; character-scoped placement does not use it.
   */
  readonly scope?: RuntimePluginFileStoreScope;
};

type DurableRuntimePluginFileStoreOptions = RuntimePluginFileStoreIdentity & {
  readonly storeRoot: string;
  readonly sessionIdentity?: object;
};

export type InMemoryRuntimePluginFileStoreOptions =
  RuntimePluginFileStoreIdentity & {
    readonly storeRoot?: undefined;
    readonly sessionIdentity: object;
  };

export type CreateRuntimePluginFileStoreOptions =
  DurableRuntimePluginFileStoreOptions | InMemoryRuntimePluginFileStoreOptions;

export type RuntimePluginFileStorePathMode = 'json' | 'jsonl';

/** The composition root injects the engine, so the host never imports it. */
export type RuntimePluginFileStoreProvider = {
  readonly createFileStore: (
    options: CreateRuntimePluginFileStoreOptions,
  ) => RuntimePluginFileStore;
};
