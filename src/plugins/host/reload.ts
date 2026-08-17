/** A reload problem never undoes the written change; the old instance keeps serving. */
import {registeredRuntimePluginLifecycleHooks} from '../api/index.ts';
import type {RuntimePlugin, RuntimePluginConfigField} from '../api/index.ts';
import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';

export type RuntimePluginReloadResult =
  | {readonly status: 'rebuilt'; readonly plugin: RuntimePlugin}
  | {readonly status: 'declined'; readonly reason: string}
  | {readonly status: 'failed'; readonly message: string};

/** Injected: the host cannot import config resolution or package catalog. */
export type RuntimePluginReloader = {
  reload(
    pluginId: string,
    options: {
      /** The reloader declines when the authored file has moved past this. */
      readonly expectedFingerprint: string;
      /** Hands the factory result to the host before anything that can fail. */
      readonly retainCandidate: (plugin: RuntimePlugin) => void;
    },
  ): Promise<RuntimePluginReloadResult>;
};

export type RuntimePluginConfigLiveApplyOutcome =
  | {readonly status: 'live'}
  | {readonly status: 'restart_required'}
  | {readonly status: 'declined'; readonly reason: string}
  | {readonly status: 'failed'; readonly message: string};

/** Brings a written config change into the running host, or says why not. */
export type RuntimePluginConfigLiveApply = (change: {
  readonly pluginId: string;
  readonly field: RuntimePluginConfigField;
  /** The authored fingerprint after the write; the reloader rebuilds only against it. */
  readonly configFingerprint: string;
}) => Promise<RuntimePluginConfigLiveApplyOutcome>;

/**
 * One per host, for the life of the process: it remembers which plugins took
 * a restart-only change, because rebuilding one of those live would apply that
 * change early. It never rejects — a reload problem is an outcome, not an
 * error, and the write it follows already happened.
 */
export function createRuntimePluginConfigLiveApply(options: {
  readonly reloader: RuntimePluginReloader | undefined;
  readonly livePlugins: () => readonly RuntimePlugin[];
  readonly swapEnabledPlugin: (
    next: RuntimePlugin,
  ) => RuntimePlugin | undefined;
  readonly retirePlugin: (
    plugin: RuntimePlugin,
    catalogPluginId: string,
  ) => void;
  /** Keeps terminal dispatch behind every reload, settled or abandoned. */
  readonly trackWork: <T>(work: Promise<T>) => Promise<T>;
  /** Once terminal dispatch owns the instances, nothing new may go live. */
  readonly closed: () => boolean;
}): RuntimePluginConfigLiveApply {
  const restartPendingPluginIds = new Set<string>();

  return async change => {
    if (change.field.reloadRequired !== false) {
      restartPendingPluginIds.add(change.pluginId);
      return {status: 'restart_required'};
    }

    if (restartPendingPluginIds.has(change.pluginId)) {
      return {
        status: 'declined',
        reason:
          'an earlier change to this plugin waits for a restart, and rebuilding it live would apply that change early',
      };
    }

    return await options.trackWork(
      rebuildLivePlugin({
        ...options,
        pluginId: change.pluginId,
        configFingerprint: change.configFingerprint,
      }),
    );
  };
}

async function rebuildLivePlugin(options: {
  readonly pluginId: string;
  readonly configFingerprint: string;
  readonly reloader: RuntimePluginReloader | undefined;
  readonly livePlugins: () => readonly RuntimePlugin[];
  readonly swapEnabledPlugin: (
    next: RuntimePlugin,
  ) => RuntimePlugin | undefined;
  readonly retirePlugin: (
    plugin: RuntimePlugin,
    catalogPluginId: string,
  ) => void;
  readonly trackWork: <T>(work: Promise<T>) => Promise<T>;
  readonly closed: () => boolean;
}): Promise<RuntimePluginConfigLiveApplyOutcome> {
  if (options.reloader === undefined) {
    return {status: 'declined', reason: 'this host has no plugin reloader'};
  }

  if (options.closed()) {
    return {status: 'declined', reason: 'the host is shutting down'};
  }

  const previous = options
    .livePlugins()
    .find(plugin => plugin.manifest.id === options.pluginId);

  if (previous === undefined) {
    return {status: 'declined', reason: 'the plugin is not enabled'};
  }

  let reloaded: RuntimePluginReloadResult;

  try {
    // Tracked on its own too: a factory that outlives the timeout is still
    // in flight, and quiesce must wait for its candidate to be retired.
    reloaded = await settleReloadWithinTimeout(
      options.trackWork(
        options.reloader.reload(options.pluginId, {
          expectedFingerprint: options.configFingerprint,
          retainCandidate: instance => {
            options.retirePlugin(instance, options.pluginId);
          },
        }),
      ),
    );
  } catch (error: unknown) {
    reloaded = {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Plugin reload failed.',
    };
  }

  if (reloaded.status === 'declined') {
    return {status: 'declined', reason: reloaded.reason};
  }

  if (reloaded.status === 'failed') {
    return {status: 'failed', message: reloaded.message};
  }

  if (rebuiltPluginChangesFrozenSurface(previous, reloaded.plugin)) {
    return {
      status: 'declined',
      reason: 'the rebuilt plugin changed its manifest, hook, or tool surface',
    };
  }

  // Shutdown may have started while the factory ran; the candidate was
  // retired on arrival and must not be published.
  if (options.closed()) {
    return {status: 'declined', reason: 'the host is shutting down'};
  }

  if (options.swapEnabledPlugin(reloaded.plugin) === undefined) {
    return {status: 'declined', reason: 'the plugin left the host'};
  }

  return {status: 'live'};
}

export const runtimePluginReloadTimeoutMs = 10_000;

/** A factory that never settles must not hold the tool call open. */
async function settleReloadWithinTimeout(
  pending: Promise<RuntimePluginReloadResult>,
): Promise<RuntimePluginReloadResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RuntimePluginReloadResult>(resolve => {
    timeoutId = setTimeout(() => {
      resolve({
        status: 'failed',
        message: `the reloader did not settle within ${String(runtimePluginReloadTimeoutMs)}ms`,
      });
    }, runtimePluginReloadTimeoutMs);
  });

  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

/** A swap must not strand advertised tools or add unadvertised behavior. */
function rebuiltPluginChangesFrozenSurface(
  previous: RuntimePlugin,
  rebuilt: RuntimePlugin,
): boolean {
  return (
    !canonicalJsonValuesEqual(rebuilt.manifest, previous.manifest) ||
    !canonicalJsonValuesEqual(rebuilt.providedTools, previous.providedTools) ||
    !canonicalJsonValuesEqual(
      registeredRuntimePluginLifecycleHooks(rebuilt),
      registeredRuntimePluginLifecycleHooks(previous),
    )
  );
}
