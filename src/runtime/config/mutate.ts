import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

import { createLocalRuntimeStorageLayout } from '../storage/layout.ts';
import {
  runtimeConfigEnvVarName,
  runtimeConfigVersion,
  type Project02RuntimeConfig,
  type Project02RuntimePluginConfig,
  type RuntimeConfigMutationOperation,
  type RuntimeConfigValue
} from './types.ts';
import { loadProject02RuntimeConfig } from './load.ts';

export type ApplyRuntimeConfigMutationOptions = {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly storeRoot?: string;
  readonly operation: RuntimeConfigMutationOperation;
};

export type RuntimeConfigMutationResult = {
  readonly configPath: string;
  readonly envPath: string;
  readonly config: Project02RuntimeConfig;
};

export function applyRuntimeConfigMutation(
  options: ApplyRuntimeConfigMutationOptions
): RuntimeConfigMutationResult {
  const locationLayout = createLocalRuntimeStorageLayout(
    options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }
  );
  const configPath =
    options.configPath ??
    runtimeConfigPathFromEnv(options.env ?? process.env) ??
    locationLayout.configPath;
  const loaded = loadProject02RuntimeConfig({
    configPath,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot })
  });
  const currentConfig = loaded.config ?? { version: runtimeConfigVersion };
  const effectiveStoreRoot = currentConfig.storeRoot ?? options.storeRoot;
  const effectiveLayout = createLocalRuntimeStorageLayout(
    effectiveStoreRoot === undefined ? {} : { storeRoot: effectiveStoreRoot }
  );
  const envPath = effectiveLayout.envPath;
  const nextConfig = mutateConfig(currentConfig, options.operation, envPath);

  writeJsonAtomic(configPath, nextConfig, 0o600);

  return Object.freeze({
    configPath,
    envPath,
    config: nextConfig
  } satisfies RuntimeConfigMutationResult);
}

function runtimeConfigPathFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[runtimeConfigEnvVarName];

  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value.trim();
}

function mutateConfig(
  config: Project02RuntimeConfig,
  operation: RuntimeConfigMutationOperation,
  envPath: string
): Project02RuntimeConfig {
  switch (operation.kind) {
    case 'set':
      return setConfigPath(config, operation.path, operation.value);
    case 'unset':
      return unsetConfigPath(config, operation.path);
    case 'plugin_enable':
      return setPluginEnabled(config, operation.pluginId, true);
    case 'plugin_disable':
      return setPluginEnabled(config, operation.pluginId, false);
    case 'default_memory_provider':
      return operation.pluginId === undefined
        ? unsetConfigPath(config, 'defaultMemoryProvider')
        : setConfigPath(config, 'defaultMemoryProvider', operation.pluginId);
    case 'secret_set':
      writeEnvSecret(envPath, operation.envVar, operation.secretValue);
      return setPluginConfigField(
        config,
        operation.pluginId,
        operation.fieldName,
        { $env: operation.envVar }
      );
  }
}

function setPluginEnabled(
  config: Project02RuntimeConfig,
  pluginId: string,
  enabled: boolean
): Project02RuntimeConfig {
  const currentPlugin = config.plugins?.[pluginId] ?? {};
  const plugins = { ...(config.plugins ?? {}) };

  plugins[pluginId] = freezePluginConfig({
    ...currentPlugin,
    enabled
  });

  return freezeConfig({ ...config, plugins });
}

function setPluginConfigField(
  config: Project02RuntimeConfig,
  pluginId: string,
  fieldName: string,
  value: RuntimeConfigValue
): Project02RuntimeConfig {
  const currentPlugin = config.plugins?.[pluginId] ?? {};
  const plugins = { ...(config.plugins ?? {}) };

  plugins[pluginId] = freezePluginConfig({
    ...currentPlugin,
    config: {
      ...(currentPlugin.config ?? {}),
      [fieldName]: value
    }
  });

  return freezeConfig({ ...config, plugins });
}

function setConfigPath(
  config: Project02RuntimeConfig,
  path: string,
  value: RuntimeConfigValue
): Project02RuntimeConfig {
  const parts = parseConfigPath(path);

  if (parts.length === 1) {
    const [field] = parts;

    if (field === 'storeRoot' && typeof value === 'string') {
      return freezeConfig({ ...config, storeRoot: value });
    }

    if (field === 'defaultMemoryProvider' && typeof value === 'string') {
      return freezeConfig({ ...config, defaultMemoryProvider: value });
    }

    if (field === 'enabledPlugins' && isStringArray(value)) {
      return freezeConfig({ ...config, enabledPlugins: value });
    }

    throw new TypeError(`Unsupported runtime config path: ${path}.`);
  }

  if (parts[0] !== 'plugins' || parts.length < 3) {
    throw new TypeError(`Unsupported runtime config path: ${path}.`);
  }

  const pluginPath = parsePluginMutationPath(parts, path);
  const currentPlugin = config.plugins?.[pluginPath.pluginId] ?? {};
  const plugins = { ...(config.plugins ?? {}) };

  if (pluginPath.kind === 'enabled') {
    if (typeof value !== 'boolean') {
      throw new TypeError('Plugin enabled config value must be boolean.');
    }

    plugins[pluginPath.pluginId] = freezePluginConfig({
      ...currentPlugin,
      enabled: value
    });
    return freezeConfig({ ...config, plugins });
  }

  plugins[pluginPath.pluginId] = freezePluginConfig({
    ...currentPlugin,
    config: {
      ...(currentPlugin.config ?? {}),
      [pluginPath.fieldName]: value
    }
  });
  return freezeConfig({ ...config, plugins });
}

