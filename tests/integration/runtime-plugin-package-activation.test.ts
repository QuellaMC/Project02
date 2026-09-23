import {characterDataDirPath} from '../../src/runtime/storage/index.ts';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {runInspectCliFromArgs} from '../../src/cli/inspect/main.ts';
import {
  characterMemoryPluginId,
  characterStatePluginId,
  runtimePluginContractVersion,
  runtimePluginId,
  sessionHistoryPluginId,
} from '../../src/plugins/api/contract.ts';
import {createRuntimePluginManifest} from '../../src/plugins/api/manifest-validation.ts';
import {demoConfigPluginId} from '../../src/plugins/packages/demo-config/plugin.ts';
import {mem0PluginId} from '../../src/plugins/packages/mem0/plugin.ts';
import type {RuntimePluginManifest} from '../../src/plugins/api/types.ts';
import {
  createConfiguredProject02PluginHostFromPlan,
  initializeProject02CharacterRuntime,
  prepareConfiguredProject02PluginActivation,
} from '../../src/app/index.ts';
import {createLocalRuntimeSessionStore} from '../../src/runtime/storage/session-store.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {collect} from '../support/streams.ts';
import {
  checkRuntimeConfigForTest,
  writeRuntimeConfig,
  runtimeConfigSnapshotForTest,
  loadRuntimeConfigForTest,
} from '../support/runtime-config.ts';
import {initializeCharacterDataForHost} from '../support/runtime-config-fixtures.ts';

