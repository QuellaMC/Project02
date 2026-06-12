import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  agentCapabilityContractVersion,
  createRuntimeCapabilityContext,
  createRuntimeCapabilityHost,
  firstPartyModelToolsCapabilityId,
  mapFirstPartyModelToolsCapability,
  mapHermesMemoryProviderFixture,
  mapMcpToolsResourcesFixture,
  mapOpenClawMemoryPluginFixture,
  mapTencentDbMemoryGatewayFixture,
  visibleReplyModelToolName,
  type AgentCapability,
  type AgentCapabilityAdapterMapping,
  type AgentCapabilityJsonObject,
  type AgentCapabilityJsonValue,
  type AgentCapabilityToolCall
} from '../src/index.ts';

describe('agent capability adapter compatibility proofs', () => {
  it('maps OpenClaw-style manifest metadata into local manifest, config, and tool declarations', async () => {
    const mapping = mapOpenClawMemoryPluginFixture(
      readJsonFixture('openclaw-memory-plugin.json')
    );
    const host = createEnabledHost(mapping);
    const registry = host.registrySnapshot();
    const health = await host.health(createTestContext());
    const toolResult = await requiredHandleToolCall(mapping.capability)(
      createToolCall({
        capabilityId: mapping.capability.manifest.id,
        toolName: 'memory_search',
        input: { query: 'adapter evidence' }
      }),
      createTestContext()
    );

    expect(registry.contractVersion).toBe(agentCapabilityContractVersion);
    expect(mapping.capability.manifest).toMatchObject({
      id: 'openclaw.memory_core.fixture',
      kind: 'bridge_adapter',
      compatibility: {
        sourceSystem: 'openclaw',
        externalContract: 'openclaw.plugin.json'
      }
    });
    expect(mapping.capability.manifest.config.fields.map((field) => field.name)).toEqual([
      'memory_store_path',
      'max_results'
    ]);
    expect(mapping.capability.providedTools.map((tool) => tool.name)).toEqual([
      'memory_get',
      'memory_search'
    ]);
    expect(mapping.capability.providedTools[1]?.inputContract.fields).toEqual([
      {
        name: 'query',
        description: 'Search query.',
        required: true
      },
      {
        name: 'limit',
        description: 'Maximum result count.',
        required: false
      }
    ]);
    expect(health.snapshots).toHaveLength(1);
    expect(health.snapshots[0]?.status).toBe('ok');
    expect(toolResult.status).toBe('accepted');
    expect(unsupportedFieldPaths(mapping)).toEqual([
      'uiHints.commands',
      'requiresPlugins',
      'package.openclaw.install'
    ]);
  });

  it('maps TencentDB gateway endpoints into recall, capture, search, session-end, and health hooks', async () => {
    const mapping = mapTencentDbMemoryGatewayFixture(
      readJsonFixture('tencentdb-memory-gateway.json')
    );
    const host = createEnabledHost(mapping);
    const context = createTestContext();
    const before = await host.beforeRoleModelCall(context);
    const search = await requiredHandleToolCall(mapping.capability)(
      createToolCall({
        capabilityId: mapping.capability.manifest.id,
        toolName: 'memory_tencentdb.memory_search',
        input: { query: 'handoff', limit: 3 }
      }),
      context
    );
    const afterCommit = await host.afterTurnCommitted(context);
    const sessionEnd = await host.onSessionEnd(context);
    const health = await host.health(context);

    expect(mapping.capability.manifest).toMatchObject({
      id: 'memory_tencentdb.gateway.fixture',
      kind: 'memory_provider',
      compatibility: {
        sourceSystem: 'TencentDB-Agent-Memory',
        externalContract: 'tdai-gateway-http'
      },
      runtimePolicy: {
        sideEffectLevel: 'local_memory_write',
        sourceReferencesRequired: true
      }
    });
    expect(
      mapping.capability.manifest.config.fields.find(
        (field) => field.name === 'gateway_api_key'
      )
    ).toMatchObject({
      secret: true,
      redactionLabels: ['secret']
    });
    expect(mapping.capability.providedTools.map((tool) => tool.name)).toEqual([
      'memory_tencentdb.memory_search',
      'memory_tencentdb.conversation_search'
    ]);
    expect(before.status).toBe('completed');

    if (before.status !== 'completed') {
      throw new Error('Expected completed beforeRoleModelCall result.');
    }

    expect(before.contextItems).toHaveLength(1);
    expect(before.contextItems[0]).toMatchObject({
      kind: 'memory',
      text: 'Mira remembers that the user prefers short implementation notes.'
    });
    expect(before.evidence[0]).toMatchObject({
      evidenceKind: 'before_role_model_call',
      status: 'accepted',
      configFingerprint: 'fixture-redacted-tdai-gateway'
    });
    expect(search.status).toBe('accepted');

    if (search.status !== 'accepted') {
      throw new Error('Expected accepted TencentDB search result.');
    }

    expect(jsonObject(search.output)['path']).toBe('/search/memories');
    expect(afterCommit).toMatchObject({
      status: 'completed',
      evidence: [
        {
          evidenceKind: 'after_turn_committed',
          status: 'accepted'
        }
      ]
    });
    expect(sessionEnd).toMatchObject({
      status: 'completed',
      evidence: [
        {
          evidenceKind: 'session_end',
          status: 'accepted'
        }
      ]
    });
    expect(health.snapshots[0]).toMatchObject({
      capabilityId: 'memory_tencentdb.gateway.fixture',
      status: 'ok'
    });
    expect(unsupportedFieldPaths(mapping)).toEqual([
      'endpoints.seed',
      'gatewayInternals.storageBackend',
      'gatewayInternals.embeddingPipeline'
    ]);
  });

  it('maps Hermes provider prefetch, sync, search, session, health, and degradation metadata', async () => {
    const mapping = mapHermesMemoryProviderFixture(
      readJsonFixture('hermes-memory-provider.json')
    );
    const host = createEnabledHost(mapping);
    const context = createTestContext();
    const before = await host.beforeRoleModelCall(context);
    const search = await requiredHandleToolCall(mapping.capability)(
      createToolCall({
        capabilityId: mapping.capability.manifest.id,
        toolName: 'memory_tencentdb_memory_search',
        input: { query: 'degradation', type: 'instruction' }
      }),
      context
    );
    const afterCommit = await host.afterTurnCommitted(context);
    const sessionEnd = await host.onSessionEnd(context);
    const health = await host.health(context);

    expect(mapping.capability.manifest).toMatchObject({
      id: 'hermes.memory_tencentdb.fixture',
      compatibility: {
        sourceSystem: 'hermes',
        externalContract: 'hermes-memory-provider'
      },
      runtimePolicy: {
        failureBehavior: {
          beforeRoleModelCall: 'degrade',
          afterTurnCommitted: 'log_failure',
          health: 'degrade'
        }
      }
    });
    expect(mapping.capability.manifest.config.fields.map((field) => field.name)).toEqual([
      'gateway_cmd',
      'gateway_host',
      'gateway_port',
      'gateway_api_key',
      'llm_api_key',
      'llm_base_url',
      'llm_model'
    ]);
    expect(
      mapping.capability.manifest.config.fields.filter((field) => field.secret)
        .map((field) => field.name)
    ).toEqual(['gateway_api_key', 'llm_api_key']);
    expect(mapping.capability.providedTools.map((tool) => tool.name)).toEqual([
      'memory_tencentdb_memory_search',
      'memory_tencentdb_conversation_search'
    ]);
    expect(before.status).toBe('completed');

    if (before.status !== 'completed') {
      throw new Error('Expected completed Hermes beforeRoleModelCall result.');
    }

    expect(before.contextItems[0]?.text).toBe(
      'Hermes prefetch recalls that Mira should keep capability evidence compact.'
    );
    expect(before.runtimeNotes[0]).toContain('circuit breaker threshold 5');
    expect(search.status).toBe('accepted');
    expect(afterCommit.evidence[0]?.summary).toContain('Mapped Hermes sync');
    expect(sessionEnd.evidence[0]?.summary).toContain(
      'Mapped Hermes session-end'
    );
    expect(health.snapshots[0]).toMatchObject({
      status: 'degraded',
      redactionLabels: ['secret']
    });
    expect(unsupportedFieldPaths(mapping)).toEqual([
      'hooks.on_memory_write',
      'gateway_cmd',
      'degradation.watchdogProbeMs'
    ]);
  });

  it('maps MCP tools and resources into local provided tools and context resources', async () => {
    const mapping = mapMcpToolsResourcesFixture(
      readJsonFixture('mcp-tools-resources.json')
    );
    const host = createEnabledHost(mapping);
    const context = createTestContext();
    const before = await host.beforeRoleModelCall(context);
    const toolResult = await requiredHandleToolCall(mapping.capability)(
      createToolCall({
        capabilityId: mapping.capability.manifest.id,
        toolName: 'knowledge.lookup',
        input: { query: 'policy' }
      }),
      context
    );
    const health = await host.health(context);

    expect(mapping.capability.manifest).toMatchObject({
      id: 'mcp.tools_resources.fixture',
      kind: 'bridge_adapter',
      compatibility: {
        sourceSystem: 'model-context-protocol',
        sourceVersion: '2025-06-18',
        externalContract: 'mcp-tools-resources'
      }
    });
    expect(mapping.capability.providedTools).toHaveLength(1);
    expect(mapping.capability.providedTools[0]).toMatchObject({
      name: 'knowledge.lookup',
      validationOwner: 'adapter',
      sourceReferencesRequired: true
    });
    expect(before.status).toBe('completed');

    if (before.status !== 'completed') {
      throw new Error('Expected completed MCP beforeRoleModelCall result.');
    }

    expect(before.contextItems.map((item) => item.kind)).toEqual([
      'resource',
      'resource'
    ]);
    expect(before.contextItems[0]?.sourceReferences[0]).toMatchObject({
      kind: 'resource',
      id: 'mcp.resource.1',
      uri: 'mcp://project02/memory-summary'
    });
    expect(toolResult.status).toBe('accepted');

    if (toolResult.status !== 'accepted') {
      throw new Error('Expected accepted MCP tool result.');
    }

    expect(jsonObject(toolResult.output)['content']).toEqual([
      {
        type: 'text',
        text: 'Capability adapters should expose bounded context.'
      }
    ]);
    expect(health.snapshots[0]?.status).toBe('ok');
    expect(unsupportedFieldPaths(mapping)).toEqual([
      'capabilities.prompts',
      'capabilities.sampling',
      'resourceSubscriptions'
    ]);
  });

  it('maps first-party built-ins through the same local contract without losing validation semantics', () => {
    const mapping = mapFirstPartyModelToolsCapability();
    const host = createEnabledHost(mapping);
    const registry = host.registrySnapshot();

    expect(mapping.capability.manifest.id).toBe(firstPartyModelToolsCapabilityId);
    expect(registry.capabilities[0]?.providedTools.map((tool) => tool.name)).toEqual([
      visibleReplyModelToolName,
      'character_state.patch'
    ]);
    expect(
      mapping.capability.providedTools.map((tool) => tool.validationOwner)
    ).toEqual(['built_in_model_tools', 'built_in_model_tools']);
    expect(mapping.capability.providedTools[0]).toMatchObject({
      name: visibleReplyModelToolName,
      requiredForUserTurn: true,
      maxCallsPerUserTurn: 1,
      inputContract: {
        type: 'object',
        additionalFields: false,
        fields: [
          {
            name: 'text',
            description: 'One visible reply line.',
            required: true
          }
        ]
      }
    });
    expect(mapping.compatibilityNotes).toEqual([
      {
        sourceSystem: 'project02',
        fieldPath: 'builtInModelToolDefinitionsForUserTurn',
        disposition: 'mapped',
        evidence:
          'First-party built-in tools are represented through AgentCapability without changing validationOwner or input contracts.'
      }
    ]);
  });
});

function readJsonFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/agent-capabilities/${name}`, import.meta.url),
      'utf8'
    )
  ) as unknown;
}

function createEnabledHost(mapping: AgentCapabilityAdapterMapping) {
  return createRuntimeCapabilityHost({
    capabilities: [mapping.capability],
    enabledCapabilityIds: [mapping.capability.manifest.id]
  });
}

function createTestContext() {
  return createRuntimeCapabilityContext({
    eventId: 'evt_adapter_fixture',
    traceId: 'trace_adapter_fixture',
    createdAt: '2026-06-12T00:00:00.000Z',
    sessionId: 'session-adapter-fixture',
    eventType: 'USER_MESSAGE',
    currentUserMessage: 'prove adapter compatibility',
    character: {
      id: 'mira',
      displayName: 'Mira'
    },
    redactionLabels: ['private']
  });
}

function requiredHandleToolCall(
  capability: AgentCapability
): NonNullable<AgentCapability['lifecycleHooks']['handleToolCall']> {
  const hook = capability.lifecycleHooks.handleToolCall;

  if (hook === undefined) {
    throw new Error(`Capability ${capability.manifest.id} has no tool handler.`);
  }

  return hook;
}

function createToolCall(options: {
  readonly capabilityId: string;
  readonly toolName: string;
  readonly input: AgentCapabilityJsonObject;
}): AgentCapabilityToolCall {
  return {
    eventId: 'evt_adapter_fixture',
    traceId: 'trace_adapter_fixture',
    createdAt: '2026-06-12T00:00:00.000Z',
    capabilityId: options.capabilityId,
    toolName: options.toolName,
    input: options.input
  };
}

function unsupportedFieldPaths(
  mapping: AgentCapabilityAdapterMapping
): readonly string[] {
  return mapping.compatibilityNotes
    .filter((note) => note.disposition !== 'mapped')
    .map((note) => note.fieldPath);
}

function jsonObject(
  value: AgentCapabilityJsonValue
): AgentCapabilityJsonObject {
  if (!isAgentCapabilityJsonObject(value)) {
    throw new Error('Expected JSON object output.');
  }

  return value;
}

function isAgentCapabilityJsonObject(
  value: AgentCapabilityJsonValue
): value is AgentCapabilityJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
