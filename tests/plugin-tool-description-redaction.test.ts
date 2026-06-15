import { describe, expect, it } from 'vitest';

import { createRuntimeEventIdentity, createUserMessageRuntimeEvent } from '../src/runtime/event.ts';
import {
  createRuntimePlugin,
  createRuntimePluginTurnEvidenceSnapshot,
  runtimePluginContractVersion
} from '../src/plugins/types.ts';
import { createRuntimePluginHost } from '../src/plugins/host.ts';
import {
  createDecisionContext,
  createRoleModelInputEnvelope
} from '../src/role-model/contracts.ts';
import { renderRoleModelTurnContext } from '../src/role-model/prompt.ts';

const credentialBearingDescription =
  'Search memory with api_key=super-secret Bearer secret-token and https://user:pass@example.test/?token=tool-secret.';

describe('plugin tool description redaction', () => {
  it('redacts provided tool descriptions before host and prompt exposure', () => {
    const plugin = createCredentialDescriptionPlugin();
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [plugin.manifest.id]
    });
    const toolDefinition = host
      .pluginToolDefinitions()
      .find((tool) => tool.name === 'memory.secret_search');

    expect(toolDefinition).toBeDefined();
    if (toolDefinition === undefined) {
      throw new Error('Expected memory.secret_search to be model-facing.');
    }

    expect(toolDefinition.description).toContain('api_key=[redacted]');
    expect(toolDefinition.description).toContain('Bearer [redacted]');
    expect(toolDefinition.description).toContain(
      'https://[redacted]@example.test/?token=[redacted]'
    );
    expect(toolDefinition.description).not.toContain('super-secret');
    expect(toolDefinition.description).not.toContain('secret-token');
    expect(toolDefinition.description).not.toContain('user:pass');
    expect(toolDefinition.description).not.toContain('tool-secret');

    const inputEnvelope = createRoleModelInputEnvelope({
      event: createUserMessageRuntimeEvent('hello', testIdentity()),
      decisionContext: createDecisionContext({
        sessionId: 'session-plugin-tool-description-redaction',
        characterSnapshot: {
          id: 'mira',
          displayName: 'Mira'
        }
      }),
      pluginToolDefinitions: host.pluginToolDefinitions()
    });
    const renderedTool = renderRoleModelTurnContext(inputEnvelope).tools.find(
      (tool) => tool.function.name === 'memory.secret_search'
    );

    expect(renderedTool).toBeDefined();
    if (renderedTool === undefined) {
      throw new Error('Expected memory.secret_search to render as a chat tool.');
    }

    expect(renderedTool.function.description).toBe(toolDefinition.description);
    expect(JSON.stringify(renderedTool)).not.toContain('super-secret');
    expect(JSON.stringify(renderedTool)).not.toContain('secret-token');
    expect(JSON.stringify(renderedTool)).not.toContain('user:pass');
    expect(JSON.stringify(renderedTool)).not.toContain('tool-secret');
  });

  it('redacts provided tool descriptions when rehydrating turn evidence snapshots', () => {
    const snapshot = createRuntimePluginTurnEvidenceSnapshot({
      ...testIdentity(),
      kind: 'runtime_plugin_turn_evidence_snapshot',
      contractVersion: runtimePluginContractVersion,
      plugins: [
        {
          pluginId: 'memory.secret_description.fixture',
          manifest: credentialDescriptionManifest(),
          providedTools: [
            {
              ...credentialDescriptionTool(),
              description: credentialBearingDescription
            }
          ],
          registeredLifecycleHooks: ['tool_provider'],
          installed: true,
          registered: true,
          enabled: true,
          availableForTurn: true,
          redactionLabels: ['credential']
        }
      ],
      contextItems: [],
      toolInvocations: [],
      evidence: [],
      health: []
    });
    const description = snapshot.plugins[0]?.providedTools[0]?.description;

    expect(description).toContain('api_key=[redacted]');
    expect(description).toContain('Bearer [redacted]');
    expect(description).not.toContain('super-secret');
    expect(description).not.toContain('secret-token');
    expect(description).not.toContain('user:pass');
    expect(description).not.toContain('tool-secret');
  });
});

function createCredentialDescriptionPlugin() {
  return createRuntimePlugin({
    manifest: {
      ...credentialDescriptionManifest(),
      declaredPlugins: ['tool_provider', 'handle_tool_call']
    },
    providedTools: [credentialDescriptionTool()],
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'accepted',
          output: {},
          evidence: []
        };
      }
    }
  });
}

function credentialDescriptionManifest() {
  return {
    id: 'memory.secret_description.fixture',
    displayName: 'Secret Description Fixture',
    version: '1.0.0',
    kind: 'memory_provider',
    description: 'Test plugin.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: 'test'
    },
    declaredPlugins: ['tool_provider'],
    config: {
      fields: []
    },
    localTrustLevel: 'test_fixture',
    runtimePolicy: {
      requiredForTurn: false,
      sideEffectLevel: 'runtime_read',
      confirmation: 'not_required',
      timeoutMs: 1000,
      sourceReferencesRequired: false,
      redactionLabels: ['credential'],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'reject_tool_call',
        afterTurnCommitted: 'log_failure',
        health: 'degrade'
      }
    },
    activation: {
      defaultEnabled: true,
      reasons: ['test']
    },
    requestedApis: []
  };
}

function credentialDescriptionTool() {
  return {
    name: 'memory.secret_search',
    description: credentialBearingDescription,
    requiredForUserTurn: false,
    maxCallsPerUserTurn: 1,
    inputContract: {
      type: 'object',
      fields: [
        {
          name: 'query',
          description: 'Search query.',
          required: true,
          valueType: 'string'
        }
      ],
      additionalFields: false
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'runtime_read',
    requiresConfirmation: false,
    sourceReferencesRequired: false
  };
}

function testIdentity() {
  return createRuntimeEventIdentity({
    eventId: 'evt_plugin_tool_description_redaction',
    traceId: 'trace_plugin_tool_description_redaction',
    createdAt: '2026-06-15T00:00:00.000Z'
  });
}
