import {join} from 'node:path';

import type {RuntimePluginDatabaseOpener} from '../../plugins/api/index.ts';
import {isProject02Identifier} from '../../shared/identifier.ts';
import {characterPluginDataDirPath} from './layout-contract.ts';
import {openRuntimeSqliteDatabase} from './sqlite.ts';

/**
 * Scopes the sqlite seam to one plugin's character data directory. The
 * composition root builds one per plugin, so the opener itself is the
 * boundary: a plugin can only ever open databases in its own folder.
 */
export function createRuntimePluginDatabaseOpener(options: {
  readonly storeRoot: string;
  readonly pluginId: string;
}): RuntimePluginDatabaseOpener {
  const pluginDataDir = characterPluginDataDirPath({
    storeRoot: options.storeRoot,
    pluginId: options.pluginId,
  });

  return Object.freeze((openOptions => {
    if (!isProject02Identifier(openOptions.name)) {
      throw new TypeError(
        'Plugin database name must start with a letter and use only ' +
          'letters, numbers, dots, underscores, or hyphens.',
      );
    }

    return openRuntimeSqliteDatabase({
      filePath: join(pluginDataDir, `${openOptions.name}.sqlite`),
      schemaVersion: openOptions.schemaVersion,
      initializeSchema: openOptions.initializeSchema,
    });
  }) satisfies RuntimePluginDatabaseOpener);
}
