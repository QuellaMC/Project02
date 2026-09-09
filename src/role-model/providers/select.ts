import type {RoleModelAdapter} from '../api/adapter.ts';
import {
  createNvidiaRoleModelProviderAdapter,
  createNvidiaRoleModelProviderConfigFromEnv,
  nvidiaApiKeyEnvName,
  nvidiaModelEnvName,
} from './nvidia.ts';
import {roleModelProviderEnvVarName} from '../../runtime/config/index.ts';

export class RoleModelProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleModelProviderSelectionError';
  }
}

export type ChatProviderName = 'local' | 'nvidia';

export function parseProviderName(value: string): ChatProviderName {
  if (value === 'local' || value === 'nvidia') {
    return value;
  }

  throw new RoleModelProviderSelectionError(
    '--provider must be either "local" or "nvidia".',
  );
}

function providerFromEnvironment(
  env: NodeJS.ProcessEnv,
): ChatProviderName | undefined {
  const value = env[roleModelProviderEnvVarName];

  if (value === undefined || value.length === 0) {
    return undefined;
  }

  try {
    return parseProviderName(value);
  } catch {
    throw new RoleModelProviderSelectionError(
      `${roleModelProviderEnvVarName} must be either "local" or "nvidia".`,
    );
  }
}

export function providerOption(provider: ChatProviderName | undefined): {
  readonly provider?: ChatProviderName;
} {
  return provider === undefined ? {} : {provider};
}

export function selectChatProvider(
  provider: ChatProviderName | undefined,
  env: NodeJS.ProcessEnv,
  configuredProvider?: ChatProviderName,
): ChatProviderName | undefined {
  return provider ?? providerFromEnvironment(env) ?? configuredProvider;
}

/**
 * The env the provider selection and the adapters read, and nothing else:
 * what a character's assembly depends on, so a change anywhere else in
 * the environment is not a reason to rebuild it.
 */
export function roleModelEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      roleModelProviderEnvVarName,
      nvidiaApiKeyEnvName,
      nvidiaModelEnvName,
    ].flatMap(name => (env[name] === undefined ? [] : [[name, env[name]]])),
  );
}

export function createSelectedRoleModelAdapter(
  provider: ChatProviderName | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RoleModelAdapter | undefined {
  if (provider !== 'nvidia') {
    return undefined;
  }

  return createNvidiaRoleModelProviderAdapter(
    createNvidiaRoleModelProviderConfigFromEnv(env),
  );
}
