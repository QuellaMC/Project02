/**
 * Store↔character binding: a store root binds permanently to one character
 * id at first durable activation. The binding file is written atomically
 * under the store mutation lock and is never rewritten; the id is
 * authoritative, while display names remain per-session historical facts.
 * The runtime deals in plain character-id strings here — it never imports
 * the characters module.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {isNodeErrorWithCode} from '../../shared/node-error.ts';
import {atomicReplaceFile} from './atomic-file.ts';
import {
  createLocalRuntimeStorageLayout,
  type LocalRuntimeStorageLayoutOptions,
} from './layout-contract.ts';
import {characterBindingFileName} from './layout-contract.ts';
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
  options: LocalRuntimeStorageLayoutOptions = {},
): string {
  return join(
    createLocalRuntimeStorageLayout(options).storeRoot,
    characterBindingFileName,
  );
}

export function readCharacterBinding(
  options: LocalRuntimeStorageLayoutOptions = {},
): CharacterBindingReadResult {
  const path = characterBindingPath(options);
  let source: string;

  try {
    source = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    // ENOTDIR: the store root is not a directory; the storage layer owns
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

export type CharacterBindingReconcileResult =
  | {
      readonly status: 'bound';
      readonly characterId: string;
      readonly adopted: 'already_bound' | 'fresh_store' | 'existing_history';
    }
  | {
      readonly status: 'rejected';
      readonly code:
        | 'character_binding_mismatch'
        | 'character_binding_malformed'
        | 'store_character_mismatch';
      readonly message: string;
    };

/**
 * Applies the binding decision table for a durable writer composition
 * root. `deriveStoreCharacterIds` runs only when no binding exists yet: it
 * reports every distinct character id recorded in the store's sessions so
 * legacy stores adopt their own history instead of the configured id
 * silently rebinding them.
 */
export async function reconcileCharacterBinding(options: {
  readonly storageOptions?: LocalRuntimeStorageLayoutOptions;
  readonly configuredCharacterId: string;
  readonly deriveStoreCharacterIds: () => Promise<readonly string[]>;
  readonly now?: () => string;
}): Promise<CharacterBindingReconcileResult> {
  const storageOptions = options.storageOptions ?? {};
  const layout = createLocalRuntimeStorageLayout(storageOptions);
  const configuredCharacterId = options.configuredCharacterId;
  const existing = evaluateExistingBinding({
    storageOptions,
    configuredCharacterId,
  });

  if (existing !== undefined) {
    return existing;
  }

  const storeCharacterIds = await options.deriveStoreCharacterIds();
  const foreignIds = storeCharacterIds.filter(
    characterId => characterId !== configuredCharacterId,
  );

  if (foreignIds.length > 0) {
    return Object.freeze({
      status: 'rejected',
      code: 'store_character_mismatch',
      message:
        `Store "${layout.storeRoot}" contains history for character ` +
        `${storeCharacterIds.map(id => `"${id}"`).join(', ')} but ` +
        `project02.character is "${configuredCharacterId}". Set ` +
        `project02.character to the store's character, or point ` +
        `project02.storeRoot at a different store for ` +
        `"${configuredCharacterId}".`,
    });
  }

  const lock = await acquireLocalRuntimeMutationLock({
    locksRoot: layout.locksRoot,
    resourceKey: characterBindingLockResourceKey,
  });

  try {
    const reread = evaluateExistingBinding({
      storageOptions,
      configuredCharacterId,
    });

    if (reread !== undefined) {
      return reread;
    }

    await atomicReplaceFile({
      targetPath: characterBindingPath(storageOptions),
      content: `${JSON.stringify(
        {
          format: characterBindingFormat,
          characterId: configuredCharacterId,
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
    status: 'bound',
    characterId: configuredCharacterId,
    adopted:
      storeCharacterIds.length === 0 ? 'fresh_store' : 'existing_history',
  });
}

function evaluateExistingBinding(options: {
  readonly storageOptions: LocalRuntimeStorageLayoutOptions;
  readonly configuredCharacterId: string;
}): CharacterBindingReconcileResult | undefined {
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
    if (read.binding.characterId === options.configuredCharacterId) {
      return Object.freeze({
        status: 'bound',
        characterId: read.binding.characterId,
        adopted: 'already_bound',
      });
    }

    return Object.freeze({
      status: 'rejected',
      code: 'character_binding_mismatch',
      message:
        `Store "${layout.storeRoot}" is permanently bound to character ` +
        `"${read.binding.characterId}"; project02.character is ` +
        `"${options.configuredCharacterId}". Set project02.character back ` +
        `to "${read.binding.characterId}", or point project02.storeRoot at ` +
        `a different store for "${options.configuredCharacterId}".`,
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
      "store's binding is permanent and is never rewritten by the runtime.",
  });
}

function defaultBindingTimestamp(): string {
  return new Date().toISOString();
}
