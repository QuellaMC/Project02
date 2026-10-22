//! A target's settings in effect: each value taken from the nearest
//! document its scope lets the target read, else from its declared
//! default, with where it came from, what is wrong with it, and the
//! fingerprints a change is bound to.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};

use p02_characters::{CharacterDefinition, CharacterVersion, Discovery};
use p02_contracts::{ConfigField, ConfigScope};
use p02_core::SpeakerName;
use p02_shared::{BaseUrl, Fingerprint, Identifier};
use p02_store::{CharacterData, Home, SettingsDocument, StorageError};
use serde_json::{Map, Value, json};

use crate::change::ConfigTarget;
use crate::conceal::{conceal_document, conceal_stanza};
use crate::declaration::{
    Declared, Layer, Namespace, RoleModelProvider, Sections, Source, Target, authorable, base_url,
    context_window_tokens, host_fields, outside_scope, role_model_provider, text,
    user_display_name,
};
use crate::diagnostic::{Code, Diagnostic};
use crate::document::{Document, Read, Stanza, unknown};
use crate::materialize::merged_overlay;

/// A target's settings, resolved: the home's, or one character's over the
/// home's.
pub struct Resolution<'s> {
    target: Target,
    layers: Layers,
    fingerprint: Fingerprint,
    host: Vec<Field<'s>>,
    resolved: Vec<Section<'s>>,
    diagnostics: Vec<Diagnostic>,
}

/// Names whose settings they are, by their fingerprint and findings, and
/// never a value: the values include secrets.
impl fmt::Debug for Resolution<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Resolution")
            .field("target", &self.target)
            .field("fingerprint", &self.fingerprint)
            .field("diagnostics", &self.diagnostics)
            .finish_non_exhaustive()
    }
}

/// Why a target's settings cannot be resolved.
#[derive(Debug, thiserror::Error)]
pub enum ReadSettingsError {
    /// No installed character answers to the id asked for.
    #[error("{0}")]
    UnknownCharacter(String),
    /// The store refuses the home, or her data directory.
    #[error("the settings' storage is refused")]
    Storage(#[from] StorageError),
    /// A document the target reads does not load.
    #[error("a settings document does not load")]
    Unloadable { diagnostics: Vec<Diagnostic> },
}

/// The documents a target is resolved from.
#[derive(Debug)]
pub(crate) struct Layers {
    pub(crate) home_path: PathBuf,
    pub(crate) home_present: bool,
    pub(crate) home: Document,
    pub(crate) overlay: Option<Overlay>,
}

/// A character's overlay as resolved.
#[derive(Clone, Debug)]
pub(crate) struct Overlay {
    pub(crate) character: Identifier,
    pub(crate) path: PathBuf,
    /// As its file holds it.
    pub(crate) written: Document,
    /// What her settings are read from, and what a change to them is bound
    /// to and edits: as written, or with her package's settings merged in
    /// as her first start, or the start after a new version of her
    /// package, will merge them.
    pub(crate) read: Document,
    /// The version of her package whose settings `read` merges in,
    /// recorded once her file holds `read`.
    pub(crate) merges: Option<CharacterVersion>,
}

impl Layers {
    pub(crate) fn document(&self, layer: Layer) -> Option<&Document> {
        match layer {
            Layer::Home => Some(&self.home),
            Layer::Overlay => self.overlay.as_ref().map(|overlay| &overlay.read),
        }
    }

    /// The documents present, the home's first.
    fn present(&self) -> impl Iterator<Item = (Layer, &Document)> {
        std::iter::once((Layer::Home, &self.home)).chain(
            self.overlay
                .as_ref()
                .map(|overlay| (Layer::Overlay, &overlay.read)),
        )
    }

