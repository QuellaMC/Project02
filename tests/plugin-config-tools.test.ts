import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimePlugin,
  createRuntimePluginContext,
  createRuntimePluginHost,
  defaultRuntimePluginHostServiceCatalogEntries,
  isRuntimePluginManagementPlugin,
  preparedRuntimePluginConfigEffectHasApprovalEvidence,
  reconcilePreparedRuntimePluginConfigEffect,
  runtimePluginConfigReadToolName,
  runtimePluginConfigUpdateToolName,
  runtimePluginId,
  runtimePluginListToolName,
  type RuntimePluginToolConfirmationRequest
} from '../src/plugins/index.ts';
import {
  createRuntimePluginManifest,
  runtimePluginContractVersion,
  type RuntimePluginJsonObject,
  type RuntimePluginJsonValue,
  type RuntimePluginManifest
} from '../src/plugins/types.ts';
import {
  applyRuntimePluginConfigControlOperation,
  inspectRuntimePluginConfig,
  loadProject02RuntimeConfig,
  prepareRuntimePluginConfigControlOperation
} from '../src/runtime/config/index.ts';
import { writeRuntimeConfig } from './support/runtime-config.ts';
import { createTestTempRoot } from './support/temp-root.ts';
import { pluginDiscoveryPluginSummaries } from './support/plugin-host-fixtures.ts';

