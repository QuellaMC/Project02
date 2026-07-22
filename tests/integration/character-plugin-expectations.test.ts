import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  characterOverlaySeedDocument,
  enforceCharacterPluginExpectations,
  resolveRuntimeCliStartup,
} from '../../src/app/index.ts';
import type {CharacterPluginExpectations} from '../../src/characters/index.ts';
import {
  applyScopedRuntimeConfigControlOperation,
  characterOverlayConfigPath,
  runtimeConfigVersion,
} from '../../src/runtime/config/index.ts';
import {characterDataDirPath} from '../../src/runtime/storage/index.ts';
import type {RuntimePluginActivationResult} from '../../src/app/index.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

function expectations(
  overrides: Partial<CharacterPluginExpectations>,
): CharacterPluginExpectations {
  return {
    required: [],
    recommended: [],
    config: {},
    ...overrides,
  };
}

function activationWithEnabled(
  enabledPluginIds: readonly string[],
): RuntimePluginActivationResult {
  return {
    enabledPluginIds,
    disabledPluginIds: [],
    plugins: [],
    diagnostics: [],
  };
}

/** Seeds a home whose operator character declares a plugins block. */
function homeWithCharacter(options: {
  readonly characterId: string;
  readonly plugins?: Readonly<Record<string, unknown>>;
}): string {
  const homeRoot = createTestTempRoot('project02-char-plugins-');
  const packageRoot = join(homeRoot, 'characters', options.characterId);

  mkdirSync(packageRoot, {recursive: true});
  writeFileSync(
    join(packageRoot, 'project02.character.json'),
    `${JSON.stringify(
      {
        format: 'project02.character.v1',
        identity: {
          id: options.characterId,
          displayName: 'Seeded Character',
        },
        persona: {system: ['You are a seeded fixture character.']},
        meta: {version: '1.0.0'},
        ...(options.plugins === undefined ? {} : {plugins: options.plugins}),
      },
      null,
      2,
    )}\n`,
  );
  writeRuntimeConfig(join(homeRoot, 'config.json'), {
    project02: {character: options.characterId},
  });
  return homeRoot;
}

describe('character overlay seed document', () => {
  it('builds one sorted enabled rung per required and recommended plugin', () => {
    const seed = characterOverlaySeedDocument(
      expectations({
        required: ['zeta-plugin', 'character-state'],
        recommended: ['demo-config', 'character-state'],
        config: {
          'demo-config': {tone: 'formal'},
          'config-only-plugin': {setting: 1},
        },
      }),
    );

    expect(seed).toEqual({
      status: 'seed',
      document: {
        version: runtimeConfigVersion,
        plugins: {
          'character-state': {enabled: true},
          'config-only-plugin': {config: {setting: 1}},
          'demo-config': {enabled: true, config: {tone: 'formal'}},
          'zeta-plugin': {enabled: true},
        },
      },
    });
  });

  it('produces no seed without expectations and reports invalid defaults', () => {
    expect(characterOverlaySeedDocument(undefined)).toEqual({status: 'none'});
    expect(
      characterOverlaySeedDocument(
        expectations({required: [], recommended: [], config: {}}),
      ),
    ).toEqual({status: 'none'});

    const invalid = characterOverlaySeedDocument(
      expectations({
        config: {'demo-config': {apiKey: {$env: ''}}},
      }),
    );

    expect(invalid.status).toBe('invalid');
    if (invalid.status !== 'invalid') {
      throw new Error('Expected invalid seed.');
    }
    expect(invalid.messages[0]).toContain(
      'Character plugin defaults do not form a valid config document',
    );
  });
});

describe('character plugin enforcement', () => {
  it('escalates required plugins and only warns for recommended ones', () => {
    const diagnostics = enforceCharacterPluginExpectations({
      expectations: expectations({
        required: ['missing-required', 'disabled-required', 'ok-plugin'],
        recommended: ['missing-recommended', 'ok-plugin'],
      }),
      characterId: 'seeded',
      activation: activationWithEnabled(['ok-plugin']),
      installedPluginIds: new Set(['disabled-required', 'ok-plugin']),
    });

    expect(diagnostics).toMatchObject([
      {
        severity: 'error',
        code: 'character_required_plugin_missing',
        pluginId: 'missing-required',
      },
      {
        severity: 'error',
        code: 'character_required_plugin_disabled',
        pluginId: 'disabled-required',
      },
      {
        severity: 'warning',
        code: 'character_recommended_plugin_missing',
        pluginId: 'missing-recommended',
      },
    ]);
    expect(diagnostics[1]?.message).toContain(
      'runtime-config --character seeded plugin enable disabled-required',
    );
  });
});

