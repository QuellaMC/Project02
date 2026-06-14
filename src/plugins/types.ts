import type {
  AgentCapabilityContextItem,
  AgentCapabilityEvidenceSnapshot,
  AgentCapabilityJsonValue,
  AgentCapabilityProvidedTool,
  AgentCapabilityToolCall,
  AgentCapabilityToolCallResult,
  RuntimeCapabilityContext
} from '../agent-capabilities.ts';
import type { RoleModelCapabilityToolDefinition } from '../role-model-contracts.ts';

export type RuntimePluginApiGrant = 'file_store';

export type RuntimePluginManifest = {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly requestedApis: readonly RuntimePluginApiGrant[];
};

export type RuntimePluginFileStore = {
  readJson(path: string): AgentCapabilityJsonValue | undefined;
  writeJsonAtomic(path: string, value: AgentCapabilityJsonValue): void;
  appendJsonl(path: string, value: AgentCapabilityJsonValue): void;
  revision(): number;
};

export type RuntimePluginToolContext = RuntimeCapabilityContext & {
  readonly pluginId: string;
  readonly fileStore?: RuntimePluginFileStore;
};

export type RuntimePluginBeforeRoleModelCallResult = {
  readonly contextItems: readonly AgentCapabilityContextItem[];
  readonly runtimeNotes: readonly string[];
  readonly evidence: readonly AgentCapabilityEvidenceSnapshot[];
};

export type RuntimePlugin = {
  readonly manifest: RuntimePluginManifest;
  readonly providedTools: readonly AgentCapabilityProvidedTool[];
  beforeRoleModelCall?(
    context: RuntimePluginToolContext
  ):
    | RuntimePluginBeforeRoleModelCallResult
    | Promise<RuntimePluginBeforeRoleModelCallResult>;
  handleToolCall?(
    call: AgentCapabilityToolCall,
    context: RuntimePluginToolContext
  ): AgentCapabilityToolCallResult | Promise<AgentCapabilityToolCallResult>;
};

export type RuntimePluginToolRouting = {
  readonly pluginId: string;
  readonly definition: RoleModelCapabilityToolDefinition;
};
