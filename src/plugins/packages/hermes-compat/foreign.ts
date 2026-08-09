import {createRequire} from 'node:module';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

import {isRecord} from '../../api/validation-primitives.ts';
import type {
  MemoryRecallItem,
  Project02MemoryProvider,
} from '../../builtin/memory-provider/index.ts';
import type {RuntimePluginSourceReference} from '../../api/types.ts';

export const hermesCompatPluginId = 'hermes-compat';

/**
 * Pinned v1 of the Hermes memory-provider surface this compat adapter
 * understands, expressed as its JS binding: prefetch(query) returns memory
 * rows, syncTurn(user, assistant) ingests a turn and may report sources,
 * search(query) backs the one tool, shutdown() releases resources. All
 * four are required; a mismatch fails construction instead of guessing.
 */
type HermesMemoryProviderV1 = {
  prefetch(query: string): unknown;
  syncTurn(userMessage: string, assistantMessage: string): unknown;
  search(query: string): unknown;
  shutdown(): unknown;
};

const nativeImportModule: unknown = createRequire(import.meta.url)(
  '../../package-loader/native-import.cjs',
);

export async function loadHermesMemoryProviderModule(options: {
  readonly modulePath: string;
  readonly storeRoot: string;
}): Promise<unknown> {
  if (!isAbsolute(options.modulePath)) {
    throw new TypeError(
      'hermes-compat modulePath must be an absolute path to the provider module.',
    );
  }

  if (typeof nativeImportModule !== 'function') {
    throw new TypeError('Native import bridge is unavailable.');
  }

  // Importing the configured module executes operator-trusted code, the
  // same trust an installed operator package already gets.
  const imported: unknown = await Promise.resolve(
    Reflect.apply(nativeImportModule, undefined, [
      pathToFileURL(options.modulePath).href,
    ]),
  );
  const exported = isRecord(imported) ? imported['default'] : undefined;

  if (typeof exported === 'function') {
    const built: unknown = await Promise.resolve(
      Reflect.apply(exported, undefined, [{dataDir: options.storeRoot}]),
    );

    return built;
  }

  return exported;
}

export function wrapHermesMemoryProvider(
  foreignValue: unknown,
): Project02MemoryProvider {
  const foreign = pinnedForeignProvider(foreignValue);

  return {
    id: hermesCompatPluginId,
    displayName: 'Hermes Memory Provider Compat',
    async recall(request) {
      const rows: unknown = await Promise.resolve(
        foreign.prefetch(request.currentUserMessage),
      );

      return {items: memoryItemsFromRows(rows, request.maxItems)};
    },
    async captureTurn(turn) {
      const result: unknown = await Promise.resolve(
        foreign.syncTurn(turn.userMessage, turn.characterMessage ?? ''),
      );
      const record = isRecord(result) ? result : {};
      const captured = record['captured'] !== false;
      const summary =
        typeof record['summary'] === 'string' && record['summary'].length > 0
          ? record['summary']
          : captured
            ? 'Synced turn to the memory provider.'
            : 'Turn not captured.';

      if (!captured) {
        return {captured: false, summary};
      }

      const sources = sourceReferencesFromForeign(record['sources']);

      return {
        captured: true,
        summary,
        sourceReferences:
          sources.length > 0
            ? sources
            : [
                {
                  kind: 'external_contract',
                  id: `${hermesCompatPluginId}.sync_turn`,
                  title: 'Memory provider turn sync',
                },
              ],
      };
    },
    async search(request) {
      const rows: unknown = await Promise.resolve(
        foreign.search(request.query),
      );

      return {items: memoryItemsFromRows(rows, request.maxItems)};
    },
    async close() {
      await Promise.resolve(foreign.shutdown());
    },
  };
}

function pinnedForeignProvider(value: unknown): HermesMemoryProviderV1 {
  const missing = (member: string): TypeError =>
    new TypeError(
      `hermes-compat module does not implement pinned v1 member "${member}".`,
    );

  if (!isRecord(value)) {
    throw new TypeError(
      'hermes-compat module does not export a memory provider object.',
    );
  }

  const prefetch = value['prefetch'];
  const syncTurn = value['syncTurn'];
  const search = value['search'];
  const shutdown = value['shutdown'];

  if (typeof prefetch !== 'function') {
    throw missing('prefetch');
  }

  if (typeof syncTurn !== 'function') {
    throw missing('syncTurn');
  }

  if (typeof search !== 'function') {
    throw missing('search');
  }

  if (typeof shutdown !== 'function') {
    throw missing('shutdown');
  }

  return Object.freeze({
    prefetch(query) {
      const result: unknown = Reflect.apply(prefetch, value, [query]);

      return result;
    },
    syncTurn(userMessage, assistantMessage) {
      const result: unknown = Reflect.apply(syncTurn, value, [
        userMessage,
        assistantMessage,
      ]);

      return result;
    },
    search(query) {
      const result: unknown = Reflect.apply(search, value, [query]);

      return result;
    },
    shutdown() {
      const result: unknown = Reflect.apply(shutdown, value, []);

      return result;
    },
  } satisfies HermesMemoryProviderV1);
}

function memoryItemsFromRows(
  rows: unknown,
  maxItems: number,
): readonly MemoryRecallItem[] {
  const list = Array.isArray(rows)
    ? rows
    : isRecord(rows) && Array.isArray(rows['items'])
      ? rows['items']
      : [];

  return Object.freeze(
    list.slice(0, maxItems).flatMap((row: unknown) => {
      if (!isRecord(row)) {
        return [];
      }

      const id = stringValue(row['id']);
      const text = stringValue(row['text']) ?? stringValue(row['memory']);

      if (id === undefined || text === undefined) {
        return [];
      }

      const sources = sourceReferencesFromForeign(row['sources']);
      const confidence = confidenceValue(row['confidence'] ?? row['score']);

      return [
        Object.freeze({
          id,
          text,
          sourceReferences:
            sources.length > 0
              ? sources
              : Object.freeze([
                  {
                    kind: 'memory' as const,
                    id,
                    title: 'Memory provider row',
                  },
                ]),
          ...(confidence === undefined ? {} : {confidence}),
        } satisfies MemoryRecallItem),
      ];
    }),
  );
}

function sourceReferencesFromForeign(
  value: unknown,
): readonly RuntimePluginSourceReference[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  return Object.freeze(
    value.flatMap((entry: unknown) => {
      if (typeof entry === 'string' && entry.length > 0) {
        return [{kind: 'memory' as const, id: entry}];
      }

      if (!isRecord(entry)) {
        return [];
      }

      const id = stringValue(entry['id']);
      const title = stringValue(entry['title']);

      return id === undefined
        ? []
        : [
            {
              kind: 'memory' as const,
              id,
              ...(title === undefined ? {} : {title}),
            },
          ];
    }),
  );
}

function confidenceValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}
