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
import {lstatSync} from 'node:fs';

import {
  characterDataDirPath,
  createLocalRuntimeStorageLayout,
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
import {resolveProject02RuntimeStoreRoot} from './resolve.ts';
import {
  characterRuntimeConfigFieldScopeViolation,
  project02RuntimeConfigFieldDefinitions,
} from './schema.ts';
import {
  configuredProject02CharacterId,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
  type RuntimeConfigCharacterScope,
  type RuntimeConfigDiagnostic,
  type RuntimeConfigDiagnosticOrigin,
  type RuntimeConfigValue,
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

  // lstat, not existence: a dangling symlink is a non-regular overlay
  // entry, never an absent overlay.
  let overlayStats;

  try {
    overlayStats = lstatSync(path);
  } catch {
    overlayStats = undefined;
  }

  if (overlayStats === undefined) {
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

  // The overlay must live inside the identity-marked data directory: a
  // symlinked file would let authored settings live outside it.
  if (overlayStats.isSymbolicLink()) {
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

/**
 * The overlay's contribution to the layered authored fingerprint: the
 * document itself, null when the file is absent, and an unreadable
 * sentinel when the file exists but cannot be trusted — each state must
 * fingerprint differently so currency gates decline on any overlay
 * change.
 */
export function characterOverlayFingerprintLayer(
  overlay: LoadedProject02CharacterOverlayConfig,
): Project02RuntimeConfig | RuntimeConfigValue | null {
  if (overlay.source === 'none') {
    return null;
  }

  return overlay.config ?? Object.freeze({$overlayUnreadable: true});
}

/**
 * The character scope every authored-fingerprint site shares: character
 * id from the loaded global config (or the default; an explicit
 * characterId — e.g. a --character flag — wins over both) and its data
 * directory under the resolved home. Undefined when the id or store
 * root cannot form a data path — that state fails elsewhere with its
 * own diagnostic, and fingerprints stay single-layer.
 */
export function deriveRuntimeConfigCharacterScope(options: {
  readonly loadedConfig: LoadedProject02RuntimeConfig;
  readonly storeRoot?: string;
  readonly characterId?: string;
}): RuntimeConfigCharacterScope | undefined {
  const characterId = configuredProject02CharacterId(
    options.loadedConfig.config,
    options.characterId,
  );

  try {
    return Object.freeze({
      characterId,
      dataRoot: characterDataDirPath(
        resolveProject02RuntimeStoreRoot(options),
        characterId,
      ),
    });
  } catch {
    return undefined;
  }
}

/**
 * The one guarded overlay read: wherever a scope's overlay feeds
 * config, fingerprints, or inspection, the identity and adoptability
 * rules hold first — a data directory rebound to another character,
 * holding foreign content, or reached through a symlink must never
 * have its overlay reported as this character's config. An absent or
 * marker-less (still adoptable) directory loads as an absent overlay.
 */
export function loadCharacterOverlayForScope(
  scope: RuntimeConfigCharacterScope,
): LoadedProject02CharacterOverlayConfig {
  assertCharacterDataDirReadable({
    storageOptions: {storeRoot: scope.dataRoot},
    characterId: scope.characterId,
  });

  return loadProject02CharacterOverlayConfig({
    dataRoot: scope.dataRoot,
    characterId: scope.characterId,
  });
}

/**
 * The one authored-fingerprint composition every consumer shares:
 * layered over the global document and the overlay snapshot when a
 * character scope exists, the plain per-file fingerprint otherwise —
 * so any two sites comparing fingerprints compose them identically.
 */
export function layeredRuntimeConfigFingerprintForScope(options: {
  readonly globalConfig: Project02RuntimeConfig;
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
