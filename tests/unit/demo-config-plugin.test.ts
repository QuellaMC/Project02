import {describe, expect, it} from 'vitest';

import {
  bundledRuntimePluginPackageRoot,
  discoverRuntimePluginPackages,
} from '../../src/plugins/package-loader/index.ts';
import {hostFirstPartyRuntimePluginIds} from '../../src/plugins/host/catalog.ts';
import {
  createDemoConfigPluginManifest,
  createProject02Plugin,
  demoConfigDefaultTone,
  demoConfigPluginId,
} from '../../src/plugins/packages/demo-config/plugin.ts';
import type {RuntimePluginFactoryInput} from '../../src/plugins/api/factory.ts';
import type {
  RuntimePlugin,
  RuntimePluginBeforeRoleModelCallResult,
} from '../../src/plugins/api/types.ts';
import {testPluginContext} from '../support/plugin-host-fixtures.ts';

function demoConfigFactoryInput(
  values: Readonly<Record<string, string>> = {},
): RuntimePluginFactoryInput {
  return {
    pluginId: demoConfigPluginId,
    manifest: createDemoConfigPluginManifest(),
    storeRoot: '/unused/demo-config-store',
    resolvedConfig: Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        {name, secret: false, source: 'config', resolved: true, value},
      ]),
    ),
    redactedConfig: {},
  };
}

async function demoConfigStyleDirectives(
  plugin: RuntimePlugin,
): Promise<RuntimePluginBeforeRoleModelCallResult> {
  const hook = plugin.lifecycleHooks.beforeRoleModelCall;

  if (hook === undefined) {
    throw new Error('demo-config plugin must register beforeRoleModelCall');
  }

  return await hook(testPluginContext());
}

describe('demo-config plugin package', () => {
  it('is discovered as a bundled package with agent-mutable style fields', () => {
    const discovery = discoverRuntimePluginPackages({
      sources: [{root: bundledRuntimePluginPackageRoot, provenance: 'bundled'}],
      reservedPluginIds: hostFirstPartyRuntimePluginIds,
    });
    const discovered = discovery.packages.find(
      item => item.manifest.id === demoConfigPluginId,
    );

    expect(discovery.diagnostics).toEqual([]);
    expect(discovered?.provenance).toBe('bundled');
    expect(discovered?.manifest.activation.defaultEnabled).toBe(false);

    const fieldsByName = Object.fromEntries(
      (discovered?.manifest.config.fields ?? []).map(field => [
        field.name,
        field,
      ]),
    );

    expect(fieldsByName['tone']?.agentMutable).toBe(true);
    expect(fieldsByName['tone']?.allowedValues).toContain('pirate');
    expect(fieldsByName['signoff']?.agentMutable).toBe(true);
    expect(fieldsByName['operatorNote']?.agentMutable).toBe(false);
    expect(fieldsByName['apiKey']?.secret).toBe(true);
    expect(fieldsByName['apiKey']?.agentMutable).toBe(false);
  });

  it('contributes default style directives when no config is set', async () => {
    const result = await demoConfigStyleDirectives(
      createProject02Plugin(demoConfigFactoryInput()),
    );

    expect(result.contextItems).toHaveLength(1);
    expect(result.contextItems[0]?.text).toContain(
      `reply in a ${demoConfigDefaultTone} tone`,
    );
    expect(result.contextItems[0]?.text).not.toContain('signoff "');
    expect(result.evidence[0]?.status).toBe('accepted');
  });

  it('reflects the configured tone and signoff in its directives', async () => {
    const result = await demoConfigStyleDirectives(
      createProject02Plugin(
        demoConfigFactoryInput({tone: 'pirate', signoff: 'Arr, matey!'}),
      ),
    );

    expect(result.contextItems[0]?.text).toContain('reply in a pirate tone');
    expect(result.contextItems[0]?.text).toContain(
      'End every reply with the exact signoff "Arr, matey!"',
    );
  });

  it('ignores unresolved and blank config values', async () => {
    const input = demoConfigFactoryInput({signoff: '   '});
    const result = await demoConfigStyleDirectives(
      createProject02Plugin({
        ...input,
        resolvedConfig: {
          ...input.resolvedConfig,
          tone: {
            name: 'tone',
            secret: false,
            source: 'missing',
            resolved: false,
          },
        },
      }),
    );

    expect(result.contextItems[0]?.text).toContain(
      `reply in a ${demoConfigDefaultTone} tone`,
    );
    expect(result.contextItems[0]?.text).not.toContain('signoff');
  });
});
