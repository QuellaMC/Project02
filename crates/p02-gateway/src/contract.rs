//! The wire's contract, written from the types that cross the socket: the
//! TypeScript declarations the page and the client compile against, and
//! the JSON Schema the conformance suite holds every answer and every
//! frame to. Both are generated files, which the repository's formatter
//! and linter leave alone.

use std::any::TypeId;
use std::collections::{BTreeMap, HashSet};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

use p02_app::{
    Answer, CancelReason, CharacterState, CharacterSummary, ConfigHealth, ConfirmationAnswer,
    ConfirmationId, ConfirmationQuestion, ConnectorPresence, Event, Health, HistoryMessage,
    HistoryOutcome, HistoryRefusal, MaintenanceFailure, OpenOutcome, OpenRefusal,
    PackageProvenance, PackageReport, PackagesHealth, PairingAnswer, PairingDecision,
    PairingOutcome, PairingRefusal, PairingRequest, PairingSubject, PendingConfirmation,
    ProtocolVersion, RosterState, RunningDraft, RunningTurn, Settlement, StartOutcome,
    StartRefusal, StorageFailure, ToolCallStatus, TurnMessage, TurnOutcome, TurnProgress,
    TurnRefusal, TurnStamp, TurnStatus,
};
use p02_characters::discover;
use p02_config::{
    ChangeOutcome, ChangeRefusal, ConfigChange, ConfigTarget, ConfigView, ConnectorConfigView,
    ConnectorRefusal, Sections, Severity, ViewRefusal,
};
use p02_core::{
    ClientStamp, ConversationId, MessageId, SpeakerName, Timestamp, VisibleMessageRole, VisibleText,
};
use p02_shared::{DanglingLinks, Identifier, canonical_path};
use p02_store::{CharacterData, Home, SettingsDocument};
use schemars::generate::{SchemaGenerator, SchemaSettings};
use schemars::transform::RecursiveTransform;
use schemars::{JsonSchema, Schema};
use serde_json::{Map, Value, json};
use ts_rs::{Config, TS, TypeVisitor};

use crate::events::Ready;
use crate::http::{
    AnswerBody, ErrorBody, GatewayMessage, OpenConversationBody, PairingRequestBody, Refusal,
};

const REGENERATE: &str = "cargo test -p p02-gateway contract";

/// The roots of the wire: what the daemon writes, every route's answer and
/// every frame, and what it reads, every route's body and query. The
/// contract holds every type they reach.
trait Wire {
    fn written<T: TS + JsonSchema + 'static>(&mut self);
    fn read<T: TS + JsonSchema + 'static>(&mut self);
}

fn walk(wire: &mut impl Wire) {
    wire.written::<Health>();
    wire.written::<StartOutcome>();
    wire.written::<OpenOutcome>();
    wire.written::<TurnOutcome>();
    wire.written::<HistoryOutcome>();
    wire.written::<PendingConfirmation>();
    wire.written::<ConfirmationAnswer>();
    wire.written::<ConfigView>();
    wire.written::<ChangeOutcome>();
    wire.written::<ConnectorConfigView>();
    wire.written::<PairingOutcome>();
    wire.written::<PairingRequest>();
    wire.written::<PairingAnswer>();
    wire.written::<ErrorBody>();
    wire.written::<Ready>();
    wire.written::<Event>();
    // Only ever flattened into the frame that settles a confirmation, and
    // named by the clients that read it.
    wire.written::<Settlement>();
    wire.read::<OpenConversationBody>();
    wire.read::<GatewayMessage>();
    wire.read::<AnswerBody>();
    wire.read::<PairingRequestBody>();
    wire.read::<ConfigChange>();
    wire.read::<ConfigTarget>();
}

/// Every declaration the roots reach, by name.
struct Declarations {
    config: Config,
    seen: HashSet<TypeId>,
    by_name: BTreeMap<String, String>,
}

impl TypeVisitor for Declarations {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if T::output_path().is_none() || !self.seen.insert(TypeId::of::<T>()) {
            return;
        }

        let name = T::ident(&self.config);
        // A client reads what the daemon said and never changes it, so its
        // lists are read-only, as every list of the TypeScript code is.
        let declaration = format!(
            "{}export {}",
            T::docs().unwrap_or_default(),
            T::decl(&self.config).replace("Array<", "ReadonlyArray<")
        );

