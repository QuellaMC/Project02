import {describe, expect, it} from 'vitest';

import {
  createRuntimePlugin,
  createRuntimePluginManifest,
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  createRuntimePluginToolInvocationSnapshot,
  runtimePluginContractVersion,
  validateRuntimePluginContextItem,
  type RuntimePluginAccessMap,
} from '../../src/plugins/api/index.ts';
import {
  normalizeRuntimePluginAccessMap,
  runtimePluginAccessAllows,
  runtimePluginAccessFor,
} from '../../src/plugins/policy/access-control.ts';
import {isFirstPartyBuiltInModelTool} from '../../src/plugins/policy/tool-policy.ts';
import {createFirstPartyModelToolsPlugin} from '../../src/plugins/builtin/model-tools/index.ts';
import {createRuntimePluginProvidedTool} from '../../src/plugins/api/index.ts';
import {
  isApprovalGatedRuntimePluginTool,
  isModelFacingRuntimePluginTool,
} from '../../src/plugins/api/tool-classification.ts';

describe('runtime plugin source references', () => {
  it('bounds every public context, evidence, and health string as one result', () => {
    const exact = 'x'.repeat(16 * 1_024);
    const over = `${exact}x`;
    const context = (sourceReferences: readonly unknown[]) => ({
      pluginId: 'memory.boundary.fixture',
      id: 'bounded-context',
      kind: 'memory',
      text: 'safe',
      budget: {estimatedTokens: 1, priority: 1},
      sourceReferences,
      redactionLabels: [],
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
      redactionLabels: [],
    });
    const health = (summary: string) => ({
      pluginId: 'memory.boundary.fixture',
      status: 'ok',
      checkedAt: '2026-07-11T00:00:00.000Z',
      summary,
      redactionLabels: [],
    });

    expect(
      createRuntimePluginContextItem(
        context([{kind: 'memory', id: 'source', title: exact}]),
      ).sourceReferences[0]?.title,
    ).toBe(exact);
    expect(() =>
      createRuntimePluginContextItem(
        context([{kind: 'memory', id: 'source', title: over}]),
      ),
    ).toThrow('exceeds the JSON string byte limit.');
    expect(
      validateRuntimePluginContextItem(
        context([{kind: 'memory', id: 'source', title: over}]),
      ),
    ).toMatchObject({
      status: 'rejected',
      reason: 'malformed_context_item',
    });
    expect(
      createRuntimePluginEvidenceSnapshot(
        evidence([{kind: 'memory', id: exact}]),
      ).sourceReferences?.[0]?.id,
    ).toBe(exact);
    expect(() =>
      createRuntimePluginEvidenceSnapshot(
        evidence([{kind: 'memory', id: over}]),
      ),
    ).toThrow('exceeds the JSON string byte limit.');
    expect(createRuntimePluginHealthSnapshot(health(exact)).summary).toBe(
      exact,
    );
    expect(() => createRuntimePluginHealthSnapshot(health(over))).toThrow(
      'exceeds the JSON string byte limit.',
    );
    expect(() =>
      createRuntimePluginContextItem(
        context(
          Array.from({length: 32}, (_value, index) => ({
            kind: 'memory',
            id: `${String(index)}-${'x'.repeat(2_200)}`,
          })),
        ),
      ),
    ).toThrow('exceeds the aggregate JSON text limit.');
  }, 20_000);

  it('enforces tool-result evidence and aggregate limits at the public constructor', () => {
    const evidence = (count: number, summary = 'accepted') =>
      Array.from({length: count}, (_value, index) => ({
        eventId: 'evt_bounded_tool_snapshot',
        traceId: 'trace_bounded_tool_snapshot',
        createdAt: '2026-07-11T00:00:00.000Z',
        kind: 'runtime_plugin_evidence_snapshot' as const,
        pluginId: 'memory.boundary.fixture',
        evidenceKind: 'tool_invocation' as const,
        status: 'accepted' as const,
        summary: `${summary}${String(index)}`,
        redactionLabels: [],
      }));
    const invocation = (resultEvidence: readonly unknown[]) => ({
      eventId: 'evt_bounded_tool_snapshot',
      traceId: 'trace_bounded_tool_snapshot',
      createdAt: '2026-07-11T00:00:00.000Z',
      kind: 'runtime_plugin_tool_invocation_snapshot' as const,
      pluginId: 'memory.boundary.fixture',
      toolName: 'memory.search',
      input: {query: 'Mira'},
      result: {
        status: 'accepted' as const,
        output: {matched: true},
        evidence: resultEvidence,
      },
    });

    expect(
      createRuntimePluginToolInvocationSnapshot(invocation(evidence(64))).result
        .evidence,
    ).toHaveLength(64);
    expect(() =>
      createRuntimePluginToolInvocationSnapshot(invocation(evidence(65))),
    ).toThrow('Plugin tool result evidence exceeds the 64-record limit.');
    expect(() =>
      createRuntimePluginToolInvocationSnapshot(
        invocation(evidence(5, 'x'.repeat(14 * 1_024))),
      ),
    ).toThrow('Plugin tool result exceeds the aggregate JSON text limit.');
  });

  it('enforces source-reference and context-text byte limits exactly', () => {
    const references = Array.from({length: 32}, (_value, index) => ({
      kind: 'memory' as const,
      id: `source-${String(index)}`,
    }));
    const exactText = '界'.repeat(Math.floor((16 * 1_024) / 3));
    const base = {
      pluginId: 'memory.boundary.fixture',
      id: 'bounded-context',
      kind: 'memory',
      budget: {estimatedTokens: 1, priority: 1},
      redactionLabels: [],
    } as const;

    expect(
      createRuntimePluginContextItem({
        ...base,
        text: exactText,
        sourceReferences: references,
      }).sourceReferences,
    ).toHaveLength(32);
    expect(() =>
      createRuntimePluginContextItem({
        ...base,
        text: `${exactText}界`,
        sourceReferences: references,
      }),
    ).toThrow('Plugin context item.text exceeds the JSON string byte limit.');
    expect(() =>
      createRuntimePluginContextItem({
        ...base,
        text: 'safe',
        sourceReferences: [
          ...references,
          {kind: 'memory' as const, id: 'source-over-limit'},
        ],
      }),
    ).toThrow('Plugin sourceReferences exceed the 32-record limit.');
  });

  it('accepts external source reference IDs that are not plugin identifiers', () => {
    const references = [
      {
        kind: 'memory',
        id: '1234567890',
        title: 'numeric database key',
      },
      {
        kind: 'resource',
        id: '1f4e2d3c-9a8b-4c7d-8123-abcdefabcdef',
        title: 'UUID beginning with a digit',
      },
      {
        kind: 'resource',
        id: 'resources/users/42/profile.json',
        title: 'path-like resource ID',
      },
    ] as const;

    const contextItem = createRuntimePluginContextItem({
      pluginId: 'memory.external_source.fixture',
      id: 'memory-context',
      kind: 'memory',
      text: 'Retrieved memory context.',
      budget: {
        estimatedTokens: 8,
        priority: 1,
      },
      sourceReferences: references,
      redactionLabels: [],
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
      redactionLabels: [],
    });

    const expectedIds = [
      '1234567890',
      '1f4e2d3c-9a8b-4c7d-8123-abcdefabcdef',
      'resources/users/42/profile.json',
    ];

    expect(contextItem.sourceReferences.map(reference => reference.id)).toEqual(
      expectedIds,
    );
    expect(evidence.sourceReferences?.map(reference => reference.id)).toEqual(
      expectedIds,
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
            priority: 1,
          },
          sourceReferences: [
            {
              kind: 'memory',
              id,
            },
          ],
          redactionLabels: [],
        }),
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
              id,
            },
          ],
          redactionLabels: [],
        }),
      ).toThrow('Plugin field "id" must be a non-empty string.');
    }
  });
});