    /// `diagnostic`, found in the document of `layer`.
    fn found_in(&self, layer: Layer, diagnostic: Diagnostic) -> Diagnostic {
        match (layer, &self.overlay) {
            (Layer::Overlay, Some(overlay)) => {
                diagnostic.in_overlay(&overlay.character, &overlay.path)
            }
            _ => diagnostic,
        }
    }
}

/// The home's document as its file holds it.
#[derive(Debug)]
pub(crate) struct Written {
    pub(crate) path: PathBuf,
    pub(crate) read: Read,
}

impl Written {
    /// Reads the home's document once the store admits the home.
    pub(crate) fn read(home: &Home) -> Result<Self, StorageError> {
        home.check()?;

        let path = home.settings_path(SettingsDocument::Home);

        Ok(Self {
            read: Read::file(&path),
            path,
        })
    }
}

/// A character's overlay as its file holds it.
#[derive(Debug)]
pub(crate) struct WrittenOverlay {
    pub(crate) path: PathBuf,
    pub(crate) read: Read,
    /// The version of her package last merged into it.
    pub(crate) package_version: Option<CharacterVersion>,
}

impl WrittenOverlay {
    /// Reads her overlay once the store admits her data directory: a link
    /// there, or a directory marked for another character, is refused
    /// before anything is read.
    pub(crate) fn read(home: &Home, character: &Identifier) -> Result<Self, StorageError> {
        let data = CharacterData::open(home, character)?;
        let path = home.settings_path(SettingsDocument::Overlay(character));

        Ok(Self {
            read: Read::file(&path),
            path,
            package_version: data.and_then(|data| data.package_version().cloned()),
        })
    }
}

/// `diagnostics`, each found in `character`'s overlay at `path`.
pub(crate) fn in_overlay(
    diagnostics: Vec<Diagnostic>,
    character: &Identifier,
    path: &Path,
) -> Vec<Diagnostic> {
    diagnostics
        .into_iter()
        .map(|diagnostic| diagnostic.in_overlay(character, path))
        .collect()
}

/// One field resolved for a target.
#[derive(Debug)]
pub(crate) struct Field<'s> {
    pub(crate) declaration: &'s ConfigField,
    /// What the target's own document holds for it, if anything.
    pub(crate) authored: Option<Value>,
    pub(crate) effective: Effective,
    /// Whether the target must have a value for it: a required field the
    /// target's documents can supply.
    pub(crate) required: bool,
}

/// Where a value in effect comes from.
#[derive(Debug)]
pub(crate) enum Effective {
    /// The nearest document that holds a value, and whether the field takes
    /// that value. One it refuses stays in effect, refused: a farther
    /// document's value would hide what its author meant.
    Authored {
        layer: Layer,
        value: Value,
        accepted: bool,
    },
    Default(Value),
    Missing,
}

impl Effective {
    pub(crate) fn source(&self) -> Source {
        match self {
            Self::Authored { layer, .. } => layer.source(),
            Self::Default(_) | Self::Missing => Source::Default,
        }
    }

    /// The value in effect, when it is one its field takes.
    pub(crate) fn value(&self) -> Option<&Value> {
        match self {
            Self::Authored {
                value,
                accepted: true,
                ..
            }
            | Self::Default(value) => Some(value),
            Self::Authored { .. } | Self::Missing => None,
        }
    }
}

/// One declared section resolved for a target.
#[derive(Debug)]
pub(crate) struct Section<'s> {
    pub(crate) declared: Declared<'s>,
    /// Its switch, a value as any other: the nearest document's, refused
    /// when it is not a boolean, else the declaration's default.
    pub(crate) switch: Effective,
    pub(crate) fields: Vec<Field<'s>>,
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) fingerprint: Fingerprint,
    pub(crate) status: Status,
}

/// Whether a section runs as its settings decide, and the one reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Active(&'static str),
    Disabled(&'static str),
    Blocked,
}

impl Section<'_> {
    pub(crate) fn enabled(&self) -> bool {
        self.switch.value() == Some(&Value::Bool(true))
    }
}

impl<'s> Resolution<'s> {
    /// The settings of `target`: the home's, or those of the installed
    /// character it names.
    ///
    /// # Errors
    ///
    /// [`ReadSettingsError`] when the character is not installed, the store
    /// refuses the home or her data directory, or a document does not load.
    pub fn read(
        home: &Home,
        sections: &'s Sections,
        discovery: &Discovery,
        target: &ConfigTarget,
    ) -> Result<Self, ReadSettingsError> {
        match target {
            ConfigTarget::Global => Self::home(home, sections),
            ConfigTarget::Character { character_id } => {
                let character = discovery
                    .find(character_id)
                    .map_err(|error| ReadSettingsError::UnknownCharacter(error.to_string()))?;

                Self::character(home, sections, character)
            }
        }
    }

