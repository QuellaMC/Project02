import {
  agentCapabilityContractVersion,
  createAgentCapability,
  createAgentCapabilityContextItem,
  createAgentCapabilityEvidenceSnapshot,
  createAgentCapabilityHealthSnapshot,
  createFirstPartyModelToolsCapability,
  type AgentCapability,
  type AgentCapabilityConfigField,
  type AgentCapabilityContextItem,
  type AgentCapabilityDeclaration,
  type AgentCapabilityEvidenceKind,
  type AgentCapabilityEvidenceSnapshot,
  type AgentCapabilityEvidenceStatus,
  type AgentCapabilityHealthSnapshot,
  type AgentCapabilityHookResult,
  type AgentCapabilityJsonObject,
  type AgentCapabilityJsonValue,
  type AgentCapabilityManifest,
  type AgentCapabilityProvidedTool,
  type AgentCapabilityRuntimePolicy,
  type AgentCapabilitySideEffectLevel,
  type AgentCapabilitySourceReference,
  type AgentCapabilityToolCall,
  type AgentCapabilityToolCallResult,
  type AgentCapabilityToolValidationOwner,
  type RuntimeCapabilityContext
} from '../agent-capabilities.ts';
import {
  modelToolInputFieldValueTypes
} from '../model-tools.ts';
import type {
  ModelToolInputFieldValueType,
  ModelToolInputContract,
  ModelToolInputField
} from '../model-tools.ts';

type JsonRecord = Readonly<Record<string, unknown>>;

export type AgentCapabilityAdapterCompatibilityDisposition =
  | 'mapped'
  | 'ignored_with_evidence'
  | 'future_extension';

export type AgentCapabilityAdapterCompatibilityNote = {
  readonly sourceSystem: string;
  readonly fieldPath: string;
  readonly disposition: AgentCapabilityAdapterCompatibilityDisposition;
  readonly evidence: string;
};

export type AgentCapabilityAdapterMapping = {
  readonly capability: AgentCapability;
  readonly compatibilityNotes: readonly AgentCapabilityAdapterCompatibilityNote[];
};

export function mapOpenClawMemoryPluginFixture(
  value: unknown
): AgentCapabilityAdapterMapping {
  const fixture = requiredRecord(value, 'OpenClaw fixture');
  const contracts = requiredRecord(fixture['contracts'], 'contracts');
  const toolNames = requiredStringArray(contracts['tools'], 'contracts.tools');
  const configSchema = requiredRecord(fixture['configSchema'], 'configSchema');
  const toolMetadata = optionalRecord(fixture['toolMetadata'], 'toolMetadata');
  const packageMetadata = optionalRecord(fixture['package'], 'package');
  const packageOpenClaw = optionalNestedRecord(
    packageMetadata,
    'openclaw',
    'package.openclaw'
  );
  const packageCompat = optionalNestedRecord(
    packageOpenClaw,
    'compat',
    'package.openclaw.compat'
  );
  const activation = requiredRecord(fixture['activation'], 'activation');
  const manifestId = 'openclaw.memory_core.fixture';
  const providedTools = toolNames.map((toolName) =>
    createProvidedToolFromSchema({
      name: toolName,
      description: toolDescriptionFromMetadata(toolMetadata, toolName),
      inputContract: inputContractFromSchema(
        toolInputSchemaFromMetadata(toolMetadata, toolName)
      ),
      validationOwner: 'adapter',
      sideEffectLevel: 'runtime_read',
      sourceReferencesRequired: true
    })
  );
  const notes = [
    createCompatibilityNote({
      sourceSystem: 'openclaw',
      fieldPath: 'contracts.tools',
      disposition: 'mapped',
      evidence:
        'OpenClaw declared tool names were normalized into local providedTools.'
    }),
    createCompatibilityNote({
      sourceSystem: 'openclaw',
      fieldPath: 'configSchema.properties',
      disposition: 'mapped',
      evidence:
        'OpenClaw JSON-schema-like config fields were normalized into local config metadata.'
    }),
    ...unsupportedNotesFromFixture(fixture, 'openclaw')
  ];
  const manifest = createOpenClawManifest({
    fixture,
    manifestId,
    configFields: configFieldsFromSchema(configSchema),
    activationReasons: activationReasonsFromOpenClawActivation(activation),
    sourceVersion:
      optionalString(packageCompat?.['pluginApi'], 'package.openclaw.compat.pluginApi') ??
      optionalString(fixture['version'], 'version') ??
      'fixture',
    compatibilityNotes: notes
  });
  const capability = createAgentCapability({
    manifest,
    providedTools,
    lifecycleHooks: {
      handleToolCall(call, context) {
        return createAcceptedToolCallResult({
          capabilityId: manifestId,
          call,
          context,
          output: {
            source: 'openclaw.fixture',
            toolName: call.toolName,
            declaredBy: 'contracts.tools'
          },
          summary: `Mapped OpenClaw tool ${call.toolName} through fixture adapter.`
        });
      },
      health(context) {
        return createAgentCapabilityHealthSnapshot({
          capabilityId: manifestId,
          status: 'ok',
          checkedAt: context.timestamp,
          summary:
            'OpenClaw fixture is static; no universal upstream health field was executed.',
          redactionLabels: []
        });
      }
    }
  });

  return freezeMapping({ capability, compatibilityNotes: notes });
}

