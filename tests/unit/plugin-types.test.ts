import {describe, expect, it} from 'vitest';

import {
  createRuntimePlugin,
  createRuntimePluginManifest,
  createRuntimePluginContextItem,
  createRuntimePluginCuratedContextSection,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  createRuntimePluginToolInvocationSnapshot,
  curatedContextSectionTextCharLimit,
  runtimePluginContractVersion,
  validateRuntimePluginContextItem,
  type RuntimePluginAccessMap,
} from '../../src/plugins/api/index.ts';
import {
  normalizeRuntimePluginAccessMap,
  runtimePluginAccessAllows,
  runtimePluginAccessFor,
  runtimePluginAccessSnapshot,
} from '../../src/plugins/policy/access-control.ts';
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

  it('withholds trusted_context from ineligible plugins while keeping the request truthful', () => {
    const requestedAccess = {
      trusted_context: 'write',
      model_input: 'write',
    } satisfies RuntimePluginAccessMap;
    const ineligible = runtimePluginAccessSnapshot({
      requestedAccess,
      enabled: true,
    });
    const eligible = runtimePluginAccessSnapshot({
      requestedAccess,
      enabled: true,
      trustedContextEligible: true,
    });

    expect(ineligible.requestedAccess).toEqual(requestedAccess);
    expect(ineligible.grantedAccess).toEqual({model_input: 'write'});
    expect(eligible.grantedAccess).toEqual(requestedAccess);
  });
});

