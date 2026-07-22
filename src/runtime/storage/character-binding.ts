/**
 * Character data-dir stamp: each `character-data/<id>/` directory carries
 * a binding file naming the one character whose history it holds. The
 * directory path already encodes the id; the stamp is the tamper guard
 * that survives directory renames and copies. Written atomically under
 * the data dir's mutation lock and never rewritten; display names remain
 * per-session historical facts, so the stamp carries the id only.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {atomicReplaceFile} from './atomic-file.ts';
import {
  characterBindingFileName,
  createLocalRuntimeStorageLayout,
  LocalRuntimeStorageContractError,
  type LocalRuntimeStorageLayout,
  type LocalRuntimeStorageLayoutOptions,
} from './layout-contract.ts';
import {acquireLocalRuntimeMutationLock} from './mutation-lock.ts';

export const characterBindingFormat = 'project02.character-binding.v1';
export {characterBindingFileName};
const characterBindingLockResourceKey = 'character-binding';

export type CharacterBinding = {
  readonly format: typeof characterBindingFormat;
  readonly characterId: string;
  readonly boundAt: string;
};

export type CharacterBindingReadResult =
  | {readonly status: 'bound'; readonly binding: CharacterBinding}
  | {readonly status: 'absent'}
  | {readonly status: 'malformed'; readonly message: string};

export function characterBindingPath(
  options: LocalRuntimeStorageLayoutOptions,
): string {
  return join(
    createLocalRuntimeStorageLayout(options).storeRoot,
    characterBindingFileName,
  );
}

export function readCharacterBinding(
  options: LocalRuntimeStorageLayoutOptions,
): CharacterBindingReadResult {
  const path = characterBindingPath(options);
  let source: string;

  try {
    source = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    // ENOTDIR: the data root is not a directory; the storage layer owns
    // that diagnosis, so the binding reads as absent here.
    if (
      isNodeErrorWithCode(error, 'ENOENT') ||
      isNodeErrorWithCode(error, 'ENOTDIR')
    ) {
      return Object.freeze({status: 'absent'});
    }

    return malformedBinding(path);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return malformedBinding(path);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>)['format'] !== characterBindingFormat ||
    typeof (parsed as Record<string, unknown>)['characterId'] !== 'string' ||
    ((parsed as Record<string, unknown>)['characterId'] as string).length ===
      0 ||
    typeof (parsed as Record<string, unknown>)['boundAt'] !== 'string'
  ) {
    return malformedBinding(path);
  }

  const record = parsed as Record<string, unknown>;

  return Object.freeze({
    status: 'bound',
    binding: Object.freeze({
      format: characterBindingFormat,
      characterId: record['characterId'] as string,
      boundAt: record['boundAt'] as string,
    } satisfies CharacterBinding),
  });
}

/**
 * A marker-less directory may hold only control entries (overlay,
 * binding stamp, lock root) before it is stamped. Anything else is
 * another character's history or a foreign tree: stamping it would
 * adopt that content under a permanent binding. A directory that has
 * a data marker is left to the storage readers, which validate it.
 */
function assertCharacterDataDirAdoptable(
  layout: LocalRuntimeStorageLayout,
): void {
  if (!existsSync(layout.storeRoot) || existsSync(layout.schemaPath)) {
    return;
  }

  const foreignEntry = readdirSync(layout.storeRoot).find(entry => {
    const entryPath = join(layout.storeRoot, entry);

    return (
      entryPath !== layout.configPath &&
      entryPath !== layout.locksRoot &&
      entryPath !== layout.characterBindingPath
    );
  });

  if (foreignEntry !== undefined) {
    throw new LocalRuntimeStorageContractError(
      'missing_file',
      `Character data directory "${layout.storeRoot}" holds ` +
        `"${foreignEntry}" without a data marker; refusing to bind a ` +
        'character to it.',
    );
  }
}

export type EnsureCharacterDataStampResult =
  | {
      readonly status: 'stamped';
      readonly characterId: string;
      readonly created: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly code:
        'character_binding_mismatch' | 'character_binding_malformed';
      readonly message: string;
    };

/**
 * Creates the stamp on first use and verifies it afterwards. A mismatch
 * means the directory's history belongs to another character (renamed or
 * copied data dir) and is never adopted silently.
 */
export async function ensureCharacterDataStamp(options: {
  readonly storageOptions: LocalRuntimeStorageLayoutOptions;
  readonly characterId: string;
  readonly now?: () => string;
}): Promise<EnsureCharacterDataStampResult> {
  const existing = evaluateCharacterDataStamp(options);

  if (existing !== undefined) {
    return existing;
  }

  const layout = createLocalRuntimeStorageLayout(options.storageOptions);

  // Before the lock so even the lock root leaves no trace in a
  // directory this refuses to adopt.
  assertCharacterDataDirAdoptable(layout);

  const lock = await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: characterBindingLockResourceKey,
  });

  try {
    const reread = evaluateCharacterDataStamp(options);

    if (reread !== undefined) {
      return reread;
    }

    await atomicReplaceFile({
      targetPath: characterBindingPath(options.storageOptions),
      content: `${JSON.stringify(
        {
          format: characterBindingFormat,
          characterId: options.characterId,
          boundAt: (options.now ?? defaultBindingTimestamp)(),
        },
        null,
        2,
      )}\n`,
    });
  } finally {
    await lock.release();
  }

  return Object.freeze({
    status: 'stamped',
    characterId: options.characterId,
    created: true,
  });
}

/**
 * Read-only twin of ensureCharacterDataStamp: reports how an existing
 * stamp relates to the requested character without ever writing one.
 * Returns undefined when no stamp exists yet.
 */
export function evaluateCharacterDataStamp(options: {
  readonly storageOptions: LocalRuntimeStorageLayoutOptions;
  readonly characterId: string;
}): EnsureCharacterDataStampResult | undefined {
  const layout = createLocalRuntimeStorageLayout(options.storageOptions);
  const read = readCharacterBinding(options.storageOptions);

  if (read.status === 'malformed') {
    return Object.freeze({
      status: 'rejected',
      code: 'character_binding_malformed',
      message: read.message,
    });
  }

  if (read.status === 'bound') {
    if (read.binding.characterId === options.characterId) {
      return Object.freeze({
        status: 'stamped',
        characterId: read.binding.characterId,
        created: false,
      });
    }

    return Object.freeze({
      status: 'rejected',
      code: 'character_binding_mismatch',
      message:
        `Character data directory "${layout.storeRoot}" holds history for ` +
        `character "${read.binding.characterId}" but character ` +
        `"${options.characterId}" was requested. Select character ` +
        `"${read.binding.characterId}", or remove the copied directory and ` +
        `let the runtime create a fresh one for "${options.characterId}".`,
    });
  }

  return undefined;
}

function malformedBinding(path: string): CharacterBindingReadResult {
  return Object.freeze({
    status: 'malformed',
    message:
      `Character binding file "${path}" is unreadable or does not match ` +
      `format "${characterBindingFormat}". Restore it from backup; a ` +
      "data directory's binding is permanent and is never rewritten by " +
      'the runtime.',
  });
}

function defaultBindingTimestamp(): string {
  return new Date().toISOString();
}
