import {
  runtimePluginContractVersion,
  createRuntimePlugin,
  createRuntimePluginContextItem,
  createRuntimePluginEvidenceSnapshot,
  createRuntimePluginHealthSnapshot,
  type RuntimePlugin,
  type RuntimePluginAccessMap,
  type RuntimePluginConfigField,
  type RuntimePluginContextItem,
  type RuntimePluginDeclaration,
  type RuntimePluginEvidenceKind,
  type RuntimePluginEvidenceSnapshot,
  type RuntimePluginEvidenceStatus,
  type RuntimePluginHealthSnapshot,
  type RuntimePluginHookResult,
  type RuntimePluginJsonObject,
  type RuntimePluginJsonValue,
  type RuntimePluginManifest,
  type RuntimePluginProvidedTool,
  type RuntimePluginRuntimePolicy,
  type RuntimePluginSourceReference,
  type RuntimePluginToolCall,
  type RuntimePluginToolCallResult,
  type RuntimePluginToolValidationOwner,
  type RuntimePluginContext,
  requiredModelToolInputContract,
} from '../../../src/plugins/api/index.ts';
import {createFirstPartyModelToolsPlugin} from '../../../src/plugins/builtin/model-tools/index.ts';
import {type ModelToolInputContract} from '../../../src/role-model/index.ts';
import {isModelFacingRuntimePluginTool} from '../../../src/plugins/api/tool-classification.ts';

type JsonRecord = Readonly<Record<string, unknown>>;

export type RuntimePluginAdapterCompatibilityDisposition =
  'mapped' | 'ignored_with_evidence' | 'future_extension';

export type RuntimePluginAdapterCompatibilityNote = {
  readonly sourceSystem: string;
  readonly fieldPath: string;
  readonly disposition: RuntimePluginAdapterCompatibilityDisposition;
  readonly evidence: string;
};

export type RuntimePluginAdapterMapping = {
  readonly plugin: RuntimePlugin;
  readonly compatibilityNotes: readonly RuntimePluginAdapterCompatibilityNote[];
};

export function mapOpenClawMemoryPluginFixture(
  value: unknown,
): RuntimePluginAdapterMapping {
  const fixture = requiredRecord(value, 'OpenClaw fixture');
  const contracts = requiredRecord(fixture['contracts'], 'contracts');
  const toolNames = requiredStringArray(contracts['tools'], 'contracts.tools');
  const configSchema = requiredRecord(fixture['configSchema'], 'configSchema');
  const toolMetadata = optionalRecord(fixture['toolMetadata'], 'toolMetadata');
  const packageMetadata = optionalRecord(fixture['package'], 'package');
  const packageOpenClaw = optionalNestedRecord(
    packageMetadata,
    'openclaw',
    'package.openclaw',
  );
  const packageCompat = optionalNestedRecord(
    packageOpenClaw,
    'compat',
    'package.openclaw.compat',
  );
  const activation = requiredRecord(fixture['activation'], 'activation');
  const manifestId = 'openclaw.memory_core.fixture';
  const providedTools = toolNames.map(toolName =>
    createProvidedToolFromSchema({
      name: toolName,
      description: toolDescriptionFromMetadata(toolMetadata, toolName),
      inputContract: inputContractFromSchema(
        toolInputSchemaFromMetadata(toolMetadata, toolName),
      ),
      validationOwner: 'adapter',
    }),
  );
  const notes = [
    createCompatibilityNote({
      sourceSystem: 'openclaw',
      fieldPath: 'contracts.tools',
      disposition: 'mapped',
      evidence:
        'OpenClaw declared tool names were normalized into local providedTools.',
    }),
    createCompatibilityNote({
      sourceSystem: 'openclaw',
      fieldPath: 'configSchema.properties',
      disposition: 'mapped',
      evidence:
        'OpenClaw JSON-schema-like config fields were normalized into local config metadata.',
    }),
    ...unsupportedNotesFromFixture(fixture, 'openclaw'),
  ];
  const manifest = createOpenClawManifest({
    fixture,
    manifestId,
    providedTools,
    configFields: configFieldsFromSchema(configSchema),
    activationReasons: activationReasonsFromOpenClawActivation(activation),
    sourceVersion:
      optionalString(
        packageCompat?.['pluginApi'],
        'package.openclaw.compat.pluginApi',
      ) ??
      optionalString(fixture['version'], 'version') ??
      'fixture',
    compatibilityNotes: notes,
  });
  const plugin = createRuntimePlugin({
    manifest,
    providedTools,
    lifecycleHooks: {
      handleToolCall(call, context) {
        return createAcceptedToolCallResult({
          pluginId: manifestId,
          call,
          context,
          output: {
            source: 'openclaw.fixture',
            toolName: call.toolName,
            declaredBy: 'contracts.tools',
          },
          summary: `Mapped OpenClaw tool ${call.toolName} through fixture adapter.`,
          sourceReferences: [
            createToolContractSourceReference({
              pluginId: manifestId,
              toolName: call.toolName,
              title: `OpenClaw contracts.tools entry ${call.toolName}`,
              uri: `fixture://openclaw/tools/${sourceReferenceIdSegment(
                call.toolName,
              )}`,
            }),
          ],
        });
      },
      health(context) {
        return createRuntimePluginHealthSnapshot({
          pluginId: manifestId,
          status: 'ok',
          checkedAt: context.timestamp,
          summary:
            'OpenClaw fixture is static; no universal upstream health field was executed.',
          redactionLabels: [],
        });
      },
    },
  });

  return freezeMapping({plugin, compatibilityNotes: notes});
}

