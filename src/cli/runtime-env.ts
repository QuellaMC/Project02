import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import {
  defaultRuntimeConfigEnvPath,
  runtimeConfigEnvVarName,
  type LoadedProject02RuntimeConfig
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
    options.loadedConfig.config?.storeRoot ?? options.storeRoot
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
