use p02_shared::vocabulary;

/// The plugin contract version every manifest names.
pub const CONTRACT_VERSION: &str = "mvp-008.runtime_plugin.v2";

/// The host's own plugin, which manages the others: it lists them, and
/// shows and changes their settings. Its tools are named after it.
pub const HOST_PLUGIN: &str = "runtime.plugin";

/// The reason a turn records when a plugin's `beforeRoleModelCall` rejects it.
pub const BEFORE_ROLE_MODEL_CALL_REJECTION: &str = "plugin_before_role_model_call_rejected";

vocabulary! {
    /// What a plugin is for, as a listing of the plugins says it. The host
    /// runs every kind alike.
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
        OnShutdown = "on_shutdown",
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
    /// What a context item is, which decides where the host renders it.
    ContextItemKind {
        Memory = "memory",
        Resource = "resource",
        RuntimeNote = "runtime_note",
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
        BeforeRoleModelCall = "before_role_model_call",
        ToolInvocation = "tool_invocation",
        AfterTurnCommitted = "after_turn_committed",
        Shutdown = "shutdown",
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
        OptionalDegraded = "optional_degraded",
        RequiredRejected = "required_rejected",
        HandlerRejected = "handler_rejected",
        UserApproved = "user_approved",
        Timeout = "timeout",
        AfterCommitFailed = "after_commit_failed",
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
