import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  classifyRuntimePluginCatalogDiscovery,
  discoverRuntimePluginCatalog,
} from '../../src/app/index.ts';
import {
  runtimeConfigVersion,
  type LoadedProject02RuntimeConfig,
  type Project02RuntimeConfig,
} from '../../src/runtime/config/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

describe('runtime plugin catalog discovery classification', () => {
  it('re-classifies one discovery per config layer without re-scanning', () => {
    const storeRoot = createTestTempRoot('project02-catalog-discovery-');
    const packageRoot = join(storeRoot, 'plugins', 'broken.pkg');

    // A manifest that fails validation; severity is a per-layer verdict.
    mkdirSync(packageRoot, {recursive: true});
    writeFileSync(
      join(packageRoot, 'project02.plugin.json'),
      `${JSON.stringify({
        format: 'project02.plugin.v1',
        entry: './index.mjs',
        manifest: {id: 'broken.pkg'},
      })}\n`,
      'utf8',
    );

    const discovery = discoverRuntimePluginCatalog({storeRoot});

    expect(discovery.packageDiagnostics.length).toBeGreaterThan(0);
    expect(Object.keys(discovery.catalogEntries)).not.toContain('broken.pkg');

    const dormant = classifyRuntimePluginCatalogDiscovery({
      discovery,
      classificationConfig: loadedConfig(undefined),
    });
    const enabled = classifyRuntimePluginCatalogDiscovery({
      discovery,
      classificationConfig: loadedConfig({
        version: runtimeConfigVersion,
        plugins: {'broken.pkg': {enabled: true}},
      }),
    });

    expect(dormant.catalogEntries).toBe(discovery.catalogEntries);
    expect(enabled.catalogEntries).toBe(discovery.catalogEntries);
    expect(
      dormant.diagnostics
        .filter(diagnostic => diagnosticNamesBrokenPackage(diagnostic))
        .map(diagnostic => diagnostic.severity),
    ).toEqual(['warning']);
    expect(
      enabled.diagnostics
        .filter(diagnostic => diagnosticNamesBrokenPackage(diagnostic))
        .map(diagnostic => diagnostic.severity),
    ).toEqual(['error']);
  });
});

function diagnosticNamesBrokenPackage(diagnostic: {
  readonly scope: string;
  readonly id?: string;
}): boolean {
  return diagnostic.scope === 'section' && diagnostic.id === 'broken.pkg';
}

function loadedConfig(
  config:
    | {
        readonly version: string;
        readonly plugins?: Readonly<
          Record<string, {readonly enabled?: boolean}>
        >;
      }
    | undefined,
): LoadedProject02RuntimeConfig {
  return Object.freeze({
    source: 'none',
    ...(config === undefined ? {} : {config: config as Project02RuntimeConfig}),
    diagnostics: Object.freeze([]),
  });
}