    /// The home's own settings.
    ///
    /// # Errors
    ///
    /// [`ReadSettingsError`] when the store refuses the home or its
    /// document does not load.
    pub fn home(home: &Home, sections: &'s Sections) -> Result<Self, ReadSettingsError> {
        let written = Written::read(home)?;
        let home_present = !matches!(written.read, Read::Absent);
        let document = written
            .read
            .usable()
            .map_err(|diagnostics| ReadSettingsError::Unloadable { diagnostics })?;

        Ok(Self::new(
            sections,
            Layers {
                home_path: written.path,
                home_present,
                home: document,
                overlay: None,
            },
            Vec::new(),
        ))
    }

    /// The settings `character` runs on: her overlay over the home's, with
    /// her package's settings in it as her next start will have merged
    /// them, while the fingerprint stays that of the overlay her file holds.
    ///
    /// # Errors
    ///
    /// [`ReadSettingsError`] when the store refuses the home or her data
    /// directory, or a document does not load.
    pub fn character(
        home: &Home,
        sections: &'s Sections,
        character: &CharacterDefinition,
    ) -> Result<Self, ReadSettingsError> {
        let id = &character.profile.id;
        let written = Written::read(home)?;
        let overlay = WrittenOverlay::read(home, id)?;
        let home_present = !matches!(written.read, Read::Absent);
        let home_document = written
            .read
            .usable()
            .map_err(|diagnostics| ReadSettingsError::Unloadable { diagnostics })?;
        let absent = matches!(overlay.read, Read::Absent);
        let on_disk =
            overlay
                .read
                .usable()
                .map_err(|diagnostics| ReadSettingsError::Unloadable {
                    diagnostics: in_overlay(diagnostics, id, &overlay.path),
                })?;
        let (merged, package_problems) = merged_overlay(
            sections,
            character,
            overlay.path,
            on_disk,
            absent,
            overlay.package_version.as_ref(),
        );

        Ok(Self::new(
            sections,
            Layers {
                home_path: written.path,
                home_present,
                home: home_document,
                overlay: Some(merged),
            },
            package_problems,
        ))
    }

    pub(crate) fn new(
        sections: &'s Sections,
        layers: Layers,
        mut diagnostics: Vec<Diagnostic>,
    ) -> Self {
        let target = layers.overlay.as_ref().map_or(Target::Home, |overlay| {
            Target::Character(overlay.character.clone())
        });
        let host: Vec<Field<'s>> = host_fields()
            .iter()
            .map(|field| {
                let read = target.layers(ConfigScope::GlobalWithCharacterOverrides);
                let value_in = |layer| {
                    layers
                        .document(layer)
                        .and_then(|document| document.host_value(field.name()))
                        .cloned()
                };

                Field {
                    declaration: &field.declaration,
                    authored: value_in(target.own_layer()),
                    effective: resolve(
                        &read,
                        value_in,
                        |value| field.accepts(value),
                        field.declaration.default_value(),
                    ),
                    required: field.declaration.required() && !read.is_empty(),
                }
            })
            .collect();
        let chosen_memory = host
            .iter()
            .find(|field| field.declaration.name().as_str() == "defaultMemoryProvider")
            .and_then(|field| field.effective.value())
            .and_then(Value::as_str)
            .map(str::to_owned);
        let resolved: Vec<Section<'s>> = sections
            .declared()
            .map(|declared| {
                section(
                    sections,
                    declared,
                    &target,
                    &layers,
                    chosen_memory.as_deref(),
                )
            })
            .collect();
        let mut all = unknown_sections(sections, &layers);

        all.append(&mut diagnostics);
        all.extend(
            resolved
                .iter()
                .flat_map(|section| section.diagnostics.iter().cloned()),
        );

        Self {
            fingerprint: target_fingerprint(sections, &layers),
            target,
            layers,
            host,
            resolved,
            diagnostics: all,
        }
    }