export function mapTencentDbMemoryGatewayFixture(
  value: unknown,
): RuntimePluginAdapterMapping {
  const fixture = requiredRecord(value, 'TencentDB gateway fixture');
  const endpoints = requiredRecord(fixture['endpoints'], 'endpoints');
  const recall = requiredEndpoint(endpoints, 'recall');
  const capture = requiredEndpoint(endpoints, 'capture');
  const searchMemories = requiredEndpoint(endpoints, 'searchMemories');
  const searchConversations = requiredEndpoint(
    endpoints,
    'searchConversations',
  );
  const sessionEnd = requiredEndpoint(endpoints, 'sessionEnd');
  const health = requiredEndpoint(endpoints, 'health');
  const config = requiredRecord(fixture['config'], 'config');
  const manifestId = 'memory_tencentdb.gateway.fixture';
  const providedTools = [
    createProvidedToolFromSchema({
      name: 'memory_tencentdb.memory_search',
      description: 'Search TencentDB memory records from the fixture gateway.',
      inputContract: inputContractFromSchema(searchMemories.requestSchema),
      validationOwner: 'adapter',
      maxCalls: 2,
    }),
    createProvidedToolFromSchema({
      name: 'memory_tencentdb.conversation_search',
      description:
        'Search TencentDB conversation records from the fixture gateway.',
      inputContract: inputContractFromSchema(searchConversations.requestSchema),
      validationOwner: 'adapter',
      maxCalls: 2,
    }),
  ];
  const notes = [
    createCompatibilityNote({
      sourceSystem: 'TencentDB-Agent-Memory',
      fieldPath: 'endpoints.recall',
      disposition: 'mapped',
      evidence: 'POST /recall fixture response maps to beforeRoleModelCall.',
    }),
    createCompatibilityNote({
      sourceSystem: 'TencentDB-Agent-Memory',
      fieldPath: 'endpoints.capture',
      disposition: 'mapped',
      evidence: 'POST /capture fixture response maps to afterTurnCommitted.',
    }),
    createCompatibilityNote({
      sourceSystem: 'TencentDB-Agent-Memory',
      fieldPath: 'endpoints.sessionEnd',
      disposition: 'mapped',
      evidence: 'POST /session/end fixture response maps to onSessionEnd.',
    }),
    ...unsupportedNotesFromFixture(fixture, 'TencentDB-Agent-Memory'),
  ];
  const manifest = createMemoryGatewayManifest({
    id: manifestId,
    displayName: 'TencentDB Agent Memory gateway fixture',
    sourceSystem: 'TencentDB-Agent-Memory',
    sourceVersion: optionalString(fixture['version'], 'version') ?? 'fixture',
    externalContract: 'tdai-gateway-http',
    description:
      'Fixture adapter for TencentDB-Agent-Memory gateway recall, capture, search, session, and health contracts.',
    providedTools,
    configFields: configFieldsFromConfigRecord(config),
    configFingerprint: 'fixture-redacted-tdai-gateway',
    compatibilityNotes: notes,
  });
  const plugin = createRuntimePlugin({
    manifest,
    providedTools,
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        const confidence = optionalNumber(
          recall.response['confidence'],
          'endpoints.recall.response.confidence',
        );
        const contextItem = createMemoryContextItem({
          pluginId: manifestId,
          id: 'tdai.recall.fixture',
          text: requiredString(
            recall.response['context'],
            'endpoints.recall.response.context',
          ),
          sourceId: 'tdai.recall.fixture',
          sourceTitle: 'TencentDB /recall fixture',
          sourceUri: 'fixture://tencentdb/recall',
          estimatedTokens:
            optionalPositiveInteger(
              recall.response['estimatedTokens'],
              'endpoints.recall.response.estimatedTokens',
            ) ?? 64,
          ...(confidence === undefined ? {} : {confidence}),
        });

        return Object.freeze({
          contextItems: Object.freeze([contextItem]),
          evidence: Object.freeze([
            createEvidence({
              pluginId: manifestId,
              context,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Mapped TencentDB /recall fixture into memory context.',
              sourceReferences: contextItem.sourceReferences,
              ...(manifest.config.fingerprint === undefined
                ? {}
                : {configFingerprint: manifest.config.fingerprint}),
            }),
          ]),
        });
      },
      handleToolCall(call, context) {
        if (call.toolName === 'memory_tencentdb.memory_search') {
          return createAcceptedToolCallResult({
            pluginId: manifestId,
            call,
            context,
            output: endpointToolOutput(searchMemories),
            summary: 'Mapped TencentDB /search/memories fixture response.',
            sourceReferences: [
              createEndpointSourceReference({
                pluginId: manifestId,
                endpointName: 'searchMemories',
                endpoint: searchMemories,
                titlePrefix: 'TencentDB gateway fixture',
                uriBase: 'fixture://tencentdb',
              }),
            ],
          });
        }

        if (call.toolName === 'memory_tencentdb.conversation_search') {
          return createAcceptedToolCallResult({
            pluginId: manifestId,
            call,
            context,
            output: endpointToolOutput(searchConversations),
            summary: 'Mapped TencentDB /search/conversations fixture response.',
            sourceReferences: [
              createEndpointSourceReference({
                pluginId: manifestId,
                endpointName: 'searchConversations',
                endpoint: searchConversations,
                titlePrefix: 'TencentDB gateway fixture',
                uriBase: 'fixture://tencentdb',
              }),
            ],
          });
        }

        return createRejectedToolCallResult({
          pluginId: manifestId,
          call,
          context,
          reason: 'unsupported_fixture_tool',
          message: `TencentDB fixture does not map tool ${call.toolName}.`,
        });
      },
      afterTurnCommitted(context) {
        return createCompletedHookResult({
          pluginId: manifestId,
          context,
          evidenceKind: 'after_turn_committed',
          summary: `Mapped TencentDB /capture response: ${JSON.stringify(
            endpointToolOutput(capture),
          )}.`,
        });
      },
      onSessionEnd(context) {
        return createCompletedHookResult({
          pluginId: manifestId,
          context,
          evidenceKind: 'session_end',
          summary: `Mapped TencentDB /session/end response: ${JSON.stringify(
            endpointToolOutput(sessionEnd),
          )}.`,
        });
      },
      health(context) {
        return healthSnapshotFromEndpoint({
          pluginId: manifestId,
          context,
          endpoint: health,
        });
      },
    },
  });

  return freezeMapping({plugin, compatibilityNotes: notes});
}

