import { createRuntimePluginManifest } from '../../manifest-validation.ts';
import type { RuntimePluginManifest } from '../../plugin-types.ts';
import type { RuntimePluginConfigActivationInspectShape } from '../../../runtime/config/types.ts';
import type { RuntimePluginConfigControlCapability } from '../../../runtime/config/index.ts';

export type RuntimePluginConfigControlHostState = {
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly activationByPluginId?: Readonly<
    Record<string, RuntimePluginConfigActivationInspectShape>
  >;
  readonly defaultEnabledPluginIds?: readonly string[];
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected by the composition root; plugins never import the functions. */
  readonly control?: RuntimePluginConfigControlCapability;
};

export function requiredRuntimePluginConfigControl(
  state: RuntimePluginConfigControlHostState
): RuntimePluginConfigControlCapability {
  if (state.control === undefined) {
    throw new Error(
      'Runtime plugin config tools require a host config-control capability.'
    );
  }

  return state.control;
}

export const runtimeConfigConflictErrorCode = 'runtime_config_conflict';

/**
 * Structural stand-in for `error instanceof RuntimeConfigConflictError`:
 * matches the stable `code` the runtime config mutation layer stamps on
 * conflict errors, so plugins need no value import of that layer.
 */
export function isRuntimeConfigConflictError(
  error: unknown
): error is Error & { readonly code: typeof runtimeConfigConflictErrorCode } {
  return (
    error instanceof Error &&
    (error as { readonly code?: unknown }).code ===
      runtimeConfigConflictErrorCode
  );
}

const runtimePluginConfigControlHostStateSnapshots =
  new WeakSet<RuntimePluginConfigControlHostState>();

export function createRuntimePluginConfigControlHostStateSnapshot(
  state: RuntimePluginConfigControlHostState
): RuntimePluginConfigControlHostState {
  if (runtimePluginConfigControlHostStateSnapshots.has(state)) {
    return state;
  }

  const pluginManifests = state.pluginManifests.map((manifest) =>
    createRuntimePluginManifest(manifest)
  );

  assertUniquePluginConfigControlManifestIds(pluginManifests);

  const snapshot = Object.freeze({
    pluginManifests: Object.freeze(pluginManifests),
    ...(state.activationByPluginId === undefined
      ? {}
      : {
          activationByPluginId: Object.freeze(
            Object.fromEntries(
              Object.entries(state.activationByPluginId).map(
                ([pluginId, activation]) => [
                  pluginId,
                  Object.freeze({
                    enabled: activation.enabled,
                    status: activation.status,
                    reasons: Object.freeze([...activation.reasons])
                  })
                ]
              )
            )
          )
        }),
    ...(state.defaultEnabledPluginIds === undefined
      ? {}
      : {
          defaultEnabledPluginIds: Object.freeze([
            ...new Set(state.defaultEnabledPluginIds)
          ])
        }),
    ...(state.configPath === undefined ? {} : { configPath: state.configPath }),
    ...(state.env === undefined
      ? {}
      : { env: Object.freeze({ ...state.env }) }),
    ...(state.control === undefined ? {} : { control: state.control })
  } satisfies RuntimePluginConfigControlHostState);

  runtimePluginConfigControlHostStateSnapshots.add(snapshot);
  return snapshot;
}

function assertUniquePluginConfigControlManifestIds(
  manifests: readonly RuntimePluginManifest[]
): void {
  const seenPluginIds = new Set<string>();

  for (const manifest of manifests) {
    if (seenPluginIds.has(manifest.id)) {
      throw new TypeError(
        `Plugin config control manifest id "${manifest.id}" is declared more than once.`
      );
    }

    seenPluginIds.add(manifest.id);
  }
}
