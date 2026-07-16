import { describe, expect, it } from 'vitest';

import {
  createRuntimePlugin,
  createRuntimePluginManifest,
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  createRuntimePluginListingSnapshot,
  createRuntimePluginToolInvocationSnapshot,
  isFirstPartyBuiltInModelTool,
  normalizeRuntimePluginAccessMap,
  runtimePluginAccessFor,
  runtimePluginAccessAllows,
  runtimePluginContractVersion,
  validateRuntimePluginContextItem,
  type RuntimePluginAccessMap
} from '../src/plugins/types.ts';
import {
  createFirstPartyModelToolsPlugin
} from '../src/plugins/builtin/model-tools.ts';
import {
  createRuntimePluginProvidedTool
} from '../src/plugins/validation.ts';
import {
  isApprovalGatedRuntimePluginTool,
  isModelFacingRuntimePluginTool
} from '../src/plugins/tool-contract.ts';

describe('runtime plugin source references', () => {
  it('bounds every public context, evidence, and health string as one result', () => {
    const exact = 'x'.repeat(16 * 1_024);
    const over = `${exact}x`;
    const context = (sourceReferences: readonly unknown[]) => ({
      pluginId: 'memory.boundary.fixture',
      id: 'bounded-context',
      kind: 'memory',
      text: 'safe',
      budget: { estimatedTokens: 1, priority: 1 },
      sourceReferences,
      redactionLabels: []
    });
    const evidence = (sourceReferences: readonly unknown[]) => ({
      eventId: 'evt_bounded_evidence',
      traceId: 'trace_bounded_evidence',
      createdAt: '2026-07-11T00:00:00.000Z',
      kind: 'runtime_plugin_evidence_snapshot',
      pluginId: 'memory.boundary.fixture',
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      summary: 'safe',
      sourceReferences,
      redactionLabels: []
    });
    const health = (summary: string) => ({
      pluginId: 'memory.boundary.fixture',
      status: 'ok',
      checkedAt: '2026-07-11T00:00:00.000Z',
      summary,
      redactionLabels: []
    });

    expect(
      createRuntimePluginContextItem(
        context([{ kind: 'memory', id: 'source', title: exact }])
      ).sourceReferences[0]?.title
    ).toBe(exact);
    expect(() =>
      createRuntimePluginContextItem(
        context([{ kind: 'memory', id: 'source', title: over }])
      )
    ).toThrow('exceeds the JSON string byte limit.');
    expect(
      validateRuntimePluginContextItem(
        context([{ kind: 'memory', id: 'source', title: over }])
      )
    ).toMatchObject({
      status: 'rejected',
      reason: 'malformed_context_item'
    });
    expect(
      createRuntimePluginEvidenceSnapshot(
        evidence([{ kind: 'memory', id: exact }])
      ).sourceReferences?.[0]?.id
    ).toBe(exact);
    expect(() =>
      createRuntimePluginEvidenceSnapshot(
        evidence([{ kind: 'memory', id: over }])
      )
    ).toThrow('exceeds the JSON string byte limit.');
    expect(createRuntimePluginHealthSnapshot(health(exact)).summary).toBe(exact);
    expect(() => createRuntimePluginHealthSnapshot(health(over))).toThrow(
      'exceeds the JSON string byte limit.'
    );
    expect(() =>
      createRuntimePluginContextItem(
        context(
          Array.from({ length: 32 }, (_value, index) => ({
            kind: 'memory',
            id: `${String(index)}-${'x'.repeat(2_200)}`
          }))
        )
      )
    ).toThrow('exceeds the aggregate JSON text limit.');
  }, 20_000);

  it('redacts credential-bearing redaction labels in public snapshots', () => {
    const labels = [
      'api_key=label-secret',
      'Bearer label-token',
      'Cookie: session=label-cookie'
    ];
    const contextItem = createRuntimePluginContextItem({
      pluginId: 'memory.labels.fixture',
      id: 'labels',
      kind: 'memory',
      text: 'safe',
      budget: { estimatedTokens: 1, priority: 1 },
      sourceReferences: [],
      redactionLabels: labels
    });
    const evidence = createRuntimePluginEvidenceSnapshot({
      eventId: 'evt_labels',
      traceId: 'trace_labels',
      createdAt: '2026-07-11T00:00:00.000Z',
      kind: 'runtime_plugin_evidence_snapshot',
      pluginId: 'memory.labels.fixture',
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      summary: 'safe',
      redactionLabels: labels
    });
    const health = createRuntimePluginHealthSnapshot({
      pluginId: 'memory.labels.fixture',
      status: 'ok',
      checkedAt: '2026-07-11T00:00:00.000Z',
      summary: 'safe',
      redactionLabels: labels
    });
    const manifest = createRuntimePluginManifest(
      runtimePluginManifestFixture({
        displayName: 'Authorization: ApiKey display-secret',
        version: '1.0.0?token=version-secret',
        runtimePolicy: {
          requiredForTurn: false,
          sideEffectLevel: 'runtime_read',
          confirmation: 'not_required',
          timeoutMs: 1_000,
          sourceReferencesRequired: false,
          redactionLabels: labels,
          failureBehavior: {
            beforeRoleModelCall: 'degrade',
            handleToolCall: 'degrade',
            afterTurnCommitted: 'log_failure',
            health: 'degrade'
          }
        },
        activation: {
          defaultEnabled: false,
          reasons: ['api_key=reason-secret']
        }
      })
    );
    const listing = createRuntimePluginListingSnapshot({
      pluginId: manifest.id,
      manifest,
      providedTools: [],
      registeredLifecycleHooks: [],
      installed: true,
      registered: true,
      enabled: true,
      availableForTurn: true,
      redactionLabels: labels,
      requestedAccess: {},
      grantedAccess: {}
    });
    const serialized = JSON.stringify({ contextItem, evidence, health, listing });

    for (const secret of [
      'label-secret',
      'label-token',
      'label-cookie',
      'display-secret',
      'version-secret',
      'reason-secret'
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(listing.manifest).toMatchObject({
      displayName: 'Authorization: [redacted]',
      version: '1.0.0?token=[redacted]',
      activation: { reasons: ['api_key=[redacted]'] }
    });
    for (const snapshotLabels of [
      contextItem.redactionLabels,
      evidence.redactionLabels,
      health.redactionLabels,
      listing.redactionLabels,
      listing.manifest.runtimePolicy.redactionLabels
    ]) {
      expect(snapshotLabels).toEqual([
        'api_key=[redacted]',
        'Bearer [redacted]',
        'Cookie: [redacted]'
      ]);
    }
  });

  it('enforces tool-result evidence and aggregate limits at the public constructor', () => {
    const evidence = (count: number, summary = 'accepted') =>
      Array.from({ length: count }, (_value, index) => ({
        eventId: 'evt_bounded_tool_snapshot',
        traceId: 'trace_bounded_tool_snapshot',
        createdAt: '2026-07-11T00:00:00.000Z',
        kind: 'runtime_plugin_evidence_snapshot' as const,
        pluginId: 'memory.boundary.fixture',
        evidenceKind: 'tool_invocation' as const,
        status: 'accepted' as const,
        summary: `${summary}${String(index)}`,
        redactionLabels: []
      }));
    const invocation = (resultEvidence: readonly unknown[]) => ({
      eventId: 'evt_bounded_tool_snapshot',
      traceId: 'trace_bounded_tool_snapshot',
      createdAt: '2026-07-11T00:00:00.000Z',
      kind: 'runtime_plugin_tool_invocation_snapshot' as const,
      pluginId: 'memory.boundary.fixture',
      toolName: 'memory.search',
      input: { query: 'Mira' },
      result: {
        status: 'accepted' as const,
        output: { matched: true },
        evidence: resultEvidence
      }
    });

    expect(
      createRuntimePluginToolInvocationSnapshot(invocation(evidence(64))).result
        .evidence
    ).toHaveLength(64);
    expect(() =>
      createRuntimePluginToolInvocationSnapshot(invocation(evidence(65)))
    ).toThrow('Plugin tool result evidence exceeds the 64-record limit.');
    expect(() =>
      createRuntimePluginToolInvocationSnapshot(
        invocation(evidence(5, 'x'.repeat(14 * 1_024)))
      )
    ).toThrow('Plugin tool result exceeds the aggregate JSON text limit.');
  });

  it('redacts credential-bearing source IDs and rejected tool reasons', () => {
    const snapshot = createRuntimePluginToolInvocationSnapshot({
      eventId: 'evt_redacted_tool_snapshot',
      traceId: 'trace_redacted_tool_snapshot',
      createdAt: '2026-07-11T00:00:00.000Z',
      kind: 'runtime_plugin_tool_invocation_snapshot',
      pluginId: 'memory.redaction.fixture',
      toolName: 'memory.search',
      input: { query: 'Authorization: Bearer input-secret' },
      result: {
        status: 'rejected',
        reason: 'handler_failed token=reason-secret',
        message: 'Cookie: session=message-secret',
        evidence: [
          {
            eventId: 'evt_redacted_tool_snapshot',
            traceId: 'trace_redacted_tool_snapshot',
            createdAt: '2026-07-11T00:00:00.000Z',
            kind: 'runtime_plugin_evidence_snapshot',
            pluginId: 'memory.redaction.fixture',
            evidenceKind: 'tool_invocation',
            status: 'rejected',
            summary: 'api_key=summary-secret',
            sourceReferences: [
              { kind: 'memory', id: 'token=source-secret' }
            ],
            redactionLabels: []
          }
        ]
      }
    });
    const serialized = JSON.stringify(snapshot);

    for (const secret of [
      'input-secret',
      'reason-secret',
      'message-secret',
      'summary-secret',
      'source-secret'
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(snapshot.result).toMatchObject({
      status: 'rejected',
      reason: 'handler_failed token=[redacted]',
      message: 'Cookie: [redacted]'
    });
    expect(snapshot.result.evidence[0]?.sourceReferences?.[0]?.id).toBe(
      'token=[redacted]'
    );
  });

  it('enforces source-reference and context-text byte limits exactly', () => {
    const references = Array.from({ length: 32 }, (_value, index) => ({
      kind: 'memory' as const,
      id: `source-${String(index)}`
    }));
    const exactText = '界'.repeat(Math.floor((16 * 1_024) / 3));
    const base = {
      pluginId: 'memory.boundary.fixture',
      id: 'bounded-context',
      kind: 'memory',
      budget: { estimatedTokens: 1, priority: 1 },
      redactionLabels: []
    } as const;

    expect(
      createRuntimePluginContextItem({
        ...base,
        text: exactText,
        sourceReferences: references
      }).sourceReferences
    ).toHaveLength(32);
    expect(() =>
      createRuntimePluginContextItem({
        ...base,
        text: `${exactText}界`,
        sourceReferences: references
      })
    ).toThrow('Plugin context item.text exceeds the JSON string byte limit.');
    expect(() =>
      createRuntimePluginContextItem({
        ...base,
        text: 'safe',
        sourceReferences: [
          ...references,
          { kind: 'memory' as const, id: 'source-over-limit' }
        ]
      })
    ).toThrow('Plugin sourceReferences exceed the 32-record limit.');
  });

  it('accepts external source reference IDs that are not plugin identifiers', () => {
    const references = [
      {
        kind: 'memory',
        id: '1234567890',
        title: 'numeric database key'
      },
      {
        kind: 'resource',
        id: '1f4e2d3c-9a8b-4c7d-8123-abcdefabcdef',
        title: 'UUID beginning with a digit'
      },
      {
        kind: 'resource',
        id: 'resources/users/42/profile.json',
        title: 'path-like resource ID'
      }
    ] as const;

    const contextItem = createRuntimePluginContextItem({
      pluginId: 'memory.external_source.fixture',
      id: 'memory-context',
      kind: 'memory',
      text: 'Retrieved memory context.',
      budget: {
        estimatedTokens: 8,
        priority: 1
      },
      sourceReferences: references,
      redactionLabels: []
    });
    const evidence = createRuntimePluginEvidenceSnapshot({
      eventId: 'evt_external_source_reference',
      traceId: 'trace_external_source_reference',
      createdAt: '2026-06-16T00:00:00.000Z',
      kind: 'runtime_plugin_evidence_snapshot',
      pluginId: 'memory.external_source.fixture',
      evidenceKind: 'tool_invocation',
      status: 'accepted',
      summary: 'Memory search completed.',
      sourceReferences: references,
      redactionLabels: []
    });

    const expectedIds = [
      '1234567890',
      '1f4e2d3c-9a8b-4c7d-8123-abcdefabcdef',
      'resources/users/42/profile.json'
    ];

    expect(contextItem.sourceReferences.map((reference) => reference.id)).toEqual(
      expectedIds
    );
    expect(evidence.sourceReferences?.map((reference) => reference.id)).toEqual(
      expectedIds
    );
  });

  it('rejects empty source reference IDs', () => {
    for (const id of ['', '   ']) {
      expect(() =>
        createRuntimePluginContextItem({
          pluginId: 'memory.external_source.fixture',
          id: 'memory-context',
          kind: 'memory',
          text: 'Retrieved memory context.',
          budget: {
            estimatedTokens: 8,
            priority: 1
          },
          sourceReferences: [
            {
              kind: 'memory',
              id
            }
          ],
          redactionLabels: []
        })
      ).toThrow('Plugin field "id" must be a non-empty string.');

      expect(() =>
        createRuntimePluginEvidenceSnapshot({
          eventId: 'evt_external_source_reference',
          traceId: 'trace_external_source_reference',
          createdAt: '2026-06-16T00:00:00.000Z',
          kind: 'runtime_plugin_evidence_snapshot',
          pluginId: 'memory.external_source.fixture',
          evidenceKind: 'tool_invocation',
          status: 'accepted',
          summary: 'Memory search completed.',
          sourceReferences: [
            {
              kind: 'memory',
              id
            }
          ],
          redactionLabels: []
        })
      ).toThrow('Plugin field "id" must be a non-empty string.');
    }
  });
});

describe('runtime plugin access control', () => {
  it('defaults absent requestedAccess to an empty permission object', () => {
    const manifest = createRuntimePluginManifest(runtimePluginManifestFixture());

    expect(manifest.requestedAccess).toEqual({});
    expect(runtimePluginAccessFor(manifest.requestedAccess, 'file_store')).toBe(
      'none'
    );
  });

  it('accepts requestedAccess permission objects', () => {
    expect(
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          requestedAccess: {}
        })
      ).requestedAccess
    ).toEqual({});
    expect(
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          requestedAccess: { file_store: 'read' }
        })
      ).requestedAccess
    ).toEqual({ file_store: 'read' });
    expect(
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          requestedAccess: {
            file_store: 'write',
            turn_context: 'read',
            model_input: 'write'
          }
        })
      ).requestedAccess
    ).toEqual({
      file_store: 'write',
      turn_context: 'read',
      model_input: 'write'
    });
  });

  it('rejects legacy arrays and malformed requestedAccess values', () => {
    for (const requestedAccess of [
      [],
      ['file_store'],
      { unknown_access: 'read' },
      { file_store: 'admin' },
      null,
      'file_store',
      true,
      1
    ]) {
      expect(() =>
        createRuntimePluginManifest(
          runtimePluginManifestFixture({
            requestedAccess
          })
        )
      ).toThrow(/requestedAccess/u);
    }
  });

  it('ignores inherited access values', () => {
    const inheritedPermissions = Object.create({
      file_store: 'write'
    }) as RuntimePluginAccessMap;

    expect(Object.keys(inheritedPermissions)).toEqual([]);
    expect(runtimePluginAccessFor(inheritedPermissions, 'file_store')).toBe(
      'none'
    );
    expect(
      normalizeRuntimePluginAccessMap(inheritedPermissions)
    ).toEqual({});
  });

  it('orders access levels for allow checks', () => {
    expect(runtimePluginAccessAllows('write', 'read')).toBe(true);
    expect(runtimePluginAccessAllows('read', 'write')).toBe(false);
    expect(runtimePluginAccessAllows('read', 'none')).toBe(true);
  });
});