export function mapTencentDbMemoryGatewayFixture(
  value: unknown
): AgentCapabilityAdapterMapping {
  const fixture = requiredRecord(value, 'TencentDB gateway fixture');
  const endpoints = requiredRecord(fixture['endpoints'], 'endpoints');
  const recall = requiredEndpoint(endpoints, 'recall');
  const capture = requiredEndpoint(endpoints, 'capture');
  const searchMemories = requiredEndpoint(endpoints, 'searchMemories');
  const searchConversations = requiredEndpoint(endpoints, 'searchConversations');
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
      sideEffectLevel: 'external_read',
      sourceReferencesRequired: true,
      maxCallsPerUserTurn: 2
    }),
    createProvidedToolFromSchema({
      name: 'memory_tencentdb.conversation_search',
      description:
        'Search TencentDB conversation records from the fixture gateway.',
      inputContract: inputContractFromSchema(searchConversations.requestSchema),
      validationOwner: 'adapter',
      sideEffectLevel: 'external_read',
      sourceReferencesRequired: true,
      maxCallsPerUserTurn: 2
    })
  ];
  const notes = [
    createCompatibilityNote({
      sourceSystem: 'TencentDB-Agent-Memory',
      fieldPath: 'endpoints.recall',
      disposition: 'mapped',
      evidence: 'POST /recall fixture response maps to beforeRoleModelCall.'
    }),
    createCompatibilityNote({
      sourceSystem: 'TencentDB-Agent-Memory',
      fieldPath: 'endpoints.capture',
      disposition: 'mapped',
      evidence: 'POST /capture fixture response maps to afterTurnCommitted.'
    }),
    createCompatibilityNote({
      sourceSystem: 'TencentDB-Agent-Memory',
      fieldPath: 'endpoints.sessionEnd',
      disposition: 'mapped',
      evidence: 'POST /session/end fixture response maps to onSessionEnd.'
    }),
    ...unsupportedNotesFromFixture(fixture, 'TencentDB-Agent-Memory')
  ];
  const manifest = createMemoryGatewayManifest({
    id: manifestId,
    displayName: 'TencentDB Agent Memory gateway fixture',
    sourceSystem: 'TencentDB-Agent-Memory',
    sourceVersion: optionalString(fixture['version'], 'version') ?? 'fixture',
    externalContract: 'tdai-gateway-http',
    description:
      'Fixture adapter for TencentDB-Agent-Memory gateway recall, capture, search, session, and health contracts.',
    configFields: configFieldsFromConfigRecord(config),
    configFingerprint: 'fixture-redacted-tdai-gateway',
    compatibilityNotes: notes
  });
  const capability = createAgentCapability({
    manifest,
    providedTools,
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        const confidence = optionalNumber(
          recall.response['confidence'],
          'endpoints.recall.response.confidence'
        );
        const contextItem = createMemoryContextItem({
          capabilityId: manifestId,
          id: 'tdai.recall.fixture',
          text: requiredString(
            recall.response['context'],
            'endpoints.recall.response.context'
          ),
          sourceId: 'tdai.recall.fixture',
          sourceTitle: 'TencentDB /recall fixture',
          sourceUri: 'fixture://tencentdb/recall',
          estimatedTokens: optionalPositiveInteger(
            recall.response['estimatedTokens'],
            'endpoints.recall.response.estimatedTokens'
          ) ?? 64,
          ...(confidence === undefined ? {} : { confidence })
        });

        return Object.freeze({
          contextItems: Object.freeze([contextItem]),
          runtimeNotes: Object.freeze([
            `TencentDB recall strategy: ${
              optionalString(
                recall.response['strategy'],
                'endpoints.recall.response.strategy'
              ) ?? 'unspecified'
            }`
          ]),
          evidence: Object.freeze([
            createEvidence({
              capabilityId: manifestId,
              context,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Mapped TencentDB /recall fixture into memory context.',
              sourceReferences: contextItem.sourceReferences,
              ...(manifest.config.fingerprint === undefined
                ? {}
                : { configFingerprint: manifest.config.fingerprint })
            })
          ])
        });
      },
      handleToolCall(call, context) {
        if (call.toolName === 'memory_tencentdb.memory_search') {
          return createAcceptedToolCallResult({
            capabilityId: manifestId,
            call,
            context,
            output: endpointToolOutput(searchMemories),
            summary: 'Mapped TencentDB /search/memories fixture response.'
          });
        }

        if (call.toolName === 'memory_tencentdb.conversation_search') {
          return createAcceptedToolCallResult({
            capabilityId: manifestId,
            call,
            context,
            output: endpointToolOutput(searchConversations),
            summary:
              'Mapped TencentDB /search/conversations fixture response.'
          });
        }

        return createRejectedToolCallResult({
          capabilityId: manifestId,
          call,
          context,
          reason: 'unsupported_fixture_tool',
          message: `TencentDB fixture does not map tool ${call.toolName}.`
        });
      },
      afterTurnCommitted(context) {
        return createCompletedHookResult({
          capabilityId: manifestId,
          context,
          evidenceKind: 'after_turn_committed',
          summary: `Mapped TencentDB /capture response: ${JSON.stringify(
            endpointToolOutput(capture)
          )}.`
        });
      },
      onSessionEnd(context) {
        return createCompletedHookResult({
          capabilityId: manifestId,
          context,
          evidenceKind: 'session_end',
          summary: `Mapped TencentDB /session/end response: ${JSON.stringify(
            endpointToolOutput(sessionEnd)
          )}.`
        });
      },
      health(context) {
        return healthSnapshotFromEndpoint({
          capabilityId: manifestId,
          context,
          endpoint: health
        });
      }
    }
  });

  return freezeMapping({ capability, compatibilityNotes: notes });
}

