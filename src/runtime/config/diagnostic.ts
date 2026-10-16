import type {
  RuntimeConfigDiagnostic,
  RuntimeConfigDiagnosticOrigin,
  RuntimeConfigDiagnosticSectionMetadata,
} from './types.ts';

export function withRuntimeConfigDiagnosticOrigin(
  diagnostic: RuntimeConfigDiagnostic,
  origin: RuntimeConfigDiagnosticOrigin,
): RuntimeConfigDiagnostic {
  return Object.freeze({...diagnostic, origin});
}

export function runtimeConfigDiagnosticAttribution(
  diagnostic: RuntimeConfigDiagnostic,
): string {
  return diagnostic.origin?.scope === 'character' &&
    diagnostic.origin.characterId !== undefined
    ? `[character ${diagnostic.origin.characterId}] `
    : '';
}

/** Unlisted codes count as authoring errors, so a new code fails safe. */
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
  metadata?: RuntimeConfigDiagnosticSectionMetadata,
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
        scope: 'section',
        namespace: metadata.namespace,
        id: metadata.id,
        ...(metadata.field === undefined ? {} : {field: metadata.field}),
      });
}
