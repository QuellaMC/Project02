import type {
  RuntimePluginFactoryFunction,
  RuntimePluginFactoryInput,
  RuntimePluginPackageLoadFunction,
  RuntimePluginPackageLoadOptions,
} from '../api/factory.ts';
import {
  createRuntimePlugin,
  runtimePluginLifecycleHookDeclarations,
} from '../api/constructors.ts';
import {isRecord} from '../api/validation-primitives.ts';
import {isRuntimePluginConstructionError} from '../api/construction-error.ts';
import type {
  RuntimePlugin,
  RuntimePluginLifecycleHooks,
  RuntimePluginManifest,
} from '../api/types.ts';
import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';
import {
  activateRuntimePluginPackageArtifact,
  type RuntimePluginPackageArtifact,
} from './artifact.ts';
import {requireNativeDynamicImport} from './native-import.ts';

type RuntimePluginPackageFactory = (
  input: RuntimePluginFactoryInput,
) => unknown;

type RuntimePluginPackageLoaderSource =
  | {
      readonly kind: 'bound';
      readonly factory: RuntimePluginFactoryFunction;
    }
  | {
      readonly kind: 'captured';
      readonly artifact: RuntimePluginPackageArtifact;
      readonly entryRelativePath: string;
    };

export function createRuntimePluginPackageLoader(options: {
  readonly manifest: RuntimePluginManifest;
  readonly source: RuntimePluginPackageLoaderSource;
}): RuntimePluginPackageLoadFunction {
  let factoryPromise: Promise<RuntimePluginPackageFactory> | undefined;

  return async (input, loadOptions) => {
    if (
      input.pluginId !== options.manifest.id ||
      !canonicalJsonValuesEqual(input.manifest, options.manifest)
    ) {
      throw new TypeError(
        `Runtime plugin package factory input does not match "${options.manifest.id}".`,
      );
    }

    const factory =
      options.source.kind === 'bound'
        ? options.source.factory
        : await (factoryPromise ??= importRuntimePluginPackageFactory({
            artifact: options.source.artifact,
            entryRelativePath: options.source.entryRelativePath,
            manifest: options.manifest,
          }));

    const candidate = await constructRuntimePluginPackage({
      factory,
      manifest: options.manifest,
      input,
    });

    return acceptRuntimePluginPackageCandidate({
      manifest: options.manifest,
      candidate,
      ...(loadOptions?.retainRejectedCandidate === undefined
        ? {}
        : {
            retainRejectedCandidate: loadOptions.retainRejectedCandidate,
          }),
    });
  };
}

export function acceptRuntimePluginPackageCandidate(options: {
  readonly manifest: RuntimePluginManifest;
  readonly candidate: RuntimePlugin;
  readonly retainRejectedCandidate?:
    RuntimePluginPackageLoadOptions['retainRejectedCandidate'] | undefined;
}): RuntimePlugin {
  if (canonicalJsonValuesEqual(options.candidate.manifest, options.manifest)) {
    return options.candidate;
  }

  options.retainRejectedCandidate?.(options.candidate);
  throw new TypeError(
    `Runtime plugin package "${options.manifest.id}" factory returned a different manifest.`,
  );
}

async function importRuntimePluginPackageFactory(options: {
  readonly artifact: RuntimePluginPackageArtifact;
  readonly entryRelativePath: string;
  readonly manifest: RuntimePluginManifest;
}): Promise<RuntimePluginPackageFactory> {
  const entryUrl = activateRuntimePluginPackageArtifact({
    artifact: options.artifact,
    entryRelativePath: options.entryRelativePath,
  });
  let moduleNamespace: unknown;

  try {
    moduleNamespace = await requireNativeDynamicImport()(entryUrl);
  } catch {
    throw new TypeError(
      `Runtime plugin package "${options.manifest.id}" entry could not be imported.`,
    );
  }

  if (!isRecord(moduleNamespace)) {
    throw new TypeError(
      `Runtime plugin package "${options.manifest.id}" entry must be an ESM module.`,
    );
  }

  const moduleExports = Object.keys(moduleNamespace);

  if (
    moduleExports.length !== 1 ||
    moduleExports[0] !== 'createProject02Plugin'
  ) {
    throw new TypeError(
      `Runtime plugin package "${options.manifest.id}" must export exactly one named createProject02Plugin factory.`,
    );
  }

  const createProject02Plugin = moduleNamespace['createProject02Plugin'];

  if (typeof createProject02Plugin !== 'function') {
    throw new TypeError(
      `Runtime plugin package "${options.manifest.id}" must export named createProject02Plugin.`,
    );
  }

  return input =>
    Reflect.apply(createProject02Plugin, undefined, [input]) as unknown;
}