describe('host-owned runtime plugin management tools', () => {
  it('constructs the canonical host-scoped plugin from the catalog', () => {
    const definition = defaultRuntimePluginHostServiceCatalogEntries()[
      runtimePluginId
    ];

    if (definition === undefined) {
      throw new TypeError('Expected runtime plugin management catalog definition.');
    }

    const plugin = definition.bootstrap({
      hostStateForTurn: () => ({
        plugins: Object.freeze([]),
        enabledPlugins: Object.freeze([]),
        accessByPluginId: Object.freeze({}),
        confirmationAvailable: false
      }),
      pluginConfigControl: {
        pluginManifests: Object.values(
          defaultRuntimePluginHostServiceCatalogEntries()
        ).map((entry) => entry.manifest)
      }
    });

    expect(isRuntimePluginManagementPlugin(plugin)).toBe(true);
    expect(plugin.providedTools.map((tool) => tool.name)).toEqual([
      runtimePluginListToolName,
      runtimePluginConfigReadToolName,
      runtimePluginConfigUpdateToolName
    ]);
    expect(plugin.manifest.runtimePolicy).toMatchObject({
      sideEffectLevel: 'runtime_config_write'
    });
  });

  it('exposes list always, config read with state, and config update only with confirmation', () => {
    const manifest = configurablePluginManifest();
    const bareHost = createRuntimePluginHost();
    const readOnlyHost = createRuntimePluginHost({
      pluginConfigControl: {
        pluginManifests: [manifest]
      }
    });
    const writableHost = createRuntimePluginHost({
      pluginConfigControl: {
        pluginManifests: [manifest]
      },
      toolConfirmationHandler: () => ({ status: 'approved' })
    });

    expect(
      bareHost.pluginToolDefinitions()
        .filter((tool) => tool.pluginId === runtimePluginId)
        .map((tool) => tool.name)
    ).toEqual([runtimePluginListToolName]);
    expect(
      readOnlyHost.pluginToolDefinitions()
        .filter((tool) => tool.pluginId === runtimePluginId)
        .map((tool) => tool.name)
    ).toEqual([runtimePluginListToolName, runtimePluginConfigReadToolName]);
    expect(readOnlyHost.pluginToolDefinitions()).toContainEqual(
      expect.objectContaining({
        pluginId: runtimePluginId,
        name: runtimePluginConfigReadToolName,
        sideEffectLevel: 'runtime_read',
        requiresConfirmation: false
      })
    );
    expect(
      readOnlyHost.pluginToolDefinitions().map((tool) => tool.name)
    ).not.toContain(runtimePluginConfigUpdateToolName);
    expect(writableHost.pluginToolDefinitions()).toContainEqual(
      expect.objectContaining({
        pluginId: runtimePluginId,
        name: runtimePluginConfigUpdateToolName,
        sideEffectLevel: 'runtime_config_write',
        requiresConfirmation: true
      })
    );
    expect(
      writableHost
        .pluginToolDefinitions()
        .filter((tool) => tool.pluginId === runtimePluginId)
    ).toEqual([
      expect.objectContaining({
        name: runtimePluginListToolName,
        callLimit: { scope: 'user_turn', maxCalls: 1 }
      }),
      expect.objectContaining({
        name: runtimePluginConfigReadToolName,
        callLimit: { scope: 'user_turn', maxCalls: 4 }
      }),
      expect.objectContaining({
        name: runtimePluginConfigUpdateToolName,
        callLimit: { scope: 'user_turn', maxCalls: 1 }
      })
    ]);
    expect(
      bareHost.registrySnapshot().plugins.map((plugin) =>
        plugin.manifest.id
      )
    ).toContain(runtimePluginId);
  });

  it('enforces approval-gated config effects without plugin identity carve-outs', async () => {
    const storeRoot = createTestTempRoot('project02-arbitrary-config-approval-');
    const targetManifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    const before = inspectRuntimePluginConfig({
      manifest: targetManifest,
      pluginManifests: [targetManifest],
      configPath,
      storeRoot
    });
    const prepared = prepareRuntimePluginConfigControlOperation({
      manifest: targetManifest,
      actor: 'agent',
      expectedFingerprint: before.fingerprint,
      operation: { kind: 'set', fieldName: 'tone', value: 'warm' },
      configPath,
      storeRoot
    });
    const arbitraryPluginId = 'settings.arbitrary.fixture';
    const arbitraryToolName = 'settings.arbitrary.update';
    const toolCallId = 'arbitrary-config-call';
    let preparationCalls = 0;
    const plugin = createRuntimePlugin({
      manifest: {
        id: arbitraryPluginId,
        displayName: 'Arbitrary settings fixture',
        version: '1.0.0',
        kind: 'tool_provider',
        description: 'Prepares an arbitrary policy-category config effect.',
        contractVersion: runtimePluginContractVersion,
        compatibility: {
          hostContractVersions: [runtimePluginContractVersion],
          sourceSystem: 'test'
        },
        declaredPlugins: ['tool_provider', 'handle_tool_call'],
        config: { fields: [] },
        localTrustLevel: 'test_fixture',
        runtimePolicy: {
          requiredForTurn: false,
          sideEffectLevel: 'runtime_config_write',
          confirmation: 'not_required',
          timeoutMs: 1_000,
          sourceReferencesRequired: false,
          redactionLabels: [],
          failureBehavior: {
            beforeRoleModelCall: 'degrade',
            handleToolCall: 'reject_tool_call',
            afterTurnCommitted: 'log_failure',
            health: 'degrade'
          }
        },
        activation: { defaultEnabled: false, reasons: ['test'] },
        requestedAccess: { model_input: 'write' }
      },
      providedTools: [
        {
          name: arbitraryToolName,
          description: 'Set one exact prepared config value after approval.',
          requiredForUserTurn: false,
          callLimit: { scope: 'user_turn', maxCalls: 1 },
          inputContract: {
            type: 'object',
            fields: [],
            additionalFields: false
          },
          validationOwner: 'plugin_host',
          sideEffectLevel: 'runtime_config_write',
          requiresConfirmation: true,
          sourceReferencesRequired: false
        }
      ],
      lifecycleHooks: {
        handleToolCall(call) {
          preparationCalls += 1;
          return {
            status: 'accepted',
            output: { status: 'prepared' },
            evidence: [],
            preparedConfigEffect: {
              eventId: call.eventId,
              traceId: call.traceId,
              createdAt: call.createdAt,
              kind: 'runtime_plugin_config_effect',
              effectId: call.toolCallId ?? toolCallId,
              targetPluginId: targetManifest.id,
              targetConfigPath: prepared.targetConfigPath,
              fieldName: 'tone',
              expectedFingerprint: before.fingerprint,
              resultFingerprint: prepared.resultFingerprint,
              operation: { kind: 'set', value: 'warm' }
            }
          };
        }
      }
    });
    const enabledPluginIds = [runtimePluginId, arbitraryPluginId];
    const pluginConfigControl = {
      pluginManifests: [targetManifest],
      configPath
    };
    const call = {
      ...testIdentity(),
      toolCallId,
      pluginId: arbitraryPluginId,
      toolName: arbitraryToolName,
      input: {}
    } as const;
    const withoutHandler = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds,
      storeRoot,
      pluginConfigControl
    });
    const withoutControl = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds,
      storeRoot,
      toolConfirmationHandler: () => ({ status: 'approved' })
    });

    expect(withoutHandler.pluginToolDefinitions()).not.toContainEqual(
      expect.objectContaining({ name: arbitraryToolName })
    );
    expect(withoutControl.pluginToolDefinitions()).not.toContainEqual(
      expect.objectContaining({ name: arbitraryToolName })
    );

    let deniedPreview: RuntimePluginJsonObject | undefined;
    const deniedHost = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds,
      storeRoot,
      pluginConfigControl,
      toolConfirmationHandler(request) {
        deniedPreview = request.preview;
        return { status: 'denied' };
      }
    });
    const denied = await deniedHost.handleToolCall(call, testContext());

    expect(deniedPreview).toMatchObject({
      targetPluginId: targetManifest.id,
      fieldName: 'tone',
      operation: 'set',
      after: { configured: true, value: 'warm' }
    });
    expect(denied).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_approval_denied'
    });
    expect(denied).not.toHaveProperty('preparedConfigEffect');
    expect(denied.evidence).not.toContainEqual(
      expect.objectContaining({ policyOutcome: 'user_approved' })
    );

    const approvedHost = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds,
      storeRoot,
      pluginConfigControl,
      toolConfirmationHandler: () => ({ status: 'approved' })
    });
    const approved = await approvedHost.handleToolCall(call, testContext());

    expect(preparationCalls).toBe(2);
    expect(approved.status).toBe('accepted');
    if (approved.status !== 'accepted') {
      return;
    }

    const effect = approved.preparedConfigEffect;

    expect(effect).toBeDefined();
    if (effect === undefined) {
      return;
    }

    expect(approved.evidence).toContainEqual(
      expect.objectContaining({
        pluginId: arbitraryPluginId,
        evidenceKind: 'policy',
        status: 'accepted',
        policyOutcome: 'user_approved',
        configFingerprint: effect.resultFingerprint
      })
    );
    expect(
      preparedRuntimePluginConfigEffectHasApprovalEvidence({
        effect,
        eventIdentity: call,
        inputIdentity: call,
        inputPluginId: call.pluginId,
        inputToolName: call.toolName,
        toolCallId: call.toolCallId,
        dispatchedToHost: true,
        pluginId: call.pluginId,
        toolName: call.toolName,
        result: approved
      })
    ).toBe(true);
  });

  it('does not register or expose the removed plugin identifiers and tool names', () => {
    const manifest = configurablePluginManifest();
    const host = createRuntimePluginHost({
      pluginConfigControl: { pluginManifests: [manifest] },
      toolConfirmationHandler: () => ({ status: 'approved' })
    });

    const registeredPluginIds = host
      .registrySnapshot()
      .plugins.map((plugin) => plugin.manifest.id);

    expect(registeredPluginIds).not.toContain('runtime.plugin_discovery');
    expect(registeredPluginIds).not.toContain('runtime.plugin_config');
    const exposedToolNames = host.pluginToolDefinitions().map(
      (definition) => definition.name
    );

    expect(exposedToolNames).not.toContain('plugin.list');
    expect(exposedToolNames).not.toContain('plugin.config');
    expect(exposedToolNames).not.toContain('plugin.config.update');
    expect(exposedToolNames).toEqual(
      expect.arrayContaining([
        runtimePluginListToolName,
        runtimePluginConfigReadToolName,
        runtimePluginConfigUpdateToolName
      ])
    );
  });

  it('returns manifest metadata and redacted authored and effective values', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-read-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [manifest.id]: {
          enabled: true,
          config: {
            tone: 'warm',
            apiKey: { $env: 'PLUGIN_CONFIG_TEST_KEY' }
          }
        }
      }
    });
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        activationByPluginId: {
          [manifest.id]: {
            enabled: false,
            status: 'blocked',
            reasons: ['host_policy_blocked']
          }
        },
        configPath,
        env: { PLUGIN_CONFIG_TEST_KEY: 'raw-secret-value' }
      }
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginConfigReadToolName,
        input: { pluginId: manifest.id }
      },
      testContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      return;
    }
    const output = requiredJsonObject(result.output);
    const fields = output['fields'];

    if (!Array.isArray(fields)) {
      throw new TypeError('Expected plugin config fields output.');
    }

    const tone = requiredNamedJsonObject(fields, 'tone');
    const toneAuthored = requiredJsonObject(tone['authored']);
    const toneEffective = requiredJsonObject(tone['effective']);
    const apiKey = requiredNamedJsonObject(fields, 'apiKey');
    const apiKeyAuthored = requiredJsonObject(apiKey['authored']);
    const apiKeyEffective = requiredJsonObject(apiKey['effective']);

    expect(output['pluginId']).toBe(manifest.id);
    expect(output['enabled']).toBe(true);
    expect(output['activation']).toEqual({
      enabled: false,
      status: 'blocked',
      reasons: ['host_policy_blocked']
    });
    expect(typeof output['fingerprint']).toBe('string');
    expect(tone['agentMutable']).toBe(true);
    expect(toneAuthored).toEqual({ configured: true, value: 'warm' });
    expect(toneEffective).toMatchObject({ resolved: true, value: 'warm' });
    expect(apiKey['sensitive']).toBe(true);
    expect(apiKey['agentMutable']).toBe(false);
    expect(apiKeyAuthored).toEqual({
      configured: true,
      value: '[redacted]'
    });
    expect(apiKeyEffective).toMatchObject({
      resolved: true,
      value: '[redacted]'
    });
    expect(JSON.stringify(result.output)).not.toContain('raw-secret-value');
  });

  it('treats a missing own activation for a prototype-named plugin as absent', async () => {
    const manifest = createRuntimePluginManifest({
      ...configurablePluginManifest(),
      id: 'constructor'
    });
    const host = createRuntimePluginHost({
      pluginConfigControl: {
        pluginManifests: [manifest],
        activationByPluginId: {}
      }
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginConfigReadToolName,
        input: { pluginId: manifest.id }
      },
      testContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      return;
    }

    const output = requiredJsonObject(result.output);

    expect(output['pluginId']).toBe(manifest.id);
    expect(output['activation']).toEqual({
      enabled: false,
      status: 'disabled',
      reasons: ['config_inspection_disabled']
    });
  });

  it('uses host-attested defaults instead of an unconfigured manifest claim', async () => {
    const manifest = configurablePluginManifest(true);
    const host = createRuntimePluginHost({
      pluginConfigControl: {
        pluginManifests: [manifest],
        defaultEnabledPluginIds: [],
        activationByPluginId: {
          [manifest.id]: {
            enabled: false,
            status: 'disabled',
            reasons: ['not_enabled']
          }
        }
      }
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginConfigReadToolName,
        input: { pluginId: manifest.id }
      },
      testContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      return;
    }

    expect(requiredJsonObject(result.output)['enabled']).toBe(false);
  });

  it('returns a stable rejection for an empty plugin config inspection id', async () => {
    const host = createRuntimePluginHost({
      pluginConfigControl: {
        pluginManifests: [configurablePluginManifest()]
      }
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginConfigReadToolName,
        input: { pluginId: '' }
      },
      testContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_inspect_invalid'
    });
  });

  it('rejects an unknown plugin before requesting approval', async () => {
    const manifest = configurablePluginManifest();
    let confirmationCalls = 0;
    const host = createRuntimePluginHost({
      pluginConfigControl: {
        pluginManifests: [manifest]
      },
      toolConfirmationHandler: () => {
        confirmationCalls += 1;
        return { status: 'approved' };
      }
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginConfigUpdateToolName,
        input: {
          pluginId: 'not.installed',
          fieldName: 'tone',
          operation: 'set',
          value: 'warm',
          expectedFingerprint: 'sha256:stale'
        }
      },
      testContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_unknown_plugin'
    });
    expect(confirmationCalls).toBe(0);
  });

  it('rejects operator-only and secret fields before requesting approval', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-policy-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    const fingerprint = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    }).fingerprint;
    let confirmationCalls = 0;
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: () => {
        confirmationCalls += 1;
        return { status: 'approved' };
      }
    });

    const lockedResult = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'locked',
      operation: 'set',
      value: true,
      expectedFingerprint: fingerprint
    });
    const secretResult = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'apiKey',
      operation: 'set',
      value: 'must-not-be-accepted',
      expectedFingerprint: fingerprint
    });

    expect(lockedResult).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_update_invalid'
    });
    expect(secretResult).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_update_invalid'
    });
    expect(confirmationCalls).toBe(0);
  });

  it('rejects updates before approval when disabled authored config is invalid', async () => {
    const storeRoot = createTestTempRoot(
      'project02-plugin-config-disabled-invalid-'
    );
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [manifest.id]: {
          enabled: false,
          config: {
            undeclared: 'invalid-authored-value'
          }
        }
      }
    });
    const before = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });
    let confirmationCalls = 0;
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: () => {
        confirmationCalls += 1;
        return { status: 'approved' };
      }
    });

    const result = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'set',
      value: 'warm',
      expectedFingerprint: before.fingerprint
    });
    const after = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });

    expect(before.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'runtime_config_unknown_plugin_config_field',
        path: `plugins.${manifest.id}.config.undeclared`,
        severity: 'error'
      })
    );
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_update_invalid'
    });
    expect(JSON.stringify(result)).not.toContain('invalid-authored-value');
    expect(confirmationCalls).toBe(0);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('presents one exact change and fails closed when approval is denied', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-denied-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    const fingerprint = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    }).fingerprint;
    let request: RuntimePluginToolConfirmationRequest | undefined;
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: (candidate) => {
        request = candidate;
        return { status: 'denied' };
      }
    });

    const result = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'set',
      value: 'warm',
      expectedFingerprint: fingerprint
    });

    expect(request).toMatchObject({
      pluginId: runtimePluginId,
      toolName: runtimePluginConfigUpdateToolName,
      preview: {
        kind: 'runtime_plugin_config_change',
        targetPluginId: manifest.id,
        fieldName: 'tone',
        operation: 'set',
        expectedFingerprint: fingerprint,
        before: { configured: false },
        after: { configured: true, value: 'warm' }
      }
    });
    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_approval_denied'
    });
    expect(
      inspectRuntimePluginConfig({
        manifest,
        pluginManifests: [manifest],
        configPath,
        storeRoot
      }).fields.find((field) => field.name === 'tone')?.authored.configured
    ).toBe(false);
  });

  it('prepares one approved field update without mutating authored config', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-approved-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [manifest.id]: {
          config: { tone: 'cool' }
        }
      }
    });
    const before = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });
    let confirmationCalls = 0;
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: () => {
        confirmationCalls += 1;
        return { status: 'approved' };
      }
    });

    const result = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'set',
      value: 'warm',
      expectedFingerprint: before.fingerprint
    });
    const after = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });

    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        status: 'approved_pending_commit',
        appliesTo: 'future_host_construction',
        pluginId: manifest.id,
        fieldName: 'tone',
        operation: 'set'
      },
      preparedConfigEffect: {
        targetPluginId: manifest.id,
        fieldName: 'tone',
        expectedFingerprint: before.fingerprint,
        operation: { kind: 'set', value: 'warm' }
      }
    });
    expect(confirmationCalls).toBe(1);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(
      after.fields.find((field) => field.name === 'tone')?.authored
    ).toEqual({ configured: true, value: 'cool' });
  });

  it('rejects a tampered prepared result fingerprint before mutating authored config', async () => {
    const storeRoot = createTestTempRoot(
      'project02-plugin-config-tampered-effect-'
    );
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [manifest.id]: {
          config: { tone: 'cool' }
        }
      }
    });
    const before = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: () => ({ status: 'approved' })
    });
    const result = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'set',
      value: 'warm',
      expectedFingerprint: before.fingerprint
    });
    const preparedConfigEffect =
      result.status === 'accepted' ? result.preparedConfigEffect : undefined;

    if (preparedConfigEffect === undefined) {
      throw new TypeError('Expected an approved prepared config effect.');
    }

    expect(() =>
      reconcilePreparedRuntimePluginConfigEffect({
        effect: Object.freeze({
          ...preparedConfigEffect,
          resultFingerprint: `${preparedConfigEffect.resultFingerprint}-tampered`
        }),
        state: {
          pluginManifests: [manifest],
          configPath
        },
        storeRoot
      })
    ).toThrow('does not match its validated config candidate');

    const after = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });

    expect(after.fingerprint).toBe(before.fingerprint);
    expect(
      after.fields.find((field) => field.name === 'tone')?.authored
    ).toEqual({ configured: true, value: 'cool' });
  });

  it('does not reconcile a prepared effect through a host targeting another config path', async () => {
    const storeRoot = createTestTempRoot(
      'project02-plugin-config-cross-path-effect-'
    );
    const manifest = configurablePluginManifest();
    const authoredConfig = {
      plugins: {
        [manifest.id]: {
          config: { tone: 'cool' }
        }
      }
    } as const;
    const configPathA = writeRuntimeConfig(
      join(storeRoot, 'config-a.json'),
      authoredConfig
    );
    const configPathB = writeRuntimeConfig(
      join(storeRoot, 'config-b.json'),
      authoredConfig
    );
    const beforeA = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath: configPathA,
      storeRoot
    });
    const beforeB = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath: configPathB,
      storeRoot
    });
    const hostA = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath: configPathA
      },
      toolConfirmationHandler: () => ({ status: 'approved' })
    });
    const result = await updateConfigField(hostA, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'set',
      value: 'warm',
      expectedFingerprint: beforeA.fingerprint
    });
    const preparedConfigEffect =
      result.status === 'accepted' ? result.preparedConfigEffect : undefined;

    if (preparedConfigEffect === undefined) {
      throw new TypeError('Expected an approved prepared config effect.');
    }

    expect(() =>
      reconcilePreparedRuntimePluginConfigEffect({
        effect: preparedConfigEffect,
        state: {
          pluginManifests: [manifest],
          configPath: configPathB
        },
        storeRoot
      })
    ).toThrow('targets another runtime config path');

    const afterA = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath: configPathA,
      storeRoot
    });
    const afterB = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath: configPathB,
      storeRoot
    });

    expect(afterA.fingerprint).toBe(beforeA.fingerprint);
    expect(afterB.fingerprint).toBe(beforeB.fingerprint);
    expect(
      afterA.fields.find((field) => field.name === 'tone')?.authored
    ).toEqual({ configured: true, value: 'cool' });
    expect(
      afterB.fields.find((field) => field.name === 'tone')?.authored
    ).toEqual({ configured: true, value: 'cool' });
  });

  it('canonicalizes caller-owned manifests before approval and preparation', async () => {
    const storeRoot = createTestTempRoot(
      'project02-plugin-config-manifest-snapshot-'
    );
    const canonicalManifest = configurablePluginManifest();
    const mutableManifest = structuredClone(canonicalManifest);
    const originalPluginId = mutableManifest.id;
    const mutatedPluginId = 'test.mutated-after-preview';
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    const before = inspectRuntimePluginConfig({
      manifest: mutableManifest,
      pluginManifests: [mutableManifest],
      configPath,
      storeRoot
    });
    let previewTarget: RuntimePluginJsonValue | undefined;
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [mutableManifest],
        configPath
      },
      toolConfirmationHandler: (request) => {
        previewTarget = request.preview['targetPluginId'];
        expect(Reflect.set(mutableManifest, 'id', mutatedPluginId)).toBe(true);
        return { status: 'approved' };
      }
    });

    const result = await updateConfigField(host, {
      pluginId: originalPluginId,
      fieldName: 'tone',
      operation: 'set',
      value: 'warm',
      expectedFingerprint: before.fingerprint
    });
    const loaded = loadProject02RuntimeConfig({ configPath, storeRoot });

    expect(mutableManifest.id).toBe(mutatedPluginId);
    expect(previewTarget).toBe(originalPluginId);
    expect(result).toMatchObject({
      status: 'accepted',
      output: {
        pluginId: originalPluginId,
        fieldName: 'tone',
        operation: 'set'
      },
      preparedConfigEffect: {
        targetPluginId: originalPluginId,
        operation: { kind: 'set', value: 'warm' }
      }
    });
    expect(loaded.config?.plugins?.[originalPluginId]).toBeUndefined();
    expect(loaded.config?.plugins?.[mutatedPluginId]).toBeUndefined();
  });

  it('shares one immutable manifest snapshot with cold discovery and config control', async () => {
    const mutableManifest = structuredClone(configurablePluginManifest());
    const originalPluginId = mutableManifest.id;
    const originalDisplayName = mutableManifest.displayName;
    const host = createRuntimePluginHost({
      pluginConfigControl: {
        pluginManifests: [mutableManifest],
        activationByPluginId: {
          [originalPluginId]: {
            enabled: false,
            status: 'disabled',
            reasons: ['test_disabled']
          }
        }
      }
    });

    expect(Reflect.set(mutableManifest, 'id', 'test.retargeted')).toBe(true);
    expect(Reflect.set(mutableManifest, 'displayName', 'Retargeted')).toBe(true);

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: { scope: 'all' }
      },
      testContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      return;
    }

    const plugins = pluginDiscoveryPluginSummaries(result.output);

    expect(
      plugins.find(
        (plugin) => plugin['id'] === originalPluginId
      )
    ).toMatchObject({
      id: originalPluginId,
      displayName: originalDisplayName,
      enabled: false,
      activationStatus: 'disabled',
      grantedAccess: {}
    });
    expect(
      plugins.some(
        (plugin) => plugin['id'] === 'test.retargeted'
      )
    ).toBe(false);
  });

  it('lists an installed cold manifest as disabled without activation metadata', async () => {
    const manifest = configurablePluginManifest();
    const host = createRuntimePluginHost({
      pluginInventoryState: {
        pluginManifests: [manifest]
      }
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginListToolName,
        input: { scope: 'all' }
      },
      testContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      return;
    }

    expect(
      pluginDiscoveryPluginSummaries(result.output).find(
        (plugin) => plugin['id'] === manifest.id
      )
    ).toMatchObject({
      id: manifest.id,
      enabled: false,
      activationStatus: 'disabled'
    });
  });

  it('rejects an approved update when the authored fingerprint drifts during approval', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-drift-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [manifest.id]: {
          config: { tone: 'cool' }
        }
      }
    });
    const before = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: () => {
        applyRuntimePluginConfigControlOperation({
          manifest,
          actor: 'operator',
          expectedFingerprint: before.fingerprint,
          operation: {
            kind: 'set',
            fieldName: 'tone',
            value: 'competing-value'
          },
          configPath,
          storeRoot
        });
        return { status: 'approved' };
      }
    });

    const result = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'set',
      value: 'agent-value',
      expectedFingerprint: before.fingerprint
    });
    const after = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_fingerprint_conflict'
    });
    expect(
      after.fields.find((field) => field.name === 'tone')?.authored.value
    ).toBe('competing-value');
  });

  it('does not allow direct host routing to bypass a missing approval handler', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-no-approval-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    const before = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      }
    });

    const result = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'set',
      value: 'warm',
      expectedFingerprint: before.fingerprint
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'tool_not_routable'
    });
    expect(
      inspectRuntimePluginConfig({
        manifest,
        pluginManifests: [manifest],
        configPath,
        storeRoot
      }).fingerprint
    ).toBe(before.fingerprint);
  });

  it('rejects malformed set and unset operations before requesting approval', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-invalid-input-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    const before = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });
    let confirmationCalls = 0;
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: () => {
        confirmationCalls += 1;
        return { status: 'approved' };
      }
    });

    const incompleteSetResult = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'set',
      expectedFingerprint: before.fingerprint
    });
    const unsetWithValueResult = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'unset',
      value: 'not-allowed',
      expectedFingerprint: before.fingerprint
    });

    expect(incompleteSetResult).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_update_invalid'
    });
    expect(unsetWithValueResult).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_update_invalid'
    });
    expect(confirmationCalls).toBe(0);
  });

  it('fails closed when approval is cancelled', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-cancelled-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    const before = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: () => ({ status: 'cancelled' })
    });

    const result = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'set',
      value: 'warm',
      expectedFingerprint: before.fingerprint
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_approval_cancelled'
    });
    expect(
      inspectRuntimePluginConfig({
        manifest,
        pluginManifests: [manifest],
        configPath,
        storeRoot
      }).fingerprint
    ).toBe(before.fingerprint);
  });

  it('accepts an approval slower than the execution timeout within the approval window', async () => {
    vi.useFakeTimers();

    try {
      const storeRoot = createTestTempRoot('project02-plugin-config-slow-approval-');
      const manifest = configurablePluginManifest();
      const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
      const before = inspectRuntimePluginConfig({
        manifest,
        pluginManifests: [manifest],
        configPath,
        storeRoot
      });
      const approvalDelayMs = 30_000;
      const host = createRuntimePluginHost({
        storeRoot,
        pluginConfigControl: {
          pluginManifests: [manifest],
          configPath
        },
        toolConfirmationHandler: async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, approvalDelayMs);
          });
          return { status: 'approved' };
        }
      });
      const updatePromise = updateConfigField(host, {
        pluginId: manifest.id,
        fieldName: 'tone',
        operation: 'set',
        value: 'warm',
        expectedFingerprint: before.fingerprint
      });

      await vi.advanceTimersByTimeAsync(approvalDelayMs + 1);
      const result = await updatePromise;

      expect(result.status).toBe('accepted');
      expect(
        result.status === 'accepted' ? result.preparedConfigEffect : undefined
      ).toMatchObject({
        targetPluginId: manifest.id,
        fieldName: 'tone'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a timed-out approval closed without applying a late approved write', async () => {
    vi.useFakeTimers();

    try {
      const storeRoot = createTestTempRoot('project02-plugin-config-delayed-approval-');
      const manifest = configurablePluginManifest();
      const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
      const before = inspectRuntimePluginConfig({
        manifest,
        pluginManifests: [manifest],
        configPath,
        storeRoot
      });
      let approvalDelayMs = 0;
      const host = createRuntimePluginHost({
        storeRoot,
        pluginConfigControl: {
          pluginManifests: [manifest],
          configPath
        },
        toolConfirmationHandler: async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, approvalDelayMs + 1);
          });
          return { status: 'approved' };
        }
      });
      const configRegistration = host
        .registrySnapshot()
        .plugins.find(
          (plugin) => plugin.manifest.id === runtimePluginId
        );

      if (configRegistration === undefined) {
        throw new TypeError('Expected runtime plugin config registration.');
      }

      expect(configRegistration.manifest.runtimePolicy.timeoutMs).toBe(5_000);
      approvalDelayMs = 5 * 60_000;
      const updatePromise = updateConfigField(host, {
        pluginId: manifest.id,
        fieldName: 'tone',
        operation: 'set',
        value: 'warm',
        expectedFingerprint: before.fingerprint
      });

      await vi.advanceTimersByTimeAsync(approvalDelayMs + 1);
      const result = await updatePromise;
      const after = inspectRuntimePluginConfig({
        manifest,
        pluginManifests: [manifest],
        configPath,
        storeRoot
      });

      expect(result).toMatchObject({
        status: 'rejected',
        reason: 'plugin_config_approval_timeout'
      });
      expect(
        after.fields.find((field) => field.name === 'tone')?.authored.value
      ).toBeUndefined();

      await vi.advanceTimersByTimeAsync(approvalDelayMs + 1);
      const afterLateApproval = inspectRuntimePluginConfig({
        manifest,
        pluginManifests: [manifest],
        configPath,
        storeRoot
      });

      expect(
        afterLateApproval.fields.find((field) => field.name === 'tone')?.authored
          .value
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prepares the exact snapshotted value that the user approved', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-exact-value-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    const before = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });
    const callerOwnedValue = { mode: 'approved-value' };
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: () => {
        callerOwnedValue.mode = 'mutated-after-preview';
        return { status: 'approved' };
      }
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginConfigUpdateToolName,
        input: {
          pluginId: manifest.id,
          fieldName: 'settings',
          operation: 'set',
          value: callerOwnedValue,
          expectedFingerprint: before.fingerprint
        }
      },
      testContext()
    );
    const after = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });

    expect(result.status).toBe('accepted');
    expect(result).toMatchObject({
      preparedConfigEffect: {
        operation: {
          kind: 'set',
          value: { mode: 'approved-value' }
        }
      }
    });
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('prepares one approved unset without accepting a value payload', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-unset-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      plugins: {
        [manifest.id]: {
          config: { tone: 'warm' }
        }
      }
    });
    const before = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });
    let request: RuntimePluginToolConfirmationRequest | undefined;
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: (candidate) => {
        request = candidate;
        return { status: 'approved' };
      }
    });

    const result = await updateConfigField(host, {
      pluginId: manifest.id,
      fieldName: 'tone',
      operation: 'unset',
      expectedFingerprint: before.fingerprint
    });
    const after = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });

    expect(result.status).toBe('accepted');
    expect(result).toMatchObject({
      preparedConfigEffect: {
        targetPluginId: manifest.id,
        fieldName: 'tone',
        operation: { kind: 'unset' }
      }
    });
    expect(request?.preview).toMatchObject({
      operation: 'unset',
      before: { configured: true, value: 'warm' },
      after: { configured: false }
    });
    expect(
      after.fields.find((field) => field.name === 'tone')?.authored.configured
    ).toBe(true);
  });

  it('rejects redacted nested content instead of asking approval for a hidden value', async () => {
    const storeRoot = createTestTempRoot('project02-plugin-config-hidden-value-');
    const manifest = configurablePluginManifest();
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {});
    const before = inspectRuntimePluginConfig({
      manifest,
      pluginManifests: [manifest],
      configPath,
      storeRoot
    });
    let confirmationCalls = 0;
    const host = createRuntimePluginHost({
      storeRoot,
      pluginConfigControl: {
        pluginManifests: [manifest],
        configPath
      },
      toolConfirmationHandler: () => {
        confirmationCalls += 1;
        return { status: 'approved' };
      }
    });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: runtimePluginId,
        toolName: runtimePluginConfigUpdateToolName,
        input: {
          pluginId: manifest.id,
          fieldName: 'settings',
          operation: 'set',
          value: { apiKey: 'must-not-be-hidden-in-preview' },
          expectedFingerprint: before.fingerprint
        }
      },
      testContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'plugin_config_update_invalid'
    });
    expect(JSON.stringify(result)).not.toContain('must-not-be-hidden-in-preview');
    expect(confirmationCalls).toBe(0);
  });

  it('rejects duplicate installed manifest ids before building the host plugin', () => {
    const manifest = configurablePluginManifest();

    expect(() =>
      createRuntimePluginHost({
        pluginConfigControl: {
          pluginManifests: [manifest, manifest]
        }
      })
    ).toThrow(
      `Plugin config control manifest id "${manifest.id}" is declared more than once.`
    );
  });
});