export function mapHermesMemoryProviderFixture(
  value: unknown,
): RuntimePluginAdapterMapping {
  const fixture = requiredRecord(value, 'Hermes provider fixture');
  const behavior = requiredRecord(fixture['behavior'], 'behavior');
  const prefetch = requiredRecord(behavior['prefetch'], 'behavior.prefetch');
  const sync = requiredRecord(behavior['sync'], 'behavior.sync');
  const sessionEnd = requiredRecord(
    behavior['sessionEnd'],
    'behavior.sessionEnd',
  );
  const health = requiredRecord(behavior['health'], 'behavior.health');
  const searchTools = recordsArray(
    behavior['searchTools'],
    'behavior.searchTools',
  );
  const config = requiredRecord(fixture['config'], 'config');
  const degradation = requiredRecord(fixture['degradation'], 'degradation');
  const manifestId = 'hermes.memory_tencentdb.fixture';
  const notes = [
    createCompatibilityNote({
      sourceSystem: 'hermes',
      fieldPath: 'behavior.prefetch',
      disposition: 'mapped',
      evidence: 'Hermes prefetch maps to beforeRoleModelCall recall context.',
    }),
    createCompatibilityNote({
      sourceSystem: 'hermes',
      fieldPath: 'behavior.sync',
      disposition: 'mapped',
      evidence: 'Hermes sync maps to afterTurnCommitted capture.',
    }),
    createCompatibilityNote({
      sourceSystem: 'hermes',
      fieldPath: 'degradation',
      disposition: 'mapped',
      evidence:
        'Circuit-breaker and back-pressure metadata map into compatibility notes and health summary.',
    }),
    ...unsupportedNotesFromFixture(fixture, 'hermes'),
  ];
  const providedTools = searchTools.map(tool =>
    createProvidedToolFromSchema({
      name: requiredString(tool['name'], 'behavior.searchTools.name'),
      description: requiredString(
        tool['description'],
        'behavior.searchTools.description',
      ),
      inputContract: inputContractFromSchema(
        requiredRecord(tool['inputSchema'], 'behavior.searchTools.inputSchema'),
      ),
      validationOwner: 'adapter',
      maxCalls: 2,
    }),
  );
  const manifest = createMemoryGatewayManifest({
    id: manifestId,
    displayName:
      optionalString(fixture['displayName'], 'displayName') ??
      'Hermes memory provider fixture',
    sourceSystem: 'hermes',
    sourceVersion: optionalString(fixture['version'], 'version') ?? 'fixture',
    externalContract: 'hermes-memory-provider',
    description:
      'Fixture adapter for Hermes memory provider prefetch, sync, search, session, health, and degradation metadata.',
    providedTools,
    configFields: configFieldsFromConfigRecord(config),
    configFingerprint: 'fixture-redacted-hermes-provider',
    compatibilityNotes: notes,
  });
  const plugin = createRuntimePlugin({
    manifest,
    providedTools,
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        const confidence = optionalNumber(
          prefetch['confidence'],
          'prefetch.confidence',
        );
        const contextItem = createMemoryContextItem({
          pluginId: manifestId,
          id: 'hermes.prefetch.fixture',
          text: requiredString(
            prefetch['context'],
            'behavior.prefetch.context',
          ),
          sourceId: 'hermes.prefetch.fixture',
          sourceTitle: 'Hermes prefetch fixture',
          sourceUri: 'fixture://hermes/prefetch',
          estimatedTokens:
            optionalPositiveInteger(
              prefetch['estimatedTokens'],
              'behavior.prefetch.estimatedTokens',
            ) ?? 72,
          ...(confidence === undefined ? {} : {confidence}),
        });

        return Object.freeze({
          contextItems: Object.freeze([contextItem]),
          evidence: Object.freeze([
            createEvidence({
              pluginId: manifestId,
              context,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Mapped Hermes prefetch fixture into memory context.',
              sourceReferences: contextItem.sourceReferences,
              ...(manifest.config.fingerprint === undefined
                ? {}
                : {configFingerprint: manifest.config.fingerprint}),
            }),
          ]),
        });
      },
      handleToolCall(call, context) {
        const tool = searchTools.find(
          candidate =>
            requiredString(candidate['name'], 'behavior.searchTools.name') ===
            call.toolName,
        );

        if (tool === undefined) {
          return createRejectedToolCallResult({
            pluginId: manifestId,
            call,
            context,
            reason: 'unsupported_fixture_tool',
            message: `Hermes fixture does not map tool ${call.toolName}.`,
          });
        }

        return createAcceptedToolCallResult({
          pluginId: manifestId,
          call,
          context,
          output: jsonObjectFromRecord(
            requiredRecord(tool['fixtureResponse'], 'fixtureResponse'),
          ),
          summary: `Mapped Hermes search tool ${call.toolName}.`,
          sourceReferences: [
            createToolContractSourceReference({
              pluginId: manifestId,
              toolName: call.toolName,
              title: `Hermes search tool ${call.toolName}`,
              uri: `fixture://hermes/searchTools/${sourceReferenceIdSegment(
                call.toolName,
              )}`,
            }),
          ],
        });
      },
      afterTurnCommitted(context) {
        return createCompletedHookResult({
          pluginId: manifestId,
          context,
          evidenceKind: 'after_turn_committed',
          summary: `Mapped Hermes sync response: ${JSON.stringify(
            jsonObjectFromRecord(sync),
          )}.`,
        });
      },
      onSessionEnd(context) {
        return createCompletedHookResult({
          pluginId: manifestId,
          context,
          evidenceKind: 'session_end',
          summary: `Mapped Hermes session-end response: ${JSON.stringify(
            jsonObjectFromRecord(sessionEnd),
          )}.`,
        });
      },
      health(context) {
        return createRuntimePluginHealthSnapshot({
          pluginId: manifestId,
          status: healthStatusFromString(
            optionalString(health['status'], 'behavior.health.status') ??
              'degraded',
          ),
          checkedAt: context.timestamp,
          summary: `Hermes health fixture; ${degradationSummary(degradation)}.`,
          redactionLabels: Object.freeze(['secret']),
        });
      },
    },
  });

  return freezeMapping({plugin, compatibilityNotes: notes});
}

