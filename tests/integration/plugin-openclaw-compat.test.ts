import {testCharacterProfile} from '../support/character-fixtures.ts';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {createRuntimeEventIdentity} from '../../src/core/index.ts';
import {
  createRuntimePluginAfterTurnCommittedContext,
  createRuntimePluginContext,
} from '../../src/plugins/api/index.ts';
import type {RuntimePluginFactoryInput} from '../../src/plugins/api/factory.ts';
import type {ResolvedPluginRuntimeConfig} from '../../src/runtime/config/index.ts';
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
      text: 'Engine brief for "remember this" after 0 ingested message(s).',
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
    expect(recallAfter?.contextItems[0]?.text).toBe(
      'Engine brief for "remember this" after 2 ingested message(s).',
    );
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
  extras: Readonly<Record<string, string>> = {},
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
  values: Readonly<Record<string, string>>,
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
