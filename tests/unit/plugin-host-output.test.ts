import {describe, expect, it} from 'vitest';

import {
  createRuntimePlugin,
  createRuntimePluginEvidenceSnapshot,
} from '../../src/plugins/api/index.ts';
import {
  createAcceptedBlockingBeforeRoleModelCallPlugin,
  createAcceptedBlockingEvidenceMemorySearchPlugin,
  createBoundedHookRecordsPlugin,
  createCredentialKeyOutputPlugin,
  createDegradedRejectingMemorySearchPlugin,
  createExplicitlyEnabledRuntimePluginHost,
  createProtoKeyOutputPlugin,
  createRecalledMemoryBudgetPlugin,
  createRejectingMemorySearchPlugin,
  createRuntimeNotesPlugin,
  createSlowNormalizationPlugin,
  memorySearchPluginManifest,
  memorySearchProvidedTools,
  createUnderestimatedContextItemPlugin,
  expectJsonObject,
  testIdentity,
  testPluginContext,
} from '../support/plugin-host-fixtures.ts';

describe('runtime plugin host output boundaries', () => {
  it.each([
    ['empty reason', '', 'search backend failed'],
    ['empty message', 'handler_rejected', ''],
    ['blank reason', '   ', 'search backend failed'],
    ['blank message', 'handler_rejected', '   '],
  ] as const)(
    'rejects plugin-returned rejected tool result with %s',
    async (_caseName, rejectionReason, rejectionMessage) => {
      const plugin = createRejectingMemorySearchPlugin({
        id: `memory.rejecting.${_caseName.replace(' ', '-')}.fixture`,
        rejectionReason,
        rejectionMessage,
      });
      const host = createExplicitlyEnabledRuntimePluginHost({
        plugins: [plugin],
      });

      const result = await host.handleToolCall(
        {
          ...testIdentity(),
          pluginId: plugin.manifest.id,
          toolName: 'memory.search',
          input: {
            query: 'Mira',
          },
        },
        testPluginContext(),
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: 'handler_failed',
        message:
          'Plugin rejected tool result reason and message must be non-empty.',
      });
      expect(result.evidence[0]).toMatchObject({
        evidenceKind: 'tool_invocation',
        status: 'rejected',
        summary:
          'Plugin rejected tool result reason and message must be non-empty.',
        policyOutcome: 'handler_rejected',
      });
    },
  );

  it('preserves degraded evidence from optional rejected plugin tool results', async () => {
    const plugin = createDegradedRejectingMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira',
        },
      },
      testPluginContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_rejected',
      message: 'search backend degraded',
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'degraded',
      policyOutcome: 'optional_degraded',
    });
  });

  it('synthesizes degraded fallback evidence for optional rejected plugin tool results with degrade policy', async () => {
    const plugin = createRejectingMemorySearchPlugin({
      id: 'memory.rejecting.degraded.fixture',
      handleToolCallFailure: 'degrade',
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira',
        },
      },
      testPluginContext(),
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_rejected',
      message:
        'lookup failed credential="open-sesame" https://user:pass@example.test/?token=abc',
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'degraded',
      policyOutcome: 'optional_degraded',
    });
  });

  it.each(['rejected', 'failed'] as const)(
    'downgrades accepted plugin tool results with %s tool invocation evidence',
    async evidenceStatus => {
      const plugin =
        createAcceptedBlockingEvidenceMemorySearchPlugin(evidenceStatus);
      const host = createExplicitlyEnabledRuntimePluginHost({
        plugins: [plugin],
      });

      const result = await host.handleToolCall(
        {
          ...testIdentity(),
          pluginId: plugin.manifest.id,
          toolName: 'memory.search',
          input: {
            query: 'Mira',
          },
        },
        testPluginContext(),
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: 'blocking_tool_invocation_evidence',
        message: `Plugin "${plugin.manifest.id}" tool "memory.search" accepted result included blocking tool invocation evidence.`,
      });
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toMatchObject({
        evidenceKind: 'tool_invocation',
        status: evidenceStatus,
      });
    },
  );

  it('redacts accepted plugin tool output values with credential-shaped keys', async () => {
    const plugin = createCredentialKeyOutputPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira',
        },
      },
      testPluginContext(),
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected memory.search to be accepted.');
    }

    expect(result.output).toMatchObject({
      api_key: '[redacted]',
      nested: {
        password: '[redacted]',
        safe: 'kept',
      },
      list: [
        {
          access_token: '[redacted]',
          label: 'kept',
        },
      ],
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('open-sesame');
    expect(serialized).not.toContain('secret-token');
  });

  it('preserves own __proto__ keys in accepted plugin tool output objects', async () => {
    const plugin = createProtoKeyOutputPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira',
        },
      },
      testPluginContext(),
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected memory.search to be accepted.');
    }

    const output = expectJsonObject(result.output);
    const nested = expectJsonObject(output['nested']);

    expect(Object.hasOwn(output, '__proto__')).toBe(true);
    expect(output['__proto__']).toEqual({
      polluted: true,
    });
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(nested['__proto__']).toBe('nested-value');
    expect(JSON.stringify(output)).toContain('"__proto__":{"polluted":true}');
    expect(JSON.stringify(output)).toContain(
      '"nested":{"__proto__":"nested-value"}',
    );
  });

  it('degrades optional accepted beforeRoleModelCall results with blocking evidence', async () => {
    const plugin = createAcceptedBlockingBeforeRoleModelCallPlugin({
      id: 'memory.before-blocking.optional.fixture',
      evidenceStatus: 'rejected',
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error(
        'Expected optional blocking beforeRoleModelCall evidence to degrade.',
      );
    }

    expect(result.contextItems).toEqual([]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        evidenceKind: 'before_role_model_call',
        status: 'rejected',
      }),
      expect.objectContaining({
        evidenceKind: 'before_role_model_call',
        status: 'degraded',
        policyOutcome: 'optional_degraded',
      }),
    ]);
  });

  it('rejects legacy beforeRoleModelCall runtime notes', async () => {
    const plugin = createRuntimeNotesPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected beforeRoleModelCall to complete.');
    }

    expect(result.contextItems).toEqual([]);
    const rejectionEvidence = result.evidence.find(
      evidence =>
        evidence.pluginId === plugin.manifest.id &&
        evidence.evidenceKind === 'before_role_model_call' &&
        evidence.status === 'degraded',
    );
    expect(rejectionEvidence?.summary).toContain(
      'beforeRoleModelCall runtimeNotes are not supported',
    );
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('budgets beforeRoleModelCall context item text with a host-side estimate', async () => {
    const plugin = createUnderestimatedContextItemPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected beforeRoleModelCall to complete.');
    }

    expect(result.contextItems).toEqual([]);
    const budgetEvidence = result.evidence.find(
      evidence =>
        evidence.pluginId === plugin.manifest.id &&
        evidence.evidenceKind === 'before_role_model_call' &&
        evidence.status === 'degraded',
    );

    expect(budgetEvidence?.summary).toContain('1 item(s)');
    expect(budgetEvidence?.summary).toContain('dropped ids oversized-context');
    expect(JSON.stringify(result.contextItems)).not.toContain(
      'oversized context',
    );
  });

  it('bounds recalled memory under its own budget separately from plugin context', async () => {
    // Three 1200-char memories (~900 tokens) overflow the 256-token plugin
    // budget but fit the 1024-token memory budget; a fourth is evicted and
    // the resource item is judged against the plugin budget alone.
    const plugin = createRecalledMemoryBudgetPlugin({
      memoryCount: 4,
      memoryChars: 1_200,
    });
    const host = createExplicitlyEnabledRuntimePluginHost({plugins: [plugin]});

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected beforeRoleModelCall to complete.');
    }

    expect(result.contextItems.map(item => item.id)).toEqual([
      'memory-1',
      'memory-2',
      'memory-3',
      'resource-1',
    ]);
    const budgetEvidence = result.evidence.find(
      evidence =>
        evidence.evidenceKind === 'before_role_model_call' &&
        evidence.status === 'degraded',
    );
    expect(budgetEvidence?.summary).toContain('Recalled-memory budget');
    expect(budgetEvidence?.summary).toContain('dropped ids memory-4');
  });

  it('accepts 64 hook records and rejects record 65 without truncation', async () => {
    const exactContextPlugin = createBoundedHookRecordsPlugin({
      id: 'memory.context-limit.exact',
      contextItemCount: 64,
      evidenceCount: 0,
    });
    const exactEvidencePlugin = createBoundedHookRecordsPlugin({
      id: 'memory.evidence-limit.exact',
      contextItemCount: 0,
      evidenceCount: 64,
    });
    const overContextPlugin = createBoundedHookRecordsPlugin({
      id: 'memory.context-limit.over',
      contextItemCount: 65,
      evidenceCount: 0,
    });
    const overEvidencePlugin = createBoundedHookRecordsPlugin({
      id: 'memory.evidence-limit.over',
      contextItemCount: 0,
      evidenceCount: 65,
    });

    const exactContext = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [exactContextPlugin],
    }).beforeRoleModelCall(testPluginContext());
    const exactEvidence = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [exactEvidencePlugin],
    }).beforeRoleModelCall(testPluginContext());
    const overContext = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [overContextPlugin],
    }).beforeRoleModelCall(testPluginContext());
    const overEvidence = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [overEvidencePlugin],
    }).beforeRoleModelCall(testPluginContext());

    expect(exactContext).toMatchObject({status: 'completed'});
    expect(
      exactContext.status === 'completed' ? exactContext.contextItems : [],
    ).toHaveLength(64);
    expect(exactEvidence.evidence).toHaveLength(64);
    expect(overContext.status).toBe('completed');
    expect(
      overContext.status === 'completed' ? overContext.contextItems : [],
    ).toEqual([]);
    expect(overContext.evidence[0]?.summary).toContain('64-record limit');
    expect(overEvidence.status).toBe('completed');
    expect(
      overEvidence.status === 'completed' ? overEvidence.contextItems : [],
    ).toEqual([]);
    expect(overEvidence.evidence[0]?.summary).toContain('64-record limit');
  });

  it('applies the hook deadline through result normalization', async () => {
    const plugin = createSlowNormalizationPlugin();
    const result = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
    }).beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    expect(result.evidence[0]).toMatchObject({
      status: 'degraded',
      policyOutcome: 'timeout',
    });
    expect(result.evidence[0]?.summary).toContain('timed out after 1ms');
  });

  it('stamps plugin evidence with the config version behind it', async () => {
    const id = 'memory.fingerprinted.fixture';
    const plugin = createRuntimePlugin({
      manifest: {
        ...memorySearchPluginManifest(id),
        config: {
          scope: 'global_with_character_overrides',
          fields: [],
          fingerprint: 'sha256:config-version',
        },
      },
      providedTools: memorySearchProvidedTools(),
      lifecycleHooks: {
        handleToolCall(_call, context) {
          return {
            status: 'accepted',
            output: {},
            evidence: [
              createRuntimePluginEvidenceSnapshot({
                eventId: context.eventId,
                traceId: context.traceId,
                createdAt: context.timestamp,
                kind: 'runtime_plugin_evidence_snapshot',
                pluginId: id,
                evidenceKind: 'tool_invocation',
                status: 'accepted',
                summary: 'Search completed.',
                redactionLabels: [],
              }),
            ],
          };
        },
      },
    });

    const result = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin],
    }).handleToolCall(
      {
        ...testIdentity(),
        pluginId: id,
        toolName: 'memory.search',
        input: {query: 'Mira'},
      },
      testPluginContext(),
    );

    // Which configuration produced a record is the host's to state: a
    // plugin's own records carry the same stamp the host puts on its
    // failure records, so a persisted action stays tied to its config.
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      configFingerprint: 'sha256:config-version',
    });
  });
});
