import type {
  RuntimeConfigDiagnostic,
  RuntimeConfigDiagnosticOrigin,
  RuntimeConfigDiagnosticPluginMetadata,
} from './types.ts';

export function withRuntimeConfigDiagnosticOrigin(
  diagnostic: RuntimeConfigDiagnostic,
  origin: RuntimeConfigDiagnosticOrigin,
): RuntimeConfigDiagnostic {
  return Object.freeze({...diagnostic, origin});
}

/**
 * CLI-facing attribution prefix naming the character overlay a
 * diagnostic came from; global-document diagnostics render bare.
 */
export function runtimeConfigDiagnosticAttribution(
  diagnostic: RuntimeConfigDiagnostic,
): string {
  return diagnostic.origin?.scope === 'character' &&
    diagnostic.origin.characterId !== undefined
    ? `[character ${diagnostic.origin.characterId}] `
    : '';
}

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