function unsetConfigPath(
  config: Project02RuntimeConfig,
  path: string
): Project02RuntimeConfig {
  const parts = parseConfigPath(path);

  if (parts.length === 1) {
    const [field] = parts;

    if (field === 'storeRoot') {
      return freezeConfig({
        version: config.version,
        ...(config.enabledPlugins === undefined ? {} : { enabledPlugins: config.enabledPlugins }),
        ...(config.defaultMemoryProvider === undefined
          ? {}
          : { defaultMemoryProvider: config.defaultMemoryProvider }),
        ...(config.plugins === undefined ? {} : { plugins: config.plugins })
      });
    }

    if (field === 'defaultMemoryProvider') {
      return freezeConfig({
        version: config.version,
        ...(config.storeRoot === undefined ? {} : { storeRoot: config.storeRoot }),
        ...(config.enabledPlugins === undefined ? {} : { enabledPlugins: config.enabledPlugins }),
        ...(config.plugins === undefined ? {} : { plugins: config.plugins })
      });
    }

    if (field === 'enabledPlugins') {
      return freezeConfig({
        version: config.version,
        ...(config.storeRoot === undefined ? {} : { storeRoot: config.storeRoot }),
        ...(config.defaultMemoryProvider === undefined
          ? {}
          : { defaultMemoryProvider: config.defaultMemoryProvider }),
        ...(config.plugins === undefined ? {} : { plugins: config.plugins })
      });
    }
  }

  if (parts[0] !== 'plugins' || parts.length < 3) {
    throw new TypeError(`Unsupported runtime config path: ${path}.`);
  }

  const pluginPath = parsePluginMutationPath(parts, path);

  const currentPlugin = config.plugins?.[pluginPath.pluginId];

  if (currentPlugin === undefined) {
    return config;
  }

  const plugins = { ...(config.plugins ?? {}) };

  if (pluginPath.kind === 'enabled') {
    plugins[pluginPath.pluginId] = freezePluginConfig({
      ...(currentPlugin.config === undefined ? {} : { config: currentPlugin.config })
    });
    return freezeConfig({ ...config, plugins });
  }

  const nextPluginConfig = Object.freeze(
    Object.fromEntries(
      Object.entries(currentPlugin.config ?? {}).filter(
        ([key]) => key !== pluginPath.fieldName
      )
    ) as Readonly<Record<string, RuntimeConfigValue>>
  );

  plugins[pluginPath.pluginId] = freezePluginConfig({
    ...currentPlugin,
    config: nextPluginConfig
  });
  return freezeConfig({ ...config, plugins });
}

function writeEnvSecret(envPath: string, envVar: string, secretValue: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(envVar)) {
    throw new TypeError('Secret env var name must be uppercase snake case.');
  }

  const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const lines = current
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith(`${envVar}=`));
  const next = `${[...lines, `${envVar}=${JSON.stringify(secretValue)}`].join('\n')}\n`;

  writeTextAtomic(envPath, next, 0o600);
}

function writeJsonAtomic(
  path: string,
  value: Project02RuntimeConfig,
  mode: number
): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function writeTextAtomic(path: string, value: string, mode: number): void {
  const tmpPath = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, value, { encoding: 'utf8', mode });
  chmodIfSupported(tmpPath, mode);
  renameSync(tmpPath, path);
  chmodIfSupported(path, mode);
}

function chmodIfSupported(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Some filesystems do not support chmod; config redaction remains enforced.
  }
}

function parseConfigPath(path: string): readonly string[] {
  const parts = path.split('.').map((part) => part.trim());

  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new TypeError('Runtime config path must use non-empty dot segments.');
  }

  return Object.freeze(parts);
}

type ParsedPluginMutationPath =
  | {
      readonly kind: 'enabled';
      readonly pluginId: string;
    }
  | {
      readonly kind: 'config_field';
      readonly pluginId: string;
      readonly fieldName: string;
    };

function parsePluginMutationPath(
  parts: readonly string[],
  path: string
): ParsedPluginMutationPath {
  const lastPart = parts.at(-1);
  const penultimatePart = parts.at(-2);

  if (lastPart === 'enabled') {
    const pluginId = parts.slice(1, -1).join('.');

    if (pluginId.length === 0) {
      throw new TypeError('Runtime config plugin path must include a plugin id.');
    }

    return Object.freeze({
      kind: 'enabled',
      pluginId
    });
  }

  if (penultimatePart === 'config' && lastPart !== undefined) {
    const pluginId = parts.slice(1, -2).join('.');

    if (pluginId.length === 0) {
      throw new TypeError('Runtime config plugin path must include a plugin id.');
    }

    if (lastPart.length === 0) {
      throw new TypeError('Plugin config path must include a field name.');
    }

    return Object.freeze({
      kind: 'config_field',
      pluginId,
      fieldName: lastPart
    });
  }

  throw new TypeError(`Unsupported runtime config path: ${path}.`);
}

function freezeConfig(config: Project02RuntimeConfig): Project02RuntimeConfig {
  return Object.freeze(config);
}

function freezePluginConfig(
  config: Project02RuntimePluginConfig
): Project02RuntimePluginConfig {
  return Object.freeze(config);
}

function isStringArray(value: RuntimeConfigValue): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