describe('configured runtime plugin package activation', () => {
  it('builds the default catalog from bundled packages and bootstrap services', () => {
    const storeRoot = createTestTempRoot('project02-package-catalog-');

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const configured = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
      }),
    });

    expect(
      configured.activation.plugins.map(plugin => plugin.pluginId).sort(),
    ).toEqual(
      [
        characterMemoryPluginId,
        characterStatePluginId,
        demoConfigPluginId,
        mem0PluginId,
        runtimePluginId,
        sessionHistoryPluginId,
      ].sort(),
    );
    const characterState = configured.activation.plugins.find(
      plugin => plugin.pluginId === characterStatePluginId,
    );

    expect(characterState).toMatchObject({
      enabled: false,
      activationStatus: 'disabled',
    });
    expect(characterState?.activationReasons).toContain('not_enabled');
    expect(configured.packageProvenanceByPluginId).toEqual({
      [characterMemoryPluginId]: 'bundled',
      [characterStatePluginId]: 'bundled',
      [demoConfigPluginId]: 'bundled',
      [mem0PluginId]: 'bundled',
      [sessionHistoryPluginId]: 'bundled',
    });
    expect(configured.catalogEntries[characterStatePluginId]).toMatchObject({
      catalogKind: 'package',
    });
    expect(configured.catalogEntries[runtimePluginId]).toMatchObject({
      catalogKind: 'host_service',
    });
    expect(
      configured.catalogEntries[characterStatePluginId]?.catalogKind ===
        'package' &&
        typeof configured.catalogEntries[characterStatePluginId].load ===
          'function',
    ).toBe(true);
    expect(
      configured.catalogEntries[runtimePluginId]?.catalogKind ===
        'host_service' &&
        typeof configured.catalogEntries[runtimePluginId].bootstrap ===
          'function',
    ).toBe(true);
    expect(
      Object.values(configured.catalogEntries).some(entry => 'create' in entry),
    ).toBe(false);
  });

  it('drops bundled provenance when a factory override displaces the package', () => {
    const storeRoot = createTestTempRoot('project02-package-override-');
    const manifest = createRuntimePluginManifest({
      ...testPackageManifest(characterStatePluginId),
      requestedAccess: {trusted_context: 'write'},
    });

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const configured = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
        factories: {
          [characterStatePluginId]: {
            manifest,
            create: () => {
              throw new Error('override factory must not construct here');
            },
          },
        },
      }),
    });
    const overridden = configured.activation.plugins.find(
      plugin => plugin.pluginId === characterStatePluginId,
    );

    // The override wins the catalog entry, so the displaced bundled
    // package's provenance must not grant it the trusted frame.
    expect(
      configured.packageProvenanceByPluginId[characterStatePluginId],
    ).toBeUndefined();
    expect(overridden?.grantedAccess).not.toMatchObject({
      trusted_context: 'write',
    });
    expect(configured.activation.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'trusted_context_not_first_party',
        pluginId: characterStatePluginId,
      }),
    );
  });

  it('keeps an operator package disabled without evaluating its entry', async () => {
    const storeRoot = createTestTempRoot('project02-package-disabled-');
    const manifest = testPackageManifest('operator.cold', {
      defaultEnabled: true,
      firstParty: true,
    });

    writeOperatorPackage({
      storeRoot,
      manifest,
      entrySource: "throw new Error('disabled operator entry was imported');\n",
    });
    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    await initializeCharacterDataForHost(storeRoot);

    const activationPlan = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
      }),
    });
    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan,
    });

    const operatorPackage = configured.activation.plugins.find(
      plugin => plugin.pluginId === manifest.id,
    );

    expect(operatorPackage).toMatchObject({
      pluginId: manifest.id,
      enabled: false,
      activationStatus: 'disabled',
    });
    expect(operatorPackage?.activationReasons).toContain('not_enabled');
    expect(configured.plugins.map(plugin => plugin.manifest.id)).toEqual([
      characterMemoryPluginId,
      sessionHistoryPluginId,
    ]);
  });

  it('does not let an operator default claim trigger required-config validation', () => {
    const storeRoot = createTestTempRoot(
      'project02-package-disabled-required-',
    );
    const manifest = testPackageManifest('operator.required-cold', {
      defaultEnabled: true,
      configFields: [
        {
          name: 'endpoint',
          description: 'Required operator endpoint.',
          required: true,
          secret: false,
          valueType: 'string',
          redactionLabels: [],
        },
      ],
    });

    writeOperatorPackage({
      storeRoot,
      manifest,
      entrySource: "throw new Error('disabled operator entry was imported');\n",
    });
    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const configured = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
      }),
    });

    expect(configured.resolvedConfig.diagnostics).not.toContainEqual(
      expect.objectContaining({
        pluginId: manifest.id,
        code: 'runtime_config_required_value_missing',
      }),
    );
    expect(
      configured.activation.plugins.find(
        plugin => plugin.pluginId === manifest.id,
      ),
    ).toMatchObject({
      enabled: false,
      activationStatus: 'disabled',
    });
    expect(
      configured.activation.plugins.find(
        plugin => plugin.pluginId === characterStatePluginId,
      ),
    ).toMatchObject({
      enabled: false,
      activationStatus: 'disabled',
    });
  });

  it('keeps a config check and inspect on the same cold package catalog path', async () => {
    const storeRoot = createTestTempRoot('project02-package-cold-clis-');
    const manifest = testPackageManifest('operator.cold-cli');
    let inspectStdout = '';
    let inspectStderr = '';

    await createLocalRuntimeSessionStore({
      storeRoot: characterDataDirPath(storeRoot, 'mira'),
      characterId: 'mira',
    }).createSession({
      conversationId: 'cold-package-inspect',
      createdAt: '2026-07-15T00:00:00.000Z',
    });
    writeOperatorPackage({
      storeRoot,
      manifest,
      entrySource: "throw new Error('cold CLI imported operator entry');\n",
    });
    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const check = await checkRuntimeConfigForTest({storeRoot});
    const inspectExitCode = await runInspectCliFromArgs(
      ['--store', storeRoot, '--sessions'],
      {
        stdout: collect(chunk => {
          inspectStdout += chunk;
        }),
        stderr: collect(chunk => {
          inspectStderr += chunk;
        }),
      },
    );

    expect(check.ok).toBe(true);
    expect(check.plugins).toContainEqual(
      expect.objectContaining({pluginId: manifest.id}),
    );
    expect(inspectExitCode).toBe(0);
    expect(inspectStderr).toBe('');
    expect(inspectStdout).toContain(`"pluginId": "${manifest.id}"`);
  });

  it('quarantines a broken disabled operator package without blocking valid packages', () => {
    const storeRoot = createTestTempRoot('project02-package-broken-disabled-');
    const manifest = testPackageManifest('operator.broken');

    writeOperatorPackage({
      storeRoot,
      manifest,
      entrySource: validOperatorEntrySource(),
    });
    writeFileSync(
      join(storeRoot, 'plugins', manifest.id, 'project02.plugin.json'),
      '{ malformed',
      'utf8',
    );
    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const configured = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
      }),
    });

    expect(configured.activation.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'runtime_plugin_package_invalid_descriptor',
        pluginId: manifest.id,
      }),
    );
    expect(
      configured.activation.plugins.find(
        plugin => plugin.pluginId === characterStatePluginId,
      )?.enabled,
    ).toBe(false);
  });

  it('fails closed when config explicitly enables a quarantined operator package', () => {
    const storeRoot = createTestTempRoot('project02-package-broken-enabled-');
    const manifest = testPackageManifest('operator.broken-enabled');

    writeOperatorPackage({
      storeRoot,
      manifest,
      entrySource: validOperatorEntrySource(),
    });
    writeFileSync(
      join(storeRoot, 'plugins', manifest.id, 'project02.plugin.json'),
      '{ malformed',
      'utf8',
    );
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {[manifest.id]: {enabled: true}},
    });

    const configured = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
      }),
    });

    expect(configured.activation.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_plugin_package_invalid_descriptor',
        pluginId: manifest.id,
      }),
    );
    expect(
      configured.activation.plugins.find(
        plugin => plugin.pluginId === runtimePluginId,
      )?.enabled,
    ).toBe(true);
    expect(
      configured.activation.plugins.find(
        plugin => plugin.pluginId === characterStatePluginId,
      )?.activationStatus,
    ).toBe('blocked');
  });

  it('refuses to plan against an overlay in an unadoptable data directory', () => {
    const storeRoot = createTestTempRoot('project02-package-foreign-overlay-');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    // Marker-less, with an overlay and foreign content: durable startup refuses
    // this directory.
    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(join(dataRoot, 'config.json'), {
      project02: {userDisplayName: 'Foreign Name'},
    });
    writeFileSync(join(dataRoot, 'notes.txt'), 'foreign\n');

    expect(() =>
      prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({storeRoot}),
          storeRoot: storeRoot,
        }),
      }),
    ).toThrow('without a data marker');
  });

  it('refuses activation planning on a home the runtime would not adopt', async () => {
    const storeRoot = createTestTempRoot('project02-package-foreign-home-');

    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    writeFileSync(join(storeRoot, 'notes.txt'), 'not a project02 home\n');

    // The home owner rejects before discovery consumes paths beneath it.
    expect(() =>
      prepareConfiguredProject02PluginActivation({
        ...runtimeConfigSnapshotForTest({
          loadedConfig: loadRuntimeConfigForTest({storeRoot}),
          storeRoot: storeRoot,
        }),
      }),
    ).toThrow('foreign entries');
    expect(existsSync(join(storeRoot, 'character-data'))).toBe(false);

    // Direct initialization applies the same ownership rule.
    await expect(
      initializeProject02CharacterRuntime({location: {storeRoot}, env: {}}),
    ).rejects.toThrow('foreign entries');
  });

  it('fails closed when only the overlay enables a quarantined package on the direct activation path', () => {
    const storeRoot = createTestTempRoot('project02-package-overlay-enabled-');
    const manifest = testPackageManifest('operator.broken-overlay');
    const dataRoot = characterDataDirPath(storeRoot, 'mira');

    writeOperatorPackage({
      storeRoot,
      manifest,
      entrySource: validOperatorEntrySource(),
    });
    writeFileSync(
      join(storeRoot, 'plugins', manifest.id, 'project02.plugin.json'),
      '{ malformed',
      'utf8',
    );
    // Only the overlay enables the plugin, and the direct path is given no
    // overlay argument.
    writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(join(dataRoot, 'config.json'), {
      plugins: {[manifest.id]: {enabled: true}},
    });

    const configured = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
        storeRoot: storeRoot,
      }),
    });

    expect(configured.activation.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_plugin_package_invalid_descriptor',
        pluginId: manifest.id,
      }),
    );
  });

  it('fails closed when config enables the claimed id of a mismatched package', () => {
    const storeRoot = createTestTempRoot(
      'project02-package-mismatched-enabled-',
    );
    const manifest = testPackageManifest('operator.enabled-mismatch');

    writeOperatorPackage({
      storeRoot,
      manifest,
      folderId: 'wrong-folder',
      entrySource: validOperatorEntrySource(),
    });
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {[manifest.id]: {enabled: true}},
    });

    const configured = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
      }),
    });

    expect(configured.activation.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'runtime_plugin_package_package_id_mismatch',
        pluginId: manifest.id,
      }),
    );
    expect(
      configured.activation.plugins.find(
        plugin => plugin.pluginId === characterStatePluginId,
      )?.activationStatus,
    ).toBe('blocked');
  });

  it('keeps bundled Character State when an operator package copies its id', () => {
    const storeRoot = createTestTempRoot(
      'project02-package-reserved-character-',
    );
    const manifest = testPackageManifest(characterStatePluginId, {
      defaultEnabled: true,
      firstParty: true,
    });

    writeOperatorPackage({
      storeRoot,
      manifest,
      entrySource: "throw new Error('operator collision must not import');\n",
    });
    writeRuntimeConfig(join(storeRoot, 'config.json'), {});

    const configured = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
      }),
    });

    expect(configured.packageProvenanceByPluginId[characterStatePluginId]).toBe(
      'bundled',
    );
    expect(configured.activation.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'runtime_plugin_package_reserved_plugin_id',
        pluginId: characterStatePluginId,
      }),
    );
    expect(
      configured.activation.plugins.find(
        plugin => plugin.pluginId === characterStatePluginId,
      )?.enabled,
    ).toBe(false);
  });

  it('imports an enabled operator package once with resolved and redacted config', async () => {
    const storeRoot = createTestTempRoot('project02-package-enabled-');
    const manifest = testPackageManifest('operator.active', {
      configFields: [
        {
          name: 'label',
          description: 'Operator-visible label.',
          required: true,
          secret: false,
          valueType: 'string',
          redactionLabels: [],
        },
      ],
    });
    const capturePath = join(storeRoot, 'operator-factory-input.json');

    writeOperatorPackage({
      storeRoot,
      manifest,
      entrySource: [
        "import { writeFileSync } from 'node:fs';",
        'let calls = 0;',
        'export function createProject02Plugin(input) {',
        '  calls += 1;',
        `  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ calls, input }), 'utf8');`,
        '  return { manifest: input.manifest, providedTools: [], lifecycleHooks: {} };',
        '}',
        '',
      ].join('\n'),
    });
    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [manifest.id]: {
          enabled: true,
          config: {label: 'hello'},
        },
      },
    });

    await initializeCharacterDataForHost(storeRoot);

    const activationPlan = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
      }),
    });
    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan,
    });
    const captured = JSON.parse(readFileSync(capturePath, 'utf8')) as {
      readonly calls: number;
      readonly input: {
        readonly pluginId: string;
        readonly manifest: RuntimePluginManifest;
        readonly storeRoot: string;
        readonly resolvedConfig: Readonly<Record<string, unknown>>;
        readonly redactedConfig: Readonly<Record<string, unknown>>;
      };
    };

    expect(captured).toMatchObject({
      calls: 1,
      input: {
        pluginId: manifest.id,
        manifest: {id: manifest.id},
        storeRoot: characterDataDirPath(
          configured.resolvedConfig.project02.storeRoot,
          'mira',
        ),
        resolvedConfig: {
          label: {
            name: 'label',
            secret: false,
            source: 'config',
            resolved: true,
            value: 'hello',
          },
        },
        redactedConfig: {
          label: {
            name: 'label',
            secret: false,
            source: 'config',
            resolved: true,
            value: 'hello',
          },
        },
      },
    });
    expect(configured.plugins.map(plugin => plugin.manifest.id).sort()).toEqual(
      [characterMemoryPluginId, manifest.id, sessionHistoryPluginId].sort(),
    );
    expect(activationPlan.packageProvenanceByPluginId).toEqual({
      [characterMemoryPluginId]: 'bundled',
      [characterStatePluginId]: 'bundled',
      [demoConfigPluginId]: 'bundled',
      [mem0PluginId]: 'bundled',
      [sessionHistoryPluginId]: 'bundled',
      [manifest.id]: 'operator',
    });
  });

  it('resolves an entry link target’s own relative imports beside the target', async () => {
    const storeRoot = createTestTempRoot('project02-package-entry-link-');
    const manifest = testPackageManifest('operator.entry-link');
    const packageRoot = join(storeRoot, 'plugins', manifest.id);
    const capturePath = join(storeRoot, 'entry-link-helper.txt');

    writeOperatorPackage({
      storeRoot,
      manifest,
      entrySource: 'unused: replaced by a link below',
    });
    // index.mjs links to sub/target.mjs, which imports its own sibling: a
    // relative specifier resolves against the bytes' directory, not the link's.
    mkdirSync(join(packageRoot, 'sub'), {recursive: true});
    writeFileSync(
      join(packageRoot, 'sub', 'helper.mjs'),
      'export const label = "from-sub-helper";\n',
      'utf8',
    );
    writeFileSync(
      join(packageRoot, 'sub', 'target.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        "import { label } from './helper.mjs';",
        'export function createProject02Plugin(input) {',
        `  writeFileSync(${JSON.stringify(capturePath)}, label, 'utf8');`,
        '  return {',
        '    manifest: input.manifest,',
        '    providedTools: [],',
        '    lifecycleHooks: {},',
        '  };',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    unlinkSync(join(packageRoot, 'index.mjs'));
    symlinkSync(
      join(packageRoot, 'sub', 'target.mjs'),
      join(packageRoot, 'index.mjs'),
      'file',
    );

    writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {[manifest.id]: {enabled: true}},
    });

    await initializeCharacterDataForHost(storeRoot);

    const activationPlan = prepareConfiguredProject02PluginActivation({
      ...runtimeConfigSnapshotForTest({
        loadedConfig: loadRuntimeConfigForTest({storeRoot}),
      }),
    });
    const configured = await createConfiguredProject02PluginHostFromPlan({
      activationPlan,
    });

    // The factory only runs if the target's own import resolved.
    expect(
      configured.activation.plugins.find(
        plugin => plugin.pluginId === manifest.id,
      ),
    ).toMatchObject({enabled: true, activationStatus: 'active'});
    expect(configured.plugins.map(plugin => plugin.manifest.id)).toEqual([
      characterMemoryPluginId,
      manifest.id,
      sessionHistoryPluginId,
    ]);
    expect(readFileSync(capturePath, 'utf8')).toBe('from-sub-helper');
  });
});

