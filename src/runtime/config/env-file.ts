import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';

import {defaultRuntimeConfigEnvPath} from './load.ts';
import {
  assertResolvedProject02HomeAdoptable,
  type ResolvedProject02RuntimeLocation,
} from './location.ts';
import {runtimeConfigEnvVarName} from './types.ts';

/**
 * A runtime location selected by the operator (store root, config
 * path, and/or character). CLI flag parsing produces this shape
 * (src/cli/shared/runtime-location-flags.ts); startup, env-file
 * resolution, and scope-aware config verbs consume it. The character
 * selects a config scope or an active character; env-file resolution
 * ignores it (secrets are shared).
 */
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
 * Read an env file that may not exist, without asking first. The
 * `existsSync`-then-read version this replaces reported a file created
 * between the two calls as absent, and a file deleted between them as a
 * crash.
 *
 * This does not borrow the store's read primitive: `.env` is resolved
 * against the working directory, not the store, and env failures reach
 * the operator as `RuntimeEnvFileError` — which all three CLIs print
 * verbatim and one branches on. A store `read_failed` would replace a
 * message naming the operator's own file with a generic one.
 */
function readOptionalEnvFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }
}