        // A type ts-rs stands in for, as `JsonValue` for serde_json's, is
        // reached as itself and as its stand-in.
        if let Some(other) = self.by_name.insert(name.clone(), declaration.clone()) {
            assert_eq!(other, declaration, "two wire types are named {name}");
        }

        T::visit_dependencies(self);
    }
}

impl Wire for Declarations {
    fn written<T: TS + JsonSchema + 'static>(&mut self) {
        self.visit::<T>();
    }

    fn read<T: TS + JsonSchema + 'static>(&mut self) {
        self.visit::<T>();
    }
}

/// Every schema the roots reach, by name: what is written as it is
/// serialized, and what is read as it is deserialized.
struct Schemas {
    written: SchemaGenerator,
    read: SchemaGenerator,
}

impl Wire for Schemas {
    fn written<T: TS + JsonSchema + 'static>(&mut self) {
        self.written.subschema_for::<T>();
    }

    fn read<T: TS + JsonSchema + 'static>(&mut self) {
        self.read.subschema_for::<T>();
    }
}

fn declarations() -> String {
    let mut declarations = Declarations {
        // Every integer on the wire is a count or a time in milliseconds,
        // which a JavaScript number holds exactly.
        config: Config::new().with_large_int("number"),
        seen: HashSet::new(),
        by_name: BTreeMap::new(),
    };

    walk(&mut declarations);

    let body: Vec<String> = declarations.by_name.into_values().collect();

    format!(
        "// Generated by ts-rs from the Rust types the socket carries: change those and run `{REGENERATE}`.\n\n{}\n",
        body.join("\n\n")
    )
}

/// The schema document: one definition per type, under `$defs`. A type
/// both written and read has one shape either way.
pub(crate) fn schema() -> Value {
    let settings = SchemaSettings::draft2020_12();
    let mut schemas = Schemas {
        written: settings
            .clone()
            .for_serialize()
            .with_transform(RecursiveTransform(never_null))
            .into_generator(),
        read: settings.for_deserialize().into_generator(),
    };

    walk(&mut schemas);

    let mut definitions: BTreeMap<String, Value> =
        schemas.written.take_definitions(true).into_iter().collect();

    for (name, read) in schemas.read.take_definitions(true) {
        if let Some(written) = definitions.get(&name) {
            assert_eq!(
                written, &read,
                "{name} is read in another shape than it is written"
            );
        }

        definitions.insert(name, read);
    }

    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$comment": format!("Generated by schemars from the Rust types the socket carries: change those and run `{REGENERATE}`."),
        "$defs": definitions.into_iter().collect::<Map<String, Value>>(),
    })
}

/// The daemon leaves out a field it has nothing for and never writes null,
/// so what it writes is described without the null schemars allows an
/// `Option`.
fn never_null(schema: &mut Schema) {
    if let Some(Value::Array(types)) = schema.get_mut("type") {
        types.retain(|kind| kind != "null");

        if let [only] = types.as_slice() {
            let only = only.clone();

            schema.insert("type".to_owned(), only);
        }
    }

    if let Some(Value::Array(alternatives)) = schema.get_mut("anyOf") {
        alternatives.retain(|alternative| *alternative != json!({"type": "null"}));

        if let [Value::Object(only)] = alternatives.as_slice() {
            let only = only.clone();

            schema.remove("anyOf");
            schema.ensure_object().extend(only);
        }
    }
}

fn repository() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap()
}

/// Where a client imports the contract from.
fn generated(name: &str) -> PathBuf {
    repository()
        .join("packages/wire/src/contract/generated")
        .join(name)
}

/// Writes `text` to `path` unless the file already holds it.
fn write(path: &Path, text: &str) {
    if p02_shared::read_file(path).ok().as_deref() != Some(text.as_bytes()) {
        p02_shared::write_file_atomically(path, text.as_bytes()).unwrap();
    }
}

/// Writes the contract; a committed file it changes was stale.
#[test]
fn writes_the_contract_from_the_wire_types() {
    let contract = generated("contract.ts");
    let schema_file = generated("schema.json");

    p02_shared::create_directories(contract.parent().unwrap()).unwrap();
    write(&contract, &declarations());
    write(
        &schema_file,
        &format!("{}\n", serde_json::to_string_pretty(&schema()).unwrap()),
    );
}