export function mapHermesMemoryProviderFixture(
  value: unknown
): AgentCapabilityAdapterMapping {
  const fixture = requiredRecord(value, 'Hermes provider fixture');
  const behavior = requiredRecord(fixture['behavior'], 'behavior');
  const prefetch = requiredRecord(behavior['prefetch'], 'behavior.prefetch');
  const sync = requiredRecord(behavior['sync'], 'behavior.sync');
  const sessionEnd = requiredRecord(
    behavior['sessionEnd'],
    'behavior.sessionEnd'
  );
  const health = requiredRecord(behavior['health'], 'behavior.health');
  const searchTools = recordsArray(behavior['searchTools'], 'behavior.searchTools');
  const config = requiredRecord(fixture['config'], 'config');
  const degradation = requiredRecord(fixture['degradation'], 'degradation');
  const manifestId = 'hermes.memory_tencentdb.fixture';
  const notes = [
    createCompatibilityNote({
      sourceSystem: 'hermes',
      fieldPath: 'behavior.prefetch',
      disposition: 'mapped',
      evidence: 'Hermes prefetch maps to beforeRoleModelCall recall context.'
    }),
    createCompatibilityNote({
      sourceSystem: 'hermes',
      fieldPath: 'behavior.sync',
      disposition: 'mapped',
      evidence: 'Hermes sync maps to afterTurnCommitted capture.'
    }),
    createCompatibilityNote({
      sourceSystem: 'hermes',
      fieldPath: 'degradation',
      disposition: 'mapped',
      evidence:
        'Circuit-breaker and back-pressure metadata map into compatibility notes and health summary.'
    }),
    ...unsupportedNotesFromFixture(fixture, 'hermes')
  ];
  const manifest = createMemoryGatewayManifest({
    id: manifestId,
    displayName: optionalString(fixture['displayName'], 'displayName') ??
      'Hermes memory provider fixture',
    sourceSystem: 'hermes',
    sourceVersion: optionalString(fixture['version'], 'version') ?? 'fixture',
    externalContract: 'hermes-memory-provider',
    description:
      'Fixture adapter for Hermes memory provider prefetch, sync, search, session, health, and degradation metadata.',
    configFields: configFieldsFromConfigRecord(config),
    configFingerprint: 'fixture-redacted-hermes-provider',
    compatibilityNotes: notes
  });
  const providedTools = searchTools.map((tool) =>
    createProvidedToolFromSchema({
      name: requiredString(tool['name'], 'behavior.searchTools.name'),
      description: requiredString(
        tool['description'],
        'behavior.searchTools.description'
      ),
      inputContract: inputContractFromSchema(
        requiredRecord(tool['inputSchema'], 'behavior.searchTools.inputSchema')
      ),
      validationOwner: 'adapter',
      sideEffectLevel: 'external_read',
      sourceReferencesRequired: true,
      maxCallsPerUserTurn: 2
    })
  );
  const capability = createAgentCapability({
    manifest,
    providedTools,
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        const confidence = optionalNumber(
          prefetch['confidence'],
          'prefetch.confidence'
        );
        const contextItem = createMemoryContextItem({
          capabilityId: manifestId,
          id: 'hermes.prefetch.fixture',
          text: requiredString(prefetch['context'], 'behavior.prefetch.context'),
          sourceId: 'hermes.prefetch.fixture',
          sourceTitle: 'Hermes prefetch fixture',
          sourceUri: 'fixture://hermes/prefetch',
          estimatedTokens:
            optionalPositiveInteger(
              prefetch['estimatedTokens'],
              'behavior.prefetch.estimatedTokens'
            ) ?? 72,
          ...(confidence === undefined ? {} : { confidence })
        });

        return Object.freeze({
          contextItems: Object.freeze([contextItem]),
          runtimeNotes: Object.freeze([
            `Hermes degradation: ${degradationSummary(degradation)}`
          ]),
          evidence: Object.freeze([
            createEvidence({
              capabilityId: manifestId,
              context,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: 'Mapped Hermes prefetch fixture into memory context.',
              sourceReferences: contextItem.sourceReferences,
              ...(manifest.config.fingerprint === undefined
                ? {}
                : { configFingerprint: manifest.config.fingerprint })
            })
          ])
        });
      },
      handleToolCall(call, context) {
        const tool = searchTools.find(
          (candidate) =>
            requiredString(candidate['name'], 'behavior.searchTools.name') ===
            call.toolName
        );

        if (tool === undefined) {
          return createRejectedToolCallResult({
            capabilityId: manifestId,
            call,
            context,
            reason: 'unsupported_fixture_tool',
            message: `Hermes fixture does not map tool ${call.toolName}.`
          });
        }

        return createAcceptedToolCallResult({
          capabilityId: manifestId,
          call,
          context,
          output: jsonObjectFromRecord(
            requiredRecord(tool['fixtureResponse'], 'fixtureResponse')
          ),
          summary: `Mapped Hermes search tool ${call.toolName}.`
        });
      },
      afterTurnCommitted(context) {
        return createCompletedHookResult({
          capabilityId: manifestId,
          context,
          evidenceKind: 'after_turn_committed',
          summary: `Mapped Hermes sync response: ${JSON.stringify(
            jsonObjectFromRecord(sync)
          )}.`
        });
      },
      onSessionEnd(context) {
        return createCompletedHookResult({
          capabilityId: manifestId,
          context,
          evidenceKind: 'session_end',
          summary: `Mapped Hermes session-end response: ${JSON.stringify(
            jsonObjectFromRecord(sessionEnd)
          )}.`
        });
      },
      health(context) {
        return createAgentCapabilityHealthSnapshot({
          capabilityId: manifestId,
          status: healthStatusFromString(
            optionalString(health['status'], 'behavior.health.status') ??
              'degraded'
          ),
          checkedAt: context.timestamp,
          summary: `Hermes health fixture; ${degradationSummary(degradation)}.`,
          redactionLabels: Object.freeze(['secret'])
        });
      }
    }
  });

  return freezeMapping({ capability, compatibilityNotes: notes });
}

