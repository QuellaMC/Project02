import {runtimePluginGrantsAccess} from './access-control.ts';
import type {RuntimePluginAccessSnapshot} from '../api/contract.ts';
import {containsForbiddenControlCharacter} from '../api/curated-context.ts';
import type {
  RuntimePluginContextItem,
  RuntimePluginCuratedContextSection,
} from '../api/types.ts';

export const pluginCuratedContextSectionLimit = 4;
export const pluginCuratedContextTotalCharLimit = 8192;
export const pluginRuntimeNoteLimit = 4;
export const pluginRuntimeNoteTotalCharLimit = 2048;

export function pluginCanWriteTrustedContext(
  access: RuntimePluginAccessSnapshot,
): boolean {
  return runtimePluginGrantsAccess({
    access,
    accessName: 'trusted_context',
    requiredAccess: 'write',
  });
}

/**
 * Trusted-frame content is intact or absent: violations throw and route
 * through the plugin's beforeRoleModelCall failure behavior, never truncate.
 */
export function assertPluginCuratedContextWithinCaps(options: {
  readonly pluginId: string;
  readonly sections: readonly RuntimePluginCuratedContextSection[];
}): void {
  assertTrustedEntriesWithinCaps({
    pluginId: options.pluginId,
    label: 'curated context',
    entryNoun: 'section',
    entries: options.sections,
    entryLimit: pluginCuratedContextSectionLimit,
    totalCharLimit: pluginCuratedContextTotalCharLimit,
  });
}

/** Runtime notes render as lines of a system-role frame, so control characters are refused too. */
export function assertPluginRuntimeNotesWithinCaps(options: {
  readonly pluginId: string;
  readonly notes: readonly RuntimePluginContextItem[];
}): void {
  assertTrustedEntriesWithinCaps({
    pluginId: options.pluginId,
    label: 'runtime notes',
    entryNoun: 'note',
    entries: options.notes,
    entryLimit: pluginRuntimeNoteLimit,
    totalCharLimit: pluginRuntimeNoteTotalCharLimit,
  });

  for (const note of options.notes) {
    if (containsForbiddenControlCharacter(note.text)) {
      throw new TypeError(
        `Plugin "${options.pluginId}" runtime note "${note.id}" contains control characters.`,
      );
    }
  }
}

function assertTrustedEntriesWithinCaps(options: {
  readonly pluginId: string;
  readonly label: string;
  readonly entryNoun: string;
  readonly entries: readonly {readonly id: string; readonly text: string}[];
  readonly entryLimit: number;
  readonly totalCharLimit: number;
}): void {
  if (options.entries.length > options.entryLimit) {
    throw new TypeError(
      `Plugin "${options.pluginId}" ${options.label} exceeds the ${String(
        options.entryLimit,
      )}-${options.entryNoun} limit.`,
    );
  }

  const ids = new Set<string>();
  let totalChars = 0;

  for (const entry of options.entries) {
    if (ids.has(entry.id)) {
      throw new TypeError(
        `Plugin "${options.pluginId}" ${options.label} repeats ${options.entryNoun} id "${entry.id}".`,
      );
    }

    ids.add(entry.id);
    totalChars += entry.text.length;
  }

  if (totalChars > options.totalCharLimit) {
    throw new TypeError(
      `Plugin "${options.pluginId}" ${options.label} exceeds the ${String(
        options.totalCharLimit,
      )}-character limit.`,
    );
  }
}