    /// What a change to this target's settings is bound to: its documents
    /// as its settings are read from them, a secret's presence counted and
    /// its value never.
    #[must_use]
    pub fn fingerprint(&self) -> &Fingerprint {
        &self.fingerprint
    }

    /// Every finding about the target's settings: sections named that this
    /// build lacks, what is wrong with each section, and with her package's
    /// settings when they cannot be merged.
    #[must_use]
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    /// What a character runs on by these settings: the host's values, and
    /// the plugins that run by them, each with its values in effect, so a
    /// field left to its default and one set to the same value run her
    /// alike. Two that are equal run the same character, so a running one
    /// is rebuilt only when hers differ from those she was built from.
    #[must_use]
    #[expect(
        clippy::missing_panics_doc,
        reason = "a host field with a default resolves to a value: each default meets its rule"
    )]
    pub fn settings(&self) -> CharacterSettings {
        let value = |name: &str| {
            self.host
                .iter()
                .find(|field| field.declaration.name().as_str() == name)
                .and_then(|field| field.effective.value())
        };
        let host = HostSettings {
            user_display_name: value("userDisplayName")
                .and_then(user_display_name)
                .expect("userDisplayName resolves to a name"),
            role_model_provider: value("roleModelProvider").and_then(role_model_provider),
            nvidia_api_key: value("nvidiaApiKey").and_then(text).map(str::to_owned),
            nvidia_model: value("nvidiaModel").and_then(text).map(str::to_owned),
            nvidia_base_url: value("nvidiaBaseUrl").and_then(base_url),
            context_window_tokens: value("contextWindowTokens")
                .and_then(context_window_tokens)
                .expect("contextWindowTokens resolves to a number of tokens"),
            default_memory_provider: value("defaultMemoryProvider")
                .and_then(text)
                .map(str::to_owned),
            enabled: value("enabled").and_then(Value::as_bool) == Some(true),
        };
        let plugins = self
            .resolved
            .iter()
            .filter(|section| {
                section.declared.namespace() == Namespace::Plugins
                    && matches!(section.status, Status::Active(_))
            })
            .map(|section| {
                let values = section
                    .fields
                    .iter()
                    .filter_map(|field| {
                        field
                            .effective
                            .value()
                            .map(|value| (field.declaration.name().to_string(), value.clone()))
                    })
                    .collect();

                (section.declared.id().clone(), values)
            })
            .collect();

        CharacterSettings { host, plugins }
    }

    /// The value in effect for field `field` of the section `id` of
    /// `namespace`, in the clear: what a change that edits it starts from.
    /// None when the section or the field is not declared, or no value its
    /// field takes is in effect.
    #[must_use]
    pub fn section_value(&self, namespace: Namespace, id: &str, field: &str) -> Option<&Value> {
        self.section(namespace, id)?
            .fields
            .iter()
            .find(|candidate| candidate.declaration.name().as_str() == field)?
            .effective
            .value()
    }

    pub(crate) fn target(&self) -> &Target {
        &self.target
    }

    pub(crate) fn layers(&self) -> &Layers {
        &self.layers
    }

    pub(crate) fn host(&self) -> &[Field<'s>] {
        &self.host
    }

    pub(crate) fn sections(&self) -> &[Section<'s>] {
        &self.resolved
    }

    pub(crate) fn section(&self, namespace: Namespace, id: &str) -> Option<&Section<'s>> {
        self.resolved.iter().find(|section| {
            section.declared.namespace() == namespace && section.declared.id().as_str() == id
        })
    }
}

/// The host's values a character runs on.
#[derive(Clone, PartialEq, Eq)]
pub struct HostSettings {
    /// The name the person goes by, trimmed.
    pub user_display_name: SpeakerName,
    /// None until the person chooses one, and no character starts before.
    pub role_model_provider: Option<RoleModelProvider>,
    pub nvidia_api_key: Option<String>,
    pub nvidia_model: Option<String>,
    pub nvidia_base_url: Option<BaseUrl>,
    pub context_window_tokens: NonZeroU64,
    pub default_memory_provider: Option<String>,
    /// Whether the character is switched on.
    pub enabled: bool,
}