export function mapMcpToolsResourcesFixture(
  value: unknown
): AgentCapabilityAdapterMapping {
  const fixture = requiredRecord(value, 'MCP fixture');
  const server = requiredRecord(fixture['server'], 'server');
  const protocolVersion = requiredString(
    fixture['protocolVersion'],
    'protocolVersion'
  );
  const tools = recordsArray(fixture['tools'], 'tools');
  const resources = recordsArray(fixture['resources'], 'resources');
  const manifestId = 'mcp.tools_resources.fixture';
  const notes = [
    createCompatibilityNote({
      sourceSystem: 'model-context-protocol',
      fieldPath: 'tools',
      disposition: 'mapped',
      evidence: 'MCP tool declarations map to local providedTools.'
    }),
    createCompatibilityNote({
      sourceSystem: 'model-context-protocol',
      fieldPath: 'resources',
      disposition: 'mapped',
      evidence:
        'MCP resource declarations map to beforeRoleModelCall context resources.'
    }),
    ...unsupportedNotesFromFixture(fixture, 'model-context-protocol')
  ];
  const manifest = createAgentCapabilityManifestForAdapter({
    id: manifestId,
    displayName:
      optionalString(server['name'], 'server.name') ?? 'MCP fixture server',
    version: `${protocolVersion}-fixture`,
    kind: 'bridge_adapter',
    description:
      'Fixture adapter for MCP 2025-06-18 tools and resources mapped into the local capability contract.',
    sourceSystem: 'model-context-protocol',
    sourceVersion: protocolVersion,
    externalContract: 'mcp-tools-resources',
    declaredCapabilities: [
      'tool_provider',
      'handle_tool_call',
      'context_provider',
      'before_role_model_call',
      'health'
    ],
    configFields: [
      createConfigField({
        name: 'server_id',
        description: 'Static MCP fixture server id.',
        required: true,
        secret: false
      })
    ],
    runtimePolicy: createAdapterPolicy({
      sideEffectLevel: 'external_read',
      timeoutMs: 1000,
      sourceReferencesRequired: true
    }),
    activationReasons: ['mcp_fixture_mapping'],
    compatibilityNotes: notes
  });
  const providedTools = tools.map((tool) =>
    createProvidedToolFromSchema({
      name: requiredString(tool['name'], 'tools.name'),
      description: requiredString(tool['description'], 'tools.description'),
      inputContract: inputContractFromSchema(
        requiredRecord(tool['inputSchema'], 'tools.inputSchema')
      ),
      validationOwner: 'adapter',
      sideEffectLevel: 'external_read',
      sourceReferencesRequired: true,
      maxCallsPerUserTurn: 2
    })
  );
  const capability = createAgentCapability({
    manifest,
    providedTools,
    lifecycleHooks: {
      beforeRoleModelCall(context) {
        const contextItems = resources.map((resource, index) =>
          createAgentCapabilityContextItem({
            capabilityId: manifestId,
            id: `mcp.resource.${String(index + 1)}`,
            kind: 'resource',
            text: requiredString(resource['fixtureText'], 'resources.fixtureText'),
            budget: {
              estimatedTokens:
                optionalPositiveInteger(
                  resource['estimatedTokens'],
                  'resources.estimatedTokens'
                ) ?? 80,
              priority: index + 1
            },
            sourceReferences: [
              {
                kind: 'resource',
                id: `mcp.resource.${String(index + 1)}`,
                title: requiredString(resource['name'], 'resources.name'),
                uri: requiredString(resource['uri'], 'resources.uri')
              }
            ],
            redactionLabels: []
          })
        );

        return Object.freeze({
          contextItems: Object.freeze(contextItems),
          runtimeNotes: Object.freeze([
            `Mapped ${String(resources.length)} MCP resources for ${protocolVersion}.`
          ]),
          evidence: Object.freeze([
            createEvidence({
              capabilityId: manifestId,
              context,
              evidenceKind: 'before_role_model_call',
              status: 'accepted',
              summary: `Mapped ${String(resources.length)} MCP fixture resources into context.`,
              sourceReferences: contextItems.flatMap(
                (item) => item.sourceReferences
              )
            })
          ])
        });
      },
      handleToolCall(call, context) {
        const tool = tools.find(
          (candidate) =>
            requiredString(candidate['name'], 'tools.name') === call.toolName
        );

        if (tool === undefined) {
          return createRejectedToolCallResult({
            capabilityId: manifestId,
            call,
            context,
            reason: 'unsupported_fixture_tool',
            message: `MCP fixture does not map tool ${call.toolName}.`
          });
        }

        return createAcceptedToolCallResult({
          capabilityId: manifestId,
          call,
          context,
          output: jsonObjectFromRecord(
            requiredRecord(tool['fixtureResponse'], 'tools.fixtureResponse')
          ),
          summary: `Mapped MCP tool ${call.toolName}.`
        });
      },
      health(context) {
        return createAgentCapabilityHealthSnapshot({
          capabilityId: manifestId,
          status: 'ok',
          checkedAt: context.timestamp,
          summary: `MCP fixture server ${requiredString(
            server['id'],
            'server.id'
          )} is static and available.`,
          redactionLabels: []
        });
      }
    }
  });

  return freezeMapping({ capability, compatibilityNotes: notes });
}