function writeOperatorPackage(options: {
  readonly storeRoot: string;
  readonly manifest: RuntimePluginManifest;
  readonly folderId?: string;
  readonly entrySource: string;
}): void {
  const packageRoot = join(
    options.storeRoot,
    'plugins',
    options.folderId ?? options.manifest.id,
  );

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({type: 'module'})}\n`,
    'utf8',
  );
  writeFileSync(
    join(packageRoot, 'project02.plugin.json'),
    `${JSON.stringify({
      format: 'project02.plugin.v1',
      entry: './index.mjs',
      manifest: options.manifest,
    })}\n`,
    'utf8',
  );
  writeFileSync(join(packageRoot, 'index.mjs'), options.entrySource, 'utf8');
}

function validOperatorEntrySource(): string {
  return [
    'export function createProject02Plugin(input) {',
    '  return { manifest: input.manifest, providedTools: [], lifecycleHooks: {} };',
    '}',
    '',
  ].join('\n');
}

function testPackageManifest(
  id: string,
  options: {
    readonly defaultEnabled?: boolean;
    readonly firstParty?: RuntimePluginManifest['firstParty'];
    readonly configFields?: RuntimePluginManifest['config']['fields'];
  } = {},
): RuntimePluginManifest {
  return createRuntimePluginManifest({
    id,
    displayName: `Test ${id}`,
    version: '1.0.0',
    kind: 'tool_provider',
    description: 'Operator package activation fixture.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
    },
    declaredPlugins: ['plugin_discovery'],
    config: {
      scope: 'global_with_character_overrides',
      fields: options.configFields ?? [],
    },
    firstParty: options.firstParty ?? false,
    runtimePolicy: {
      timeoutMs: 1000,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: options.defaultEnabled ?? false,
      reasons: ['operator_fixture'],
    },
    requestedAccess: {},
  });
}
