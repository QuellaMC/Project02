import {createRuntimePluginManifest} from '../../api/manifest-validation.ts';
import type {RuntimePluginManifest} from '../../api/types.ts';
import type {RuntimePluginConfigActivationInspectShape} from '../../../runtime/config/index.ts';
import type {RuntimePluginConfigControlCapability} from '../../../runtime/config/index.ts';
import {
  requireResolvedRuntimeConfigScopeTarget,
  type ResolvedRuntimeConfigScopeTarget,
} from '../../../runtime/config/index.ts';

/** Manifest inventory a host serves without any config mutation capability. */
export type RuntimePluginInventoryHostState = {
  readonly pluginManifests: readonly RuntimePluginManifest[];
  readonly activationByPluginId?: Readonly<
    Record<string, RuntimePluginConfigActivationInspectShape>
  >;
  readonly defaultEnabledPluginIds?: readonly string[];
};

/** One binding, so control, scope, and location cannot be mismatched. */
export type RuntimePluginConfigControlBinding = Readonly<{
  /** Injected by the composition root; plugins never import the functions. */
  control: RuntimePluginConfigControlCapability;
  target: ResolvedRuntimeConfigScopeTarget;
}>;

export type RuntimePluginConfigControlHostState =
  RuntimePluginInventoryHostState & {
    readonly configControl: RuntimePluginConfigControlBinding;
  };

const runtimePluginConfigControlBindings =
  new WeakSet<RuntimePluginConfigControlBinding>();

/** Frozen so caller mutation cannot retarget an advertised config tool. */
export function createRuntimePluginConfigControlBinding(
  binding: RuntimePluginConfigControlBinding,
): RuntimePluginConfigControlBinding {
  if (runtimePluginConfigControlBindings.has(binding)) {
    return binding;
  }

  requiredRecord(binding, 'Runtime plugin config-control binding');

  const snapshot = Object.freeze({
    control: runtimePluginConfigControlCapabilitySnapshot(binding.control),
    target: requireResolvedRuntimeConfigScopeTarget(binding.target),
  });

  runtimePluginConfigControlBindings.add(snapshot);
  return snapshot;
}

export function requiredRuntimePluginConfigControl(
  state: RuntimePluginConfigControlHostState,
): RuntimePluginConfigControlCapability {
  return state.configControl.control;
}

export const runtimeConfigConflictErrorCode = 'runtime_config_conflict';

/** Structural check so plugins need no value import of the config layer. */
export function isRuntimeConfigConflictError(
  error: unknown,
): error is Error & {readonly code: typeof runtimeConfigConflictErrorCode} {
  return (
    error instanceof Error &&
    (error as {readonly code?: unknown}).code === runtimeConfigConflictErrorCode
  );
}

// One marker set per role: a control snapshot must not short-circuit here.
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

  const configControl = configControlBindingFromHostState(state);
  const snapshot = Object.freeze({
    ...inventoryHostStateSnapshotFields(state),
    configControl,
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
  };
}

function configControlBindingFromHostState(
  state: RuntimePluginConfigControlHostState,
): RuntimePluginConfigControlBinding {
  const candidate = state as unknown as Record<string, unknown>;
  const configControl = candidate['configControl'];

  if (configControl === undefined) {
    throw new TypeError(
      'Runtime plugin config-control state requires a configControl binding ' +
        'created with createRuntimePluginConfigControlBinding().',
    );
  }

  return createRuntimePluginConfigControlBinding(
    configControl as RuntimePluginConfigControlBinding,
  );
}

function runtimePluginConfigControlCapabilitySnapshot(
  control: RuntimePluginConfigControlCapability,
): RuntimePluginConfigControlCapability {
  const capability = requiredRecord(
    control,
    'Runtime plugin config-control capability ("control")',
  );

  for (const methodName of [
    'validateOperation',
    'prepareOperation',
    'applyOperation',
    'inspectConfig',
    'redactValue',
    'createConflictError',
  ] as const) {
    assertFunction(capability[methodName], `control.${methodName}`);
  }

  return Object.freeze({
    validateOperation: control.validateOperation,
    prepareOperation: control.prepareOperation,
    applyOperation: control.applyOperation,
    inspectConfig: control.inspectConfig,
    redactValue: control.redactValue,
    createConflictError: control.createConflictError,
  } satisfies RuntimePluginConfigControlCapability);
}

function requiredRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function assertFunction(value: unknown, field: string): void {
  if (typeof value !== 'function') {
    throw new TypeError(`${field} must be a function.`);
  }
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