export function mapFirstPartyModelToolsCapability(): AgentCapabilityAdapterMapping {
  const capability = createFirstPartyModelToolsCapability();
  const notes = [
    createCompatibilityNote({
      sourceSystem: 'project02',
      fieldPath: 'builtInModelToolDefinitionsForUserTurn',
      disposition: 'mapped',
      evidence:
        'First-party built-in tools are represented through AgentCapability without changing validationOwner or input contracts.'
    })
  ];

  return freezeMapping({ capability, compatibilityNotes: notes });
}

function createOpenClawManifest(options: {
  readonly fixture: JsonRecord;
  readonly manifestId: string;
  readonly configFields: readonly AgentCapabilityConfigField[];
  readonly activationReasons: readonly string[];
  readonly sourceVersion: string;
  readonly compatibilityNotes: readonly AgentCapabilityAdapterCompatibilityNote[];
}): AgentCapabilityManifest {
  return createAgentCapabilityManifestForAdapter({
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
      'OpenClaw memory plugin fixture mapped into the local capability contract.',
    sourceSystem: 'openclaw',
    sourceVersion: options.sourceVersion,
    externalContract: 'openclaw.plugin.json',
    declaredCapabilities: ['tool_provider', 'handle_tool_call', 'health'],
    configFields: options.configFields,
    runtimePolicy: createAdapterPolicy({
      sideEffectLevel: 'runtime_read',
      timeoutMs: 1000,
      sourceReferencesRequired: true
    }),
    activationReasons: options.activationReasons,
    compatibilityNotes: options.compatibilityNotes
  });
}

function createMemoryGatewayManifest(options: {
  readonly id: string;
  readonly displayName: string;
  readonly sourceSystem: string;
  readonly sourceVersion: string;
  readonly externalContract: string;
  readonly description: string;
  readonly configFields: readonly AgentCapabilityConfigField[];
  readonly configFingerprint: string;
  readonly compatibilityNotes: readonly AgentCapabilityAdapterCompatibilityNote[];
}): AgentCapabilityManifest {
  return createAgentCapabilityManifestForAdapter({
    id: options.id,
    displayName: options.displayName,
    version: options.sourceVersion,
    kind: 'memory_provider',
    description: options.description,
    sourceSystem: options.sourceSystem,
    sourceVersion: options.sourceVersion,
    externalContract: options.externalContract,
    declaredCapabilities: [
      'context_provider',
      'before_role_model_call',
      'tool_provider',
      'handle_tool_call',
      'after_turn_committed',
      'on_session_end',
      'health'
    ],
    configFields: options.configFields,
    configFingerprint: options.configFingerprint,
    runtimePolicy: createAdapterPolicy({
      sideEffectLevel: 'local_memory_write',
      timeoutMs: 2000,
      sourceReferencesRequired: true,
      redactionLabels: ['secret']
    }),
    activationReasons: ['memory_fixture_mapping'],
    compatibilityNotes: options.compatibilityNotes
  });
}

