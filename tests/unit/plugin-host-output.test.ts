import { describe, expect, it } from 'vitest';
import {
  createAcceptedBlockingBeforeRoleModelCallPlugin,
  createAcceptedBlockingEvidenceMemorySearchPlugin,
  createBoundedHookRecordsPlugin,
  createCredentialKeyOutputPlugin,
  createDegradedRejectingMemorySearchPlugin,
  createExplicitlyEnabledRuntimePluginHost,
  createMemorySearchPlugin,
  createProtoKeyOutputPlugin,
  createRejectingMemorySearchPlugin,
  createRuntimeNotesPlugin,
  createSlowNormalizationPlugin,
  createSourceRequiredMemorySearchPlugin,
  createSourceRequiredRuntimeNotesPlugin,
  createUnderestimatedContextItemPlugin,
  expectJsonObject,
  testIdentity,
  testPluginContext
} from '../support/plugin-host-fixtures.ts';

describe('runtime plugin host output boundaries', () => {
  it('redacts plugin-returned rejected tool result messages', async () => {
    const plugin = createRejectingMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_rejected',
      message:
        'lookup failed credential="[redacted]" https://[redacted]@example.test/?token=[redacted]'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'rejected',
      summary:
        'lookup failed credential="[redacted]" https://[redacted]@example.test/?token=[redacted]',
      policyOutcome: 'handler_rejected'
    });
    expect(JSON.stringify(result)).not.toContain('open-sesame');
    expect(JSON.stringify(result)).not.toContain('abc');
  });

  it.each([
    ['empty reason', '', 'search backend failed'],
    ['empty message', 'handler_rejected', ''],
    ['blank reason', '   ', 'search backend failed'],
    ['blank message', 'handler_rejected', '   ']
  ] as const)(
    'rejects plugin-returned rejected tool result with %s',
    async (_caseName, rejectionReason, rejectionMessage) => {
      const plugin = createRejectingMemorySearchPlugin({
        id: `memory.rejecting.${_caseName.replace(' ', '-')}.fixture`,
        rejectionReason,
        rejectionMessage
      });
      const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

      const result = await host.handleToolCall(
        {
          ...testIdentity(),
          pluginId: plugin.manifest.id,
          toolName: 'memory.search',
          input: {
            query: 'Mira'
          }
        },
        testPluginContext()
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: 'handler_failed',
        message:
          'Plugin rejected tool result reason and message must be non-empty.'
      });
      expect(result.evidence[0]).toMatchObject({
        evidenceKind: 'tool_invocation',
        status: 'rejected',
        summary:
          'Plugin rejected tool result reason and message must be non-empty.',
        policyOutcome: 'handler_rejected'
      });
    }
  );

  it('preserves degraded evidence from optional rejected plugin tool results', async () => {
    const plugin = createDegradedRejectingMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_rejected',
      message: 'search backend degraded'
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'degraded',
      policyOutcome: 'optional_degraded'
    });
  });

  it('synthesizes degraded fallback evidence for optional rejected plugin tool results with degrade policy', async () => {
    const plugin = createRejectingMemorySearchPlugin({
      id: 'memory.rejecting.degraded.fixture',
      handleToolCallFailure: 'degrade'
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_rejected',
      message:
        'lookup failed credential="[redacted]" https://[redacted]@example.test/?token=[redacted]'
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'degraded',
      policyOutcome: 'optional_degraded'
    });
  });

  it.each(['rejected', 'failed'] as const)(
    'downgrades accepted plugin tool results with %s tool invocation evidence',
    async (evidenceStatus) => {
      const plugin =
        createAcceptedBlockingEvidenceMemorySearchPlugin(evidenceStatus);
      const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

      const result = await host.handleToolCall(
        {
          ...testIdentity(),
          pluginId: plugin.manifest.id,
          toolName: 'memory.search',
          input: {
            query: 'Mira'
          }
        },
        testPluginContext()
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: 'blocking_tool_invocation_evidence',
        message: `Plugin "${plugin.manifest.id}" tool "memory.search" accepted result included blocking tool invocation evidence.`
      });
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]).toMatchObject({
        evidenceKind: 'tool_invocation',
        status: evidenceStatus
      });
    }
  );

  it('redacts accepted plugin tool output strings', async () => {
    const plugin = createMemorySearchPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query:
            'api_key=super-secret Bearer secret-token https://user:pass@example.test/?token=abc'
        }
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected memory.search to be accepted.');
    }

    expect(result.output).toMatchObject({
      matched:
        'api_key=[redacted] Bearer [redacted] https://[redacted]@example.test/?token=[redacted]'
    });
  });

  it('redacts accepted plugin tool output values with credential-shaped keys', async () => {
    const plugin = createCredentialKeyOutputPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected memory.search to be accepted.');
    }

    expect(result.output).toMatchObject({
      api_key: '[redacted]',
      nested: {
        password: '[redacted]',
        safe: 'kept'
      },
      list: [
        {
          access_token: '[redacted]',
          label: 'kept'
        }
      ]
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('open-sesame');
    expect(serialized).not.toContain('secret-token');
  });

  it('preserves own __proto__ keys in accepted plugin tool output objects', async () => {
    const plugin = createProtoKeyOutputPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected memory.search to be accepted.');
    }

    const output = expectJsonObject(result.output);
    const nested = expectJsonObject(output['nested']);

    expect(Object.hasOwn(output, '__proto__')).toBe(true);
    expect(output['__proto__']).toEqual({
      polluted: true
    });
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(nested['__proto__']).toBe('nested-value');
    expect(JSON.stringify(output)).toContain(
      '"__proto__":{"polluted":true}'
    );
    expect(JSON.stringify(output)).toContain(
      '"nested":{"__proto__":"nested-value"}'
    );
  });

  it('rejects accepted source-required tool output backed only by unrelated source evidence', async () => {
    const plugin = createSourceRequiredMemorySearchPlugin({
      id: 'memory.source-required.unrelated.fixture',
      evidenceKinds: ['policy', 'health']
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      message:
        'Plugin "memory.source-required.unrelated.fixture" tool "memory.search" accepted result requires source references.'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'rejected',
      policyOutcome: 'handler_rejected'
    });
  });

  it('degrades optional source-required tool output backed only by unrelated source evidence', async () => {
    const plugin = createSourceRequiredMemorySearchPlugin({
      id: 'memory.source-required.degraded.fixture',
      evidenceKinds: ['policy'],
      handleToolCallFailure: 'degrade'
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed',
      message:
        'Plugin "memory.source-required.degraded.fixture" tool "memory.search" accepted result requires source references.'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'degraded',
      policyOutcome: 'optional_degraded'
    });
  });

  it('accepts source-required tool output backed by accepted tool invocation source evidence', async () => {
    const plugin = createSourceRequiredMemorySearchPlugin({
      id: 'memory.source-required.accepted.fixture',
      evidenceKinds: ['tool_invocation']
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.handleToolCall(
      {
        ...testIdentity(),
        pluginId: plugin.manifest.id,
        toolName: 'memory.search',
        input: {
          query: 'Mira'
        }
      },
      testPluginContext()
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('Expected source-required memory.search to be accepted.');
    }

    expect(result.output).toEqual({
      matched: 'Mira'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      sourceReferences: [
        {
          kind: 'memory',
          id: 'source.tool_invocation'
        }
      ]
    });
  });

  it('degrades optional source-required runtime notes before prompting', async () => {
    const plugin = createSourceRequiredRuntimeNotesPlugin({
      id: 'memory.source-required-notes.degraded.fixture'
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected optional source-required notes to degrade.');
    }

    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'before_role_model_call',
      status: 'degraded',
      policyOutcome: 'optional_degraded',
      summary:
        'Optional before-role-model plugin hook degraded: Plugin "memory.source-required-notes.degraded.fixture" context item "unsourced-note" requires source references.'
    });
  });

  it('rejects required source-required runtime notes before prompting', async () => {
    const plugin = createSourceRequiredRuntimeNotesPlugin({
      id: 'memory.source-required-notes.required.fixture',
      requiredForTurn: true
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result).toMatchObject({
      status: 'rejected',
      pluginId: plugin.manifest.id,
      message:
        'Plugin "memory.source-required-notes.required.fixture" context item "unsourced-note" requires source references.'
    });
    expect(result.evidence[0]).toMatchObject({
      evidenceKind: 'before_role_model_call',
      status: 'rejected',
      policyOutcome: 'required_rejected'
    });
  });

  it.each(['rejected', 'failed'] as const)(
    'rejects required accepted beforeRoleModelCall results with %s evidence',
    async (evidenceStatus) => {
      const plugin = createAcceptedBlockingBeforeRoleModelCallPlugin({
        id: `memory.before-blocking.required.${evidenceStatus}.fixture`,
        requiredForTurn: true,
        evidenceStatus
      });
      const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

      const result = await host.beforeRoleModelCall(testPluginContext());

      expect(result).toMatchObject({
        status: 'rejected',
        pluginId: plugin.manifest.id,
        message: `Plugin "${plugin.manifest.id}" accepted beforeRoleModelCall result included blocking before-role-model evidence.`
      });
      expect(result.evidence).toEqual([
        expect.objectContaining({
          evidenceKind: 'before_role_model_call',
          status: evidenceStatus
        }),
        expect.objectContaining({
          evidenceKind: 'before_role_model_call',
          status: 'rejected',
          policyOutcome: 'required_rejected'
        })
      ]);
    }
  );

  it('degrades optional accepted beforeRoleModelCall results with blocking evidence', async () => {
    const plugin = createAcceptedBlockingBeforeRoleModelCallPlugin({
      id: 'memory.before-blocking.optional.fixture',
      evidenceStatus: 'rejected'
    });
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected optional blocking beforeRoleModelCall evidence to degrade.');
    }

    expect(result.contextItems).toEqual([]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        evidenceKind: 'before_role_model_call',
        status: 'rejected'
      }),
      expect.objectContaining({
        evidenceKind: 'before_role_model_call',
        status: 'degraded',
        policyOutcome: 'optional_degraded'
      })
    ]);
  });

  it('rejects legacy beforeRoleModelCall runtime notes', async () => {
    const plugin = createRuntimeNotesPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected beforeRoleModelCall to complete.');
    }

    expect(result.contextItems).toEqual([]);
    const rejectionEvidence = result.evidence.find(
      (evidence) =>
        evidence.pluginId === plugin.manifest.id &&
        evidence.evidenceKind === 'before_role_model_call' &&
        evidence.status === 'degraded'
    );
    expect(rejectionEvidence?.summary).toContain(
      'beforeRoleModelCall runtimeNotes are not supported'
    );
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('budgets beforeRoleModelCall context item text with a host-side estimate', async () => {
    const plugin = createUnderestimatedContextItemPlugin();
    const host = createExplicitlyEnabledRuntimePluginHost({ plugins: [plugin] });

    const result = await host.beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected beforeRoleModelCall to complete.');
    }

    expect(result.contextItems).toEqual([]);
    const budgetEvidence = result.evidence.find(
      (evidence) =>
        evidence.pluginId === plugin.manifest.id &&
        evidence.evidenceKind === 'before_role_model_call' &&
        evidence.status === 'degraded'
    );

    expect(budgetEvidence?.summary).toContain('1 item(s)');
    expect(budgetEvidence?.summary).toContain('dropped ids oversized-context');
    expect(JSON.stringify(result.contextItems)).not.toContain('oversized context');
  });

  it('accepts 64 hook records and rejects record 65 without truncation', async () => {
    const exactContextPlugin = createBoundedHookRecordsPlugin({
      id: 'memory.context-limit.exact',
      contextItemCount: 64,
      evidenceCount: 0
    });
    const exactEvidencePlugin = createBoundedHookRecordsPlugin({
      id: 'memory.evidence-limit.exact',
      contextItemCount: 0,
      evidenceCount: 64
    });
    const overContextPlugin = createBoundedHookRecordsPlugin({
      id: 'memory.context-limit.over',
      contextItemCount: 65,
      evidenceCount: 0
    });
    const overEvidencePlugin = createBoundedHookRecordsPlugin({
      id: 'memory.evidence-limit.over',
      contextItemCount: 0,
      evidenceCount: 65
    });

    const exactContext = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [exactContextPlugin]
    }).beforeRoleModelCall(testPluginContext());
    const exactEvidence = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [exactEvidencePlugin]
    }).beforeRoleModelCall(testPluginContext());
    const overContext = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [overContextPlugin]
    }).beforeRoleModelCall(testPluginContext());
    const overEvidence = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [overEvidencePlugin]
    }).beforeRoleModelCall(testPluginContext());

    expect(exactContext).toMatchObject({ status: 'completed' });
    expect(
      exactContext.status === 'completed' ? exactContext.contextItems : []
    ).toHaveLength(64);
    expect(exactEvidence.evidence).toHaveLength(64);
    expect(overContext.status).toBe('completed');
    expect(
      overContext.status === 'completed' ? overContext.contextItems : []
    ).toEqual([]);
    expect(overContext.evidence[0]?.summary).toContain('64-record limit');
    expect(overEvidence.status).toBe('completed');
    expect(
      overEvidence.status === 'completed' ? overEvidence.contextItems : []
    ).toEqual([]);
    expect(overEvidence.evidence[0]?.summary).toContain('64-record limit');
  });

  it('applies the hook deadline through result normalization', async () => {
    const plugin = createSlowNormalizationPlugin();
    const result = await createExplicitlyEnabledRuntimePluginHost({
      plugins: [plugin]
    }).beforeRoleModelCall(testPluginContext());

    expect(result.status).toBe('completed');
    expect(result.evidence[0]).toMatchObject({
      status: 'degraded',
      policyOutcome: 'timeout'
    });
    expect(result.evidence[0]?.summary).toContain('timed out after 1ms');
  });
});
