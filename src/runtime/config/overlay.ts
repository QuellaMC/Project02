import {describeRealEntry} from '../../shared/real-path.ts';
import {
  createLocalRuntimeStorageLayout,
  type LocalRuntimeCharacterDataStorageSchemaMarker,
} from '../storage/layout-contract.ts';
import {assertCharacterDataDirReadable} from '../storage/character-data.ts';
import {
  createRuntimeConfigDiagnostic,
  withRuntimeConfigDiagnosticOrigin,
} from './diagnostic.ts';
import {
  createLayeredRuntimeConfigFingerprint,
  createRuntimeConfigFingerprint,
} from './fingerprint.ts';
import {
  readProject02RuntimeConfigDocument,
  validateProject02RuntimeConfig,
} from './load.ts';
import {
  characterRuntimeConfigFieldScopeViolation,
  project02RuntimeConfigFieldDefinitions,
} from './schema.ts';
import {
  type Project02RuntimeConfig,
  type RuntimeConfigCharacterScope,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigDiagnosticOrigin,
  type RuntimeConfigValue,
} from './types.ts';
import type {JsonBoundaryObject} from '../../shared/json-boundary.ts';

export type LoadedProject02CharacterOverlayConfig = {
  readonly scope: 'character';
  readonly characterId: string;
  // 'overlay' is not a RuntimeConfigSource, so this type cannot pass as global.
  readonly source: 'none' | 'overlay';
  readonly path?: string;
  /** Survives failed validation so control can repair the real document. */
  readonly authoredDocument?: JsonBoundaryObject;
  readonly config?: Project02RuntimeConfig;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
};

export function characterOverlayConfigPath(dataRoot: string): string {
  return createLocalRuntimeStorageLayout({storeRoot: dataRoot}).configPath;
}

function loadProject02CharacterOverlayConfig(options: {
  readonly dataRoot: string;
  readonly characterId: string;
}): LoadedProject02CharacterOverlayConfig {
  const path = characterOverlayConfigPath(options.dataRoot);

  // A dangling symlink is a non-regular entry here, not an absent overlay.
  const overlayEntry = describeRealEntry(path);

  // Only ENOENT means absent; another error must not erase authored settings.
  if (overlayEntry.kind === 'absent') {
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

  // A symlink would let authored settings live outside the data directory.
  if (overlayEntry.kind === 'link') {
    return loadedOverlay({
      ...options,
      path,
      origin,
      diagnostics: [
        createRuntimeConfigDiagnostic(
          'error',
          'runtime_config_overlay_symlink',
          `Character overlay "${path}" is a symlink; the overlay must ` +
            'be a regular file inside the character-data directory.',
        ),
      ],
    });
  }

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
    ...(accepted.authoredDocument === undefined
      ? {}
      : {authoredDocument: accepted.authoredDocument}),
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
  readonly authoredDocument?: JsonBoundaryObject;
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
    ...(options.authoredDocument === undefined
      ? {}
      : {authoredDocument: options.authoredDocument}),
    // An invalid overlay keeps its bytes for repair, never a usable config.
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

/**
 * Invalid bytes fingerprint distinctly, not as one sentinel, so an edit to a
 * broken overlay stays visible. The wrapper stops a collision with a config.
 */
function characterOverlayFingerprintLayer(
  overlay: LoadedProject02CharacterOverlayConfig,
): Project02RuntimeConfig | RuntimeConfigValue | null {
  if (overlay.source === 'none') {
    return null;
  }

  if (overlay.config !== undefined) {
    return overlay.config;
  }

  return overlay.authoredDocument === undefined
    ? Object.freeze({$overlayUnreadable: true})
    : Object.freeze({$overlayInvalid: overlay.authoredDocument});
}

export type RuntimeConfigCharacterOverlaySnapshot = {
  readonly marker?: LocalRuntimeCharacterDataStorageSchemaMarker;
  readonly overlay: LoadedProject02CharacterOverlayConfig;
};

/** The one overlay read: the data directory's identity is checked first. */
export function readCharacterOverlayForScope(
  scope: RuntimeConfigCharacterScope,
): RuntimeConfigCharacterOverlaySnapshot {
  const marker = assertCharacterDataDirReadable({
    storageOptions: {storeRoot: scope.dataRoot},
    characterId: scope.characterId,
  });

  return Object.freeze({
    ...(marker === undefined ? {} : {marker}),
    overlay: loadProject02CharacterOverlayConfig({
      dataRoot: scope.dataRoot,
      characterId: scope.characterId,
    }),
  } satisfies RuntimeConfigCharacterOverlaySnapshot);
}

/** The one composition, so any two sites comparing fingerprints agree. */
export function layeredRuntimeConfigFingerprintForScope(options: {
  readonly globalConfig: Project02RuntimeConfig | JsonBoundaryObject;
  readonly characterScope: RuntimeConfigCharacterScope | undefined;
  readonly overlay: LoadedProject02CharacterOverlayConfig | undefined;
}): string {
  return options.characterScope === undefined || options.overlay === undefined
    ? createRuntimeConfigFingerprint(options.globalConfig)
    : createLayeredRuntimeConfigFingerprint({
        globalConfig: options.globalConfig,
        characterId: options.characterScope.characterId,
        overlayConfig: characterOverlayFingerprintLayer(options.overlay),
      });
}

// Reads the raw document so a global-only field is named even if invalid.
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

  return project02RuntimeConfigFieldDefinitions().flatMap(field => {
    const violation = characterRuntimeConfigFieldScopeViolation(field);

    return violation === undefined || section[field.name] === undefined
      ? []
      : [
          createRuntimeConfigDiagnostic(
            'error',
            'runtime_config_field_global_only',
            violation,
            field.path,
          ),
        ];
  });
}