function createAgentCapabilityManifestForAdapter(options: {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly kind: AgentCapabilityManifest['kind'];
  readonly description: string;
  readonly sourceSystem: string;
  readonly sourceVersion: string;
  readonly externalContract: string;
  readonly declaredCapabilities: readonly AgentCapabilityDeclaration[];
  readonly configFields: readonly AgentCapabilityConfigField[];
  readonly configFingerprint?: string;
  readonly runtimePolicy: AgentCapabilityRuntimePolicy;
  readonly activationReasons: readonly string[];
  readonly compatibilityNotes: readonly AgentCapabilityAdapterCompatibilityNote[];
}): AgentCapabilityManifest {
  return {
    id: options.id,
    displayName: options.displayName,
    version: options.version,
    kind: options.kind,
    description: options.description,
    contractVersion: agentCapabilityContractVersion,
    compatibility: {
      hostContractVersions: [agentCapabilityContractVersion],
      sourceSystem: options.sourceSystem,
      sourceVersion: options.sourceVersion,
      externalContract: options.externalContract,
      notes: options.compatibilityNotes.map(
        (note) => `${note.disposition}:${note.fieldPath}:${note.evidence}`
      )
    },
    declaredCapabilities: options.declaredCapabilities,
    config: {
      fields: options.configFields,
      ...(options.configFingerprint === undefined
        ? {}
        : { fingerprint: options.configFingerprint })
    },
    localTrustLevel: 'test_fixture',
    runtimePolicy: options.runtimePolicy,
    activation: {
      defaultEnabled: false,
      reasons: options.activationReasons
    }
  };
}

function createAdapterPolicy(options: {
  readonly sideEffectLevel: AgentCapabilitySideEffectLevel;
  readonly timeoutMs: number;
  readonly sourceReferencesRequired: boolean;
  readonly redactionLabels?: readonly string[];
}): AgentCapabilityRuntimePolicy {
  return {
    requiredForTurn: false,
    sideEffectLevel: options.sideEffectLevel,
    confirmation: 'not_required',
    timeoutMs: options.timeoutMs,
    sourceReferencesRequired: options.sourceReferencesRequired,
    redactionLabels: options.redactionLabels ?? [],
    failureBehavior: {
      beforeRoleModelCall: 'degrade',
      handleToolCall: 'degrade',
      afterTurnCommitted: 'log_failure',
      health: 'degrade'
    }
  };
}

function createProvidedToolFromSchema(options: {
  readonly name: string;
  readonly description: string;
  readonly inputContract: ModelToolInputContract;
  readonly validationOwner: AgentCapabilityToolValidationOwner;
  readonly sideEffectLevel: AgentCapabilitySideEffectLevel;
  readonly sourceReferencesRequired: boolean;
  readonly maxCallsPerUserTurn?: number;
}): AgentCapabilityProvidedTool {
  return {
    name: options.name,
    description: options.description,
    requiredForUserTurn: false,
    maxCallsPerUserTurn: options.maxCallsPerUserTurn ?? 1,
    inputContract: options.inputContract,
    validationOwner: options.validationOwner,
    sideEffectLevel: options.sideEffectLevel,
    requiresConfirmation: false,
    sourceReferencesRequired: options.sourceReferencesRequired
  };
}

function configFieldsFromSchema(
  schema: JsonRecord
): readonly AgentCapabilityConfigField[] {
  const properties = optionalRecord(schema['properties'], 'schema.properties');
  const required = new Set(
    optionalStringArray(schema['required'], 'schema.required')
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
            `schema.properties.${name}.description`
          ) ?? `Configuration field ${name}.`,
        required: required.has(name),
        secret
      });
    })
  );
}

function configFieldsFromConfigRecord(
  config: JsonRecord
): readonly AgentCapabilityConfigField[] {
  return Object.freeze(
    Object.entries(config).map(([name, value]) => {
      const configField = requiredRecord(value, `config.${name}`);
      const secret =
        optionalBoolean(configField['secret'], `config.${name}.secret`) ??
        isSecretConfigField(name, configField);

      return createConfigField({
        name,
        description:
          optionalString(configField['description'], `config.${name}.description`) ??
          `Configuration field ${name}.`,
        required:
          optionalBoolean(configField['required'], `config.${name}.required`) ??
          false,
        secret
      });
    })
  );
}

function createConfigField(options: {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
}): AgentCapabilityConfigField {
  return {
    name: options.name,
    description: options.description,
    required: options.required,
    secret: options.secret,
    redactionLabels: options.secret ? ['secret'] : []
  };
}

function inputContractFromSchema(schema: JsonRecord): ModelToolInputContract {
  const properties = optionalRecord(schema['properties'], 'schema.properties');
  const required = new Set(
    optionalStringArray(schema['required'], 'schema.required')
  );
  const fields =
    properties === undefined
      ? []
      : Object.entries(properties).map(([name, value]) =>
          inputFieldFromSchemaProperty({
            name,
            property: requiredRecord(value, `schema.properties.${name}`),
            required: required.has(name)
          })
        );

  return {
    type: 'object',
    fields: Object.freeze(fields),
    additionalFields: schema['additionalProperties'] !== false
  };
}

function inputFieldFromSchemaProperty(options: {
  readonly name: string;
  readonly property: JsonRecord;
  readonly required: boolean;
}): ModelToolInputField {
  const allowedValues = optionalStringArray(
    options.property['enum'],
    `schema.properties.${options.name}.enum`
  );
  const valueType = modelToolInputFieldValueTypeFromSchema(
    options.property['type']
  );

  return {
    name: options.name,
    description:
      optionalString(
        options.property['description'],
        `schema.properties.${options.name}.description`
      ) ?? `Input field ${options.name}.`,
    required: options.required,
    ...(valueType === undefined ? {} : { valueType }),
    ...(allowedValues.length === 0
      ? {}
      : { allowedValues: Object.freeze([...allowedValues]) })
  };
}

