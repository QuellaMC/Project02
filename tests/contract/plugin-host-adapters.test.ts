import {describe, expect, it} from 'vitest';
import {createFirstPartyModelToolsPlugin} from '../../src/plugins/builtin/model-tools/index.ts';
import {firstPartyModelToolsPluginId} from '../../src/plugins/api/contract.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {
  mapAstraMemoryProviderFixture,
  mapFirstPartyModelToolsPlugin,
  mapMcpToolsResourcesFixture,
  mapTidepoolMemoryPluginFixture,
  mapCoralDbMemoryGatewayFixture,
} from '../support/adapter-proofs/index.ts';
import {visibleReplyModelToolName} from '../../src/role-model/index.ts';
import {
  createMemorySearchPluginWithoutHandlerDeclaration,
  readAgentCapabilityFixture,
  testPluginContext,
} from '../support/plugin-host-fixtures.ts';

describe('runtime plugin host adapters and contracts', () => {
  it.each([
    [
      'CoralDB',
      'coraldb-memory-gateway.json',
      mapCoralDbMemoryGatewayFixture,
      'memory_coraldb.gateway.fixture',
      ['coral.recall.fixture'],
      'Mira remembers that the user prefers short implementation notes.',
    ],
    [
      'Astra',
      'astra-memory-provider.json',
      mapAstraMemoryProviderFixture,
      'astra.memory_coraldb.fixture',
      ['astra.prefetch.fixture'],
      'Astra prefetch recalls that Mira should keep plugin evidence compact.',
    ],
    [
      'MCP',
      'mcp-tools-resources.json',
      mapMcpToolsResourcesFixture,
      'mcp.tools_resources.fixture',
      ['mcp.resource.1', 'mcp.resource.2'],
      'MCP resource fixture: project02 has a universal plugin host contract.',
    ],
  ] as const)(
    'keeps source-backed beforeRoleModelCall context for source-required %s proof adapter',
    async (
      _name,
      fixtureName,
      mapFixture,
      expectedPluginId,
      expectedContextIds,
      expectedText,
    ) => {
      const mapping = mapFixture(readAgentCapabilityFixture(fixtureName));
      const host = createRuntimePluginHost({
        plugins: [mapping.plugin],
        enabledPluginIds: [mapping.plugin.manifest.id],
      });

      const result = await host.beforeRoleModelCall(testPluginContext());

      expect(result.status).toBe('completed');
      if (result.status !== 'completed') {
        throw new Error('Expected source-required proof adapter to complete.');
      }

      expect(result.contextItems.map(item => item.id)).toEqual(
        expectedContextIds,
      );
      expect(result.contextItems.map(item => item.pluginId)).toEqual(
        expectedContextIds.map(() => expectedPluginId),
      );
      expect(
        result.contextItems.every(item => item.sourceReferences.length > 0),
      ).toBe(true);
      expect(
        result.contextItems.some(item => item.text.includes(expectedText)),
      ).toBe(true);

      const acceptedEvidence = result.evidence.find(
        evidence =>
          evidence.pluginId === expectedPluginId &&
          evidence.evidenceKind === 'before_role_model_call' &&
          evidence.status === 'accepted',
      );

      expect(acceptedEvidence?.sourceReferences?.length).toBeGreaterThan(0);
      expect(
        result.evidence.find(
          evidence =>
            evidence.pluginId === expectedPluginId &&
            evidence.evidenceKind === 'before_role_model_call' &&
            evidence.status === 'degraded',
        ),
      ).toBeUndefined();
    },
  );

  it('does not request model input for adapter-owned Tidepool tools', () => {
    const mapping = mapTidepoolMemoryPluginFixture(
      readAgentCapabilityFixture('tidepool-memory-plugin.json'),
    );
    const host = createRuntimePluginHost({
      plugins: [mapping.plugin],
      enabledPluginIds: [mapping.plugin.manifest.id],
    });
    const registration = host
      .registrySnapshot()
      .plugins.find(
        plugin => plugin.manifest.id === mapping.plugin.manifest.id,
      );

    expect(mapping.plugin.manifest.requestedAccess).toEqual({});
    expect(registration).toMatchObject({
      requestedAccess: {},
      grantedAccess: {},
    });
    const adapterToolNames = new Set(
      mapping.plugin.providedTools.map(tool => tool.name),
    );

    expect(
      host
        .pluginToolDefinitions()
        .some(tool => adapterToolNames.has(tool.name)),
    ).toBe(false);
  });

  it('accepts first-party model tools as tool-provider-only mappings', () => {
    const plugin = createFirstPartyModelToolsPlugin();
    const mapping = mapFirstPartyModelToolsPlugin();

    expect(plugin.manifest.id).toBe(firstPartyModelToolsPluginId);
    expect(plugin.manifest.declaredPlugins).toEqual(['tool_provider']);
    expect(plugin.lifecycleHooks.handleToolCall).toBeUndefined();
    expect(plugin.providedTools.map(tool => tool.name)).toEqual([
      visibleReplyModelToolName,
    ]);

    expect(mapping.plugin.manifest.id).toBe(firstPartyModelToolsPluginId);
    expect(mapping.plugin.manifest.declaredPlugins).toEqual(['tool_provider']);
    expect(mapping.plugin.lifecycleHooks.handleToolCall).toBeUndefined();
    expect(mapping.plugin.providedTools.map(tool => tool.name)).toEqual([
      visibleReplyModelToolName,
    ]);
  });

  it('rejects handleToolCall hooks without a matching declaration', () => {
    expect(() => createMemorySearchPluginWithoutHandlerDeclaration()).toThrow(
      /handleToolCall hooks must declare handle_tool_call/iu,
    );
  });
});