function configurablePluginManifest(
  defaultEnabled = false
): RuntimePluginManifest {
  return createRuntimePluginManifest({
    id: 'test.configurable',
    displayName: 'Configurable fixture',
    version: '1.0.0',
    kind: 'tool_provider',
    description: 'Fixture for host-owned config tools.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: 'test'
    },
    declaredPlugins: ['tool_provider'],
    config: {
      fields: [
        {
          name: 'tone',
          description: 'Reply tone.',
          required: false,
          secret: false,
          valueType: 'string',
          agentMutable: true,
          redactionLabels: []
        },
        {
          name: 'locked',
          description: 'Operator-only setting.',
          required: false,
          secret: false,
          valueType: 'boolean',
          agentMutable: false,
          redactionLabels: []
        },
        {
          name: 'settings',
          description: 'Structured agent-mutable settings.',
          required: false,
          secret: false,
          valueType: 'object',
          agentMutable: true,
          redactionLabels: []
        },
        {
          name: 'apiKey',
          description: 'Secret fixture.',
          required: false,
          secret: true,
          valueType: 'secret',
          agentMutable: false,
          envVar: 'PLUGIN_CONFIG_TEST_KEY',
          redactionLabels: ['secret']
        }
      ]
    },
    localTrustLevel: 'test_fixture',
    runtimePolicy: {
      requiredForTurn: false,
      sideEffectLevel: 'runtime_read',
      confirmation: 'not_required',
      timeoutMs: 1000,
      sourceReferencesRequired: false,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
        afterTurnCommitted: 'log_failure',
        health: 'degrade'
      }
    },
    activation: {
      defaultEnabled,
      reasons: ['test']
    },
    requestedAccess: {}
  });
}

