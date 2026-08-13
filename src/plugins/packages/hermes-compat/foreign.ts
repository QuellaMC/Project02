import {
  isRecord,
  runtimePluginSourceReferenceLimit,
} from '../../api/validation-primitives.ts';
import {RuntimePluginConstructionError} from '../../api/construction-error.ts';
import {importOperatorConfiguredModule} from '../../package-loader/native-import.ts';
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

export async function loadHermesMemoryProviderModule(options: {
  readonly modulePath: string;
  readonly storeRoot: string;
}): Promise<unknown> {
  const imported = await importOperatorConfiguredModule({
    subject: 'hermes-compat',
    modulePath: options.modulePath,
  });
  const exported = isRecord(imported) ? imported['default'] : undefined;

  // A factory is required: the module namespace is cached per process, so
  // a plain exported object would be shared by every character and
  // session host, and one host's shutdown would break the others.
  if (typeof exported !== 'function') {
    // Evaluating the module may already have opened what the object owns.
    await shutdownRejectedForeignProvider(exported);
    throw new RuntimePluginConstructionError(
      'hermes-compat module must default-export a factory returning a provider instance; a plain exported object would be shared across hosts.',
    );
  }

  const built: unknown = await Promise.resolve(
    Reflect.apply(exported, undefined, [{dataDir: options.storeRoot}]),
  );

  return built;
}

/**
 * The factory has already allocated whatever the provider owns -- database
 * handles, workers, locks -- by the time its shape can be checked, so a
 * rejected provider is shut down before the failure propagates; a repeated
 * construction attempt would otherwise leak one instance per try.
 */
export async function wrapHermesMemoryProvider(
  foreignValue: unknown,
): Promise<Project02MemoryProvider> {
  let foreign;

  try {
    foreign = pinnedForeignProvider(foreignValue);
  } catch (error: unknown) {
    await shutdownRejectedForeignProvider(foreignValue);
    throw error;
  }

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
      const capturedFlag = record['captured'];

      if (capturedFlag !== undefined && typeof capturedFlag !== 'boolean') {
        throw new TypeError(
          'hermes-compat provider returned a non-boolean captured flag; the configured module no longer matches pinned interface v1.',
        );
      }

      const captured = capturedFlag !== false;
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

async function shutdownRejectedForeignProvider(value: unknown): Promise<void> {
  const shutdown = isRecord(value) ? value['shutdown'] : undefined;

  if (typeof shutdown !== 'function') {
    return;
  }

  try {
    await Promise.resolve(Reflect.apply(shutdown, value, []));
  } catch {
    // Best effort: the validation failure is what the operator must see.
  }
}

function pinnedForeignProvider(value: unknown): HermesMemoryProviderV1 {
  const missing = (member: string): RuntimePluginConstructionError =>
    new RuntimePluginConstructionError(
      `hermes-compat module does not implement pinned v1 member "${member}".`,
    );

  if (!isRecord(value)) {
    throw new RuntimePluginConstructionError(
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
  // A shape this adapter cannot read is a contract violation, not an
  // empty memory: reporting zero results would hide a version skew that
  // silently loses every memory.
  const list = Array.isArray(rows)
    ? rows
    : isRecord(rows) && Array.isArray(rows['items'])
      ? rows['items']
      : undefined;

  if (list === undefined) {
    throw new TypeError(
      'hermes-compat provider returned an unsupported result shape; expected an array or {items: array}.',
    );
  }

  return Object.freeze(
    list.slice(0, maxItems).map((row: unknown) => {
      const id = isRecord(row) ? stringValue(row['id']) : undefined;
      const text = isRecord(row)
        ? (stringValue(row['text']) ?? stringValue(row['memory']))
        : undefined;

      if (!isRecord(row) || id === undefined || text === undefined) {
        throw new TypeError(
          'hermes-compat provider returned a row without a readable id and text; the configured module no longer matches pinned interface v1.',
        );
      }

      const sources = sourceReferencesFromForeign(row['sources']);
      const confidence = confidenceValue(row['confidence'] ?? row['score']);

      return Object.freeze({
        id,
        text,
        sourceReferences:
          sources.length > 0
            ? sources
            : Object.freeze([
                {kind: 'memory' as const, id, title: 'Memory provider row'},
              ]),
        ...(confidence === undefined ? {} : {confidence}),
      } satisfies MemoryRecallItem);
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
    value.slice(0, runtimePluginSourceReferenceLimit).map((entry: unknown) => {
      if (typeof entry === 'string' && entry.length > 0) {
        return {kind: 'memory' as const, id: entry};
      }

      const id = isRecord(entry) ? stringValue(entry['id']) : undefined;
      const title = isRecord(entry) ? stringValue(entry['title']) : undefined;

      // Dropping an entry this adapter cannot read would let the runtime
      // invent provenance for a provider whose contract has moved.
      if (id === undefined) {
        throw new TypeError(
          'hermes-compat provider returned a source without a readable id; the configured module no longer matches pinned interface v1.',
        );
      }

      return {
        kind: 'memory' as const,
        id,
        ...(title === undefined ? {} : {title}),
      };
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
