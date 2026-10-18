import type {ResolvedProject02RuntimeConfig} from '../../runtime/config/index.ts';
import type {RoleModelAdapter} from '../api/adapter.ts';
import {createNvidiaRoleModelProviderAdapter} from './nvidia.ts';

/** The host settings the provider adapter is built from. */
export type RoleModelProviderSettings = Pick<
  ResolvedProject02RuntimeConfig['project02'],
  'roleModelProvider' | 'nvidiaApiKey' | 'nvidiaModel' | 'nvidiaBaseUrl'
>;

/** Undefined until a provider is chosen. */
export function createRoleModelProviderAdapter(
  settings: RoleModelProviderSettings,
  requestTimeoutMs?: number,
): RoleModelAdapter | undefined {
  if (settings.roleModelProvider !== 'nvidia') {
    return undefined;
  }

  return createNvidiaRoleModelProviderAdapter({
    ...(settings.nvidiaApiKey === undefined
      ? {}
      : {apiKey: settings.nvidiaApiKey}),
    ...(settings.nvidiaModel === undefined
      ? {}
      : {model: settings.nvidiaModel}),
    ...(settings.nvidiaBaseUrl === undefined
      ? {}
      : {baseUrl: settings.nvidiaBaseUrl}),
    ...(requestTimeoutMs === undefined ? {} : {requestTimeoutMs}),
  });
}