/// One value of every wire type, as serde writes it or as a body the
/// daemon reads, is what its schema says: a derive that misdescribes serde
/// fails here, before the suite runs.
#[test]
fn every_wire_type_is_as_its_schema_says() {
    let validators = jsonschema::validator_map_for(&schema()).unwrap();

    for (name, value) in written().into_iter().chain(read()) {
        let validator = validators.get(&format!("#/$defs/{name}")).unwrap();

        if let Err(error) = validator.validate(&value) {
            panic!("{name} {value} is refused by its schema: {error}");
        }
    }
}

fn value(name: &'static str, value: &impl serde::Serialize) -> (&'static str, Value) {
    (name, serde_json::to_value(value).unwrap())
}

/// A value of a type a client reads, which reads back as what was written.
fn read_back<T: serde::Serialize + serde::de::DeserializeOwned>(
    name: &'static str,
    value: &T,
) -> (&'static str, Value) {
    let written = serde_json::to_value(value).unwrap();
    let read: T = serde_json::from_value(written.clone())
        .unwrap_or_else(|error| panic!("{name} does not read back {written}: {error}"));

    assert_eq!(serde_json::to_value(read).unwrap(), written, "{name}");
    (name, written)
}

/// A body of each type a route reads, which the type reads.
fn read() -> Vec<(&'static str, Value)> {
    fn reads<T: serde::de::DeserializeOwned>(
        name: &'static str,
        body: Value,
    ) -> (&'static str, Value) {
        assert!(
            serde_json::from_value::<T>(body.clone()).is_ok(),
            "{name} does not read {body}"
        );
        (name, body)
    }

    vec![
        reads::<OpenConversationBody>("OpenConversationBody", json!({"characterId": "mira"})),
        reads::<GatewayMessage>(
            "GatewayMessage",
            json!({
                "conversationId": "conv_1",
                "senderId": "local-user",
                "text": "Hello.",
                "source": "web",
                "clientMessageId": "line-1",
            }),
        ),
        reads::<AnswerBody>("AnswerBody", json!({"decision": "approved"})),
        reads::<PairingRequestBody>(
            "PairingRequestBody",
            json!({
                "subject": {"id": "381940562", "label": "Alice (@alice)"},
                "source": "telegram:mira_bot",
            }),
        ),
        reads::<ConfigChange>(
            "ConfigChange",
            json!({
                "target": {"scope": "character", "characterId": "mira"},
                "expectedFingerprint": "sha256:0",
                "operation": {"kind": "section_enabled", "namespace": "plugins", "id": "mem0"},
            }),
        ),
    ]
}