impl fmt::Debug for HostSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostSettings")
            .field("user_display_name", &self.user_display_name)
            .field("role_model_provider", &self.role_model_provider)
            .field(
                "nvidia_api_key",
                &self.nvidia_api_key.as_ref().map(|_| "[redacted]"),
            )
            .field("nvidia_model", &self.nvidia_model)
            .field("nvidia_base_url", &self.nvidia_base_url)
            .field("context_window_tokens", &self.context_window_tokens)
            .field("default_memory_provider", &self.default_memory_provider)
            .field("enabled", &self.enabled)
            .finish()
    }
}

/// What a character runs on: the host's values, and each plugin that runs
/// by her settings with each of its values in effect by field name, a
/// declared default among them, secrets in the clear, for the plugin host
/// to resolve against its manifest.
#[derive(Clone, PartialEq, Eq)]
pub struct CharacterSettings {
    host: HostSettings,
    plugins: BTreeMap<Identifier, Map<String, Value>>,
}

impl CharacterSettings {
    #[must_use]
    pub fn host(&self) -> &HostSettings {
        &self.host
    }

    /// The plugins switched on, in id order, each with its values.
    pub fn plugins(&self) -> impl Iterator<Item = (&Identifier, &Map<String, Value>)> {
        self.plugins.iter()
    }
}

/// Names the plugins and their fields only: the values include secrets.
impl fmt::Debug for CharacterSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CharacterSettings")
            .field("host", &self.host)
            .field(
                "plugins",
                &self
                    .plugins
                    .iter()
                    .map(|(id, values)| (id, values.keys().collect::<Vec<_>>()))
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// The value the nearest of `layers` holds, judged by `accepts`, else the
/// default.
fn resolve(
    layers: &[Layer],
    value_in: impl Fn(Layer) -> Option<Value>,
    accepts: impl Fn(&Value) -> bool,
    default: Option<&Value>,
) -> Effective {
    for &layer in layers {
        if let Some(value) = value_in(layer) {
            let accepted = accepts(&value);

            return Effective::Authored {
                layer,
                value,
                accepted,
            };
        }
    }

    default.map_or(Effective::Missing, |value| {
        Effective::Default(value.clone())
    })
}

fn section<'s>(
    sections: &'s Sections,
    declared: Declared<'s>,
    target: &Target,
    layers: &Layers,
    chosen_memory: Option<&str>,
) -> Section<'s> {
    let namespace = declared.namespace();
    let id = declared.id().as_str();
    let stanza = |layer| {
        layers
            .document(layer)
            .and_then(|document| document.stanza(namespace, id))
    };
    let read = target.layers(declared.config().scope());
    let switch = resolve(
        &read,
        |layer| stanza(layer).and_then(|stanza| stanza.enabled.clone()),
        Value::is_boolean,
        Some(&Value::Bool(declared.default_enabled())),
    );
    let fields: Vec<Field<'s>> = declared
        .config()
        .fields()
        .iter()
        .map(|field| {
            let field_layers = target.layers(declared.scope_of(field));
            let value_in = |layer| {
                stanza(layer)
                    .and_then(|stanza| stanza.config.as_ref())
                    .and_then(|config| config.get(field.name().as_str()))
                    .cloned()
            };

            Field {
                declaration: field,
                authored: value_in(target.own_layer()),
                effective: resolve(
                    &field_layers,
                    value_in,
                    |value| field.accepts(value),
                    field.default_value(),
                ),
                required: field.required() && !field_layers.is_empty(),
            }
        })
        .collect();
    let mut diagnostics = outside_scope_warnings(declared, layers);
    let switched = matches!(switch, Effective::Authored { .. });

    // A section that does not run, switched off by a document or by its
    // default, or a memory provider the settings do not choose, stops
    // nothing, so what its settings lack or misspell is not judged.
    let status = if switch.value() == Some(&Value::Bool(false)) {
        Status::Disabled(if switched {
            "disabled_by_config"
        } else {
            "not_enabled"
        })
    } else if declared.is_memory_provider() && chosen_memory.is_some_and(|chosen| chosen != id) {
        Status::Disabled("not_selected_as_default_memory_provider")
    } else {
        diagnostics.extend(judge(declared, &fields, &switch, &read, layers));

        if diagnostics.iter().any(Diagnostic::is_error) {
            Status::Blocked
        } else if switched {
            Status::Active("enabled_by_config")
        } else {
            Status::Active("enabled_by_default")
        }
    };

    Section {
        declared,
        switch,
        fields,
        diagnostics,
        fingerprint: section_fingerprint(sections, declared, layers),
        status,
    }
}

