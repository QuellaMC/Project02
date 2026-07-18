import { describe, expect, it } from 'vitest';
import { createFirstPartyModelToolsPlugin } from '../../src/plugins/builtin/model-tools/index.ts';
import { firstPartyModelToolsPluginId } from '../../src/plugins/api/contract.ts';
import { createRuntimePluginHost } from '../../src/plugins/host/index.ts';
import {
  mapHermesMemoryProviderFixture,
  mapFirstPartyModelToolsPlugin,
  mapMcpToolsResourcesFixture,
  mapOpenClawMemoryPluginFixture,
  mapTencentDbMemoryGatewayFixture
} from '../support/adapter-proofs/index.ts';
import { visibleReplyModelToolName } from '../../src/role-model/index.ts';
import {
  characterStatePluginId,
  createCharacterStatePlugin
} from '../../src/plugins/packages/character-state/plugin.ts';
import {
  createExplicitlyEnabledRuntimePluginHost,
  createLowPriorityBudgetPressurePlugin,
  createMemorySearchPluginWithoutHandlerDeclaration,
  readAgentCapabilityFixture,
  testPluginContext
} from '../support/plugin-host-fixtures.ts';

describe('runtime plugin host adapters and contracts', () => {
  it('retains higher-priority Character State and runtime notes before lower-priority context', async () => {
    const pressurePlugin = createLowPriorityBudgetPressurePlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({
      plugins: [createCharacterStatePlugin(), pressurePlugin],
      sessionIdentity: {
        test: 'priority-budget-pressure'
      }
    });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected beforeRoleModelCall to complete.');
    }

    expect(
      result.contextItems.map((item) => `${item.pluginId}:${item.id}`)
    ).toEqual([
      `${characterStatePluginId}:current`,
      `${pressurePlugin.manifest.id}:runtime-note-host`
    ]);
    expect(result.contextItems[0]?.budget.priority).toBe(90);
    expect(result.contextItems[1]?.text).toBe('runtime note from host');
    const budgetEvidence = result.evidence.find(
      (evidence) =>
        evidence.pluginId === pressurePlugin.manifest.id &&
        evidence.evidenceKind === 'before_role_model_call' &&
        evidence.status === 'degraded'
    );

    expect(budgetEvidence?.summary).toContain(
      'dropped ids low-priority-bulk'
    );
    expect(JSON.stringify(result.contextItems)).not.toContain('low ');
  });

  it.each([
    [
      'TencentDB',
      'tencentdb-memory-gateway.json',
      mapTencentDbMemoryGatewayFixture,
      'memory_tencentdb.gateway.fixture',
      ['tdai.recall.fixture'],
      'Mira remembers that the user prefers short implementation notes.'
    ],
    [
      'Hermes',
      'hermes-memory-provider.json',
      mapHermesMemoryProviderFixture,
      'hermes.memory_tencentdb.fixture',
      ['hermes.prefetch.fixture'],
      'Hermes prefetch recalls that Mira should keep plugin evidence compact.'
    ],
    [
      'MCP',
      'mcp-tools-resources.json',
      mapMcpToolsResourcesFixture,
      'mcp.tools_resources.fixture',
      ['mcp.resource.1', 'mcp.resource.2'],
      'MCP resource fixture: project02 has a universal plugin host contract.'
    ]
  ] as const)(
    'keeps source-backed beforeRoleModelCall context for source-required %s proof adapter',
    async (
      _name,
      fixtureName,
      mapFixture,
      expectedPluginId,
      expectedContextIds,
      expectedText
    ) => {
      const mapping = mapFixture(readAgentCapabilityFixture(fixtureName));
      const host = createRuntimePluginHost({
        plugins: [mapping.plugin],
        enabledPluginIds: [mapping.plugin.manifest.id]
      });

      const result = await host.beforeRoleModelCall(testPluginContext());

      expect(result.status).toBe('completed');
      if (result.status !== 'completed') {
        throw new Error('Expected source-required proof adapter to complete.');
      }

      expect(result.contextItems.map((item) => item.id)).toEqual(
        expectedContextIds
      );
      expect(result.contextItems.map((item) => item.pluginId)).toEqual(
        expectedContextIds.map(() => expectedPluginId)
      );
      expect(
        result.contextItems.every((item) => item.sourceReferences.length > 0)
      ).toBe(true);
      expect(
        result.contextItems.some((item) => item.text.includes(expectedText))
      ).toBe(true);

      const acceptedEvidence = result.evidence.find(
        (evidence) =>
          evidence.pluginId === expectedPluginId &&
          evidence.evidenceKind === 'before_role_model_call' &&
          evidence.status === 'accepted'
      );

      expect(acceptedEvidence?.sourceReferences?.length).toBeGreaterThan(0);
      expect(
        result.evidence.find(
          (evidence) =>
            evidence.pluginId === expectedPluginId &&
            evidence.evidenceKind === 'before_role_model_call' &&
            evidence.status === 'degraded'
        )
      ).toBeUndefined();
    }
  );

  it('does not request model input for adapter-owned OpenClaw tools', () => {
    const mapping = mapOpenClawMemoryPluginFixture(
      readAgentCapabilityFixture('openclaw-memory-plugin.json')
    );
    const host = createRuntimePluginHost({
      plugins: [mapping.plugin],
      enabledPluginIds: [mapping.plugin.manifest.id]
    });
    const registration = host
      .registrySnapshot()
      .plugins.find(
        (plugin) => plugin.manifest.id === mapping.plugin.manifest.id
      );

    expect(mapping.plugin.manifest.requestedAccess).toEqual({});
    expect(registration).toMatchObject({
      requestedAccess: {},
      grantedAccess: {}
    });
    const adapterToolNames = new Set(
      mapping.plugin.providedTools.map((tool) => tool.name)
    );

    expect(
      host.pluginToolDefinitions().some((tool) => adapterToolNames.has(tool.name))
    ).toBe(false);
  });

  it('accepts first-party model tools as tool-provider-only mappings', () => {
    const plugin = createFirstPartyModelToolsPlugin();
    const mapping = mapFirstPartyModelToolsPlugin();

    expect(plugin.manifest.id).toBe(firstPartyModelToolsPluginId);
    expect(plugin.manifest.declaredPlugins).toEqual(['tool_provider']);
    expect(plugin.lifecycleHooks.handleToolCall).toBeUndefined();
    expect(plugin.providedTools.map((tool) => tool.name)).toEqual([
      visibleReplyModelToolName
    ]);

    expect(mapping.plugin.manifest.id).toBe(firstPartyModelToolsPluginId);
    expect(mapping.plugin.manifest.declaredPlugins).toEqual(['tool_provider']);
    expect(mapping.plugin.lifecycleHooks.handleToolCall).toBeUndefined();
    expect(mapping.plugin.providedTools.map((tool) => tool.name)).toEqual([
      visibleReplyModelToolName
    ]);
  });

  it('rejects handleToolCall hooks without a matching declaration', () => {
    expect(() => createMemorySearchPluginWithoutHandlerDeclaration()).toThrow(
      /handleToolCall hooks must declare handle_tool_call/iu
    );
  });
});
