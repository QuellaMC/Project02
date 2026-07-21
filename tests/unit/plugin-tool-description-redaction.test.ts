import {testCharacterProfile} from '../support/character-fixtures.ts';
import {describe, expect, it} from 'vitest';

import {
  createRuntimeEventIdentity,
  createUserMessageRuntimeEvent,
} from '../../src/core/index.ts';
import {
  createRuntimePlugin,
  createRuntimePluginRegistrySnapshot,
  createRuntimePluginTurnEvidenceSnapshot,
  runtimePluginContractVersion,
} from '../../src/plugins/api/index.ts';
import {createRuntimePluginHost} from '../../src/plugins/host/index.ts';
import {
  createDecisionContext,
  createRoleModelInputEnvelope,
  renderRoleModelTurnContext,
} from '../../src/role-model/index.ts';

const credentialBearingDescription =
  'Search memory with api_key=super-secret Bearer secret-token and https://user:pass@example.test/?token=tool-secret.';

describe('plugin tool description redaction', () => {
  it('redacts manifest descriptions before registry and evidence exposure', () => {
    const plugin = createCredentialDescriptionPlugin();
    const registry = createRuntimePluginRegistrySnapshot([plugin]);

    expectCredentialBearingTextRedacted(
      registry.plugins[0]?.manifest.description,
    );
    expectCredentialBearingTextRedacted(
      registry.plugins[0]?.manifest.config.fields[0]?.description,
    );

    const snapshot = createRuntimePluginTurnEvidenceSnapshot({
      ...testIdentity(),
      kind: 'runtime_plugin_turn_evidence_snapshot',
      contractVersion: runtimePluginContractVersion,
      plugins: [
        {
          pluginId: 'memory.secret_description.fixture',
          manifest: credentialDescriptionManifest(),
          providedTools: [credentialDescriptionTool()],
          registeredLifecycleHooks: ['tool_provider'],
          installed: true,
          registered: true,
          enabled: true,
          availableForTurn: true,
          redactionLabels: ['credential'],
        },
      ],
      contextItems: [],
      toolInvocations: [],
      evidence: [],
      health: [],
    });

    expectCredentialBearingTextRedacted(
      snapshot.plugins[0]?.manifest.description,
    );
    expectCredentialBearingTextRedacted(
      snapshot.plugins[0]?.manifest.config.fields[0]?.description,
    );
  });

  it('redacts provided tool descriptions before host and prompt exposure', () => {
    const plugin = createCredentialDescriptionPlugin();
    const host = createRuntimePluginHost({
      plugins: [plugin],
      enabledPluginIds: [plugin.manifest.id],
    });
    const toolDefinition = host
      .pluginToolDefinitions()
      .find(tool => tool.name === 'memory.secret_search');

    expect(toolDefinition).toBeDefined();
    if (toolDefinition === undefined) {
      throw new Error('Expected memory.secret_search to be model-facing.');
    }

    expectCredentialBearingTextRedacted(toolDefinition.description);

    const inputEnvelope = createRoleModelInputEnvelope({
      event: createUserMessageRuntimeEvent('hello', testIdentity()),
      decisionContext: createDecisionContext({
        sessionId: 'session-plugin-tool-description-redaction',
        characterSnapshot: testCharacterProfile,
      }),
      pluginToolDefinitions: host.pluginToolDefinitions(),
    });
    const renderedTool = renderRoleModelTurnContext(inputEnvelope).tools.find(
      tool => tool.function.name === 'memory.secret_search',
    );

    expect(renderedTool).toBeDefined();
    if (renderedTool === undefined) {
      throw new Error(
        'Expected memory.secret_search to render as a chat tool.',
      );
    }

    expect(renderedTool.function.description).toContain(
      toolDefinition.description,
    );
    expect(renderedTool.function.description).toContain(
      'Optional for this user turn; at most 1 call per user turn.',
    );
    expectCredentialBearingTextToHaveNoRawSecrets(JSON.stringify(renderedTool));
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
              description: credentialBearingDescription,
            },
          ],
          registeredLifecycleHooks: ['tool_provider'],
          installed: true,
          registered: true,
          enabled: true,
          availableForTurn: true,
          redactionLabels: ['credential'],
        },
      ],
      contextItems: [],
      toolInvocations: [],
      evidence: [],
      health: [],
    });
    const description = snapshot.plugins[0]?.providedTools[0]?.description;

    expectCredentialBearingTextRedacted(description);
  });
});

function createCredentialDescriptionPlugin() {
  return createRuntimePlugin({
    manifest: {
      ...credentialDescriptionManifest(),
      declaredPlugins: ['tool_provider', 'handle_tool_call'],
    },
    providedTools: [credentialDescriptionTool()],
    lifecycleHooks: {
      handleToolCall() {
        return {
          status: 'accepted',
          output: {},
          evidence: [],
        };
      },
    },
  });
}

function credentialDescriptionManifest() {
  return {
    id: 'memory.secret_description.fixture',
    displayName: 'Secret Description Fixture',
    version: '1.0.0',
    kind: 'memory_provider',
    description: credentialBearingDescription,
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: 'test',
    },
    declaredPlugins: ['tool_provider'],
    config: {
      fields: [
        {
          name: 'memory_api_key',
          description: credentialBearingDescription,
          required: false,
          secret: true,
          redactionLabels: ['credential'],
        },
      ],
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
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: true,
      reasons: ['test'],
    },
    requestedAccess: {model_input: 'write'},
  };
}

function expectCredentialBearingTextRedacted(value: string | undefined): void {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error('Expected credential-bearing text.');
  }

  expect(value).toContain('api_key=[redacted]');
  expect(value).toContain('Bearer [redacted]');
  expect(value).toContain('https://[redacted]@example.test/?token=[redacted]');
  expectCredentialBearingTextToHaveNoRawSecrets(value);
}

function expectCredentialBearingTextToHaveNoRawSecrets(value: string): void {
  expect(value).not.toContain('super-secret');
  expect(value).not.toContain('secret-token');
  expect(value).not.toContain('user:pass');
  expect(value).not.toContain('tool-secret');
}

function credentialDescriptionTool() {
  return {
    name: 'memory.secret_search',
    description: credentialBearingDescription,
    requiredForUserTurn: false,
    callLimit: {
      scope: 'user_turn',
      maxCalls: 1,
    },
    inputContract: {
      type: 'object',
      fields: [
        {
          name: 'query',
          description: 'Search query.',
          required: true,
          valueType: 'string',
        },
      ],
      additionalFields: false,
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'runtime_read',
    requiresConfirmation: false,
    sourceReferencesRequired: false,
  };
}

function testIdentity() {
  return createRuntimeEventIdentity({
    eventId: 'evt_plugin_tool_description_redaction',
    traceId: 'trace_plugin_tool_description_redaction',
    createdAt: '2026-06-15T00:00:00.000Z',
  });
}
