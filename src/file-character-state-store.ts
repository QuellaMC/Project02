import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  createDefaultCharacterRuntimeState,
  decodeCharacterRuntimeState,
  encodeCharacterRuntimeState,
  freezeCharacterRuntimeState,
  type CharacterRuntimeState,
  type CharacterStateStore
} from './character-state.ts';
import {
  createLocalRuntimeSessionPaths,
  LocalRuntimeStorageContractError,
  type LocalRuntimeSessionPathsOptions
} from './local-storage.ts';
import { assertLocalRuntimeSessionReadable } from './session-store.ts';

export type CreateFileCharacterStateStoreOptions =
  LocalRuntimeSessionPathsOptions;

export function createFileCharacterStateStore(
  options: CreateFileCharacterStateStoreOptions = {}
): CharacterStateStore {
  const paths = createLocalRuntimeSessionPaths(options);
  const storageOptions =
    options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot };
  const assertSessionReadable = (): void => {
    assertLocalRuntimeSessionReadable({
      ...storageOptions,
      sessionId: paths.sessionId
    });
  };

  return Object.freeze({
    readCurrentState() {
      assertSessionReadable();

      if (!existsSync(paths.characterStatePath)) {
        return createDefaultCharacterRuntimeState();
      }

      try {
        return decodeCharacterRuntimeState(
          JSON.parse(readFileSync(paths.characterStatePath, 'utf8')) as unknown,
          throwMalformedStateRecord
        );
      } catch (error: unknown) {
        if (error instanceof LocalRuntimeStorageContractError) {
          throw error;
        }

        throw new LocalRuntimeStorageContractError(
          'malformed_record',
          'Stored character state is not valid JSON.'
        );
      }
    },
    writeCurrentState(state: CharacterRuntimeState) {
      assertSessionReadable();
      const frozenState = freezeCharacterRuntimeState(state);

      try {
        writeFileSync(
          paths.characterStatePath,
          `${encodeCharacterRuntimeState(frozenState)}\n`,
          'utf8'
        );
      } catch {
        throw new LocalRuntimeStorageContractError(
          'write_failed',
          `Could not write local runtime character state file: ${paths.characterStatePath}.`
        );
      }

      return frozenState;
    }
  } satisfies CharacterStateStore);
}

function throwMalformedStateRecord(field: string): never {
  throw new LocalRuntimeStorageContractError(
    'malformed_record',
    `Stored local runtime field "${field}" is malformed.`
  );
}