/**
 * The one place a package factory is called: every source -- an imported
 * entry module or a host-supplied definition -- gets the same sanitized
 * failure, so an operator sees the same message either way.
 */
export async function constructRuntimePluginPackage(options: {
  readonly factory: RuntimePluginPackageFactory;
  readonly manifest: RuntimePluginManifest;
  readonly input: RuntimePluginFactoryInput;
}): Promise<RuntimePlugin> {
  const factoryInput = Object.freeze({
    ...options.input,
    pluginId: options.manifest.id,
    manifest: options.manifest,
  } satisfies RuntimePluginFactoryInput);
  let factoryOutput: unknown;

  try {
    factoryOutput = await options.factory(factoryInput);
  } catch (error: unknown) {
    // The caught error is deliberately dropped rather than attached as a
    // cause: arbitrary factory text can embed a resolved secret, and
    // ordinary error inspection prints nested causes.
    throw runtimePluginPackageConstructionFailure(
      `Runtime plugin package "${options.manifest.id}" factory failed during construction.${constructionFailureDetail(error)}`,
    );
  }

  let plugin: RuntimePlugin;

  try {
    if (!isRuntimePluginFactoryOutput(factoryOutput)) {
      throw new TypeError('Invalid runtime plugin package output.');
    }

    plugin = createRuntimePlugin(factoryOutput);
  } catch (error: unknown) {
    throw new TypeError(
      `Runtime plugin package "${options.manifest.id}" factory returned an invalid plugin definition.${constructionFailureDetail(error)}`,
      {cause: error},
    );
  }

  return plugin;
}

/**
 * Arbitrary factory text can carry resolved secrets, so only a failure
 * the package declared safe reaches the operator.
 */
/**
 * Names a construction failure whose whole message the loader composed
 * from the manifest and declared-safe package text, so an operator-facing
 * surface may show it verbatim.
 */
export const runtimePluginPackageConstructionFailureName =
  'RuntimePluginPackageConstructionFailure';

export function isRuntimePluginPackageConstructionFailure(
  error: unknown,
): error is Error {
  return (
    error instanceof Error &&
    error.name === runtimePluginPackageConstructionFailureName
  );
}

function runtimePluginPackageConstructionFailure(message: string): TypeError {
  const failure = new TypeError(message);
  failure.name = runtimePluginPackageConstructionFailureName;

  return failure;
}

function constructionFailureDetail(error: unknown): string {
  return isRuntimePluginConstructionError(error) &&
    error instanceof Error &&
    error.message.trim().length > 0
    ? ` ${error.message}`
    : '';
}

type RuntimePluginFactoryOutput = {
  readonly manifest: unknown;
  readonly providedTools: readonly unknown[];
  readonly lifecycleHooks: RuntimePluginLifecycleHooks;
};

function isRuntimePluginFactoryOutput(
  value: unknown,
): value is RuntimePluginFactoryOutput {
  return (
    isRecord(value) &&
    Object.hasOwn(value, 'manifest') &&
    Array.isArray(value['providedTools']) &&
    isRuntimePluginLifecycleHooks(value['lifecycleHooks'])
  );
}

function isRuntimePluginLifecycleHooks(
  value: unknown,
): value is RuntimePluginLifecycleHooks {
  if (!isRecord(value)) {
    return false;
  }

  return runtimePluginLifecycleHookDeclarations.every(
    ([hookName]) =>
      value[hookName] === undefined || typeof value[hookName] === 'function',
  );
}
