import {parseEnv} from 'node:util';

import {readTextFileSync} from '../../shared/file-system.ts';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';

import {defaultRuntimeConfigEnvPath} from './load.ts';
import {
  assertResolvedProject02HomeAdoptable,
  type ResolvedProject02RuntimeLocation,
} from './location.ts';
import {runtimeConfigEnvVarName} from './types.ts';

export class RuntimeEnvFileError extends Error {
  readonly path: string | undefined;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'RuntimeEnvFileError';
    this.path = path;
  }
}

export function runtimeConfigEnvPathForLocation(
  runtimeLocation: Pick<ResolvedProject02RuntimeLocation, 'homeRoot'>,
): string {
  return defaultRuntimeConfigEnvPath(runtimeLocation.homeRoot);
}

export function loadRuntimeConfigEnvFile(options: {
  readonly runtimeLocation: ResolvedProject02RuntimeLocation;
  readonly env?: NodeJS.ProcessEnv;
  readonly envDefaults?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  assertResolvedProject02HomeAdoptable(options.runtimeLocation);
  const envPath = runtimeConfigEnvPathForLocation(options.runtimeLocation);
  const env = options.env ?? process.env;

  try {
    const source = readOptionalEnvFile(envPath);

    return source === undefined
      ? {...(options.envDefaults ?? {}), ...env}
      : {
          ...(options.envDefaults ?? {}),
          ...parseEnv(source),
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

  try {
    const source = readOptionalEnvFile(envPath);

    return source === undefined ? {} : parseEnv(source);
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

/**
 * No existence check first: the two-call form races creation and deletion.
 * The store read primitive is not reused: `.env` is relative to the cwd.
 */
function readOptionalEnvFile(path: string): string | undefined {
  try {
    return readTextFileSync(path);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }
}