function modelToolInputFieldValueTypeFromSchema(
  value: unknown
): ModelToolInputFieldValueType | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return modelToolInputFieldValueTypes.find((candidate) => candidate === value);
}

function createMemoryContextItem(options: {
  readonly capabilityId: string;
  readonly id: string;
  readonly text: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly sourceUri: string;
  readonly estimatedTokens: number;
  readonly confidence?: number;
}): AgentCapabilityContextItem {
  return createAgentCapabilityContextItem({
    capabilityId: options.capabilityId,
    id: options.id,
    kind: 'memory',
    text: options.text,
    budget: {
      estimatedTokens: options.estimatedTokens,
      priority: 1
    },
    sourceReferences: [
      {
        kind: 'memory',
        id: options.sourceId,
        title: options.sourceTitle,
        uri: options.sourceUri
      }
    ],
    ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
    redactionLabels: ['memory']
  });
}

function createEvidence(options: {
  readonly capabilityId: string;
  readonly context: RuntimeCapabilityContext;
  readonly evidenceKind: AgentCapabilityEvidenceKind;
  readonly status: AgentCapabilityEvidenceStatus;
  readonly summary: string;
  readonly policyOutcome?: string;
  readonly sourceReferences?: readonly AgentCapabilitySourceReference[];
  readonly configFingerprint?: string;
  readonly redactionLabels?: readonly string[];
}): AgentCapabilityEvidenceSnapshot {
  return createAgentCapabilityEvidenceSnapshot({
    eventId: options.context.eventId,
    traceId: options.context.traceId,
    createdAt: options.context.timestamp,
    kind: 'agent_capability_evidence_snapshot',
    capabilityId: options.capabilityId,
    evidenceKind: options.evidenceKind,
    status: options.status,
    summary: options.summary,
    ...(options.policyOutcome === undefined
      ? {}
      : { policyOutcome: options.policyOutcome }),
    ...(options.sourceReferences === undefined
      ? {}
      : { sourceReferences: options.sourceReferences }),
    redactionLabels: options.redactionLabels ?? [],
    ...(options.configFingerprint === undefined
      ? {}
      : { configFingerprint: options.configFingerprint })
  });
}

function createAcceptedToolCallResult(options: {
  readonly capabilityId: string;
  readonly call: AgentCapabilityToolCall;
  readonly context: RuntimeCapabilityContext;
  readonly output: AgentCapabilityJsonValue;
  readonly summary: string;
}): AgentCapabilityToolCallResult {
  return Object.freeze({
    status: 'accepted',
    output: options.output,
    evidence: Object.freeze([
      createEvidence({
        capabilityId: options.capabilityId,
        context: options.context,
        evidenceKind: 'tool_invocation',
        status: 'accepted',
        summary: `${options.summary} Tool: ${options.call.toolName}.`
      })
    ])
  });
}

function createRejectedToolCallResult(options: {
  readonly capabilityId: string;
  readonly call: AgentCapabilityToolCall;
  readonly context: RuntimeCapabilityContext;
  readonly reason: string;
  readonly message: string;
}): AgentCapabilityToolCallResult {
  return Object.freeze({
    status: 'rejected',
    reason: options.reason,
    message: options.message,
    evidence: Object.freeze([
      createEvidence({
        capabilityId: options.capabilityId,
        context: options.context,
        evidenceKind: 'tool_invocation',
        status: 'rejected',
        summary: options.message,
        policyOutcome: 'handler_rejected'
      })
    ])
  });
}

function createCompletedHookResult(options: {
  readonly capabilityId: string;
  readonly context: RuntimeCapabilityContext;
  readonly evidenceKind: AgentCapabilityEvidenceKind;
  readonly summary: string;
}): AgentCapabilityHookResult {
  return Object.freeze({
    status: 'completed',
    evidence: Object.freeze([
      createEvidence({
        capabilityId: options.capabilityId,
        context: options.context,
        evidenceKind: options.evidenceKind,
        status: 'accepted',
        summary: options.summary
      })
    ])
  });
}

function healthSnapshotFromEndpoint(options: {
  readonly capabilityId: string;
  readonly context: RuntimeCapabilityContext;
  readonly endpoint: EndpointFixture;
}): AgentCapabilityHealthSnapshot {
  const statusText =
    optionalString(options.endpoint.response['status'], 'health.status') ?? 'ok';

  return createAgentCapabilityHealthSnapshot({
    capabilityId: options.capabilityId,
    status: healthStatusFromString(statusText),
    checkedAt: options.context.timestamp,
    summary: `Gateway health fixture status ${statusText}.`,
    redactionLabels: Object.freeze(['secret'])
  });
}

