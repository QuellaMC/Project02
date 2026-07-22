/**
 * Character overlay config: the optional config.json inside a
 * character-data/<id>/ directory. It shares the global document dialect
 * and version gate but is restricted to character-scoped fields;
 * global-only fields (storeRoot, character) are rejected with a
 * diagnostic naming the fix. The loaded shape is deliberately not
 * assignable to LoadedProject02RuntimeConfig — its source says
 * 'overlay' — so an overlay can never reach the global resolvers or
 * re-derive a store root from its own path.
 */
import {existsSync} from 'node:fs';

import {createLocalRuntimeStorageLayout} from '../storage/layout-contract.ts';
import {
  createRuntimeConfigDiagnostic,
  withRuntimeConfigDiagnosticOrigin,
} from './diagnostic.ts';
import {
  readProject02RuntimeConfigDocument,
  validateProject02RuntimeConfig,
} from './load.ts';
import {project02RuntimeConfigFieldDefinitions} from './schema.ts';
import type {
  Project02RuntimeConfig,
  RuntimeConfigDiagnostic,
  RuntimeConfigDiagnosticOrigin,
} from './types.ts';

export type LoadedProject02CharacterOverlayConfig = {
  readonly scope: 'character';
  readonly characterId: string;
  // 'overlay' is not a RuntimeConfigSource on purpose: it keeps this
  // type structurally incompatible with the global loaded config.
  readonly source: 'none' | 'overlay';
  readonly path?: string;
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

export function characterOverlayConfigPath(dataRoot: string): string {
  return createLocalRuntimeStorageLayout({storeRoot: dataRoot}).configPath;
}

export function loadProject02CharacterOverlayConfig(options: {
  readonly dataRoot: string;
  readonly characterId: string;
}): LoadedProject02CharacterOverlayConfig {
  const path = characterOverlayConfigPath(options.dataRoot);

  if (!existsSync(path)) {
    return Object.freeze({
      scope: 'character',
      characterId: options.characterId,
      source: 'none',
      diagnostics: Object.freeze([]),
    } satisfies LoadedProject02CharacterOverlayConfig);
  }

  const origin: RuntimeConfigDiagnosticOrigin = Object.freeze({
    scope: 'character',
    characterId: options.characterId,
    path,
  });
  const document = readProject02RuntimeConfigDocument(path);

  if (document.status === 'rejected') {
    return loadedOverlay({
      ...options,
      path,
      origin,
      diagnostics: [document.diagnostic],
    });
  }

  const accepted = validateProject02RuntimeConfig(document.value);

  return loadedOverlay({
    ...options,
    path,
    origin,
    ...(accepted.config === undefined ? {} : {config: accepted.config}),
    diagnostics: [
      ...accepted.diagnostics,
      ...globalOnlyFieldDiagnostics(document.value),
    ],
  });
}

function loadedOverlay(options: {
  readonly characterId: string;
  readonly path: string;
  readonly origin: RuntimeConfigDiagnosticOrigin;
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
}): LoadedProject02CharacterOverlayConfig {
  const hasErrors = options.diagnostics.some(
    diagnostic => diagnostic.severity === 'error',
  );

  return Object.freeze({
    scope: 'character',
    characterId: options.characterId,
    source: 'overlay',
    path: options.path,
    ...(options.config === undefined || hasErrors
      ? {}
      : {config: options.config}),
    diagnostics: Object.freeze(
      options.diagnostics.map(diagnostic =>
        withRuntimeConfigDiagnosticOrigin(diagnostic, options.origin),
      ),
    ),
  } satisfies LoadedProject02CharacterOverlayConfig);
}

// Checked against the raw document so a global-only field is named even
// when its value would also fail the per-field validation.
function globalOnlyFieldDiagnostics(
  value: unknown,
): readonly RuntimeConfigDiagnostic[] {
  const project02 =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)['project02']
      : undefined;

  if (
    typeof project02 !== 'object' ||
    project02 === null ||
    Array.isArray(project02)
  ) {
    return [];
  }

  const section = project02 as Record<string, unknown>;

  return project02RuntimeConfigFieldDefinitions()
    .filter(
      field =>
        !field.scopes.includes('character') &&
        section[field.name] !== undefined,
    )
    .map(field =>
      createRuntimeConfigDiagnostic(
        'error',
        'runtime_config_field_global_only',
        `Config field "${field.path}" is global-only; set it in the home ` +
          'config.json, not the character overlay.',
        field.path,
      ),
    );
}
