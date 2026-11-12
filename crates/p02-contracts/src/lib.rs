#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod access;
mod capability;
mod config;
mod context;
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
    StoreAccess, StoreError, TEXT_FILE_KIB, WriteHold,
};
pub use config::{ConfigField, ConfigSection, ResolvedConfig};
pub use context::{HookContext, TurnIdentity, TurnText};
pub use evidence::{Evidence, EvidenceError, EvidenceNote};
pub use label::{ParseRedactionLabelError, RedactionLabel};
pub use manifest::{Activation, FailureBehavior, Manifest, ManifestError, RuntimePolicy};
pub use output::{
    BeforeRoleModelCallOutput, CommittedTurn, ContextItem, ContextItemError, CuratedSection,
    CuratedSectionError, HookReport, HookStatus, PluginContextItem, PluginCuratedSection,
    SourceReference, SourceReferenceError, contains_forbidden_control_character, within_limits,
};
pub use p02_wire::{AccessLevel, AccessName};
pub use plugin::{
    FactoryInput, Hook, PluginError, PluginFactory, Registration, RegistrationError, RuntimePlugin,
    SetupCheck,
};
pub use role_model::{
    BlankContextTextError, CharacterDecision, ChatCompletionTool, ChatFunctionCall, ChatMessage,
    ChatToolCall, ChatToolFunction, ConversationToolCall, ConversationTurn, DecisionContext,
    DecisionRejection, DecisionRejectionReason, DecisionResult, DuplicateToolError, Invocation,
    ModelOutput, ModelToolCall, ModelToolDefinition, Occasion, PLUGIN_LIST_TOOL,
    ParseModelToolCallError, PluginToolDefinition, PluginToolDefinitions, ProviderAnswer,
    ProviderFailure, ProviderName, Rang, ReasoningFilter, ReplyDelta, RoleModelAdapter,
    RuntimeNote, TextCompletion, TextCompletionRequest, TokenUsage, ToolCallResult, ToolRound,
    VISIBLE_REPLY, WrittenCall, scrub_reasoning_blocks,
};
pub use schema::{InputContractError, ToolInputContract, ToolInputRejection};
pub use tool::{
    Confirmation, ParseToolCallIdError, PreparedEffect, ProvidedTool, ToolCall, ToolCallId,
    ToolCallOutcome, ToolDefinitionError, ToolPreparation,
};
pub use vocabulary::{
    BEFORE_ROLE_MODEL_CALL_REJECTION, BeforeRoleModelCallFailure, CONTRACT_VERSION, ConfigScope,
    ContextItemKind, Declaration, EvidenceKind, EvidenceStatus, HOST_PLUGIN, HandleToolCallFailure,
    PluginKind, PolicyOutcome, SourceKind, ToolConcurrency,
};
