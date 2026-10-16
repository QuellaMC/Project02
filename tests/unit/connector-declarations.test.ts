import {describe, expect, it} from 'vitest';

import {validateRuntimePluginManifest} from '../../src/plugins/index.ts';
import {builtInConnectors} from '../../src/runtime/config/index.ts';
import {memorySearchPluginManifest} from '../support/plugin-host-fixtures.ts';

describe('built-in connector declarations', () => {
  it('pass the validation a plugin manifest passes, under unique ids, with no field the model may change or a change reloads', () => {
    for (const connector of builtInConnectors) {
      // Worn as a manifest, so the one validator judges its declaration.
      expect(
        validateRuntimePluginManifest({
          ...memorySearchPluginManifest(connector.id),
          ...connector,
        }),
      ).toMatchObject({status: 'accepted'});
    }

    expect(new Set(builtInConnectors.map(connector => connector.id)).size).toBe(
      builtInConnectors.length,
    );
    expect(
      builtInConnectors
        .flatMap(connector => connector.config.fields)
        .filter(
          field =>
            field.agentMutable === true || field.reloadRequired !== false,
        ),
    ).toEqual([]);
  });
});