function healthStatusFromString(
  value: string
): AgentCapabilityHealthSnapshot['status'] {
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
  name: string
): EndpointFixture {
  const endpoint = requiredRecord(endpoints[name], `endpoints.${name}`);

  return Object.freeze({
    method: requiredString(endpoint['method'], `endpoints.${name}.method`),
    path: requiredString(endpoint['path'], `endpoints.${name}.path`),
    requestSchema:
      optionalRecord(
        endpoint['requestSchema'],
        `endpoints.${name}.requestSchema`
      ) ?? emptyObject(),
    response: requiredRecord(endpoint['response'], `endpoints.${name}.response`)
  });
}

function endpointToolOutput(endpoint: EndpointFixture): AgentCapabilityJsonObject {
  return Object.freeze({
    method: endpoint.method,
    path: endpoint.path,
    response: jsonValueFromUnknown(endpoint.response)
  });
}

function toolDescriptionFromMetadata(
  metadata: JsonRecord | undefined,
  toolName: string
): string {
  const tool = optionalNestedRecord(metadata, toolName, `toolMetadata.${toolName}`);

  return (
    optionalString(tool?.['description'], `toolMetadata.${toolName}.description`) ??
    `OpenClaw fixture tool ${toolName}.`
  );
}

function toolInputSchemaFromMetadata(
  metadata: JsonRecord | undefined,
  toolName: string
): JsonRecord {
  const tool = optionalNestedRecord(metadata, toolName, `toolMetadata.${toolName}`);

  return (
    optionalNestedRecord(tool, 'inputSchema', `toolMetadata.${toolName}.inputSchema`) ??
    emptyObject()
  );
}

function activationReasonsFromOpenClawActivation(
  activation: JsonRecord
): readonly string[] {
  const reasons = ['openclaw_fixture_mapping'];
  const commands = optionalStringArray(activation['commands'], 'activation.commands');

  if (commands.length > 0) {
    reasons.push(`commands:${commands.join(',')}`);
  }

  if (optionalBoolean(activation['onStartup'], 'activation.onStartup') === true) {
    reasons.push('on_startup');
  }

  return Object.freeze(reasons);
}

function degradationSummary(degradation: JsonRecord): string {
  const circuitBreaker = optionalRecord(
    degradation['circuitBreaker'],
    'degradation.circuitBreaker'
  );
  const backPressure = optionalRecord(
    degradation['backPressure'],
    'degradation.backPressure'
  );
  const failureThreshold =
    circuitBreaker === undefined
      ? 'unknown'
      : String(
          optionalPositiveInteger(
            circuitBreaker['failureThreshold'],
            'degradation.circuitBreaker.failureThreshold'
          ) ?? 'unknown'
        );
  const pauseMs =
    circuitBreaker === undefined
      ? 'unknown'
      : String(
          optionalPositiveInteger(
            circuitBreaker['pauseMs'],
            'degradation.circuitBreaker.pauseMs'
          ) ?? 'unknown'
        );
  const maxInFlight =
    backPressure === undefined
      ? 'unknown'
      : String(
          optionalPositiveInteger(
            backPressure['maxInFlight'],
            'degradation.backPressure.maxInFlight'
          ) ?? 'unknown'
        );

  return `circuit breaker threshold ${failureThreshold}, pause ${pauseMs}ms, max in-flight sync ${maxInFlight}`;
}

function createCompatibilityNote(
  options: AgentCapabilityAdapterCompatibilityNote
): AgentCapabilityAdapterCompatibilityNote {
  return Object.freeze({
    sourceSystem: options.sourceSystem,
    fieldPath: options.fieldPath,
    disposition: options.disposition,
    evidence: options.evidence
  });
}

function unsupportedNotesFromFixture(
  fixture: JsonRecord,
  sourceSystem: string
): readonly AgentCapabilityAdapterCompatibilityNote[] {
  const unsupportedFields = recordsArray(
    fixture['unsupportedFields'],
    'unsupportedFields'
  );

  return Object.freeze(
    unsupportedFields.map((field) =>
      createCompatibilityNote({
        sourceSystem,
        fieldPath: requiredString(field['fieldPath'], 'unsupportedFields.fieldPath'),
        disposition: compatibilityDispositionFromString(
          requiredString(
            field['disposition'],
            'unsupportedFields.disposition'
          )
        ),
        evidence: requiredString(field['evidence'], 'unsupportedFields.evidence')
      })
    )
  );
}

function compatibilityDispositionFromString(
  value: string
): AgentCapabilityAdapterCompatibilityDisposition {
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
  mapping: AgentCapabilityAdapterMapping
): AgentCapabilityAdapterMapping {
  return Object.freeze({
    capability: mapping.capability,
    compatibilityNotes: Object.freeze([...mapping.compatibilityNotes])
  });
}

function jsonObjectFromRecord(record: JsonRecord): AgentCapabilityJsonObject {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        jsonValueFromUnknown(value)
      ])
    )
  );
}

function jsonValueFromUnknown(value: unknown): AgentCapabilityJsonValue {
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
  field: string
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
      requiredRecord(item, `${field}[${String(index)}]`)
    )
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

  return Object.freeze(value.map((item) => requiredString(item, field)));
}

function optionalStringArray(
  value: unknown,
  field: string
): readonly string[] {
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
  field: string
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
