#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod access;
mod capability;
mod config;
mod context;
mod descriptor;
mod evidence;
mod label;
mod manifest;
mod output;
mod plugin;
mod role_model;
mod schema;
mod tool;
mod vocabulary;

pub use access::{AccessMap, AccessMapError};
pub use capability::{
    CharacterStorage, DatabaseError, DatabaseOpener, FileStore, FileStoreBackend, HistoryCursor,
    HistoryMessage, LeasedFiles, LeasedStore, MessageBatch, PluginDatabase, ReadMessages,
    SessionHistory, SessionHistoryError, SessionHistoryFeed, SessionListing, SessionSummary,
    StoreAccess, StoreError, WriteHold,
};
pub use config::{ConfigField, ConfigSection, MissingConfigValueError, ResolvedConfig};
pub use context::{HookContext, TurnIdentity, TurnText};
pub use descriptor::{DESCRIPTOR_FORMAT, DescriptorError};
pub use evidence::{Evidence, EvidenceError, EvidenceNote};
pub use label::{ParseRedactionLabelError, RedactionLabel, merged_labels};
pub use manifest::{
    Activation, Compatibility, FailureBehavior, Manifest, ManifestError, RuntimePolicy,
};
pub use output::{
    BeforeRoleModelCallOutput, CommittedTurn, ContextItem, ContextItemError, CuratedSection,
    CuratedSectionError, HealthReport, HealthSnapshot, HealthSnapshotError, HookReport, HookStatus,
    PluginContextItem, PluginCuratedSection, SourceReference, SourceReferenceError,
    contains_forbidden_control_character, within_limits,
};
pub use plugin::{
    FactoryInput, Hook, PluginError, PluginFactory, Registration, RegistrationError, RuntimePlugin,
};
pub use role_model::{
    BlankContextTextError, CharacterDecision, ChatCompletionTool, ChatFunctionCall, ChatMessage,
    ChatToolCall, ChatToolFunction, ContextRole, ConversationToolCall, ConversationTurn,
    DECISION_CONTRACT_VERSION, DECISION_OUTPUT_CONTRACT, DecisionContext, DecisionRejection,
    DecisionRejectionReason, DecisionResult, DuplicateToolError, ExchangeProvider, ExchangeRecord,
    FrameSize, HistoryWindow, InputEnvelope, Invocation, ModelToolCall, ModelToolDefinition,
    OutputContract, PLUGIN_LIST_TOOL, ParseDecisionError, ParseModelToolCallError,
    PluginToolDefinition, PluginToolDefinitions, PromptSize, PromptSizeError, ProviderAnswer,
    ProviderCapabilities, ProviderExchange, ProviderFailure, ProviderMetadata, ProviderName,
    ProviderRequest, ProviderResponse, RawOutput, ReasoningFilter, ReasoningLeakError,
    ReasoningParameterStyle, ReplyDelta, RoleModelAdapter, RuntimeNote, TextCompletion,
    TextCompletionRequest, ToolCallResult, ToolNameMapping, ToolRound, VISIBLE_REPLY,
    scrub_reasoning_blocks,
};
pub use schema::{InputContractError, ToolInputContract, ToolInputRejection};
pub use tool::{
    Confirmation, ParseToolCallIdError, PreparedEffect, ProvidedTool, ToolCall, ToolCallId,
    ToolCallOutcome, ToolDefinitionError, ToolPreparation,
};
pub use vocabulary::{
    AccessLevel, AccessName, BEFORE_ROLE_MODEL_CALL_REJECTION, BeforeRoleModelCallFailure,
    CONTRACT_VERSION, ConfigScope, ConfigValueType, ContextItemKind, Declaration, EvidenceKind,
    EvidenceStatus, HEALTH_REJECTION, HOST_PLUGIN, HandleToolCallFailure, HealthFailure,
    HealthStatus, PluginKind, PolicyOutcome, SourceKind, ToolConcurrency, ValidationFailureReason,
};