export function mapMcpToolsResourcesFixture(
  value: unknown,
): RuntimePluginAdapterMapping {
  const fixture = requiredRecord(value, 'MCP fixture');
  const server = requiredRecord(fixture['server'], 'server');
  const protocolVersion = requiredString(
    fixture['protocolVersion'],
    'protocolVersion',
  );
  const tools = recordsArray(fixture['tools'], 'tools');
  const resources = recordsArray(fixture['resources'], 'resources');
  const manifestId = 'mcp.tools_resources.fixture';
  const notes = [
    createCompatibilityNote({
      sourceSystem: 'model-context-protocol',
      fieldPath: 'tools',
      disposition: 'mapped',
      evidence: 'MCP tool declarations map to local providedTools.',
    }),
    createCompatibilityNote({
      sourceSystem: 'model-context-protocol',
      fieldPath: 'resources',
      disposition: 'mapped',
      evidence:
        'MCP resource declarations map to beforeRoleModelCall context resources.',
    }),
    ...unsupportedNotesFromFixture(fixture, 'model-context-protocol'),
  ];
  const providedTools = tools.map(tool =>
    createProvidedToolFromSchema({
      name: requiredString(tool['name'], 'tools.name'),
      description: requiredString(tool['description'], 'tools.description'),
      inputContract: inputContractFromSchema(
        requiredRecord(tool['inputSchema'], 'tools.inputSchema'),
      ),
      validationOwner: 'adapter',
      maxCalls: 2,
    }),
  );
  const manifest = createRuntimePluginManifestForAdapter({
    id: manifestId,
    displayName:
      optionalString(server['name'], 'server.name') ?? 'MCP fixture server',
    version: `${protocolVersion}-fixture`,
    kind: 'bridge_adapter',
    description:
      'Fixture adapter for MCP 2025-06-18 tools and resources mapped into the local plugin contract.',
    sourceSystem: 'model-context-protocol',
    sourceVersion: protocolVersion,
    externalContract: 'mcp-tools-resources',
    declaredPlugins: [
      'tool_provider',
      'handle_tool_call',
      'context_provider',
      'before_role_model_call',
      'health',
    ],
    providedTools,
    configFields: [
      createConfigField({
        name: 'server_id',
        description: 'Static MCP fixture server id.',
        required: true,
        secret: false,
      }),
    ],
    runtimePolicy: createAdapterPolicy({
      timeoutMs: 1000,
    }),
    activationReasons: ['mcp_fixture_mapping'],
    compatibilityNotes: notes,
  });
  const plugin = createRuntimePlugin({
    manifest,
    providedTools,
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        const contextItems = resources.map((resource, index) =>
          createRuntimePluginContextItem({
            pluginId: manifestId,
            id: `mcp.resource.${String(index + 1)}`,
            kind: 'resource',
            text: requiredString(
              resource['fixtureText'],
              'resources.fixtureText',
            ),
            budget: {
              estimatedTokens:
                optionalPositiveInteger(
                  resource['estimatedTokens'],
                  'resources.estimatedTokens',
                ) ?? 80,
              priority: index + 1,
            },
            sourceReferences: [
              {
                kind: 'resource',
                id: `mcp.resource.${String(index + 1)}`,
                title: requiredString(resource['name'], 'resources.name'),
                uri: requiredString(resource['uri'], 'resources.uri'),
              },
            ],
            redactionLabels: [],
          }),
        );

        return Object.freeze({
          contextItems: Object.freeze(contextItems),
          evidence: Object.freeze([
            createEvidence({
              pluginId: manifestId,
              context,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: `Mapped ${String(resources.length)} MCP fixture resources into context.`,
              sourceReferences: contextItems.flatMap(
                item => item.sourceReferences,
              ),
            }),
          ]),
        });
      },
      handleToolCall(call, context) {
        const tool = tools.find(
          candidate =>
            requiredString(candidate['name'], 'tools.name') === call.toolName,
        );

        if (tool === undefined) {
          return createRejectedToolCallResult({
            pluginId: manifestId,
            call,
            context,
            reason: 'unsupported_fixture_tool',
            message: `MCP fixture does not map tool ${call.toolName}.`,
          });
        }

        return createAcceptedToolCallResult({
          pluginId: manifestId,
          call,
          context,
          output: jsonObjectFromRecord(
            requiredRecord(tool['fixtureResponse'], 'tools.fixtureResponse'),
          ),
          summary: `Mapped MCP tool ${call.toolName}.`,
          sourceReferences: [
            createToolContractSourceReference({
              pluginId: manifestId,
              toolName: call.toolName,
              title: `MCP tool ${call.toolName}`,
              uri: `fixture://mcp/tools/${sourceReferenceIdSegment(
                call.toolName,
              )}`,
            }),
          ],
        });
      },
      health(context) {
        return createRuntimePluginHealthSnapshot({
          pluginId: manifestId,
          status: 'ok',
          checkedAt: context.timestamp,
          summary: `MCP fixture server ${requiredString(
            server['id'],
            'server.id',
          )} is static and available.`,
          redactionLabels: [],
        });
      },
    },
  });

  return freezeMapping({plugin, compatibilityNotes: notes});
}