describe('runtime plugin model-facing tool policy', () => {
  it('rejects credential-bearing legacy and JSON Schema enum values', () => {
    expect(() =>
      createRuntimePluginProvidedTool(
        runtimePluginProvidedToolFixture({
          inputContract: {
            type: 'object',
            fields: [
              {
                name: 'mode',
                description: 'Mode.',
                required: false,
                allowedValues: ['api_key=legacy-enum-secret']
              }
            ],
            additionalFields: false
          }
        })
      )
    ).toThrow(
      'Model tool inputContract field allowedValues must not contain credential-bearing values.'
    );
    expect(() =>
      createRuntimePluginProvidedToolWithJsonSchema({
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['Authorization: ApiKey schema-enum-secret']
          }
        },
        required: [],
        additionalProperties: false
      })
    ).toThrow(
      'Model tool inputContract.jsonSchema.properties.mode.enum must not contain credential-bearing values.'
    );
  });

  it('rejects unsupported root JSON Schema keywords with their field path', () => {
    expect(() =>
      createRuntimePluginProvidedToolWithJsonSchema({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
        oneOf: []
      })
    ).toThrow('Model tool inputContract.jsonSchema.oneOf is not supported.');
  });

  it('rejects unsupported property JSON Schema keywords with their field path', () => {
    expect(() =>
      createRuntimePluginProvidedToolWithJsonSchema({
        type: 'object',
        properties: {
          profile: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                minLength: 1
              }
            },
            required: ['name'],
            additionalProperties: false
          }
        },
        required: ['profile'],
        additionalProperties: false
      })
    ).toThrow(
      'Model tool inputContract.jsonSchema.properties.profile.properties.name.minLength is not supported.'
    );
  });

  it('rejects unsupported item JSON Schema keywords with their field path', () => {
    expect(() =>
      createRuntimePluginProvidedToolWithJsonSchema({
        type: 'object',
        properties: {
          aliases: {
            type: 'array',
            items: {
              type: 'string',
              pattern: '^[a-z]+$'
            }
          }
        },
        required: ['aliases'],
        additionalProperties: false
      })
    ).toThrow(
      'Model tool inputContract.jsonSchema.properties.aliases.items.pattern is not supported.'
    );
  });

  it('preserves supported JSON Schema keywords and union types', () => {
    const jsonSchema = {
      type: 'object',
      description: 'Memory capture input.',
      properties: {
        note: {
          type: ['string', 'null'],
          description: 'Optional note.',
          enum: ['remember', 'forget']
        },
        entries: {
          type: ['array', 'null'],
          items: {
            type: ['object', 'null'],
            properties: {
              text: {
                type: 'string'
              }
            },
            required: ['text'],
            additionalProperties: false
          }
        }
      },
      required: ['note'],
      additionalProperties: false
    };

    const tool = createRuntimePluginProvidedToolWithJsonSchema(jsonSchema);

    expect(tool.inputContract.jsonSchema).toEqual(jsonSchema);
  });

  it('preserves an explicitly declared __proto__ property as data', () => {
    const jsonSchema = {
      type: 'object',
      properties: Object.fromEntries([
        ['__proto__', { type: 'string' }]
      ]),
      required: ['__proto__'],
      additionalProperties: false
    };
    const schema = createRuntimePluginProvidedToolWithJsonSchema(jsonSchema)
      .inputContract.jsonSchema;

    expect(schema?.properties === undefined).toBe(false);
    expect(Object.hasOwn(schema?.properties ?? {}, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(schema?.properties ?? {})).toBe(
      Object.prototype
    );
  });

  it.each([
    [
      'duplicate required names',
      {
        type: 'object',
        properties: { note: { type: 'string' } },
        required: ['note', 'note'],
        additionalProperties: false
      },
      'jsonSchema.required must not contain duplicates'
    ],
    [
      'required names absent from properties',
      {
        type: 'object',
        properties: { note: { type: 'string' } },
        required: ['missing'],
        additionalProperties: false
      },
      'jsonSchema.required includes "missing" outside properties'
    ],
    [
      'required names inherited from Object.prototype',
      {
        type: 'object',
        properties: {},
        required: ['toString'],
        additionalProperties: false
      },
      'jsonSchema.required includes "toString" outside properties'
    ],
    [
      'duplicate union types',
      {
        type: 'object',
        properties: { note: { type: ['string', 'string'] } },
        required: ['note'],
        additionalProperties: false
      },
      'jsonSchema.properties.note.type must not contain duplicates'
    ],
    [
      'object keywords on non-object types',
      {
        type: 'object',
        properties: {
          note: { type: 'string', properties: {} }
        },
        required: ['note'],
        additionalProperties: false
      },
      'jsonSchema.properties.note uses object keywords without object type'
    ]
  ])('rejects %s recursively', (_case, schema, message) => {
    expect(() => createRuntimePluginProvidedToolWithJsonSchema(schema)).toThrow(
      message
    );
  });

  it('requires the scoped call-limit contract on provided tools', () => {
    expect(() =>
      createRuntimePluginProvidedTool(
        runtimePluginProvidedToolFixture({
          callLimit: undefined,
          maxCallsPerUserTurn: 1
        })
      )
    ).toThrow('Plugin provided tool callLimit must be an object.');
    expect(() =>
      createRuntimePluginProvidedTool(
        runtimePluginProvidedToolFixture({
          callLimit: {
            scope: 'session',
            maxCalls: 1
          }
        })
      )
    ).toThrow('Plugin provided tool callLimit.scope is not supported.');
  });

  it('rejects model-facing tools without requestedAccess.model_input write', () => {
    expect(() =>
      createRuntimePlugin({
        manifest: runtimePluginManifestFixture({
          declaredPlugins: ['tool_provider', 'handle_tool_call'],
          requestedAccess: {}
        }),
        providedTools: [runtimePluginProvidedToolFixture()],
        lifecycleHooks: {
          handleToolCall() {
            return {
              status: 'accepted',
              output: {},
              evidence: []
            };
          }
        }
      })
    ).toThrow(
      'Model-facing tools require requestedAccess.model_input = "write".'
    );
  });

  it('accepts model-facing tools with requestedAccess.model_input write', () => {
    const plugin = createRuntimePlugin({
      manifest: runtimePluginManifestFixture({
        declaredPlugins: ['tool_provider', 'handle_tool_call'],
        requestedAccess: { model_input: 'write' }
      }),
      providedTools: [runtimePluginProvidedToolFixture()],
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

    expect(plugin.providedTools).toHaveLength(1);
  });

  it('classifies approval-gated config writes by policy instead of plugin identity', () => {
    const manifest = createRuntimePluginManifest(
      runtimePluginManifestFixture({
        id: 'settings.arbitrary.fixture',
        requestedAccess: { model_input: 'write' }
      })
    );
    const tool = createRuntimePluginProvidedTool(
      runtimePluginProvidedToolFixture({
        name: 'settings.arbitrary.update',
        sideEffectLevel: 'runtime_config_write',
        requiresConfirmation: true
      })
    );

    expect(isApprovalGatedRuntimePluginTool(tool)).toBe(true);
    expect(isModelFacingRuntimePluginTool({ manifest, tool })).toBe(true);
    expect(
      isModelFacingRuntimePluginTool({
        manifest: createRuntimePluginManifest(
          runtimePluginManifestFixture({
            id: 'settings.arbitrary.fixture',
            requestedAccess: { model_input: 'write' },
            runtimePolicy: {
              ...manifest.runtimePolicy,
              confirmation: 'required'
            }
          })
        ),
        tool
      })
    ).toBe(false);
  });

  it('accepts non-model-facing tools without model_input write', () => {
    for (const tool of [
      runtimePluginProvidedToolFixture({ sideEffectLevel: 'external_write' }),
      runtimePluginProvidedToolFixture({
        sideEffectLevel: 'runtime_config_write',
        requiresConfirmation: false
      })
    ]) {
      expect(() =>
        createRuntimePlugin({
          manifest: runtimePluginManifestFixture({
            declaredPlugins: ['tool_provider', 'handle_tool_call'],
            requestedAccess: {}
          }),
          providedTools: [tool],
          lifecycleHooks: {
            handleToolCall() {
              return {
                status: 'accepted',
                output: {},
                evidence: []
              };
            }
          }
        })
      ).not.toThrow();
    }
  });

  it('requires shutdown hooks to declare the shutdown lifecycle', () => {
    expect(() =>
      createRuntimePlugin({
        manifest: runtimePluginManifestFixture(),
        lifecycleHooks: {
          onShutdown() {
            return { status: 'completed', evidence: [] };
          }
        }
      })
    ).toThrow('onShutdown hooks must declare on_shutdown.');
  });

  it('recognizes first-party built-in model tools only from the real host-owned instance', () => {
    const firstPartyPlugin = createFirstPartyModelToolsPlugin();
    const firstPartyTool = firstPartyPlugin.providedTools[0];
    const copiedPlugin = createRuntimePlugin({
      manifest: firstPartyPlugin.manifest,
      providedTools: firstPartyPlugin.providedTools,
      lifecycleHooks: firstPartyPlugin.lifecycleHooks
    });

    if (firstPartyTool === undefined) {
      throw new Error('Expected first-party model tools plugin to provide a tool.');
    }

    expect(firstPartyTool.callLimit).toEqual({
      scope: 'model_response',
      maxCalls: 1
    });

    expect(
      isFirstPartyBuiltInModelTool({
        plugin: firstPartyPlugin,
        tool: firstPartyTool,
        isHostOwnedFirstPartyModelToolsPlugin: (plugin) =>
          plugin === firstPartyPlugin
      })
    ).toBe(true);
    expect(
      isFirstPartyBuiltInModelTool({
        plugin: copiedPlugin,
        tool: firstPartyTool,
        isHostOwnedFirstPartyModelToolsPlugin: (plugin) =>
          plugin === firstPartyPlugin
      })
    ).toBe(false);
  });
});

describe('runtime plugin config metadata', () => {
  it('accepts optional config metadata fields without resolved config values', () => {
    const plugin = createRuntimePlugin({
      manifest: {
        id: 'metadata.fixture',
        displayName: 'Metadata Fixture',
        version: '1.0.0',
        kind: 'tool_provider',
        description: 'Config metadata fixture.',
        contractVersion: runtimePluginContractVersion,
        compatibility: {
          hostContractVersions: [runtimePluginContractVersion],
          sourceSystem: 'test'
        },
        declaredPlugins: ['plugin_discovery'],
        config: {
          fields: [
            {
              name: 'backend',
              description: 'Backend selection.',
              required: true,
              secret: false,
              valueType: 'enum',
              defaultValueSummary: 'local',
              allowedValues: ['local', 'cloud'],
              agentMutable: true,
              reloadRequired: true,
              redactionLabels: [],
              configFingerprint: 'declared-backend-v1'
            },
            {
              name: 'apiKey',
              description: 'API key.',
              required: false,
              secret: true,
              valueType: 'secret',
              envVar: 'MEMORY_API_KEY',
              redactionLabels: ['secret']
            }
          ],
          fingerprint: 'declared-config-v1'
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
            handleToolCall: 'degrade',
            afterTurnCommitted: 'log_failure',
            health: 'degrade'
          }
        },
        activation: {
          defaultEnabled: false,
          reasons: ['test']
        },
        requestedAccess: {}
      }
    });

    expect(plugin.manifest.config.fields[0]).toMatchObject({
      name: 'backend',
      valueType: 'enum',
      allowedValues: ['local', 'cloud'],
      agentMutable: true,
      reloadRequired: true,
      configFingerprint: 'declared-backend-v1'
    });
    expect(JSON.stringify(plugin.manifest)).not.toContain('resolvedConfig');
    expect(JSON.stringify(plugin.manifest)).not.toContain('MEMORY_API_KEY=');
  });

  it('rejects manifest metadata that makes a secret field agent-mutable', () => {
    expect(() =>
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          config: {
            fields: [
              {
                name: 'apiKey',
                description: 'API key.',
                required: false,
                secret: true,
                valueType: 'secret',
                agentMutable: true,
                redactionLabels: ['secret']
              }
            ]
          }
        })
      )
    ).toThrow('Secret plugin config fields cannot allow agent mutation.');
  });
});

