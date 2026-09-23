import {parseEnv} from 'node:util';

import {readTextFileSync} from '../../shared/file-system.ts';
import {isNodeErrorWithCode} from '../../shared/node-error.ts';

import {createProject02HomeLayout} from '../storage/layout-contract.ts';
import {
  assertResolvedProject02HomeAdoptable,
  type ResolvedProject02ConfigLocation,
} from './location.ts';

export class RuntimeEnvFileError extends Error {
  readonly path: string | undefined;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'RuntimeEnvFileError';
    this.path = path;
  }
}

export function loadRuntimeConfigEnvFile(options: {
  readonly runtimeLocation: ResolvedProject02ConfigLocation;
  readonly env?: NodeJS.ProcessEnv;
  readonly envDefaults?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  assertResolvedProject02HomeAdoptable(options.runtimeLocation);
  const envPath = createProject02HomeLayout({
    homeRoot: options.runtimeLocation.homeRoot,
  }).envPath;
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
