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

/**
 * The one classifier separating activation-readiness failures from
 * authoring errors: a required value or secret that is merely not
 * supplied yet describes an incomplete environment, while every other
 * error describes an invalid authored document. Package-config
 * materialization and startup preflight both block on exactly the
 * authoring side, so a new resolver error code fails safe in both
 * without either keeping its own code list.
 */
export function runtimeConfigDiagnosticIsReadinessFailure(
  diagnostic: RuntimeConfigDiagnostic,
): boolean {
  return (
    diagnostic.code === 'runtime_config_required_value_missing' ||
    diagnostic.code === 'runtime_config_required_secret_missing'
  );
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
