import { pathToFileURL } from 'node:url';

import {
  applyRuntimeConfigControlOperation,
  createConfiguredProject02PluginHost,
  createRuntimeConfigInspectShape,
  defaultRuntimeConfigEnvPath,
  defaultRuntimeConfigPath,
  loadProject02RuntimeConfig,
  type RuntimeConfigMutationOperation,
  type RuntimeConfigValue
} from '../runtime/config/index.ts';
import {
  parseRuntimeLocationFlag,
  RuntimeLocationCliUsageError,
  type RuntimeLocationCliState
} from './runtime-location.ts';
import {
  loadRuntimeConfigEnvFile,
  RuntimeEnvFileError
} from './runtime-env.ts';

type RuntimeConfigCliOptions = {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
};

class RuntimeConfigCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigCliUsageError';
  }
}

export async function runRuntimeConfigCliFromArgs(
  args: readonly string[],
  options: RuntimeConfigCliOptions
): Promise<number> {
  try {
    const parsed = parseRuntimeConfigCliArgs(args, options.env ?? process.env);

    if (parsed.command.kind === 'path') {
      options.stdout.write(`${defaultRuntimeConfigPath(parsed.location.storeRoot)}\n`);
      return 0;
    }

    if (parsed.command.kind === 'env_path') {
      options.stdout.write(`${defaultRuntimeConfigEnvPath(parsed.location.storeRoot)}\n`);
      return 0;
    }

    if (parsed.command.kind === 'check') {
      const loaded = loadProject02RuntimeConfig({
        ...parsed.location,
        env: options.env ?? process.env
      });
      loadRuntimeConfigEnvFile({
        loadedConfig: loaded,
        ...(parsed.location.storeRoot === undefined
          ? {}
          : { storeRoot: parsed.location.storeRoot })
      });
      const configured = await createConfiguredProject02PluginHost({
        loadedConfig: loaded,
        ...(parsed.location.storeRoot === undefined
          ? {}
          : { storeRoot: parsed.location.storeRoot })
      });

      writeJson(options.stdout, {
        runtimeConfig: createRuntimeConfigInspectShape(configured.resolvedConfig),
        activationDiagnostics: configured.activation.diagnostics,
        plugins: configured.activation.plugins
      });
      return configured.activation.diagnostics.some((item) => item.severity === 'error')
        ? 1
        : 0;
    }

    if (parsed.command.kind === 'get') {
      const loaded = loadProject02RuntimeConfig({
        ...parsed.location,
        env: options.env ?? process.env
      });
      const value = valueAtPath(loaded.config, parsed.command.path);

      writeJson(options.stdout, value ?? null);
      return 0;
    }

    const result = applyRuntimeConfigControlOperation({
      ...parsed.location,
      env: options.env ?? process.env,
      operation: parsed.command.operation
    });

    writeJson(options.stdout, {
      configPath: result.configPath,
      envPath: result.envPath,
      version: result.config.version
    });
    return 0;
  } catch (error: unknown) {
    if (
      error instanceof RuntimeConfigCliUsageError ||
      error instanceof RuntimeLocationCliUsageError ||
      error instanceof RuntimeEnvFileError ||
      error instanceof TypeError
    ) {
      options.stderr.write(
        `Error: ${error instanceof Error ? error.message : 'runtime config failed'}\n`
      );
      return 1;
    }

    throw error;
  }
}

type RuntimeConfigCliArgs = {
  readonly location: RuntimeLocationCliState;
  readonly command:
    | { readonly kind: 'path' }
    | { readonly kind: 'env_path' }
    | { readonly kind: 'check' }
    | { readonly kind: 'get'; readonly path: string }
    | { readonly kind: 'mutate'; readonly operation: RuntimeConfigMutationOperation };
};

function parseRuntimeConfigCliArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv
): RuntimeConfigCliArgs {
  let location: RuntimeLocationCliState = {};
  const commandArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined || arg === '--') {
      continue;
    }

    const locationResult = parseRuntimeLocationFlag({ args, index, state: location });

    if (locationResult.status === 'matched') {
      location = locationResult.state;
      index = locationResult.nextIndex;
      continue;
    }

    commandArgs.push(arg);
  }

  return {
    location,
    command: parseRuntimeConfigCommand(commandArgs, env)
  };
}

function parseRuntimeConfigCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv
): RuntimeConfigCliArgs['command'] {
  const command = args[0];

  if (command === 'path') {
    return { kind: 'path' };
  }

  if (command === 'env-path') {
    return { kind: 'env_path' };
  }

  if (command === 'check') {
    return { kind: 'check' };
  }

  if (command === 'get') {
    return { kind: 'get', path: requiredArg(args, 1, 'get requires a path.') };
  }

  if (command === 'set') {
    return {
      kind: 'mutate',
      operation: {
        kind: 'set',
        path: requiredArg(args, 1, 'set requires a path.'),
        value: parseConfigValue(requiredArg(args, 2, 'set requires a value.'))
      }
    };
  }

  if (command === 'unset') {
    return {
      kind: 'mutate',
      operation: {
        kind: 'unset',
        path: requiredArg(args, 1, 'unset requires a path.')
      }
    };
  }

  if (command === 'plugin') {
    const action = requiredArg(args, 1, 'plugin requires enable or disable.');
    const pluginId = requiredArg(args, 2, 'plugin command requires a plugin id.');

    if (action === 'enable') {
      return {
        kind: 'mutate',
        operation: { kind: 'plugin_enable', pluginId }
      };
    }

    if (action === 'disable') {
      return {
        kind: 'mutate',
        operation: { kind: 'plugin_disable', pluginId }
      };
    }
  }

  if (command === 'default-memory-provider') {
    return {
      kind: 'mutate',
      operation: {
        kind: 'default_memory_provider',
        ...(args[1] === undefined || args[1] === '--unset'
          ? {}
          : { pluginId: args[1] })
      }
    };
  }

  if (command === 'secret' && args[1] === 'set') {
    const envVar = requiredArg(args, 4, 'secret set requires an env var.');
    const secretValue = env[envVar];

    if (args[5] !== undefined) {
      throw new RuntimeConfigCliUsageError(
        'secret set reads the secret from the named env var; do not pass the secret value as an argument.'
      );
    }

    if (secretValue === undefined || secretValue.length === 0) {
      throw new RuntimeConfigCliUsageError(
        `Secret env var ${envVar} must be set before running secret set.`
      );
    }

    return {
      kind: 'mutate',
      operation: {
        kind: 'secret_set',
        pluginId: requiredArg(args, 2, 'secret set requires a plugin id.'),
        fieldName: requiredArg(args, 3, 'secret set requires a field name.'),
        envVar,
        secretValue
      }
    };
  }

  throw new RuntimeConfigCliUsageError(
    'Use path, env-path, check, get, set, unset, plugin enable, plugin disable, default-memory-provider, or secret set.'
  );
}

function parseConfigValue(value: string): RuntimeConfigValue {
  try {
    return JSON.parse(value) as RuntimeConfigValue;
  } catch {
    return value;
  }
}

function requiredArg(args: readonly string[], index: number, message: string): string {
  const value = args[index];

  if (value === undefined || value.trim().length === 0) {
    throw new RuntimeConfigCliUsageError(message);
  }

  return value;
}

function valueAtPath(value: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = value;

  for (const part of parts) {
    if (
      typeof current !== 'object' ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }

    current = (current as Readonly<Record<string, unknown>>)[part];
  }

  return current;
}

function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isMainModule(): boolean {
  const scriptPath = process.argv[1];

  if (scriptPath === undefined) {
    return false;
  }

  return import.meta.url === pathToFileURL(scriptPath).href;
}

if (isMainModule()) {
  const exitCode = await runRuntimeConfigCliFromArgs(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr
  });

  process.exitCode = exitCode;
}
