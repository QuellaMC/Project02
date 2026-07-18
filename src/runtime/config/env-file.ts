import {existsSync, readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';

import {defaultRuntimeConfigEnvPath} from './load.ts';
import {storeRootForLoadedDefaultConfigPath} from './resolve.ts';
import {
  runtimeConfigEnvVarName,
  type LoadedProject02RuntimeConfig,
} from './types.ts';

/**
 * A runtime location selected by the operator (store root and/or config
 * path). CLI flag parsing produces this shape (src/cli/runtime-location.ts);
 * startup and env-file resolution consume it.
 */
export type RuntimeLocationCliState = {
  readonly storeRoot?: string;
  readonly configPath?: string;
};

export class RuntimeEnvFileError extends Error {
  readonly path: string | undefined;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'RuntimeEnvFileError';
    this.path = path;
  }
}

export function runtimeConfigEnvPathForLocation(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
}): string {
  return defaultRuntimeConfigEnvPath(
    options.loadedConfig.config?.project02?.storeRoot ??
      options.storeRoot ??
      storeRootForLoadedDefaultConfigPath(options.loadedConfig),
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
    return {...(options.envDefaults ?? {}), ...env};
  }

  try {
    return {
      ...(options.envDefaults ?? {}),
      ...parseEnv(readFileSync(envPath, 'utf8')),
      ...env,
    };
  } catch (error: unknown) {
    throw new RuntimeEnvFileError(
      `Could not load runtime config env file "${envPath}": ${
        error instanceof Error ? error.message : 'unknown error'
      }.`,
      envPath,
    );
  }
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
      }.`,
    );
  }
}

export function shouldReadDefaultDotEnvForRuntimeLocation(options: {
  readonly location: {
    readonly configPath?: string;
    readonly storeRoot?: string;
  };
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
  location: {readonly configPath?: string; readonly storeRoot?: string},
): NodeJS.ProcessEnv {
  if (
    defaultEnv[runtimeConfigEnvVarName] === undefined ||
    (location.configPath === undefined && location.storeRoot === undefined)
  ) {
    return defaultEnv;
  }

  const env = {...defaultEnv};
  Reflect.deleteProperty(env, runtimeConfigEnvVarName);
  return env;
}

function runtimeConfigEnvSelectsConfig(env: NodeJS.ProcessEnv): boolean {
  return (env[runtimeConfigEnvVarName]?.trim().length ?? 0) > 0;
}