/// What is wrong with a section's settings in the documents `read`: the
/// shape of its stanzas, a switch in effect that is no boolean, fields it
/// does not declare, and values its fields refuse or, while it is on,
/// lack.
fn judge(
    declared: Declared<'_>,
    fields: &[Field<'_>],
    switch: &Effective,
    read: &[Layer],
    layers: &Layers,
) -> Vec<Diagnostic> {
    let namespace = declared.namespace();
    let id = declared.id().as_str();
    let stanzas: Vec<(Layer, &Stanza)> = read
        .iter()
        .filter_map(|&layer| {
            layers
                .document(layer)
                .and_then(|document| document.stanza(namespace, id))
                .map(|stanza| (layer, stanza))
        })
        .collect();
    let mut diagnostics: Vec<Diagnostic> = stanzas
        .iter()
        .flat_map(|(layer, stanza)| {
            stanza
                .problems
                .iter()
                .map(|problem| layers.found_in(*layer, problem.clone()))
        })
        .collect();

    diagnostics.extend(refused_switch(declared, switch, layers));

    let names: Vec<&str> = declared
        .config()
        .fields()
        .iter()
        .map(|field| field.name().as_str())
        .collect();

    for (layer, stanza) in &stanzas {
        for name in stanza
            .config
            .iter()
            .flat_map(|config| unknown(config, &names))
        {
            diagnostics.push(
                layers.found_in(
                    *layer,
                    Diagnostic::error(
                        Code::UnknownPluginConfigField,
                        format!("Unknown config field \"{name}\" for section \"{id}\"."),
                    )
                    .at(declared.field_path(name))
                    .on_field(namespace, id, name),
                ),
            );
        }
    }

    let on = switch.value() == Some(&Value::Bool(true));

    for field in fields {
        let name = field.declaration.name().as_str();
        let secret = field.declaration.secret();
        let diagnostic = match &field.effective {
            Effective::Authored {
                layer,
                accepted: false,
                ..
            } => layers.found_in(
                *layer,
                if secret {
                    Diagnostic::error(
                        Code::SecretValueInvalid,
                        format!(
                            "Secret config field \"{name}\" of \"{id}\" must be a non-blank string."
                        ),
                    )
                } else {
                    Diagnostic::error(
                        Code::ValueTypeInvalid,
                        format!(
                            "Config field \"{name}\" of \"{id}\" must be {}.",
                            crate::declaration::expectation(field.declaration)
                        ),
                    )
                },
            ),
            Effective::Missing if field.required && on => Diagnostic::error(
                if secret {
                    Code::RequiredSecretMissing
                } else {
                    Code::RequiredValueMissing
                },
                format!("Required config field \"{name}\" is missing for section \"{id}\"."),
            ),
            _ => continue,
        };

        diagnostics.push(
            diagnostic
                .at(declared.field_path(name))
                .on_field(namespace, id, name),
        );
    }

    diagnostics
}

/// The finding of a switch in effect that is no boolean, made in the
/// document that holds it: a farther one it overrides is not in effect,
/// and is not judged.
fn refused_switch(
    declared: Declared<'_>,
    switch: &Effective,
    layers: &Layers,
) -> Option<Diagnostic> {
    let Effective::Authored {
        layer,
        accepted: false,
        ..
    } = switch
    else {
        return None;
    };
    let path = format!("{}.enabled", declared.path());

    Some(
        layers.found_in(
            *layer,
            Diagnostic::error(Code::BooleanInvalid, format!("{path} must be a boolean."))
                .at(path)
                .in_section(declared.namespace(), declared.id().as_str()),
        ),
    )
}

/// A warning for each value a document holds for the section that its
/// scope keeps from that document: it never takes effect, and blocks
/// nothing.
fn outside_scope_warnings(declared: Declared<'_>, layers: &Layers) -> Vec<Diagnostic> {
    let namespace = declared.namespace();
    let id = declared.id().as_str();
    let mut warnings = Vec::new();

    for (layer, document) in layers.present() {
        let Some(stanza) = document.stanza(namespace, id) else {
            continue;
        };

        if stanza.enabled.is_some() && !authorable(declared.config().scope(), layer) {
            warnings.push(
                layers.found_in(
                    layer,
                    Diagnostic::warning(Code::AuthoredOutsideScope, outside_scope(id, None, layer))
                        .at(format!("{}.enabled", declared.path()))
                        .in_section(namespace, id),
                ),
            );
        }

        for field in declared.config().fields() {
            let name = field.name().as_str();
            let authored = stanza
                .config
                .as_ref()
                .is_some_and(|config| config.contains_key(name));

            if authored && !authorable(declared.scope_of(field), layer) {
                warnings.push(
                    layers.found_in(
                        layer,
                        Diagnostic::warning(
                            Code::AuthoredOutsideScope,
                            outside_scope(id, Some(name), layer),
                        )
                        .at(declared.field_path(name))
                        .on_field(namespace, id, name),
                    ),
                );
            }
        }
    }

    warnings
}

/// A warning for each section the documents name that this build has no
/// declaration of, unless the nearest document that switches it switches
/// it off.
fn unknown_sections(sections: &Sections, layers: &Layers) -> Vec<Diagnostic> {
    let mut warnings = Vec::new();

    for namespace in Namespace::ALL {
        let named: BTreeSet<&String> = layers
            .present()
            .flat_map(|(_, document)| document.stanzas(namespace).keys())
            .filter(|id| sections.find(namespace, id).is_none())
            .collect();

        for id in named {
            let switched_off = layers
                .present()
                .filter_map(|(_, document)| document.stanza(namespace, id))
                .filter_map(|stanza| stanza.enabled.as_ref())
                .last()
                == Some(&Value::Bool(false));

            if switched_off {
                continue;
            }

            let (code, kind) = match namespace {
                Namespace::Plugins => (Code::UnknownPlugin, "plugin"),
                Namespace::Connectors => (Code::UnknownConnector, "connector"),
            };

            for (layer, document) in layers.present() {
                if document.stanza(namespace, id).is_some() {
                    warnings.push(
                        layers.found_in(
                            layer,
                            Diagnostic::warning(
                                code,
                                format!("Runtime config references unknown {kind} \"{id}\"."),
                            )
                            .at(format!("{}.{id}", namespace.as_str()))
                            .in_section(namespace, id),
                        ),
                    );
                }
            }
        }
    }

    warnings
}

/// The fingerprint of a target: its documents as its settings are read
/// from them, and whose they are.
pub(crate) fn target_fingerprint(sections: &Sections, layers: &Layers) -> Fingerprint {
    let home = conceal_document(layers.home.raw(), sections);

    Fingerprint::new(&match &layers.overlay {
        None => json!({"home": home}),
        Some(overlay) => json!({
            "character": overlay.character,
            "home": home,
            "overlay": conceal_document(overlay.read.raw(), sections),
        }),
    })
}

/// The fingerprint of one section for a target: its stanzas as the
/// target's settings are read from them, so a change to that section alone
/// is bound to nothing else.
fn section_fingerprint(
    sections: &Sections,
    declared: Declared<'_>,
    layers: &Layers,
) -> Fingerprint {
    let namespace = declared.namespace();
    let id = declared.id().as_str();
    let stanza = |document: &Document| {
        document
            .raw()
            .get(namespace.as_str())
            .and_then(|stanzas| stanzas.get(id))
            .map(|stanza| conceal_stanza(namespace, id, stanza, sections))
    };
    let home = stanza(&layers.home);

    Fingerprint::new(&match &layers.overlay {
        None => json!({"section": declared.path(), "home": home}),
        Some(overlay) => json!({
            "section": declared.path(),
            "character": overlay.character,
            "home": home,
            "overlay": stanza(&overlay.read),
        }),
    })
}
