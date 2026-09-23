import type {ResolvedProject02RuntimeConfig} from '../../runtime/config/index.ts';
import type {RoleModelAdapter} from '../api/adapter.ts';
import {createNvidiaRoleModelProviderAdapter} from './nvidia.ts';

/** The host settings the provider adapter is built from. */
export type RoleModelProviderSettings = Pick<
  ResolvedProject02RuntimeConfig['project02'],
  'roleModelProvider' | 'nvidiaApiKey' | 'nvidiaModel'
>;

/** Undefined for the local provider: the caller supplies that adapter. */
export function createRoleModelProviderAdapter(
  settings: RoleModelProviderSettings,
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
  });
}
