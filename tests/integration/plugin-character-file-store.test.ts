import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {createTestPluginContext} from '../support/role-model-loop-fixtures.ts';
import {createTestTempRoot} from '../support/temp-root.ts';

import {
  createRuntimePlugin,
  createRuntimePluginManifest,
} from '../../src/plugins/api/index.ts';
import {
  runtimePluginContractVersion,
  runtimePluginId,
  type RuntimePluginAccessMap,
} from '../../src/plugins/api/contract.ts';
import type {
  RuntimePlugin,
  RuntimePluginContext,
} from '../../src/plugins/api/types.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {
  characterPluginDataDirPath,
  createLocalRuntimePluginPaths,
} from '../../src/runtime/storage/layout-contract.ts';
import {createDurableRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/durable-store.ts';
import {createRuntimePluginFileStore} from '../../src/runtime/storage/plugin-file-store/index.ts';

const probePluginId = 'storage.probe';

describe('character-scoped plugin file store', () => {
  it('persists across sessions while the session store stays scoped', async () => {
    const storeRoot = createTestTempRoot('project02-character-store-');
    const bothScopes: RuntimePluginAccessMap = {
      file_store: 'write',
      character_file_store: 'write',
    };
    const writer = createStorageProbePlugin({
      requestedAccess: bothScopes,
      onContext: context => {
        context.characterFileStore?.writeJsonAtomic('memo.json', {
          note: 'crossing sessions',
        });
        context.fileStore?.writeJsonAtomic('scratch.json', {only: 'one'});
      },
    });
    const first = await probeHost(writer, storeRoot, 'one').beforeRoleModelCall(
      contextForSession('evt_scope_one'),
    );

    expect(first.status).toBe('completed');

    let readCharacter: unknown = 'unread';
    let readSession: unknown = 'unread';
    const reader = createStorageProbePlugin({
      requestedAccess: bothScopes,
      onContext: context => {
        readCharacter = context.characterFileStore?.readJson('memo.json');
        readSession = context.fileStore?.readJson('scratch.json');
      },
    });
    const second = await probeHost(
      reader,
      storeRoot,
      'two',
    ).beforeRoleModelCall(contextForSession('evt_scope_two'));

    expect(second.status).toBe('completed');
    expect(readCharacter).toEqual({note: 'crossing sessions'});
    expect(readSession).toBeUndefined();

    expect(
      existsSync(
        join(
          characterPluginDataDirPath({storeRoot, pluginId: probePluginId}),
          'memo.json',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          createLocalRuntimePluginPaths({
            storeRoot,
            sessionId: 'one',
            pluginId: probePluginId,
          }).pluginRoot,
          'scratch.json',
        ),
      ),
    ).toBe(true);
  });

  it('serves each store only to plugins that declared its scope', async () => {
    const storeRoot = createTestTempRoot('project02-character-store-');
    const contexts: RuntimePluginContext[] = [];

    for (const requestedAccess of [
      {file_store: 'write'},
      {character_file_store: 'write'},
      {},
    ] satisfies readonly RuntimePluginAccessMap[]) {
      const probe = createStorageProbePlugin({
        requestedAccess,
        onContext: context => contexts.push(context),
      });
      const result = await probeHost(
        probe,
        storeRoot,
        'gating',
      ).beforeRoleModelCall(contextForSession('evt_gating'));

      expect(result.status).toBe('completed');
    }

    expect(contexts[0]?.fileStore).toBeDefined();
    expect(contexts[0]?.characterFileStore).toBeUndefined();
    expect(contexts[1]?.fileStore).toBeUndefined();
    expect(contexts[1]?.characterFileStore).toBeDefined();
    expect(contexts[2]?.fileStore).toBeUndefined();
    expect(contexts[2]?.characterFileStore).toBeUndefined();
  });

  it('revokes character-store writes when the hook completes', async () => {
    const storeRoot = createTestTempRoot('project02-character-store-');
    let captured: RuntimePluginContext | undefined;
    const probe = createStorageProbePlugin({
      requestedAccess: {character_file_store: 'write'},
      onContext: context => {
        captured = context;
      },
    });
    const result = await probeHost(
      probe,
      storeRoot,
      'revoked',
    ).beforeRoleModelCall(contextForSession('evt_revoked'));

    expect(result.status).toBe('completed');
    expect(() => {
      captured?.characterFileStore?.writeJsonAtomic('late.json', {no: true});
    }).toThrow(/no longer allowed after hook completion/);
  });

  it('degrades a plugin whose store cannot be opened instead of failing the turn', async () => {
    const storeRoot = createTestTempRoot('project02-character-store-');
    const probe = createStorageProbePlugin({
      requestedAccess: {character_file_store: 'write'},
      onContext: () => undefined,
      beforeRoleModelCallFailure: 'degrade',
    });
    const host = createRuntimePluginHost({
      plugins: [probe],
      enabledPluginIds: [runtimePluginId, probePluginId],
      storeRoot,
      sessionId: 'contended',
      fileStore: {
        createFileStore: () => {
          throw new Error('character store mutation lock deadline exceeded');
        },
      },
    });

    const result = await host.beforeRoleModelCall(
      contextForSession('evt_contended'),
    );

    // Opening the store is host work done for the plugin, so its failure
    // owes the same degrade the manifest declares for the hook itself.
    expect(result.status).toBe('completed');
    expect(JSON.stringify(result.evidence)).toContain(
      'mutation lock deadline exceeded',
    );
  });

  it('recovers a crashed write under any later session', () => {
    const storeRoot = createTestTempRoot('project02-character-store-');
    const crashing = createDurableRuntimePluginFileStore(
      {
        storeRoot,
        sessionId: 'one',
        pluginId: probePluginId,
        scope: 'character',
      },
      {
        faultInjector: () => {
          throw new Error('crash between journal apply and cleanup');
        },
      },
    );

    expect(() => {
      crashing.appendJsonl('log.jsonl', {n: 1});
    }).toThrow(/crash between/);

    // A different session opens the same character store and completes the
    // journaled write instead of rejecting it as foreign.
    const recovered = createDurableRuntimePluginFileStore({
      storeRoot,
      sessionId: 'two',
      pluginId: probePluginId,
      scope: 'character',
    });

    expect(recovered.readJsonl('log.jsonl')).toEqual([{n: 1}]);
  });

  it('keeps in-memory scopes distinct even for a session named character', () => {
    const sessionIdentity = {};
    const sessionStore = createRuntimePluginFileStore({
      sessionId: 'character',
      pluginId: probePluginId,
      sessionIdentity,
    });
    const characterStore = createRuntimePluginFileStore({
      sessionId: 'character',
      pluginId: probePluginId,
      sessionIdentity,
      scope: 'character',
    });

    sessionStore.writeJsonAtomic('value.json', {from: 'session'});
    characterStore.writeJsonAtomic('value.json', {from: 'character'});

    expect(sessionStore.readJson('value.json')).toEqual({from: 'session'});
    expect(characterStore.readJson('value.json')).toEqual({from: 'character'});
  });
});

function createStorageProbePlugin(options: {
  readonly requestedAccess: RuntimePluginAccessMap;
  readonly onContext: (context: RuntimePluginContext) => void;
  readonly beforeRoleModelCallFailure?: 'reject_turn' | 'degrade';
}): RuntimePlugin {
  return createRuntimePlugin({
    manifest: createRuntimePluginManifest({
      id: probePluginId,
      displayName: 'Storage Probe',
      version: '1.0.0',
      kind: 'context_provider',
      description: 'Probes plugin file store scope declarations.',
      contractVersion: runtimePluginContractVersion,
      compatibility: {hostContractVersions: [runtimePluginContractVersion]},
      declaredPlugins: ['before_role_model_call'],
      config: {scope: 'global_with_character_overrides', fields: []},
      firstParty: false,
      runtimePolicy: {
        timeoutMs: 5_000,
        redactionLabels: [],
        failureBehavior: {
          beforeRoleModelCall:
            options.beforeRoleModelCallFailure ?? 'reject_turn',
          handleToolCall: 'degrade',
          health: 'degrade',
        },
      },
      activation: {defaultEnabled: false, reasons: ['storage_probe_test']},
      requestedAccess: options.requestedAccess,
    }),
    providedTools: [],
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        options.onContext(context);
        return {contextItems: [], evidence: []};
      },
    },
  });
}

function probeHost(probe: RuntimePlugin, storeRoot: string, sessionId: string) {
  return createRuntimePluginHost({
    plugins: [probe],
    enabledPluginIds: [runtimePluginId, probePluginId],
    storeRoot,
    sessionId,
    fileStore: {createFileStore: createRuntimePluginFileStore},
  });
}

function contextForSession(eventId: string) {
  return createTestPluginContext(eventId);
}
