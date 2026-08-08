import {createRequire} from 'node:module';

import type {
  RuntimePluginFactoryFunction,
  RuntimePluginFactoryInput,
  RuntimePluginPackageLoadFunction,
  RuntimePluginPackageLoadOptions,
} from '../api/factory.ts';
import {createRuntimePlugin} from '../api/constructors.ts';
import {isRecord} from '../api/validation-primitives.ts';
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

type NativeDynamicImport = (specifier: string) => Promise<unknown>;

let nativeDynamicImport: NativeDynamicImport | undefined;

function requireNativeDynamicImport(): NativeDynamicImport {
  if (nativeDynamicImport !== undefined) {
    return nativeDynamicImport;
  }
  const nativeImportModule: unknown = createRequire(import.meta.url)(
    './native-import.cjs',
  );

  if (typeof nativeImportModule !== 'function') {
    throw new TypeError('Native runtime plugin importer is unavailable.');
  }
  nativeDynamicImport = specifier => {
    const result: unknown = Reflect.apply(nativeImportModule, undefined, [
      specifier,
    ]);

    return Promise.resolve(result);
  };
  return nativeDynamicImport;
}

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

async function constructRuntimePluginPackage(options: {
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
  } catch {
    throw new TypeError(
      `Runtime plugin package "${options.manifest.id}" factory failed during construction.`,
    );
  }

  let plugin: RuntimePlugin;

  try {
    if (!isRuntimePluginFactoryOutput(factoryOutput)) {
      throw new TypeError('Invalid runtime plugin package output.');
    }

    plugin = createRuntimePlugin(factoryOutput);
  } catch {
    throw new TypeError(
      `Runtime plugin package "${options.manifest.id}" factory returned an invalid plugin definition.`,
    );
  }

  return plugin;
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

  const hookNames = [
    'beforeRoleModelCall',
    'handleToolCall',
    'afterTurnCommitted',
    'onSessionEnd',
    'health',
  ] as const;

  return hookNames.every(
    hookName =>
      value[hookName] === undefined || typeof value[hookName] === 'function',
  );
}
