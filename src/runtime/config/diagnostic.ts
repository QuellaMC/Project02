import type {
  RuntimeConfigDiagnostic,
  RuntimeConfigDiagnosticPluginMetadata,
} from './types.ts';

export function createRuntimeConfigDiagnostic(
  severity: RuntimeConfigDiagnostic['severity'],
  code: string,
  message: string,
  path?: string,
  metadata?: RuntimeConfigDiagnosticPluginMetadata,
): RuntimeConfigDiagnostic {
  const base = {
    severity,
    code,
    message,
    ...(path === undefined ? {} : {path}),
  } as const;

  return metadata === undefined
    ? Object.freeze({...base, scope: 'global'})
    : Object.freeze({
        ...base,
        scope: 'plugin',
        pluginId: metadata.pluginId,
        ...(metadata.pluginConfigField === undefined
          ? {}
          : {pluginConfigField: metadata.pluginConfigField}),
      });
}