export function mapFirstPartyModelToolsPlugin(): RuntimePluginAdapterMapping {
  const plugin = createFirstPartyModelToolsPlugin();
  const notes = [
    createCompatibilityNote({
      sourceSystem: 'project02',
      fieldPath: 'builtInModelToolDefinitionsForUserTurn',
      disposition: 'mapped',
      evidence:
        'First-party built-in tools are represented through RuntimePlugin without changing validationOwner or input contracts.',
    }),
  ];

  return freezeMapping({plugin, compatibilityNotes: notes});
}

function createOpenClawManifest(options: {
  readonly fixture: JsonRecord;
  readonly manifestId: string;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
  readonly configFields: readonly RuntimePluginConfigField[];
  readonly activationReasons: readonly string[];
  readonly sourceVersion: string;
  readonly compatibilityNotes: readonly RuntimePluginAdapterCompatibilityNote[];
}): RuntimePluginManifest {
  return createRuntimePluginManifestForAdapter({
    id: options.manifestId,
    displayName:
      optionalString(options.fixture['name'], 'name') ??
      optionalString(options.fixture['displayName'], 'displayName') ??
      'OpenClaw memory fixture',
    version:
      optionalString(options.fixture['version'], 'version') ?? '0.0.0-fixture',
    kind: 'bridge_adapter',
    description:
      optionalString(options.fixture['description'], 'description') ??
      'OpenClaw memory plugin fixture mapped into the local plugin contract.',
    sourceSystem: 'openclaw',
    sourceVersion: options.sourceVersion,
    externalContract: 'openclaw.plugin.json',
    declaredPlugins: ['tool_provider', 'handle_tool_call', 'health'],
    providedTools: options.providedTools,
    configFields: options.configFields,
    runtimePolicy: createAdapterPolicy({
      timeoutMs: 1000,
    }),
    activationReasons: options.activationReasons,
    compatibilityNotes: options.compatibilityNotes,
  });
}

function createMemoryGatewayManifest(options: {
  readonly id: string;
  readonly displayName: string;
  readonly sourceSystem: string;
  readonly sourceVersion: string;
  readonly externalContract: string;
  readonly description: string;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
  readonly configFields: readonly RuntimePluginConfigField[];
  readonly configFingerprint: string;
  readonly compatibilityNotes: readonly RuntimePluginAdapterCompatibilityNote[];
}): RuntimePluginManifest {
  return createRuntimePluginManifestForAdapter({
    id: options.id,
    displayName: options.displayName,
    version: options.sourceVersion,
    kind: 'memory_provider',
    description: options.description,
    sourceSystem: options.sourceSystem,
    sourceVersion: options.sourceVersion,
    externalContract: options.externalContract,
    declaredPlugins: [
      'context_provider',
      'before_role_model_call',
      'tool_provider',
      'handle_tool_call',
      'after_turn_committed',
      'on_session_end',
      'health',
    ],
    providedTools: options.providedTools,
    configFields: options.configFields,
    configFingerprint: options.configFingerprint,
    runtimePolicy: createAdapterPolicy({
      timeoutMs: 2000,
      redactionLabels: ['secret'],
    }),
    activationReasons: ['memory_fixture_mapping'],
    compatibilityNotes: options.compatibilityNotes,
  });
}

function createRuntimePluginManifestForAdapter(options: {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly kind: RuntimePluginManifest['kind'];
  readonly description: string;
  readonly sourceSystem: string;
  readonly sourceVersion: string;
  readonly externalContract: string;
  readonly declaredPlugins: readonly RuntimePluginDeclaration[];
  readonly providedTools: readonly RuntimePluginProvidedTool[];
  readonly configFields: readonly RuntimePluginConfigField[];
  readonly configFingerprint?: string;
  readonly runtimePolicy: RuntimePluginRuntimePolicy;
  readonly activationReasons: readonly string[];
  readonly compatibilityNotes: readonly RuntimePluginAdapterCompatibilityNote[];
}): RuntimePluginManifest {
  const manifest = {
    id: options.id,
    displayName: options.displayName,
    version: options.version,
    kind: options.kind,
    description: options.description,
    contractVersion: runtimePluginContractVersion,
    compatibility: {
      hostContractVersions: [runtimePluginContractVersion],
      sourceSystem: options.sourceSystem,
      sourceVersion: options.sourceVersion,
      externalContract: options.externalContract,
      notes: options.compatibilityNotes.map(
        note => `${note.disposition}:${note.fieldPath}:${note.evidence}`,
      ),
    },
    declaredPlugins: options.declaredPlugins,
    config: {
      scope: 'global_with_character_overrides',
      fields: options.configFields,
      ...(options.configFingerprint === undefined
        ? {}
        : {fingerprint: options.configFingerprint}),
    },
    firstParty: false,
    runtimePolicy: options.runtimePolicy,
    activation: {
      defaultEnabled: false,
      reasons: options.activationReasons,
    },
    requestedAccess: {},
  } satisfies RuntimePluginManifest;

  return {
    ...manifest,
    requestedAccess: adapterRequestedAccess({
      manifest,
      providedTools: options.providedTools,
    }),
  };
}