/// A value of each type the daemon writes, every flattened and newtype
/// variant of an event among them, those a client reads read back.
#[expect(clippy::too_many_lines, reason = "one value of every wire type")]
fn written() -> Vec<(&'static str, Value)> {
    let id = |text: &str| Identifier::new(text).unwrap();
    let stamp = |text: &str| ClientStamp::new(text).unwrap();
    let conversation = ConversationId::new("conv_1").unwrap();
    let at = Timestamp::new("2026-10-21T00:00:00.000Z").unwrap();
    let mira = SpeakerName::new("Mira").unwrap();
    let message_id = MessageId::parse("conv_1.1:message-2").unwrap();
    let text = VisibleText::parse("Hello.").unwrap();
    let (diagnosed, overlaid, connector) = settings();
    let maintenance = MaintenanceFailure {
        at: at.clone(),
        message: "A segment did not close.".to_owned(),
    };
    let health = Health {
        protocol_version: ProtocolVersion,
        home_root: "/home/person/.project02".to_owned(),
        config: ConfigHealth {
            diagnostics: match &diagnosed {
                ConfigView::Ok { diagnostics, .. } => diagnostics.clone(),
                ConfigView::Refused { .. } => Vec::new(),
            },
        },
        packages: PackagesHealth {
            diagnostics: vec![PackageReport {
                severity: Severity::Error,
                code: "package_id_mismatch".to_owned(),
                message: "The package's id is not its folder's.".to_owned(),
                path: "/home/person/.project02/characters/nova".to_owned(),
                provenance: PackageProvenance::Operator,
                character_id: Some("nova".to_owned()),
                claimed_character_id: Some(id("vega")),
            }],
        },
        characters: vec![CharacterSummary {
            id: id("mira"),
            display_name: mira.clone(),
            enabled: true,
            state: RosterState::NotStarted,
            diagnostic: Some("No model provider is chosen.".to_owned()),
            maintenance: Some(maintenance.clone()),
        }],
        connectors: vec![ConnectorPresence {
            id: id("telegram"),
            connected: false,
        }],
    };
    let turn = TurnStamp {
        conversation_id: conversation.clone(),
        source: stamp("web"),
        client_message_id: stamp("line-1"),
    };
    let pending = PendingConfirmation {
        character_id: id("mira"),
        id: ConfirmationId::mint(),
        request: ConfirmationQuestion {
            plugin_id: id("runtime.plugin"),
            tool_name: id("runtime.plugin.config_update"),
            summary: "Turn the demo plugin on.".to_owned(),
            preview: json!({"enabled": true}).as_object().unwrap().clone(),
        },
        deadline_at: 1_793_000_000_000,
        turn: Some(turn.clone()),
    };
    let subject = PairingSubject {
        id: stamp("381940562"),
        label: SpeakerName::new("Alice (@alice)").unwrap(),
    };
    let request = PairingRequest {
        connector_id: id("telegram"),
        code: "123456".to_owned(),
        subject: subject.clone(),
        source: stamp("telegram:mira_bot"),
        requested_at: at.clone(),
        expires_at: 1_793_000_000_000,
    };
    let events = [
        Event::TurnProgress {
            character_id: id("mira"),
            conversation_id: conversation.clone(),
            progress: TurnProgress::UserMessage {
                message_id: message_id.clone(),
                speaker_id: id("local-user"),
                speaker_name: SpeakerName::new("You").unwrap(),
                text: text.clone(),
                source: Some(stamp("web")),
                client_message_id: None,
            },
        },
        Event::TurnProgress {
            character_id: id("mira"),
            conversation_id: conversation.clone(),
            progress: TurnProgress::ToolCallCompleted {
                round: NonZeroU32::MIN,
                status: ToolCallStatus::Rejected,
                tool_name: id("notes.add"),
            },
        },
        Event::TurnCompleted {
            character_id: id("mira"),
            conversation_id: conversation.clone(),
            source: stamp("web"),
            client_message_id: stamp("line-1"),
            status: TurnStatus::Rejected,
            committed: true,
            reason: Some("malformed_output".to_owned()),
            message: None,
        },
        Event::ConfirmationRequested(pending.clone()),
        Event::ConfirmationSettled {
            character_id: id("mira"),
            id: pending.id,
            settlement: Settlement::Cancelled {
                reason: CancelReason::Stopped,
            },
        },
        Event::PairingRequested(request.clone()),
        Event::PairingSettled {
            connector_id: id("telegram"),
            code: "123456".to_owned(),
            subject,
            decision: PairingDecision::Expired,
        },
        Event::StateChanged {
            character_id: id("mira"),
            state: CharacterState::Failed,
            message: None,
        },
        Event::MaintenanceFailed {
            character_id: id("mira"),
            failure: maintenance,
        },
    ];

    let mut written = vec![
        read_back("GatewayHealth", &health),
        value(
            "StartOutcome",
            &StartOutcome::Refused {
                reason: StartRefusal::GatewayStopped,
                message: "The daemon is stopping.".to_owned(),
            },
        ),
        read_back(
            "OpenOutcome",
            &OpenOutcome::Refused {
                reason: OpenRefusal::CharacterUnavailable,
                message: "Mira is not ready.".to_owned(),
            },
        ),
        read_back(
            "TurnOutcome",
            &TurnOutcome::Completed {
                character_id: id("mira"),
                conversation_id: conversation.clone(),
                messages: vec![TurnMessage {
                    message_id: message_id.clone(),
                    speaker_id: id("mira"),
                    speaker_name: mira.clone(),
                    text: text.clone(),
                }],
            },
        ),
        read_back(
            "TurnOutcome",
            &TurnOutcome::Refused {
                reason: TurnRefusal::DuplicateSubmission,
                message: "The line is taken already.".to_owned(),
            },
        ),
        value(
            "HistoryOutcome",
            &HistoryOutcome::Ok {
                conversation_id: conversation.clone(),
                character_id: id("mira"),
                messages: vec![HistoryMessage {
                    message_id,
                    role: VisibleMessageRole::User,
                    speaker_id: id("local-user"),
                    speaker_name: mira,
                    text,
                    committed_at: at,
                    source: Some(stamp("web")),
                    client_message_id: None,
                }],
                earlier: None,
            },
        ),
        value(
            "HistoryOutcome",
            &HistoryOutcome::Refused {
                reason: HistoryRefusal::InvalidPage,
                message: "A page takes a limit from 1 to 500.".to_owned(),
            },
        ),
        value(
            "HistoryOutcome",
            &HistoryOutcome::Failed(StorageFailure {
                code: "write_failed".to_owned(),
                message: "The disk is full.".to_owned(),
            }),
        ),
        read_back("PendingConfirmation", &pending),
        read_back("AnswerOutcome", &ConfirmationAnswer::Expired),
        value("ConfigView", &diagnosed),
        value("ConfigView", &overlaid),
        value(
            "ConfigView",
            &ConfigView::Refused {
                reason: ViewRefusal::UnknownCharacter,
                message: "No character is installed as nova.".to_owned(),
            },
        ),
        value(
            "ConfigChangeOutcome",
            &ChangeOutcome::Refused {
                reason: ChangeRefusal::Conflict,
                message: "Someone else saved first.".to_owned(),
            },
        ),
        read_back("ConnectorConfigView", &connector),
        read_back(
            "ConnectorConfigView",
            &ConnectorConfigView::Refused {
                reason: ConnectorRefusal::UnknownConnector,
                message: "Unknown connector \"discord\".".to_owned(),
            },
        ),
        read_back(
            "PairingRequestOutcome",
            &PairingOutcome::Pending {
                request: request.clone(),
            },
        ),
        read_back(
            "PairingRequestOutcome",
            &PairingOutcome::Refused {
                reason: PairingRefusal::InvalidSubject,
                message: "A label is one line.".to_owned(),
            },
        ),
        read_back(
            "PairingSettleOutcome",
            &PairingAnswer::Settled {
                decision: Answer::Denied,
            },
        ),
        read_back(
            "GatewayErrorBody",
            &ErrorBody {
                error: Refusal::new(
                    axum::http::StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    "A bearer token is required.".to_owned(),
                ),
            },
        ),
        read_back(
            "GatewayReady",
            &Ready {
                protocol_version: ProtocolVersion,
                health,
                confirmations: vec![pending],
                pairings: vec![request],
                turns: vec![RunningTurn {
                    character_id: id("mira"),
                    conversation_id: conversation,
                    source: stamp("web"),
                    client_message_id: stamp("line-1"),
                    drafts: vec![RunningDraft {
                        draft_id: "1.1".to_owned(),
                        text: "Hel".to_owned(),
                    }],
                }],
            },
        ),
    ];

    written.extend(events.iter().map(|event| read_back("GatewayEvent", event)));
    written
}

