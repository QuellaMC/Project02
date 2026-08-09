import {runtimePluginGrantsAccess} from './access-control.ts';
import type {RuntimePluginAccessSnapshot} from '../api/contract.ts';
import type {RuntimePluginCuratedContextSection} from '../api/types.ts';

export const pluginCuratedContextSectionLimit = 4;
export const pluginCuratedContextTotalCharLimit = 8192;

export function pluginCanContributeCuratedContext(
  access: RuntimePluginAccessSnapshot,
): boolean {
  return runtimePluginGrantsAccess({
    access,
    accessName: 'curated_context',
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
  if (options.sections.length > pluginCuratedContextSectionLimit) {
    throw new TypeError(
      `Plugin "${options.pluginId}" curated context exceeds the ${String(
        pluginCuratedContextSectionLimit,
      )}-section limit.`,
    );
  }

  const sectionIds = new Set<string>();
  let totalChars = 0;

  for (const section of options.sections) {
    if (sectionIds.has(section.id)) {
      throw new TypeError(
        `Plugin "${options.pluginId}" curated context repeats section id "${section.id}".`,
      );
    }

    sectionIds.add(section.id);
    totalChars += section.text.length;
  }

  if (totalChars > pluginCuratedContextTotalCharLimit) {
    throw new TypeError(
      `Plugin "${options.pluginId}" curated context exceeds the ${String(
        pluginCuratedContextTotalCharLimit,
      )}-character limit.`,
    );
  }
}