function adapterRequestedAccess(options: {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly RuntimePluginProvidedTool[];
}): RuntimePluginAccessMap {
  const hasModelFacingPluginHostTool = options.providedTools.some(tool =>
    isModelFacingRuntimePluginTool({manifest: options.manifest, tool}),
  );

  return Object.freeze({
    ...(options.manifest.declaredPlugins.includes('before_role_model_call') ||
    options.manifest.declaredPlugins.includes('after_turn_committed')
      ? {turn_context: 'read'}
      : {}),
    ...(options.manifest.declaredPlugins.includes('before_role_model_call') ||
    hasModelFacingPluginHostTool
      ? {model_input: 'write'}
      : {}),
  } satisfies RuntimePluginAccessMap);
}

function createAdapterPolicy(options: {
  readonly timeoutMs: number;
  readonly redactionLabels?: readonly string[];
}): RuntimePluginRuntimePolicy {
  return {
    timeoutMs: options.timeoutMs,
    redactionLabels: options.redactionLabels ?? [],
    failureBehavior: {
      beforeRoleModelCall: 'degrade',
      handleToolCall: 'degrade',
      health: 'degrade',
    },
  };
}

function createProvidedToolFromSchema(options: {
  readonly name: string;
  readonly description: string;
  readonly inputContract: ModelToolInputContract;
  readonly validationOwner: RuntimePluginToolValidationOwner;
  readonly maxCalls?: number;
}): RuntimePluginProvidedTool {
  return {
    name: options.name,
    description: options.description,
    inputContract: options.inputContract,
    validationOwner: options.validationOwner,
    requiresConfirmation: false,
  };
}

function configFieldsFromSchema(
  schema: JsonRecord,
): readonly RuntimePluginConfigField[] {
  const properties = optionalRecord(schema['properties'], 'schema.properties');
  const required = new Set(
    optionalStringArray(schema['required'], 'schema.required'),
  );

  if (properties === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    Object.entries(properties).map(([name, value]) => {
      const property = requiredRecord(value, `schema.properties.${name}`);
      const secret = isSecretConfigField(name, property);

      return createConfigField({
        name,
        description:
          optionalString(
            property['description'],
            `schema.properties.${name}.description`,
          ) ?? `Configuration field ${name}.`,
        required: required.has(name),
        secret,
      });
    }),
  );
}

function configFieldsFromConfigRecord(
  config: JsonRecord,
): readonly RuntimePluginConfigField[] {
  return Object.freeze(
    Object.entries(config).map(([name, value]) => {
      const configField = requiredRecord(value, `config.${name}`);
      const secret =
        optionalBoolean(configField['secret'], `config.${name}.secret`) ??
        isSecretConfigField(name, configField);

      return createConfigField({
        name,
        description:
          optionalString(
            configField['description'],
            `config.${name}.description`,
          ) ?? `Configuration field ${name}.`,
        required:
          optionalBoolean(configField['required'], `config.${name}.required`) ??
          false,
        secret,
      });
    }),
  );
}

function createConfigField(options: {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
}): RuntimePluginConfigField {
  return {
    name: options.name,
    description: options.description,
    required: options.required,
    secret: options.secret,
    redactionLabels: options.secret ? ['secret'] : [],
  };
}

function inputContractFromSchema(schema: JsonRecord): ModelToolInputContract {
  const validated = requiredModelToolInputContract({
    ...schema,
    type: 'object',
    properties: optionalRecord(schema['properties'], 'schema.properties') ?? {},
    required: optionalStringArray(schema['required'], 'schema.required'),
    additionalProperties: schema['additionalProperties'] !== false,
  });

  if (validated.status === 'rejected') {
    throw new TypeError(
      `Adapter proof tool schema is not a usable input contract: ${validated.details}`,
    );
  }

  return validated.value;
}

function createMemoryContextItem(options: {
  readonly pluginId: string;
  readonly id: string;
  readonly text: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly sourceUri: string;
  readonly estimatedTokens: number;
  readonly confidence?: number;
}): RuntimePluginContextItem {
  return createRuntimePluginContextItem({
    pluginId: options.pluginId,
    id: options.id,
    kind: 'memory',
    text: options.text,
    budget: {
      estimatedTokens: options.estimatedTokens,
      priority: 1,
    },
    sourceReferences: [
      {
        kind: 'memory',
        id: options.sourceId,
        title: options.sourceTitle,
        uri: options.sourceUri,
      },
    ],
    ...(options.confidence === undefined
      ? {}
      : {confidence: options.confidence}),
    redactionLabels: ['memory'],
  });
}

function createEvidence(options: {
  readonly pluginId: string;
  readonly context: RuntimePluginContext;
  readonly evidenceKind: RuntimePluginEvidenceKind;
  readonly status: RuntimePluginEvidenceStatus;
  readonly summary: string;
  readonly policyOutcome?: string;
  readonly sourceReferences?: readonly RuntimePluginSourceReference[];
  readonly configFingerprint?: string;
  readonly redactionLabels?: readonly string[];
}): RuntimePluginEvidenceSnapshot {
  return createRuntimePluginEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'runtime_plugin_evidence_snapshot',
    pluginId: options.pluginId,
    evidenceKind: options.evidenceKind,
    status: options.status,
    summary: options.summary,
    ...(options.policyOutcome === undefined
      ? {}
      : {policyOutcome: options.policyOutcome}),
    ...(options.sourceReferences === undefined
      ? {}
      : {sourceReferences: options.sourceReferences}),
    redactionLabels: options.redactionLabels ?? [],
    ...(options.configFingerprint === undefined
      ? {}
      : {configFingerprint: options.configFingerprint}),
  });
}