describe('runtime plugin curated context sections', () => {
  it('accepts a section and normalizes carriage returns to newlines', () => {
    const section = createRuntimePluginCuratedContextSection({
      pluginId: 'memory.fixture',
      id: 'notes',
      title: 'Character notes',
      text: 'line one\r\nline two\rline three',
      capChars: 2200,
      usedChars: 40,
    });

    expect(section).toEqual({
      pluginId: 'memory.fixture',
      id: 'notes',
      title: 'Character notes',
      text: 'line one\nline two\nline three',
      capChars: 2200,
      usedChars: 40,
    });
  });

  it.each([
    ['not-an-object', 'must be an object'],
    [
      {
        pluginId: 'memory.fixture',
        id: 'notes',
        title: 'multi\nline',
        text: 'x',
      },
      'single line',
    ],
    [
      {
        pluginId: 'memory.fixture',
        id: 'notes',
        title: `t${'x'.repeat(64)}`,
        text: 'x',
      },
      'single line',
    ],
    [
      {
        pluginId: 'memory.fixture',
        id: 'notes',
        title: 'Notes',
        text: 'null byte \u0000 stays out',
      },
      'control characters',
    ],
    [
      {
        pluginId: 'memory.fixture',
        id: 'notes',
        title: 'Notes',
        text: 'next line \u0085 stays out',
      },
      'control characters',
    ],
    [
      {
        pluginId: 'memory.fixture',
        id: 'notes',
        title: 'Notes',
        text: 'line separator \u2028 stays out',
      },
      'control characters',
    ],
    [
      {
        pluginId: 'memory.fixture',
        id: 'notes',
        title: 'Notes',
        text: 'paragraph separator \u2029 stays out',
      },
      'control characters',
    ],
    [
      {
        pluginId: 'memory.fixture',
        id: 'notes',
        title: 'Title with \u2028 separator',
        text: 'x',
      },
      'single line',
    ],
    [
      {
        pluginId: 'memory.fixture',
        id: 'notes',
        title: 'Notes',
        text: 'x'.repeat(curatedContextSectionTextCharLimit + 1),
      },
      'character limit',
    ],
    [
      {
        pluginId: 'memory.fixture',
        id: 'notes',
        title: 'Notes',
        text: 'x',
        capChars: 0,
      },
      'positive integer',
    ],
  ])('rejects malformed section %#', (value, messagePart) => {
    expect(() => createRuntimePluginCuratedContextSection(value)).toThrow(
      new RegExp(messagePart, 'u'),
    );
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

  it('accepts the JSON Schema vocabulary the old field walker refused', () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        name: {type: 'string', minLength: 1, pattern: '^[a-z]+$'},
        count: {type: 'integer', minimum: 0},
        pick: {oneOf: [{type: 'string'}, {type: 'number'}]},
        tree: {$ref: '#/$defs/node'},
      },
      allOf: [{type: 'object', required: ['name']}],
      additionalProperties: false,
      $defs: {
        node: {
          type: 'object',
          properties: {
            value: {type: 'string'},
            children: {type: 'array', items: {$ref: '#/$defs/node'}},
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
    };

    const tool = createRuntimePluginProvidedToolWithJsonSchema(jsonSchema);

    expect(tool.inputContract).toEqual(jsonSchema);
  });

  it('constructs a tool with an $id-carrying contract repeatedly', () => {
    // The storage codec re-derives the tool for every decoded record, so one
    // schema must never register globally or collide with itself.
    const jsonSchema = {
      $id: 'https://project02.test/schemas/memory-search.json',
      type: 'object',
      properties: {query: {type: 'string'}},
      required: ['query'],
      additionalProperties: false,
    };

    const first = createRuntimePluginProvidedToolWithJsonSchema(jsonSchema);
    const second = createRuntimePluginProvidedToolWithJsonSchema(jsonSchema);

    expect(first.inputContract).toEqual(jsonSchema);
    expect(second.inputContract).toEqual(jsonSchema);
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

    expect(tool.inputContract).toEqual(jsonSchema);
  });

  it('preserves an explicitly declared __proto__ property as data', () => {
    const jsonSchema = {
      type: 'object',
      properties: Object.fromEntries([['__proto__', {type: 'string'}]]),
      required: ['__proto__'],
      additionalProperties: false,
    };
    const schema =
      createRuntimePluginProvidedToolWithJsonSchema(jsonSchema).inputContract;
    const properties = schema.properties ?? {};

    expect(Object.hasOwn(properties, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
  });

  it.each([
    [
      'a misspelled keyword',
      {
        type: 'object',
        properties: {note: {type: 'string'}},
        requred: ['note'],
        additionalProperties: false,
      },
      'unknown keyword: "requred"',
    ],
    [
      'a duplicate required name',
      {
        type: 'object',
        properties: {note: {type: 'string'}},
        required: ['note', 'note'],
        additionalProperties: false,
      },
      'must NOT have duplicate items',
    ],
    [
      'a duplicate union type',
      {
        type: 'object',
        properties: {note: {type: ['string', 'string']}},
        required: ['note'],
        additionalProperties: false,
      },
      'schema is invalid',
    ],
    [
      'object keywords on a non-object type',
      {
        type: 'object',
        properties: {
          note: {type: 'string', properties: {}},
        },
        required: ['note'],
        additionalProperties: false,
      },
      'missing type "object" for keyword "properties"',
    ],
    [
      'an asynchronous schema',
      {
        $async: true,
        type: 'object',
        properties: {note: {type: 'string'}},
        required: ['note'],
        additionalProperties: false,
      },
      'asynchronous schemas ($async) cannot gate tool dispatch',
    ],
    [
      'a format constraint no registry enforces',
      {
        type: 'object',
        properties: {email: {type: 'string', format: 'email'}},
        required: ['email'],
        additionalProperties: false,
      },
      'unknown format "email"',
    ],
    [
      'a registry identity the self-contained contract cannot resolve',
      {
        $id: 'https://example.test/tree',
        type: 'object',
        properties: {next: {$ref: 'https://example.test/tree'}},
        additionalProperties: false,
      },
      "can't resolve reference",
    ],
  ])(
    'rejects %s as invalid JSON Schema with the compile reason',
    (_case, schema, message) => {
      expect(() =>
        createRuntimePluginProvidedToolWithJsonSchema(schema),
      ).toThrow(message);
      expect(() =>
        createRuntimePluginProvidedToolWithJsonSchema(schema),
      ).toThrow('is not valid JSON Schema');
    },
  );

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
    const tool = createRuntimePluginProvidedTool(
      runtimePluginProvidedToolFixture({
        name: 'settings.arbitrary.update',
        requiresConfirmation: true,
      }),
    );

    // Enabling the plugin is the trust decision; a declared class withholds
    // nothing from the model.
    expect(isApprovalGatedRuntimePluginTool(tool)).toBe(true);
    expect(isModelFacingRuntimePluginTool(tool)).toBe(true);
  });

  it('requires model_input write for a plugin that provides model tools', () => {
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
            },
            {
              name: 'apiKey',
              description: 'API key.',
              required: false,
              secret: true,
              valueType: 'secret',
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
    runtimePluginProvidedToolFixture({inputContract: jsonSchema}),
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
      properties: {},
      required: [],
      additionalProperties: false,
    },
    validationOwner: 'plugin_host',
    requiresConfirmation: false,
    ...overrides,
  });
}
