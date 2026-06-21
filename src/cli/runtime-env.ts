import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { parseEnv } from 'node:util';

import {
  defaultRuntimeConfigEnvPath,
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
}): NodeJS.ProcessEnv {
  const envPath = runtimeConfigEnvPathForLocation(options);

  if (!existsSync(envPath)) {
    return options.env ?? process.env;
  }

  try {
    if (options.env === undefined || options.env === process.env) {
      loadEnvFile(envPath);
      return process.env;
    }

    return { ...parseEnv(readFileSync(envPath, 'utf8')), ...options.env };
  } catch (error: unknown) {
    throw new RuntimeEnvFileError(
      `Could not load runtime config env file "${envPath}": ${
        error instanceof Error ? error.message : 'unknown error'
      }.`
    );
  }
}