function createAcceptedToolCallResult(options: {
  readonly pluginId: string;
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly output: RuntimePluginJsonValue;
  readonly summary: string;
  readonly sourceReferences?: readonly RuntimePluginSourceReference[];
}): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'accepted',
    output: options.output,
    evidence: Object.freeze([
      createEvidence({
        pluginId: options.pluginId,
        context: options.context,
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: `${options.summary} Tool: ${options.call.toolName}.`,
        ...(options.sourceReferences === undefined
          ? {}
          : {sourceReferences: options.sourceReferences}),
      }),
    ]),
  });
}

function createToolContractSourceReference(options: {
  readonly pluginId: string;
  readonly toolName: string;
  readonly title: string;
  readonly uri: string;
}): RuntimePluginSourceReference {
  return createAdapterExternalContractSourceReference({
    pluginId: options.pluginId,
    idSuffix: `tool.${sourceReferenceIdSegment(options.toolName)}`,
    title: options.title,
    uri: options.uri,
  });
}

function createEndpointSourceReference(options: {
  readonly pluginId: string;
  readonly endpointName: string;
  readonly endpoint: EndpointFixture;
  readonly titlePrefix: string;
  readonly uriBase: string;
}): RuntimePluginSourceReference {
  return createAdapterExternalContractSourceReference({
    pluginId: options.pluginId,
    idSuffix: `endpoint.${sourceReferenceIdSegment(options.endpointName)}`,
    title: `${options.titlePrefix} ${options.endpoint.method} ${options.endpoint.path}`,
    uri: `${options.uriBase}${options.endpoint.path}`,
  });
}

function createAdapterExternalContractSourceReference(options: {
  readonly pluginId: string;
  readonly idSuffix: string;
  readonly title: string;
  readonly uri: string;
}): RuntimePluginSourceReference {
  return Object.freeze({
    kind: 'external_contract',
    id: `${options.pluginId}.${options.idSuffix}`,
    title: options.title,
    uri: options.uri,
  });
}

function sourceReferenceIdSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, '-');
  const bounded = normalized.length === 0 ? 'source' : normalized.slice(0, 64);

  return /^[A-Za-z]/u.test(bounded)
    ? bounded
    : `source-${bounded}`.slice(0, 64);
}

function createRejectedToolCallResult(options: {
  readonly pluginId: string;
  readonly call: RuntimePluginToolCall;
  readonly context: RuntimePluginContext;
  readonly reason: string;
  readonly message: string;
}): RuntimePluginToolCallResult {
  return Object.freeze({
    status: 'rejected',
    reason: options.reason,
    message: options.message,
    evidence: Object.freeze([
      createEvidence({
        pluginId: options.pluginId,
        context: options.context,
        evidenceKind: 'tool_invocation',
        status: 'rejected',
        summary: options.message,
        policyOutcome: 'handler_rejected',
      }),
    ]),
  });
}

function createCompletedHookResult(options: {
  readonly pluginId: string;
  readonly context: RuntimePluginContext;
  readonly evidenceKind: RuntimePluginEvidenceKind;
  readonly summary: string;
}): RuntimePluginHookResult {
  return Object.freeze({
    status: 'completed',
    evidence: Object.freeze([
      createEvidence({
        pluginId: options.pluginId,
        context: options.context,
        evidenceKind: options.evidenceKind,
        status: 'accepted',
        summary: options.summary,
      }),
    ]),
  });
}

function healthSnapshotFromEndpoint(options: {
  readonly pluginId: string;
  readonly context: RuntimePluginContext;
  readonly endpoint: EndpointFixture;
}): RuntimePluginHealthSnapshot {
  const statusText =
    optionalString(options.endpoint.response['status'], 'health.status') ??
    'ok';

  return createRuntimePluginHealthSnapshot({
    pluginId: options.pluginId,
    status: healthStatusFromString(statusText),
    checkedAt: options.context.timestamp,
    summary: `Gateway health fixture status ${statusText}.`,
    redactionLabels: Object.freeze(['secret']),
  });
}

function healthStatusFromString(
  value: string,
): RuntimePluginHealthSnapshot['status'] {
  if (value === 'ok' || value === 'degraded' || value === 'unavailable') {
    return value;
  }

  return 'degraded';
}

type EndpointFixture = {
  readonly method: string;
  readonly path: string;
  readonly requestSchema: JsonRecord;
  readonly response: JsonRecord;
};

function requiredEndpoint(
  endpoints: JsonRecord,
  name: string,
): EndpointFixture {
  const endpoint = requiredRecord(endpoints[name], `endpoints.${name}`);

  return Object.freeze({
    method: requiredString(endpoint['method'], `endpoints.${name}.method`),
    path: requiredString(endpoint['path'], `endpoints.${name}.path`),
    requestSchema:
      optionalRecord(
        endpoint['requestSchema'],
        `endpoints.${name}.requestSchema`,
      ) ?? emptyObject(),
    response: requiredRecord(
      endpoint['response'],
      `endpoints.${name}.response`,
    ),
  });
}

function endpointToolOutput(
  endpoint: EndpointFixture,
): RuntimePluginJsonObject {
  return Object.freeze({
    method: endpoint.method,
    path: endpoint.path,
    response: jsonValueFromUnknown(endpoint.response),
  });
}

function toolDescriptionFromMetadata(
  metadata: JsonRecord | undefined,
  toolName: string,
): string {
  const tool = optionalNestedRecord(
    metadata,
    toolName,
    `toolMetadata.${toolName}`,
  );

  return (
    optionalString(
      tool?.['description'],
      `toolMetadata.${toolName}.description`,
    ) ?? `OpenClaw fixture tool ${toolName}.`
  );
}

