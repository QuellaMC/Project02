import type {LocalRuntimeSessionIndex} from '../../../runtime/storage/index.ts';

export type {LocalRuntimeSessionIndex};

const sessionIndexSnapshots = new WeakSet<LocalRuntimeSessionIndex>();

/**
 * Injected by the composition root; the plugin never imports the index
 * implementation. Frozen so caller mutation cannot retarget the advertised
 * history tools.
 */
export function createSessionIndexSnapshot(
  index: LocalRuntimeSessionIndex,
): LocalRuntimeSessionIndex {
  if (sessionIndexSnapshots.has(index)) {
    return index;
  }

  if (typeof index !== 'object') {
    throw new TypeError('Session index must be an object.');
  }

  if (typeof index.characterId !== 'string' || index.characterId.length === 0) {
    throw new TypeError('Session index must carry a non-empty characterId.');
  }

  for (const methodName of ['search', 'readAround', 'close'] as const) {
    if (typeof index[methodName] !== 'function') {
      throw new TypeError(`sessionIndex.${methodName} must be a function.`);
    }
  }

  const snapshot = Object.freeze({
    characterId: index.characterId,
    search: options => index.search(options),
    readAround: options => index.readAround(options),
    close: () => {
      index.close();
    },
  } satisfies LocalRuntimeSessionIndex);

  sessionIndexSnapshots.add(snapshot);
  return snapshot;
}