describe('runtime plugin access control', () => {
  it('defaults absent requestedAccess to an empty permission object', () => {
    const manifest = createRuntimePluginManifest(
      runtimePluginManifestFixture(),
    );

    expect(manifest.requestedAccess).toEqual({});
    expect(runtimePluginAccessFor(manifest.requestedAccess, 'file_store')).toBe(
      'none',
    );
  });

  it('accepts requestedAccess permission objects', () => {
    expect(
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          requestedAccess: {},
        }),
      ).requestedAccess,
    ).toEqual({});
    expect(
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          requestedAccess: {file_store: 'read'},
        }),
      ).requestedAccess,
    ).toEqual({file_store: 'read'});
    expect(
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          requestedAccess: {
            file_store: 'write',
            turn_context: 'read',
            model_input: 'write',
          },
        }),
      ).requestedAccess,
    ).toEqual({
      file_store: 'write',
      turn_context: 'read',
      model_input: 'write',
    });
  });

  it('rejects legacy arrays and malformed requestedAccess values', () => {
    for (const requestedAccess of [
      [],
      ['file_store'],
      {unknown_access: 'read'},
      {file_store: 'admin'},
      null,
      'file_store',
      true,
      1,
    ]) {
      expect(() =>
        createRuntimePluginManifest(
          runtimePluginManifestFixture({
            requestedAccess,
          }),
        ),
      ).toThrow(/requestedAccess/u);
    }
  });

  it('ignores inherited access values', () => {
    const inheritedPermissions = Object.create({
      file_store: 'write',
    }) as RuntimePluginAccessMap;

    expect(Object.keys(inheritedPermissions)).toEqual([]);
    expect(runtimePluginAccessFor(inheritedPermissions, 'file_store')).toBe(
      'none',
    );
    expect(normalizeRuntimePluginAccessMap(inheritedPermissions)).toEqual({});
  });

  it('orders access levels for allow checks', () => {
    expect(runtimePluginAccessAllows('write', 'read')).toBe(true);
    expect(runtimePluginAccessAllows('read', 'write')).toBe(false);
    expect(runtimePluginAccessAllows('read', 'none')).toBe(true);
  });
});

