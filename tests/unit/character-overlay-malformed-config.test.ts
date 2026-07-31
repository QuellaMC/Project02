import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  characterOverlayConfigPath,
  resolveRuntimeConfigScopeTarget,
  runtimeConfigVersion,
  simulateCharacterOverlayCandidate,
} from '../../src/runtime/config/index.ts';
import {
  characterDataDirPath,
  ensureInitializedProject02Home,
} from '../../src/runtime/storage/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {runtimeLocationForTest} from '../support/runtime-config.ts';

const characterId = 'mira';

/** A store whose overlay gives `character-state` the given `config`. */
function storeWithAuthoredPluginConfig(config: unknown): string {
  const storeRoot = createTestTempRoot('project02-malformed-overlay-');
  const dataRoot = characterDataDirPath(storeRoot, characterId);

  writeFileSync(
    join(storeRoot, 'config.json'),
    `${JSON.stringify({version: runtimeConfigVersion, project02: {storeRoot}})}\n`,
    'utf8',
  );
  mkdirSync(dataRoot, {recursive: true});
  writeFileSync(
    characterOverlayConfigPath(dataRoot),
    `${JSON.stringify(
      {
        version: runtimeConfigVersion,
        plugins: {'character-state': {enabled: true, config}},
      },
      null,
      2,
    )}\n`,
    {encoding: 'utf8', mode: 0o600},
  );

  return storeRoot;
}

function simulateMaterialization(storeRoot: string) {
  return simulateCharacterOverlayCandidate({
    target: resolveRuntimeConfigScopeTarget({
      runtimeLocation: runtimeLocationForTest({storeRoot, characterId}),
      env: {},
      scope: 'character',
    }),
    characterMaterialization: {
      document: Object.freeze({
        version: runtimeConfigVersion,
        plugins: {
          'character-state': {
            enabled: true,
            config: {greeting: 'package default'},
          },
        },
      }),
      fillMissingFields: true,
    },
  });
}

describe('character overlay whose plugin config is not an object', () => {
  it('rejects the run and names the field instead of repairing it', async () => {
    // A value typed where a section belongs: what an operator produces
    // by hand, and what materialization used to overwrite.
    const storeRoot = storeWithAuthoredPluginConfig('KEEP-ME');

    await ensureInitializedProject02Home({homeRoot: storeRoot});

    const simulated = simulateMaterialization(storeRoot);

    // Materializing defaults into a malformed value is the silent
    // failure: it produces a valid document by discarding the authored
    // one. The operator has to be told which field is wrong, because
    // that is the only way they can fix it themselves.
    expect(simulated.status).toBe('invalid');
    expect(simulated.status === 'invalid' && simulated.message).toContain(
      `plugins.character-state.config`,
    );
  });

  it('still fills missing fields into a config that is an object', async () => {
    const storeRoot = storeWithAuthoredPluginConfig({tone: 'authored'});

    await ensureInitializedProject02Home({homeRoot: storeRoot});

    const simulated = simulateMaterialization(storeRoot);

    // The other half of the same rule: refusing to write over a
    // malformed value must not cost a well-formed one its defaults.
    // Materialization adds what is missing and touches nothing else.
    expect(simulated.status).toBe('valid');
    expect(
      simulated.status === 'valid' &&
        simulated.document.plugins?.['character-state']?.config,
    ).toEqual({greeting: 'package default', tone: 'authored'});
  });
});
