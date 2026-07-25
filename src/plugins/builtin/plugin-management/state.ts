import {createRuntimePluginManifest} from '../../api/manifest-validation.ts';
import type {RuntimePluginManifest} from '../../api/types.ts';
import type {RuntimePluginConfigActivationInspectShape} from '../../../runtime/config/index.ts';
import type {RuntimePluginConfigControlCapability} from '../../../runtime/config/index.ts';
import type {ResolvedProject02RuntimeLocation} from '../../../runtime/config/index.ts';

/**
 * Manifest inventory a host can serve without any config mutation
 * capability: enough for runtime.plugin.list and activation display.
 */
export type RuntimePluginInventoryHostState = {
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly activationByPluginId?: Readonly<
    Record<string, RuntimePluginConfigActivationInspectShape>
  >;
  readonly defaultEnabledPluginIds?: readonly string[];
  readonly runtimeLocation?: ResolvedProject02RuntimeLocation;
  readonly env?: NodeJS.ProcessEnv;
};

/**
 * Inventory plus the config-control capability. The capability is part
 * of the type, so a control-less config-control state cannot be
 * expressed in TypeScript; the runtime guards below remain as the
 * backstop for untyped callers.
 */
export type RuntimePluginConfigControlHostState =
  RuntimePluginInventoryHostState & {
    readonly runtimeLocation: ResolvedProject02RuntimeLocation;
    readonly configScope: 'global' | 'character';
    /** Injected by the composition root; plugins never import the functions. */
    readonly control: RuntimePluginConfigControlCapability;
  };

/** Wide shape the runtime backstops accept: untyped callers may omit control. */
type MaybeRuntimePluginConfigControlHostState =
  RuntimePluginInventoryHostState & {
    readonly control?: RuntimePluginConfigControlCapability;
  };

export function requiredRuntimePluginConfigControl(
  state: MaybeRuntimePluginConfigControlHostState,
): RuntimePluginConfigControlCapability {
  if (state.control === undefined) {
    throw new Error(
      'Runtime plugin config tools require a host config-control capability.',
    );
  }

  return state.control;
}

/**
 * Fails plugin-management construction, not first tool invocation, when
 * config-control state carries no capability: every config tool handler
 * requires it, so a control-less state would advertise config tools to the
 * model that fail on each call. TypeScript callers cannot express that
 * state since control became a required property; this remains for
 * untyped callers, and the invocation-time check is the last backstop.
 */
export function assertRuntimePluginConfigControlCapabilityPresent(
  state: MaybeRuntimePluginConfigControlHostState,
): void {
  if (state.control !== undefined) {
    return;
  }

  throw new TypeError(
    'Runtime plugin config-control state was supplied without its host ' +
      'config-control capability ("control"). Attach control or compose the ' +
      'host through the configured plugin activation factory; pass ' +
      'pluginInventoryState instead for an inventory-only host.',
  );
}

export const runtimeConfigConflictErrorCode = 'runtime_config_conflict';

/**
 * Structural stand-in for `error instanceof RuntimeConfigConflictError`:
 * matches the stable `code` the runtime config mutation layer stamps on
 * conflict errors, so plugins need no value import of that layer.
 */
export function isRuntimeConfigConflictError(
  error: unknown,
): error is Error & {readonly code: typeof runtimeConfigConflictErrorCode} {
  return (
    error instanceof Error &&
    (error as {readonly code?: unknown}).code === runtimeConfigConflictErrorCode
  );
}

// One marker set per role: a config-control snapshot passed to the
// inventory helper must NOT short-circuit, or it would come back with
// its control capability still attached instead of stripped.
const runtimePluginInventoryHostStateSnapshots =
  new WeakSet<RuntimePluginInventoryHostState>();
const runtimePluginConfigControlHostStateSnapshots =
  new WeakSet<RuntimePluginConfigControlHostState>();

export function createRuntimePluginInventoryHostStateSnapshot(
  state: RuntimePluginInventoryHostState,
): RuntimePluginInventoryHostState {
  if (runtimePluginInventoryHostStateSnapshots.has(state)) {
    return state;
  }

  const snapshot = Object.freeze(inventoryHostStateSnapshotFields(state));

  runtimePluginInventoryHostStateSnapshots.add(snapshot);
  return snapshot;
}

export function createRuntimePluginConfigControlHostStateSnapshot(
  state: RuntimePluginConfigControlHostState,
): RuntimePluginConfigControlHostState {
  if (runtimePluginConfigControlHostStateSnapshots.has(state)) {
    return state;
  }

  const snapshot = Object.freeze({
    ...inventoryHostStateSnapshotFields(state),
    runtimeLocation: state.runtimeLocation,
    configScope: state.configScope,
    control: state.control,
  } satisfies RuntimePluginConfigControlHostState);

  runtimePluginConfigControlHostStateSnapshots.add(snapshot);
  return snapshot;
}

function inventoryHostStateSnapshotFields(
  state: RuntimePluginInventoryHostState,
): RuntimePluginInventoryHostState {
  const pluginManifests = state.pluginManifests.map(manifest =>
    createRuntimePluginManifest(manifest),
  );

  assertUniquePluginConfigControlManifestIds(pluginManifests);

  return {
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
                    reasons: Object.freeze([...activation.reasons]),
                  }),
                ],
              ),
            ),
          ),
        }),
    ...(state.defaultEnabledPluginIds === undefined
      ? {}
      : {
          defaultEnabledPluginIds: Object.freeze([
            ...new Set(state.defaultEnabledPluginIds),
          ]),
        }),
    ...(state.runtimeLocation === undefined
      ? {}
      : {runtimeLocation: state.runtimeLocation}),
    ...(state.env === undefined ? {} : {env: Object.freeze({...state.env})}),
  };
}

function assertUniquePluginConfigControlManifestIds(
  manifests: readonly RuntimePluginManifest[],
): void {
  const seenPluginIds = new Set<string>();

  for (const manifest of manifests) {
    if (seenPluginIds.has(manifest.id)) {
      throw new TypeError(
        `Plugin config control manifest id "${manifest.id}" is declared more than once.`,
      );
    }

    seenPluginIds.add(manifest.id);
  }
}