describe('runtime plugin model-facing tool policy', () => {
  it.each([
    ['sideEffectLevel', 'external_write'],
    ['requiredForUserTurn', false],
    ['callLimit', {scope: 'user_turn', maxCalls: 1}],
  ])('refuses a tool still declaring retired field %s', (field, value) => {
    // Ignoring the field would hand the model a tool its author withheld.
    expect(() =>
      createRuntimePluginProvidedTool(
        runtimePluginProvidedToolFixture({[field]: value}),
      ),
    ).toThrow(`declares retired field "${field}"`);
  });

  it('rejects unsupported root JSON Schema keywords with their field path', () => {
    expect(() =>
      createRuntimePluginProvidedToolWithJsonSchema({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
        oneOf: [],
      }),
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
                minLength: 1,
              },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        required: ['profile'],
        additionalProperties: false,
      }),
    ).toThrow(
      'Model tool inputContract.jsonSchema.properties.profile.properties.name.minLength is not supported.',
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
              pattern: '^[a-z]+$',
            },
          },
        },
        required: ['aliases'],
        additionalProperties: false,
      }),
    ).toThrow(
      'Model tool inputContract.jsonSchema.properties.aliases.items.pattern is not supported.',
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
          enum: ['remember', 'forget'],
        },
        entries: {
          type: ['array', 'null'],
          items: {
            type: ['object', 'null'],
            properties: {
              text: {
                type: 'string',
              },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
      required: ['note'],
      additionalProperties: false,
    };

    const tool = createRuntimePluginProvidedToolWithJsonSchema(jsonSchema);

    expect(tool.inputContract.jsonSchema).toEqual(jsonSchema);
  });

  it('preserves an explicitly declared __proto__ property as data', () => {
    const jsonSchema = {
      type: 'object',
      properties: Object.fromEntries([['__proto__', {type: 'string'}]]),
      required: ['__proto__'],
      additionalProperties: false,
    };
    const schema =
      createRuntimePluginProvidedToolWithJsonSchema(jsonSchema).inputContract
        .jsonSchema;

    expect(schema?.properties === undefined).toBe(false);
    expect(Object.hasOwn(schema?.properties ?? {}, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(schema?.properties ?? {})).toBe(
      Object.prototype,
    );
  });

  it.each([
    [
      'duplicate required names',
      {
        type: 'object',
        properties: {note: {type: 'string'}},
        required: ['note', 'note'],
        additionalProperties: false,
      },
      'jsonSchema.required must not contain duplicates',
    ],
    [
      'required names absent from properties',
      {
        type: 'object',
        properties: {note: {type: 'string'}},
        required: ['missing'],
        additionalProperties: false,
      },
      'jsonSchema.required includes "missing" outside properties',
    ],
    [
      'required names inherited from Object.prototype',
      {
        type: 'object',
        properties: {},
        required: ['toString'],
        additionalProperties: false,
      },
      'jsonSchema.required includes "toString" outside properties',
    ],
    [
      'duplicate union types',
      {
        type: 'object',
        properties: {note: {type: ['string', 'string']}},
        required: ['note'],
        additionalProperties: false,
      },
      'jsonSchema.properties.note.type must not contain duplicates',
    ],
    [
      'object keywords on non-object types',
      {
        type: 'object',
        properties: {
          note: {type: 'string', properties: {}},
        },
        required: ['note'],
        additionalProperties: false,
      },
      'jsonSchema.properties.note uses object keywords without object type',
    ],
  ])('rejects %s recursively', (_case, schema, message) => {
    expect(() => createRuntimePluginProvidedToolWithJsonSchema(schema)).toThrow(
      message,
    );
  });

  it('rejects model-facing tools without requestedAccess.model_input write', () => {
    expect(() =>
      createRuntimePlugin({
        manifest: runtimePluginManifestFixture({
          declaredPlugins: ['tool_provider', 'handle_tool_call'],
          requestedAccess: {},
        }),
        providedTools: [runtimePluginProvidedToolFixture()],
        lifecycleHooks: {
          handleToolCall() {
            return {
              status: 'accepted',
              output: {},
              evidence: [],
            };
          },
        },
      }),
    ).toThrow(
      'Model-facing tools require requestedAccess.model_input = "write".',
    );
  });

  it('accepts model-facing tools with requestedAccess.model_input write', () => {
    const plugin = createRuntimePlugin({
      manifest: runtimePluginManifestFixture({
        declaredPlugins: ['tool_provider', 'handle_tool_call'],
        requestedAccess: {model_input: 'write'},
      }),
      providedTools: [runtimePluginProvidedToolFixture()],
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

    expect(plugin.providedTools).toHaveLength(1);
  });

  it('offers a confirm-gated tool to the model instead of hiding it', () => {
    const manifest = createRuntimePluginManifest(
      runtimePluginManifestFixture({}),
    );
    const tool = createRuntimePluginProvidedTool(
      runtimePluginProvidedToolFixture({
        name: 'settings.arbitrary.update',
        requiresConfirmation: true,
      }),
    );

    // Enabling the plugin is the trust decision. A tool that prepares an
    // effect for approval says so and is prompted, rather than being kept
    // away from the model by its declared class.
    expect(isApprovalGatedRuntimePluginTool({manifest, tool})).toBe(true);
    expect(isModelFacingRuntimePluginTool({manifest, tool})).toBe(true);
  });

  it('requires model_input write for a plugin that provides model tools', () => {
    // Every host-validated tool reaches the model now, so a plugin that
    // provides one must declare the access that implies. The old
    // "non-model-facing tool" carve-out was defined by the retired
    // effect-level enum and no longer exists.
    expect(() =>
      createRuntimePlugin({
        manifest: runtimePluginManifestFixture({
          declaredPlugins: ['tool_provider', 'handle_tool_call'],
          requestedAccess: {},
        }),
        providedTools: [runtimePluginProvidedToolFixture({})],
        lifecycleHooks: {
          handleToolCall() {
            return {
              status: 'accepted',
              output: {},
              evidence: [],
            };
          },
        },
      }),
    ).toThrow('model_input');
  });

  it('requires shutdown hooks to declare the shutdown lifecycle', () => {
    expect(() =>
      createRuntimePlugin({
        manifest: runtimePluginManifestFixture(),
        lifecycleHooks: {
          onShutdown() {
            return {status: 'completed', evidence: []};
          },
        },
      }),
    ).toThrow('onShutdown hooks must declare on_shutdown.');
  });

  it('recognizes first-party built-in model tools only from the real host-owned instance', () => {
    const firstPartyPlugin = createFirstPartyModelToolsPlugin();
    const firstPartyTool = firstPartyPlugin.providedTools[0];
    const copiedPlugin = createRuntimePlugin({
      manifest: firstPartyPlugin.manifest,
      providedTools: firstPartyPlugin.providedTools,
      lifecycleHooks: firstPartyPlugin.lifecycleHooks,
    });

    if (firstPartyTool === undefined) {
      throw new Error(
        'Expected first-party model tools plugin to provide a tool.',
      );
    }

    expect(
      isFirstPartyBuiltInModelTool({
        plugin: firstPartyPlugin,
        tool: firstPartyTool,
        isHostOwnedFirstPartyModelToolsPlugin: plugin =>
          plugin === firstPartyPlugin,
      }),
    ).toBe(true);
    expect(
      isFirstPartyBuiltInModelTool({
        plugin: copiedPlugin,
        tool: firstPartyTool,
        isHostOwnedFirstPartyModelToolsPlugin: plugin =>
          plugin === firstPartyPlugin,
      }),
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
          sourceSystem: 'test',
        },
        declaredPlugins: ['plugin_discovery'],
        config: {
          scope: 'global_with_character_overrides',
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
              configFingerprint: 'declared-backend-v1',
            },
            {
              name: 'apiKey',
              description: 'API key.',
              required: false,
              secret: true,
              valueType: 'secret',
              envVar: 'MEMORY_API_KEY',
              redactionLabels: ['secret'],
            },
          ],
          fingerprint: 'declared-config-v1',
        },
        firstParty: false,
        runtimePolicy: {
          timeoutMs: 1000,
          redactionLabels: [],
          failureBehavior: {
            beforeRoleModelCall: 'degrade',
            handleToolCall: 'degrade',
            health: 'degrade',
          },
        },
        activation: {
          defaultEnabled: false,
          reasons: ['test'],
        },
        requestedAccess: {},
      },
    });

    expect(plugin.manifest.config.fields[0]).toMatchObject({
      name: 'backend',
      valueType: 'enum',
      allowedValues: ['local', 'cloud'],
      agentMutable: true,
      reloadRequired: true,
      configFingerprint: 'declared-backend-v1',
    });
    expect(JSON.stringify(plugin.manifest)).not.toContain('resolvedConfig');
    expect(JSON.stringify(plugin.manifest)).not.toContain('MEMORY_API_KEY=');
  });

  it('rejects manifest metadata that makes a secret field agent-mutable', () => {
    expect(() =>
      createRuntimePluginManifest(
        runtimePluginManifestFixture({
          config: {
            scope: 'global_with_character_overrides',
            fields: [
              {
                name: 'apiKey',
                description: 'API key.',
                required: false,
                secret: true,
                valueType: 'secret',
                agentMutable: true,
                redactionLabels: ['secret'],
              },
            ],
          },
        }),
      ),
    ).toThrow('Secret plugin config fields cannot allow agent mutation.');
  });
});

function runtimePluginManifestFixture(
  overrides: Readonly<Record<string, unknown>> = {},
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
      sourceSystem: 'test',
    },
    declaredPlugins: ['plugin_discovery'],
    config: {
      scope: 'global_with_character_overrides',
      fields: [],
    },
    firstParty: false,
    runtimePolicy: {
      timeoutMs: 1000,
      redactionLabels: [],
      failureBehavior: {
        beforeRoleModelCall: 'degrade',
        handleToolCall: 'degrade',
        health: 'degrade',
      },
    },
    activation: {
      defaultEnabled: false,
      reasons: ['test'],
    },
    ...overrides,
  });
}

function createRuntimePluginProvidedToolWithJsonSchema(jsonSchema: unknown) {
  return createRuntimePluginProvidedTool(
    runtimePluginProvidedToolFixture({
      inputContract: {
        type: 'object',
        fields: [],
        additionalFields: false,
        jsonSchema,
      },
    }),
  );
}

function runtimePluginProvidedToolFixture(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: 'memory.search',
    description: 'Search memory.',
    inputContract: {
      type: 'object',
      fields: [],
      additionalFields: false,
    },
    validationOwner: 'plugin_host',
    requiresConfirmation: false,
    ...overrides,
  });
}
