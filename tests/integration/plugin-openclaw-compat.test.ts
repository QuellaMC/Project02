import {testCharacterProfile} from '../support/character-fixtures.ts';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {createTestTempRoot} from '../support/temp-root.ts';
import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
} from '../../src/plugins/api/index.ts';
import type {RuntimePluginFactoryInput} from '../../src/plugins/api/factory.ts';
import type {
  ResolvedPluginRuntimeConfig,
  RuntimeConfigValue,
} from '../../src/runtime/config/index.ts';
import {createProject02Plugin} from '../../src/plugins/packages/openclaw-compat/index.ts';
import {
  createOpenClawCompatPluginManifest,
  openClawCompatPluginId,
} from '../../src/plugins/packages/openclaw-compat/plugin.ts';

const fixturesRoot = join(
  process.cwd(),
  'tests',
  'fixtures',
  'openclaw-context-engine',
);

describe('OpenClaw context-engine compat plugin', () => {
  it('mounts a pinned-v1 module as a recall-and-capture memory provider', async () => {
    const manifest = createOpenClawCompatPluginManifest();
    const plugin = await createProject02Plugin(
      compatFactoryInput(join(fixturesRoot, 'engine.mjs')),
    );

    expect(plugin.manifest).toEqual(manifest);
    expect(plugin.manifest.kind).toBe('memory_provider');
    expect(plugin.manifest.activation.defaultEnabled).toBe(false);
    // The current context-engine surface has no row-backed verbs, so the
    // compat provider exposes no tools.
    expect(plugin.providedTools).toEqual([]);
    expect(plugin.manifest.declaredPlugins).toEqual([
      'before_role_model_call',
      'after_turn_committed',
      'on_shutdown',
    ]);
  });

  it('surfaces the assembled system-prompt addition as one source-backed recall item', async () => {
    const plugin = await createProject02Plugin(
      compatFactoryInput(join(fixturesRoot, 'engine.mjs')),
    );

    const result =
      await plugin.lifecycleHooks.beforeRoleModelCall?.(compatContext());

    expect(result?.contextItems).toHaveLength(1);
    expect(result?.contextItems[0]).toMatchObject({
      pluginId: openClawCompatPluginId,
      kind: 'memory',
      text: 'Engine brief for "remember this" after 0 ingested message(s). budget=150',
      sourceReferences: [
        {
          kind: 'external_contract',
          id: 'fixture-engine.assemble',
          title: 'Context engine assembly',
        },
      ],
    });
  });

  it('ingests committed turns so later assemblies see them', async () => {
    const plugin = await createProject02Plugin(
      compatFactoryInput(join(fixturesRoot, 'engine.mjs')),
    );

    const capture = await plugin.lifecycleHooks.afterTurnCommitted?.(
      createRuntimePluginAfterTurnCommittedContext({
        ...testIdentity(),
        sessionId: 'session-openclaw-compat',
        eventType: 'USER_MESSAGE',
        currentUserMessage: 'remember this',
        character: testCharacterProfile,
        committedAt: '2026-08-10T00:00:01.000Z',
        visibleMessages: [
          {
            id: 'visible-character',
            role: 'character',
            speakerId: 'mira',
            speakerName: 'Mira',
            text: 'noted',
          },
        ],
      }),
    );
    const recallAfter =
      await plugin.lifecycleHooks.beforeRoleModelCall?.(compatContext());

    expect(capture?.status).toBe('completed');
    expect(capture?.evidence[0]).toMatchObject({
      evidenceKind: 'after_turn_committed',
      status: 'accepted',
      sourceReferences: [
        {kind: 'external_contract', id: 'fixture-engine.ingest'},
      ],
    });
    expect(recallAfter?.contextItems[0]?.text).toContain(
      'after 2 ingested message(s).',
    );
  });

  it('recalls an assembly carried only in the engine messages', async () => {
    const plugin = await createProject02Plugin(
      compatFactoryInput(join(fixturesRoot, 'messages-only.mjs')),
    );

    const result =
      await plugin.lifecycleHooks.beforeRoleModelCall?.(compatContext());

    // The messages are the engine's primary output; discarding them would
    // report no recall for a working engine.
    expect(result?.contextItems[0]?.text).toBe(
      'Assembled without a prompt addition.',
    );
  });

  it('forwards configured engine settings and the secret credential to the factory', async () => {
    const plugin = await createProject02Plugin(
      compatFactoryInput(join(fixturesRoot, 'engine.mjs'), {
        engineConfig: {label: 'configured'},
        engineApiKey: 'engine-secret',
      }),
    );

    const result =
      await plugin.lifecycleHooks.beforeRoleModelCall?.(compatContext());
    const text = result?.contextItems[0]?.text ?? '';

    // The credential reaches the engine without ever being written to the
    // config file, and never travels back out in recalled text.
    expect(text).toContain('label:configured');
    expect(text).toContain('credential:present');
    expect(text).not.toContain('engine-secret');
  });

  it('keeps the prompt it handed the engine out of recalled memory', async () => {
    const plugin = await createProject02Plugin(
      compatFactoryInput(join(fixturesRoot, 'echoing.mjs')),
    );

    const result =
      await plugin.lifecycleHooks.beforeRoleModelCall?.(compatContext());

    // An engine returns the assembled message list, input included;
    // recalling the echo would spend the budget on the current prompt.
    expect(result?.contextItems[0]?.text).toBe(
      'Recalled: they take tea black.',
    );
  });

  it('reports an assembly that drifted from the pinned shape instead of recalling nothing', async () => {
    const plugin = await createProject02Plugin(
      compatFactoryInput(join(fixturesRoot, 'malformed-assembly.mjs')),
    );

    // An incompatible engine must not read as an engine with nothing to
    // say; the host degrades the turn and records why.
    await expect(
      plugin.lifecycleHooks.beforeRoleModelCall?.(compatContext()),
    ).rejects.toThrow('no longer matches pinned interface v1');
  });

  it('reports an ingestion the engine declined instead of claiming capture', async () => {
    const plugin = await createProject02Plugin(
      compatFactoryInput(join(fixturesRoot, 'declining-ingest.mjs')),
    );

    // Persisting accepted evidence for a message the engine refused would
    // record a memory nothing holds.
    await expect(
      plugin.lifecycleHooks.afterTurnCommitted?.(
        createRuntimePluginAfterTurnCommittedContext({
          ...testIdentity(),
          sessionId: 'session-openclaw-compat',
          eventType: 'USER_MESSAGE',
          currentUserMessage: 'remember this',
          character: testCharacterProfile,
          committedAt: '2026-08-10T00:00:01.000Z',
          visibleMessages: [],
        }),
      ),
    ).rejects.toThrow('declined the ingested message');
  });

  it('disposes an engine that fails pinned-interface validation', async () => {
    const storeRoot = createTestTempRoot('project02-openclaw-compat-');

    await expect(
      createProject02Plugin({
        ...compatFactoryInput(join(fixturesRoot, 'leaky-missing-ingest.mjs')),
        storeRoot,
      }),
    ).rejects.toThrow('does not implement pinned v1 member "ingest"');

    // The factory already opened whatever the engine holds; a rejected
    // construction that leaves it running can outlive the failed startup.
    expect(existsSync(join(storeRoot, 'disposed.marker'))).toBe(true);
  });

  it('keeps executable engine selection and activation with the operator', () => {
    const manifest = createOpenClawCompatPluginManifest();
    const operatorOwned = manifest.config.fields.filter(field =>
      ['modulePath', 'engineId', 'engineConfig'].includes(field.name),
    );

    // Selecting a character must not choose which code the runtime imports,
    // nor start exporting the conversation on inherited credentials.
    expect(manifest.activation.globalOnly).toBe(true);
    expect(operatorOwned).toHaveLength(3);
    for (const field of operatorOwned) {
      expect(field.globalOnly).toBe(true);
    }
  });

  it('rejects modules that do not satisfy the pinned v1 interface', async () => {
    await expect(
      createProject02Plugin(
        compatFactoryInput(join(fixturesRoot, 'not-a-register.mjs')),
      ),
    ).rejects.toThrow('does not export a default register function');
    await expect(
      createProject02Plugin(
        compatFactoryInput(join(fixturesRoot, 'missing-ingest.mjs')),
      ),
    ).rejects.toThrow('does not implement pinned v1 member "ingest"');
    await expect(
      createProject02Plugin(
        compatFactoryInput(join(fixturesRoot, 'engine.mjs'), {
          engineId: 'no-such-engine',
        }),
      ),
    ).rejects.toThrow('registered no context engine "no-such-engine"');
    await expect(
      createProject02Plugin(
        compatFactoryInput(join(fixturesRoot, 'two-engines.mjs')),
      ),
    ).rejects.toThrow('set the engineId config field to choose one');
    await expect(
      createProject02Plugin(
        compatFactoryInput(join(fixturesRoot, 'no-such-module.mjs')),
      ),
    ).rejects.toThrow('could not import the configured module');
    await expect(
      createProject02Plugin(compatFactoryInput('relative/path.mjs')),
    ).rejects.toThrow('must be an absolute path');
    await expect(
      createProject02Plugin({
        ...compatFactoryInput(join(fixturesRoot, 'engine.mjs')),
        resolvedConfig: {},
      }),
    ).rejects.toThrow('needs the modulePath config field');
  });
});

function compatFactoryInput(
  modulePath: string,
  extras: Readonly<Record<string, RuntimeConfigValue>> = {},
): RuntimePluginFactoryInput {
  return {
    pluginId: openClawCompatPluginId,
    manifest: createOpenClawCompatPluginManifest(),
    storeRoot: '.project02/character-data/mira',
    characterId: 'mira',
    resolvedConfig: resolvedConfig({modulePath, ...extras}),
    redactedConfig: {},
  };
}

function resolvedConfig(
  values: Readonly<Record<string, RuntimeConfigValue>>,
): ResolvedPluginRuntimeConfig {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        Object.freeze({
          name,
          secret: false,
          source: 'config' as const,
          resolved: true,
          value,
        }),
      ]),
    ),
  );
}

function compatContext() {
  return createRuntimePluginContext({
    ...testIdentity(),
    sessionId: 'session-openclaw-compat',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'remember this',
    character: testCharacterProfile,
  });
}

function testIdentity() {
  return createRuntimeEventIdentity({
    eventId: 'evt_openclaw_compat',
    traceId: 'trace_openclaw_compat',
    createdAt: '2026-08-10T00:00:00.000Z',
  });
}
