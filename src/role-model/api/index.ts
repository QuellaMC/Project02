/**
 * Plugin-independent contract surface of role-model: the model-tool and
 * chat-wire vocabulary. This is the ONLY role-model barrel plugins/api
 * files may import — anything more would put the plugin contract on an
 * import cycle (plugins/api/types imports this barrel). Everything else
 * exports through the top-level role-model/index.ts.
 */
export {
  builtInModelToolDefinitions,
  builtInModelToolDefinitionsForUserTurn,
  createVisibleReplyModelToolCall,
  freezeBuiltInModelToolCall,
  freezeModelToolCall,
  freezeModelToolCalls,
  freezeModelToolDefinition,
  freezeModelToolJsonSchemaType,
  isBuiltInModelToolName,
  isModelToolJsonSchemaType,
  isModelToolJsonSchemaTypeArray,
  modelToolJsonSchemaTypeValues,
  userTurnBuiltInModelToolNames,
  visibleReplyModelToolName,
  type BuiltInModelToolCall,
  type BuiltInModelToolDefinition,
  type BuiltInModelToolName,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelToolInputContract,
  type ModelToolJsonSchema,
  type ModelToolJsonSchemaType,
  type PluginModelToolCall,
  type VisibleReplyModelToolCall,
  type VisibleReplyModelToolName,
  type VisibleReplyToolInput,
} from './model-tools.ts';
export {
  validateModelToolInputAgainstContract,
  type ModelToolInputValidationResult,
} from './model-tool-input-validation.ts';
export {
  hasDuplicateRoleModelAllowedTools,
  isRoleModelAllowedToolName,
  isRoleModelToolNameSyntax,
  requiredRoleModelIdentifier,
  roleModelAllowedToolNames,
  type RoleModelAllowedToolName,
} from './tool-names.ts';
export {
  freezeRoleModelChatMessage,
  freezeRoleModelChatToolCall,
  type RoleModelAssistantChatMessage,
  type RoleModelChatCompletionTool,
  type RoleModelChatMessage,
  type RoleModelChatToolCall,
  type RoleModelDeveloperChatMessage,
  type RoleModelJsonSchema,
  type RoleModelObjectJsonSchema,
  type RoleModelProviderCapabilities,
  type RoleModelProviderToolNameMapping,
  type RoleModelSystemChatMessage,
  type RoleModelToolChatMessage,
  type RoleModelUserChatMessage,
} from './chat-wire.ts';
