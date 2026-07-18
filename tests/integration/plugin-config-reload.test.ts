import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {prepareConfiguredProject02PluginActivation} from '../../src/app/index.ts';
import {createConfiguredRuntimePluginReloader} from '../../src/app/plugin-reload.ts';
import {runtimePluginId} from '../../src/plugins/api/index.ts';
import {
  inspectRuntimePluginConfig,
  loadProject02RuntimeConfig,
} from '../../src/runtime/config/index.ts';
import {createTestTempRoot} from '../support/temp-root.ts';
import {writeRuntimeConfig} from '../support/runtime-config.ts';
import {testPluginContext} from '../support/plugin-host-fixtures.ts';

async function demoConfigContextText(plugin: {
  readonly lifecycleHooks: {
    readonly beforeRoleModelCall?: (
      context: ReturnType<typeof testPluginContext>,
    ) => unknown;
  };
}): Promise<string> {
  const hook = plugin.lifecycleHooks.beforeRoleModelCall;

  if (hook === undefined) {
    throw new Error('demo-config must register beforeRoleModelCall');
  }

  const result = (await hook(testPluginContext())) as {
    contextItems: ReadonlyArray<{text: string}>;
  };

  return result.contextItems.map(item => item.text).join('|');
}

function authoredFingerprint(options: {
  readonly activationPlan: {
    readonly pluginConfigControl: {
      readonly pluginManifests: ReadonlyArray<{readonly id: string}>;
    };
  };
  readonly configPath: string;
  readonly storeRoot: string;
}): string {
  const manifest =
    options.activationPlan.pluginConfigControl.pluginManifests.find(
      candidate => candidate.id === 'demo-config',
    );

  if (manifest === undefined) {
    throw new Error('demo-config manifest missing from the plan');
  }

  return inspectRuntimePluginConfig({
    manifest: manifest as Parameters<
      typeof inspectRuntimePluginConfig
    >[0]['manifest'],
    configPath: options.configPath,
    storeRoot: options.storeRoot,
    env: {},
  }).fingerprint;
}

describe('configured runtime plugin reloader', () => {
  it('rebuilds a package plugin from freshly authored config and declines the rest', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {
        'demo-config': {enabled: true, config: {tone: 'warm'}},
      },
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
      env: {},
    });
    const reloader = createConfiguredRuntimePluginReloader({activationPlan});

    const rebuilt = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
    });

    if (rebuilt.status !== 'rebuilt') {
      throw new Error(`Expected rebuilt, got ${rebuilt.status}`);
    }
    expect(await demoConfigContextText(rebuilt.plugin)).toContain('warm tone');

    const authored = loadProject02RuntimeConfig({
      configPath,
      storeRoot,
      env: {},
    });

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          ...(authored.config ?? {}),
          plugins: {
            'demo-config': {enabled: true, config: {tone: 'playful'}},
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const refreshed = await reloader.reload('demo-config', {
      expectedFingerprint: authoredFingerprint({
        activationPlan,
        configPath,
        storeRoot,
      }),
    });

    if (refreshed.status !== 'rebuilt') {
      throw new Error(`Expected rebuilt, got ${refreshed.status}`);
    }
    expect(await demoConfigContextText(refreshed.plugin)).toContain(
      'playful tone',
    );

    const currentFingerprint = authoredFingerprint({
      activationPlan,
      configPath,
      storeRoot,
    });
    const hostService = await reloader.reload(runtimePluginId, {
      expectedFingerprint: currentFingerprint,
    });
    const unknown = await reloader.reload('nope.not-installed', {
      expectedFingerprint: currentFingerprint,
    });

    expect(hostService.status).toBe('declined');
    expect(unknown.status).toBe('declined');
  });

  it('declines when the authored config moved past the approved update', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-moved-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
      env: {},
    });
    const reloader = createConfiguredRuntimePluginReloader({activationPlan});
    const approvedFingerprint = authoredFingerprint({
      activationPlan,
      configPath,
      storeRoot,
    });

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'playful'}}},
    });

    const result = await reloader.reload('demo-config', {
      expectedFingerprint: approvedFingerprint,
    });

    expect(result.status).toBe('declined');
    if (result.status === 'declined') {
      expect(result.reason).toContain('moved past');
    }
  });

  it('declines a reload when the refreshed config is invalid', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-reload-invalid-');
    const configPath = join(storeRoot, 'config.json');

    writeRuntimeConfig(configPath, {
      plugins: {'demo-config': {enabled: true, config: {tone: 'warm'}}},
    });

    const activationPlan = prepareConfiguredProject02PluginActivation({
      loadedConfig: loadProject02RuntimeConfig({
        configPath,
        storeRoot,
        env: {},
      }),
      storeRoot,
      env: {},
    });
    const reloader = createConfiguredRuntimePluginReloader({activationPlan});

    const approvedFingerprint = authoredFingerprint({
      activationPlan,
      configPath,
      storeRoot,
    });

    writeFileSync(
      configPath,
      `${JSON.stringify({version: 'project02.config.unsupported'})}\n`,
      'utf8',
    );

    const result = await reloader.reload('demo-config', {
      expectedFingerprint: approvedFingerprint,
    });

    expect(result.status).toBe('declined');
  });
});