function runtimePluginManifestFixture(
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: 'access-control.fixture',
    displayName: 'Access Control Fixture',
    version: '1.0.0',
    kind: 'tool_provider',
    description: 'Access control fixture.',
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: 'test'
    },
    declaredPlugins: ['plugin_discovery'],
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
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'degrade',
        afterTurnCommitted: 'log_failure',
        health: 'degrade'
      }
    },
    activation: {
      defaultEnabled: false,
      reasons: ['test']
    },
    ...overrides
  });
}

function createRuntimePluginProvidedToolWithJsonSchema(jsonSchema: unknown) {
  return createRuntimePluginProvidedTool(
    runtimePluginProvidedToolFixture({
      inputContract: {
        type: 'object',
        fields: [],
        additionalFields: false,
        jsonSchema
      }
    })
  );
}

function runtimePluginProvidedToolFixture(
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: 'memory.search',
    description: 'Search memory.',
    requiredForUserTurn: false,
    callLimit: {
      scope: 'user_turn',
      maxCalls: 1
    },
    inputContract: {
      type: 'object',
      fields: [],
      additionalFields: false
    },
    validationOwner: 'plugin_host',
    sideEffectLevel: 'runtime_read',
    requiresConfirmation: false,
    sourceReferencesRequired: false,
    ...overrides
  });
}
