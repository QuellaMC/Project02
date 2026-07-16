import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import {
  defaultRuntimeConfigEnvPath,
  resolveConfiguredProject02PluginActivation,
  runtimeConfigEnvVarName,
  storeRootForLoadedDefaultConfigPath,
  type LoadedProject02RuntimeConfig,
  type Project02ConfiguredPluginActivation,
  type RuntimeConfigDiagnostic,
  type RuntimePluginFactoryCatalogSnapshot,
  type RuntimePluginFactoryDefinition
} from '../runtime/config/index.ts';

export class RuntimeEnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeEnvFileError';
  }
}

export function runtimeConfigEnvPathForLocation(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
}): string {
  return defaultRuntimeConfigEnvPath(
    options.loadedConfig.config?.project02?.storeRoot ??
      options.storeRoot ??
      storeRootForLoadedDefaultConfigPath(options.loadedConfig)
  );
}

export function loadRuntimeConfigEnvFile(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly envDefaults?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const envPath = runtimeConfigEnvPathForLocation(options);
  const env = options.env ?? process.env;

  if (!existsSync(envPath)) {
    return { ...(options.envDefaults ?? {}), ...env };
  }

  try {
    return {
      ...(options.envDefaults ?? {}),
      ...parseEnv(readFileSync(envPath, 'utf8')),
      ...env
    };
  } catch (error: unknown) {
    throw new RuntimeEnvFileError(
      `Could not load runtime config env file "${envPath}": ${
        error instanceof Error ? error.message : 'unknown error'
      }.`
    );
  }
}

export function resolveRuntimeConfigActivationBeforeEnvFile(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimePluginFactoryDefinition>>;
  readonly catalogSnapshot?: RuntimePluginFactoryCatalogSnapshot;
}): Project02ConfiguredPluginActivation | undefined {
  const configured = resolveConfiguredProject02PluginActivation({
    loadedConfig: options.loadedConfig,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    env: options.env,
    ...(options.factories === undefined ? {} : { factories: options.factories }),
    ...(options.catalogSnapshot === undefined
      ? {}
      : { catalogSnapshot: options.catalogSnapshot })
  });

  return diagnosticsCanBypassRuntimeEnvFile(configured.activation.diagnostics)
    ? configured
    : undefined;
}

function diagnosticsCanBypassRuntimeEnvFile(
  diagnostics: readonly RuntimeConfigDiagnostic[]
): boolean {
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error'
  );

  return (
    errors.length > 0 &&
    errors.every(
      (diagnostic) => !runtimeConfigDiagnosticRequiresEnvFile(diagnostic)
    )
  );
}

function runtimeConfigDiagnosticRequiresEnvFile(
  diagnostic: RuntimeConfigDiagnostic
): boolean {
  return diagnostic.code === 'runtime_config_required_secret_missing';
}

export function readDefaultDotEnvFile(): NodeJS.ProcessEnv {
  const envPath = '.env';

  if (!existsSync(envPath)) {
    return {};
  }

  try {
    return parseEnv(readFileSync(envPath, 'utf8'));
  } catch (error: unknown) {
    throw new RuntimeEnvFileError(
      `Could not load .env file: ${
        error instanceof Error ? error.message : 'unknown error'
      }.`
    );
  }
}

export function shouldReadDefaultDotEnvForRuntimeLocation(options: {
  readonly location: { readonly configPath?: string; readonly storeRoot?: string };
  readonly env?: NodeJS.ProcessEnv;
}): boolean {
  const env = options.env ?? process.env;

  return (
    options.location.configPath === undefined &&
    options.location.storeRoot === undefined &&
    !runtimeConfigEnvSelectsConfig(env)
  );
}

export function defaultDotEnvForRuntimeLocation(
  defaultEnv: NodeJS.ProcessEnv,
  location: { readonly configPath?: string; readonly storeRoot?: string }
): NodeJS.ProcessEnv {
  if (
    defaultEnv[runtimeConfigEnvVarName] === undefined ||
    (location.configPath === undefined && location.storeRoot === undefined)
  ) {
    return defaultEnv;
  }

  const env = { ...defaultEnv };
  Reflect.deleteProperty(env, runtimeConfigEnvVarName);
  return env;
}

function runtimeConfigEnvSelectsConfig(env: NodeJS.ProcessEnv): boolean {
  return (env[runtimeConfigEnvVarName]?.trim().length ?? 0) > 0;
}
