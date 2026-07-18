/**
 * Load phase of the runtime plugin package loader: imports a discovered
 * package entry and validates that its factory returns the manifest it
 * was discovered with.
 */
import {pathToFileURL} from 'node:url';

import type {RuntimePluginFactoryInput} from '../api/factory.ts';
import {createRuntimePlugin} from '../api/constructors.ts';
import {isRecord} from '../api/validation-primitives.ts';
import type {
  RuntimePlugin,
  RuntimePluginLifecycleHooks,
  RuntimePluginManifest,
} from '../api/types.ts';
import {canonicalJsonValuesEqual} from '../../shared/canonical-json.ts';

export async function loadRuntimePluginPackage(options: {
  readonly entryPath: string;
  readonly manifest: RuntimePluginManifest;
  readonly input: RuntimePluginFactoryInput;
}): Promise<RuntimePlugin> {
  if (
    options.input.pluginId !== options.manifest.id ||
    !canonicalJsonValuesEqual(options.input.manifest, options.manifest)
  ) {
    throw new TypeError(
      `Runtime plugin package factory input does not match "${options.manifest.id}".`,
    );
  }

  let moduleNamespace: unknown;

  try {
    moduleNamespace = await import(pathToFileURL(options.entryPath).href);
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

  const factoryInput = Object.freeze({
    ...options.input,
    pluginId: options.manifest.id,
    manifest: options.manifest,
  } satisfies RuntimePluginFactoryInput);
  let factoryOutput: unknown;

  try {
    factoryOutput = await Reflect.apply(createProject02Plugin, undefined, [
      factoryInput,
    ]);
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

  if (!canonicalJsonValuesEqual(plugin.manifest, options.manifest)) {
    throw new TypeError(
      `Runtime plugin package "${options.manifest.id}" factory returned a different manifest.`,
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
