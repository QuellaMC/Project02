import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

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
}): void {
  const envPath = runtimeConfigEnvPathForLocation(options);

  if (!existsSync(envPath)) {
    return;
  }

  try {
    loadEnvFile(envPath);
  } catch (error: unknown) {
    throw new RuntimeEnvFileError(
      `Could not load runtime config env file "${envPath}": ${
        error instanceof Error ? error.message : 'unknown error'
      }.`
    );
  }
}
