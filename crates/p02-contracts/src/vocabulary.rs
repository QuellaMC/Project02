/// A closed vocabulary of the contract: each value beside its one spelling,
/// which the wire, the records and the messages share.
macro_rules! vocabulary {
    (
        $(#[$meta:meta])*
        $name:ident { $($(#[$variant_meta:meta])* $variant:ident = $text:literal,)+ }
    ) => {
        $(#[$meta])*
        #[derive(
            Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash,
            serde::Serialize, serde::Deserialize,
        )]
        pub enum $name {
            $($(#[$variant_meta])* #[serde(rename = $text)] $variant,)+
        }

        impl $name {
            /// Every value, in the contract's order.
            pub const ALL: &[Self] = &[$(Self::$variant,)+];

            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text,)+
                }
            }

            /// The value spelled `text`, if the vocabulary has one.
            #[must_use]
            pub fn parse(text: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|value| value.as_str() == text)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

pub(crate) use vocabulary;

/// The plugin contract version every manifest names.
pub const CONTRACT_VERSION: &str = "mvp-008.runtime_plugin.v2";

/// The host's own plugin, which manages the others: it lists them, and
/// shows and changes their settings. Its tools are named after it.
pub const HOST_PLUGIN: &str = "runtime.plugin";

/// The reason a turn records when a plugin's `beforeRoleModelCall` rejects it.
pub const BEFORE_ROLE_MODEL_CALL_REJECTION: &str = "plugin_before_role_model_call_rejected";

/// The reason a turn records when a plugin's health check rejects it.
pub const HEALTH_REJECTION: &str = "plugin_health_rejected";

vocabulary! {
    /// What a plugin is for. Only a memory provider changes what the host
    /// does with it: the default memory provider is chosen among them.
    PluginKind {
        FirstParty = "first_party",
        MemoryProvider = "memory_provider",
        ToolProvider = "tool_provider",
        ContextProvider = "context_provider",
        BridgeAdapter = "bridge_adapter",
    }
}

vocabulary! {
    /// What a manifest announces it does: tools, or one hook each. The host
    /// runs only what is declared.
    Declaration {
        ToolProvider = "tool_provider",
        BeforeRoleModelCall = "before_role_model_call",
        HandleToolCall = "handle_tool_call",
        AfterTurnCommitted = "after_turn_committed",
        OnSessionEnd = "on_session_end",
        OnShutdown = "on_shutdown",
        Health = "health",
    }
}

vocabulary! {
    /// A host service a plugin may request.
    AccessName {
        CharacterFileStore = "character_file_store",
        SessionHistory = "session_history",
        PluginDatabase = "plugin_database",
        TurnContext = "turn_context",
        ModelInput = "model_input",
        TrustedContext = "trusted_context",
    }
}

vocabulary! {
    /// How much of a service: ordered, so `Write` satisfies a need for `Read`.
    AccessLevel {
        None = "none",
        Read = "read",
        Write = "write",
    }
}

vocabulary! {
    /// Whether calls of one tool may overlap within a model round.
    ToolConcurrency {
        Shared = "shared",
        Exclusive = "exclusive",
    }
}

vocabulary! {
    /// What a failed `beforeRoleModelCall` does to the turn.
    BeforeRoleModelCallFailure {
        RejectTurn = "reject_turn",
        Degrade = "degrade",
    }
}

vocabulary! {
    /// How a failed `handleToolCall` is recorded; the call is refused either way.
    HandleToolCallFailure {
        RejectToolCall = "reject_tool_call",
        Degrade = "degrade",
    }
}

vocabulary! {
    /// What a failed health check does to the turn.
    HealthFailure {
        Degrade = "degrade",
        RejectTurn = "reject_turn",
    }
}

vocabulary! {
    /// What a context item is, which decides where the host renders it.
    ContextItemKind {
        Memory = "memory",
        Resource = "resource",
        RuntimeNote = "runtime_note",
        ToolResult = "tool_result",
        Discovery = "discovery",
    }
}

vocabulary! {
    /// What a source reference points at.
    SourceKind {
        Memory = "memory",
        Conversation = "conversation",
        Resource = "resource",
        ExternalContract = "external_contract",
        Runtime = "runtime",
    }
}

vocabulary! {
    /// The step an evidence record describes.
    EvidenceKind {
        Registration = "registration",
        BeforeRoleModelCall = "before_role_model_call",
        ToolInvocation = "tool_invocation",
        AfterTurnCommitted = "after_turn_committed",
        SessionEnd = "session_end",
        Shutdown = "shutdown",
        Health = "health",
        Policy = "policy",
    }
}

vocabulary! {
    /// How the described step ended.
    EvidenceStatus {
        Accepted = "accepted",
        Rejected = "rejected",
        Degraded = "degraded",
        Failed = "failed",
    }
}

vocabulary! {
    /// The rule that decided the described step.
    PolicyOutcome {
        RegistrationAccepted = "registration_accepted",
        AvailableForTurn = "available_for_turn",
        OptionalDegraded = "optional_degraded",
        RequiredRejected = "required_rejected",
        DisallowedToolCall = "disallowed_tool_call",
        HandlerRejected = "handler_rejected",
        UserApproved = "user_approved",
        Timeout = "timeout",
        HealthDegraded = "health_degraded",
        AfterCommitFailed = "after_commit_failed",
    }
}

vocabulary! {
    /// A health check's verdict.
    HealthStatus {
        Ok = "ok",
        Degraded = "degraded",
        Unavailable = "unavailable",
    }
}

vocabulary! {
    /// The kind of value a config field holds. Whether it holds a
    /// credential is the field's `secret` flag alone to say.
    ConfigValueType {
        String = "string",
        Number = "number",
        Boolean = "boolean",
        Object = "object",
        Array = "array",
        Path = "path",
        Enum = "enum",
    }
}

vocabulary! {
    /// Which settings may set a config section or field: the home's with
    /// a character's on top, a character's alone, or the home's alone.
    ConfigScope {
        GlobalWithCharacterOverrides = "global_with_character_overrides",
        CharacterOnly = "character_only",
        GlobalOnly = "global_only",
    }
}

vocabulary! {
    /// The machine reason a refused manifest, tool or plugin output names.
    ValidationFailureReason {
        MalformedManifest = "malformed_manifest",
        UnsupportedContractVersion = "unsupported_contract_version",
        UnsupportedPluginKind = "unsupported_plugin_kind",
        DuplicateDeclaration = "duplicate_declaration",
        MissingRequiredDeclaration = "missing_required_declaration",
        MalformedToolDefinition = "malformed_tool_definition",
        MalformedContextItem = "malformed_context_item",
        MalformedCuratedContextSection = "malformed_curated_context_section",
        DuplicatePluginId = "duplicate_plugin_id",
    }
}