function testIdentity() {
  return {
    eventId: 'evt_plugin_config_test',
    traceId: 'trace_plugin_config_test',
    createdAt: '2026-07-12T00:00:00.000Z'
  } as const;
}

function testContext() {
  return createRuntimePluginContext({
    ...testIdentity(),
    sessionId: 'session_plugin_config_test',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'inspect plugin config',
    character: {
      id: 'mira',
      displayName: 'Mira'
    }
  });
}

async function updateConfigField(
  host: ReturnType<typeof createRuntimePluginHost>,
  input: Readonly<Record<string, string | number | boolean | null>>
) {
  return await host.handleToolCall(
    {
      ...testIdentity(),
      pluginId: runtimePluginId,
      toolName: runtimePluginConfigUpdateToolName,
      input
    },
    testContext()
  );
}

function requiredJsonObject(
  value: RuntimePluginJsonValue | undefined
): RuntimePluginJsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError('Expected plugin JSON object.');
  }

  return value;
}

function requiredNamedJsonObject(
  values: readonly RuntimePluginJsonValue[],
  name: string
): RuntimePluginJsonObject {
  const value = values.find(
    (candidate) => isJsonObject(candidate) && candidate['name'] === name
  );

  return requiredJsonObject(value);
}

function isJsonObject(
  value: RuntimePluginJsonValue | undefined
): value is RuntimePluginJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