describe('first-selection materialization through startup', () => {
  it('seeds the overlay once and keeps it byte-identical afterwards', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {
        required: ['demo-config'],
        config: {'demo-config': {tone: 'formal'}},
      },
    });
    const overlayPath = characterOverlayConfigPath(
      characterDataDirPath(homeRoot, 'seeded'),
    );

    const first = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      dataDir: 'materialize',
    });

    expect(first.status).toBe('resolved');
    if (first.status !== 'resolved') {
      throw new Error('Expected a resolved startup.');
    }
    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: runtimeConfigVersion,
      plugins: {'demo-config': {enabled: true, config: {tone: 'formal'}}},
    });
    // The materialized overlay already governs this same startup.
    expect(
      first.activationPlan.resolvedConfig.pluginConfigs['demo-config']?.[
        'tone'
      ],
    ).toMatchObject({value: 'formal'});
    expect(first.activationPlan.activation.enabledPluginIds).toContain(
      'demo-config',
    );

    // Second selection: the file is the marker; nothing is rewritten.
    const bytesAfterFirst = readFileSync(overlayPath, 'utf8');

    await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      dataDir: 'materialize',
    });
    expect(readFileSync(overlayPath, 'utf8')).toBe(bytesAfterFirst);
  });

  it('seeds unknown plugin ids verbatim and then blocks on the missing requirement', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {required: ['not-installed-plugin']},
    });
    const overlayPath = characterOverlayConfigPath(
      characterDataDirPath(homeRoot, 'seeded'),
    );

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      dataDir: 'materialize',
    });

    expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual({
      version: runtimeConfigVersion,
      plugins: {'not-installed-plugin': {enabled: true}},
    });
    expect(startup.status).toBe('activation_blocked_before_runtime_env');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected a plugin activation plan.');
    }
    expect(
      startup.activationPlan.activation.diagnostics.filter(
        diagnostic => diagnostic.code === 'character_required_plugin_missing',
      ),
    ).toHaveLength(1);
  });

  it('never overwrites an overlay the CLI created first, and enforcement still reports', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {required: ['demo-config']},
    });

    // Operator writes the overlay before ever selecting the character.
    applyScopedRuntimeConfigControlOperation({
      storeRoot: homeRoot,
      env: {},
      scope: 'character',
      characterId: 'seeded',
      operation: {
        kind: 'set',
        path: 'project02.userDisplayName',
        value: 'Early Bird',
      },
    });

    const overlayPath = characterOverlayConfigPath(
      characterDataDirPath(homeRoot, 'seeded'),
    );
    const cliWrittenBytes = readFileSync(overlayPath, 'utf8');
    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      dataDir: 'materialize',
    });

    // The CLI-authored overlay wins: no package seed on top of it, so
    // demo-config never got its enabled rung and enforcement says so.
    expect(readFileSync(overlayPath, 'utf8')).toBe(cliWrittenBytes);
    expect(startup.status).toBe('activation_blocked_before_runtime_env');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected a plugin activation plan.');
    }
    expect(
      startup.activationPlan.activation.diagnostics.filter(
        diagnostic => diagnostic.code === 'character_required_plugin_disabled',
      ),
    ).toHaveLength(1);
  });

  it('blocks a required plugin an operator explicitly disabled in the overlay', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {required: ['demo-config']},
    });
    const dataRoot = characterDataDirPath(homeRoot, 'seeded');

    mkdirSync(dataRoot, {recursive: true});
    writeRuntimeConfig(characterOverlayConfigPath(dataRoot), {
      plugins: {'demo-config': {enabled: false}},
    });

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      dataDir: 'materialize',
    });

    expect(startup.status).toBe('activation_blocked_before_runtime_env');
    if (startup.status === 'character_invalid') {
      throw new Error('Expected a plugin activation plan.');
    }

    const disabled = startup.activationPlan.activation.diagnostics.find(
      diagnostic => diagnostic.code === 'character_required_plugin_disabled',
    );

    expect(disabled?.message).toContain(
      'runtime-config --character seeded plugin enable demo-config',
    );
  });
});

describe('materialization ordering', () => {
  it('creates no durable state when the global config is invalid', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {required: ['demo-config']},
    });

    writeFileSync(
      join(homeRoot, 'config.json'),
      '{"version":"project02.config.v2","unknownField":true}\n',
    );

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      dataDir: 'materialize',
    });

    expect(startup.status).toBe('config_invalid');
    expect(existsSync(characterDataDirPath(homeRoot, 'seeded'))).toBe(false);
    expect(existsSync(join(homeRoot, 'schema.json'))).toBe(false);
  });
});

describe('seed validation against installed manifests', () => {
  it('refuses to persist a seed the installed manifests reject', async () => {
    const homeRoot = homeWithCharacter({
      characterId: 'seeded',
      plugins: {
        required: ['demo-config'],
        config: {'demo-config': {misspelledTone: 'warm'}},
      },
    });

    const startup = await resolveRuntimeCliStartup({
      location: {storeRoot: homeRoot},
      env: {},
      dataDir: 'materialize',
    });

    expect(startup.status).toBe('character_invalid');
    if (startup.status !== 'character_invalid') {
      throw new Error('Expected character_invalid.');
    }
    expect(
      startup.characterActivation.status === 'failed'
        ? startup.characterActivation.messages[0]
        : '',
    ).toContain('rejected by the installed plugin manifests');
    expect(
      existsSync(
        characterOverlayConfigPath(characterDataDirPath(homeRoot, 'seeded')),
      ),
    ).toBe(false);
  });
});
