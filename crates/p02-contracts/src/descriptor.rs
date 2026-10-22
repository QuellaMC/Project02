use serde_json::Value;

use crate::manifest::{Manifest, ManifestError};

/// The format of `project02.plugin.json`: a plugin's one authored manifest,
/// compiled into the daemon with the plugin's code.
pub const DESCRIPTOR_FORMAT: &str = "project02.plugin.v2";

/// Why a descriptor was refused.
#[derive(Debug, thiserror::Error)]
pub enum DescriptorError {
    #[error("plugin descriptor is not JSON")]
    NotJson(#[source] serde_json::Error),
    #[error("plugin descriptor must be an object")]
    NotAnObject,
    #[error("plugin descriptor has unknown key \"{key}\"")]
    UnknownKey { key: String },
    #[error("plugin descriptor \"$schema\" must be a string")]
    SchemaNotAString,
    #[error("plugin descriptor manifest is invalid")]
    Manifest(#[source] ManifestError),
    #[error("plugin descriptor format must be \"{DESCRIPTOR_FORMAT}\"")]
    UnsupportedFormat,
}

impl Manifest {
    /// Reads a plugin descriptor: an object of `format`, `manifest` and an
    /// optional `$schema` for editors, which is otherwise ignored. The
    /// manifest is judged before the format, so a manifest's own refusal is
    /// what an author of an old descriptor sees first.
    ///
    /// # Errors
    ///
    /// [`DescriptorError`] for the first rule the descriptor breaks.
    pub fn from_descriptor(text: &str) -> Result<Self, DescriptorError> {
        let value: Value = serde_json::from_str(text).map_err(DescriptorError::NotJson)?;
        let Value::Object(entries) = &value else {
            return Err(DescriptorError::NotAnObject);
        };

        if let Some(key) = entries
            .keys()
            .filter(|key| !["$schema", "format", "manifest"].contains(&key.as_str()))
            .min()
        {
            return Err(DescriptorError::UnknownKey { key: key.clone() });
        }

        if entries
            .get("$schema")
            .is_some_and(|schema| !schema.is_string())
        {
            return Err(DescriptorError::SchemaNotAString);
        }

        let manifest = Self::from_value(entries.get("manifest").unwrap_or(&Value::Null))
            .map_err(DescriptorError::Manifest)?;

        if entries.get("format").and_then(Value::as_str) == Some(DESCRIPTOR_FORMAT) {
            Ok(manifest)
        } else {
            Err(DescriptorError::UnsupportedFormat)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::*;
    use crate::access::AccessMap;
    use crate::vocabulary::{
        AccessLevel, AccessName, BeforeRoleModelCallFailure, ConfigScope, Declaration,
        HandleToolCallFailure, PluginKind,
    };

    /// A bundled plugin's descriptor, read where p02-plugins keeps it beside
    /// the plugin's code, in the module named after its id.
    fn bundled(id: &str) -> Manifest {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../p02-plugins/src")
            .join(id.replace('-', "_"))
            .join("project02.plugin.json");
        let text = p02_shared::read_text_lossy(&path).unwrap();

        Manifest::from_descriptor(&text).unwrap_or_else(|error| panic!("{id}: {error:?}"))
    }

    #[test]
    fn every_bundled_descriptor_parses_with_its_manifest_intact() {
        let ids = [
            "character-memory",
            "character-state",
            "demo-config",
            "mem0",
            "session-history",
        ];
        let manifests = ids.map(bundled);

        for (manifest, id) in manifests.iter().zip(ids) {
            assert_eq!(manifest.id().as_str(), id);
            assert_eq!(
                Manifest::from_value(&serde_json::to_value(manifest).unwrap()).as_ref(),
                Ok(manifest)
            );
        }

        let [memory, state, demo, mem0, history] = &manifests;

        assert_eq!(memory.kind(), PluginKind::FirstParty);
        assert_eq!(
            memory.declared_plugins(),
            [
                Declaration::ToolProvider,
                Declaration::BeforeRoleModelCall,
                Declaration::HandleToolCall
            ]
        );
        assert_eq!(memory.runtime_policy().timeout_ms().get(), 10_000);
        assert_eq!(
            memory.runtime_policy().redaction_labels()[0].as_str(),
            "memory"
        );
        assert!(memory.activation().default_enabled());
        assert!(
            memory
                .requested_access()
                .grants(AccessName::TrustedContext, AccessLevel::Write)
        );

        assert_eq!(state.config().scope(), ConfigScope::CharacterOnly);
        assert!(!state.activation().default_enabled());
        assert_eq!(
            state
                .runtime_policy()
                .failure_behavior()
                .before_role_model_call(),
            BeforeRoleModelCallFailure::RejectTurn
        );

        let tone = demo.config().field("tone").unwrap();

        assert_eq!(demo.kind(), PluginKind::ContextProvider);
        assert_eq!(tone.allowed_values().map(<[String]>::len), Some(5));
        assert!(tone.agent_mutable() && !tone.reload_required());
        assert!(demo.config().field("apiKey").unwrap().secret());
        assert!(
            demo.config()
                .field("operatorNote")
                .unwrap()
                .reload_required()
        );

        assert_eq!(mem0.kind(), PluginKind::MemoryProvider);
        assert!(!mem0.first_party());
        assert_eq!(mem0.config().fields().len(), 10);
        assert_eq!(
            mem0.config().field("backend").unwrap().default_value(),
            Some(&json!("platform"))
        );
        assert_eq!(
            mem0.runtime_policy().failure_behavior().handle_tool_call(),
            HandleToolCallFailure::Degrade
        );
        assert_eq!(
            mem0.requested_access(),
            &[
                (AccessName::TurnContext, AccessLevel::Read),
                (AccessName::ModelInput, AccessLevel::Write),
                (AccessName::PluginDatabase, AccessLevel::Write)
            ]
            .into_iter()
            .collect::<AccessMap>()
        );

        assert_eq!(history.runtime_policy().timeout_ms().get(), 5_000);
        assert!(
            history
                .requested_access()
                .grants(AccessName::PluginDatabase, AccessLevel::Write)
        );
        assert!(history.declares(Declaration::OnShutdown));
    }

    #[test]
    fn a_descriptor_is_refused_by_its_own_rules_before_and_after_its_manifest() {
        let manifest = serde_json::to_value(bundled("demo-config")).unwrap();
        let descriptor = |format: &str, extra: Value| {
            let mut value = json!({
                "$schema": "../../schemas/project02.plugin.schema.json",
                "format": format,
                "manifest": manifest,
            });
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            value.to_string()
        };
        let refusal = |text: &str| Manifest::from_descriptor(text).unwrap_err();

        assert!(Manifest::from_descriptor(&descriptor(DESCRIPTOR_FORMAT, json!({}))).is_ok());
        assert!(matches!(refusal("{"), DescriptorError::NotJson(_)));
        assert!(matches!(refusal("[]"), DescriptorError::NotAnObject));
        assert!(matches!(
            refusal(&descriptor(DESCRIPTOR_FORMAT, json!({"entry": "./index.ts"}))),
            DescriptorError::UnknownKey { key } if key == "entry"
        ));
        assert!(matches!(
            refusal(&descriptor(DESCRIPTOR_FORMAT, json!({"$schema": 42}))),
            DescriptorError::SchemaNotAString
        ));
        assert!(matches!(
            refusal(&descriptor("project02.plugin.v1", json!({}))),
            DescriptorError::UnsupportedFormat
        ));
        assert!(matches!(
            refusal(&descriptor("project02.plugin.v1", json!({"manifest": {}}))),
            DescriptorError::Manifest(ManifestError::UnsupportedContractVersion)
        ));
    }
}