/// The settings of a home whose documents each name a connector this build
/// lacks, a warning of the home's and one of Mira's overlay: the home's view,
/// Mira's, and Telegram's read.
fn settings() -> (ConfigView, ConfigView, ConnectorConfigView) {
    let directory = tempfile::TempDir::new().unwrap();
    let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());
    let mira = Identifier::new("mira").unwrap();
    let document = json!({"version": "project02.config.v2", "connectors": {"discord": {}}});

    home.ensure().unwrap();
    CharacterData::ensure(&home, &mira).unwrap();

    for settings in [SettingsDocument::Home, SettingsDocument::Overlay(&mira)] {
        p02_shared::write_file_atomically(
            &home.settings_path(settings),
            document.to_string().as_bytes(),
        )
        .unwrap();
    }

    let sections = Sections::new(
        p02_plugins::list::plugins()
            .unwrap()
            .iter()
            .map(|(manifest, _)| manifest.clone()),
    );
    let discovery = discover(home.root());

    (
        ConfigView::read(&home, &sections, &discovery, &ConfigTarget::Global),
        ConfigView::read(
            &home,
            &sections,
            &discovery,
            &ConfigTarget::Character {
                character_id: mira.to_string(),
            },
        ),
        ConnectorConfigView::read(&home, &sections, &discovery, "telegram"),
    )
}