function toolInputSchemaFromMetadata(
  metadata: JsonRecord | undefined,
  toolName: string,
): JsonRecord {
  const tool = optionalNestedRecord(
    metadata,
    toolName,
    `toolMetadata.${toolName}`,
  );

  return (
    optionalNestedRecord(
      tool,
      'inputSchema',
      `toolMetadata.${toolName}.inputSchema`,
    ) ?? emptyObject()
  );
}

function activationReasonsFromOpenClawActivation(
  activation: JsonRecord,
): readonly string[] {
  const reasons = ['openclaw_fixture_mapping'];
  const commands = optionalStringArray(
    activation['commands'],
    'activation.commands',
  );

  if (commands.length > 0) {
    reasons.push(`commands:${commands.join(',')}`);
  }

  if (
    optionalBoolean(activation['onStartup'], 'activation.onStartup') === true
  ) {
    reasons.push('on_startup');
  }

  return Object.freeze(reasons);
}

function degradationSummary(degradation: JsonRecord): string {
  const circuitBreaker = optionalRecord(
    degradation['circuitBreaker'],
    'degradation.circuitBreaker',
  );
  const backPressure = optionalRecord(
    degradation['backPressure'],
    'degradation.backPressure',
  );
  const failureThreshold =
    circuitBreaker === undefined
      ? 'unknown'
      : String(
          optionalPositiveInteger(
            circuitBreaker['failureThreshold'],
            'degradation.circuitBreaker.failureThreshold',
          ) ?? 'unknown',
        );
  const pauseMs =
    circuitBreaker === undefined
      ? 'unknown'
      : String(
          optionalPositiveInteger(
            circuitBreaker['pauseMs'],
            'degradation.circuitBreaker.pauseMs',
          ) ?? 'unknown',
        );
  const maxInFlight =
    backPressure === undefined
      ? 'unknown'
      : String(
          optionalPositiveInteger(
            backPressure['maxInFlight'],
            'degradation.backPressure.maxInFlight',
          ) ?? 'unknown',
        );

  return `circuit breaker threshold ${failureThreshold}, pause ${pauseMs}ms, max in-flight sync ${maxInFlight}`;
}

function createCompatibilityNote(
  options: RuntimePluginAdapterCompatibilityNote,
): RuntimePluginAdapterCompatibilityNote {
  return Object.freeze({
    sourceSystem: options.sourceSystem,
    fieldPath: options.fieldPath,
    disposition: options.disposition,
    evidence: options.evidence,
  });
}

function unsupportedNotesFromFixture(
  fixture: JsonRecord,
  sourceSystem: string,
): readonly RuntimePluginAdapterCompatibilityNote[] {
  const unsupportedFields = recordsArray(
    fixture['unsupportedFields'],
    'unsupportedFields',
  );

  return Object.freeze(
    unsupportedFields.map(field =>
      createCompatibilityNote({
        sourceSystem,
        fieldPath: requiredString(
          field['fieldPath'],
          'unsupportedFields.fieldPath',
        ),
        disposition: compatibilityDispositionFromString(
          requiredString(field['disposition'], 'unsupportedFields.disposition'),
        ),
        evidence: requiredString(
          field['evidence'],
          'unsupportedFields.evidence',
        ),
      }),
    ),
  );
}

function compatibilityDispositionFromString(
  value: string,
): RuntimePluginAdapterCompatibilityDisposition {
  if (
    value === 'mapped' ||
    value === 'ignored_with_evidence' ||
    value === 'future_extension'
  ) {
    return value;
  }

  throw new TypeError(`Unsupported compatibility disposition "${value}".`);
}

function freezeMapping(
  mapping: RuntimePluginAdapterMapping,
): RuntimePluginAdapterMapping {
  return Object.freeze({
    plugin: mapping.plugin,
    compatibilityNotes: Object.freeze([...mapping.compatibilityNotes]),
  });
}

function jsonObjectFromRecord(record: JsonRecord): RuntimePluginJsonObject {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        jsonValueFromUnknown(value),
      ]),
    ),
  );
}

function jsonValueFromUnknown(value: unknown): RuntimePluginJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map(jsonValueFromUnknown));
  }

  if (isRecord(value)) {
    return jsonObjectFromRecord(value);
  }

  throw new TypeError(`Unsupported JSON value type: ${typeof value}.`);
}

function requiredRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object.`);
  }

  return value;
}

function optionalRecord(value: unknown, field: string): JsonRecord | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredRecord(value, field);
}

function optionalNestedRecord(
  record: JsonRecord | undefined,
  key: string,
  field: string,
): JsonRecord | undefined {
  if (record === undefined) {
    return undefined;
  }

  return optionalRecord(record[key], field);
}

function recordsArray(value: unknown, field: string): readonly JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array.`);
  }

  return Object.freeze(
    value.map((item, index) =>
      requiredRecord(item, `${field}[${String(index)}]`),
    ),
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }

  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredString(value, field);
}

function requiredStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array.`);
  }

  return Object.freeze(value.map(item => requiredString(item, field)));
}

function optionalStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }

  return requiredStringArray(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be a boolean.`);
  }

  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number') {
    throw new TypeError(`${field} must be a number.`);
  }

  return value;
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer.`);
  }

  return value;
}

function isSecretConfigField(name: string, property: JsonRecord): boolean {
  if (optionalBoolean(property['x-secret'], `${name}.x-secret`) === true) {
    return true;
  }

  if (optionalString(property['format'], `${name}.format`) === 'password') {
    return true;
  }

  return /(?:api[_-]?key|token|secret|password)/iu.test(name);
}

function emptyObject(): JsonRecord {
  return Object.freeze({});
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
