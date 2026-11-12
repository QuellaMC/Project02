//! The wire's contract, written from the types that cross the socket: the
//! TypeScript declarations the page and the client compile against, and
//! the JSON Schema the conformance suite holds every answer and every
//! frame to. Both are generated files, which the repository's formatter
//! and linter leave alone.

use std::any::TypeId;
use std::collections::{BTreeMap, HashSet};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

use p02_characters::discover;
use p02_config::{Sections, config_view, connector_config_view};
use p02_core::{
    ClientStamp, ConversationId, MessageId, SpeakerName, Timestamp, VisibleMessageRole, VisibleText,
};
use p02_shared::{DanglingLinks, Identifier, canonical_path};
use p02_store::{CharacterData, Home, SettingsDocument};
use p02_wire::{
    AddCharacterOutcome, AddCharacterRefusal, Answer, AnswerBody, AppAccount, AppInstallOutcome,
    AppInstallRefusal, AppPreviewOutcome, AppRemoveOutcome, AppRemoveRefusal, AppSource, AppView,
    AppWakeBody, AppWakeOutcome, AppWakeRefusal, BotState, BotUsername, CancelReason,
    ChangeOutcome, ChangeRefusal, CharacterFeature, CharacterInstalled, CharacterPreviewOutcome,
    CharacterPreviewRefusal, CharacterState, CharacterSummary, ChatgptOutcome, ChatgptSignIn,
    ConfigChange, ConfigHealth, ConfigTarget, ConfigView, ConfirmationAnswer, ConfirmationId,
    ConfirmationQuestion, ConnectorBot, ConnectorBotsBody, ConnectorBotsOutcome,
    ConnectorBotsRefusal, ConnectorConfigView, ConnectorPresence, ConnectorRefusal, ErrorBody,
    Event, GatewayMessage, Health, HistoryMessage, HistoryOutcome, HistoryRefusal, LiveReading,
    MaintenanceFailure, OpenConversationBody, OpenOutcome, OpenRefusal, PackageReport,
    PackagesHealth, PairingAnswer, PairingDecision, PairingOutcome, PairingRefusal, PairingRequest,
    PairingRequestBody, PairingSubject, PendingConfirmation, PersonAccount, PhoneApp, PhoneDid,
    PhoneFront, PhoneOutcome, PhoneRefusal, PhoneRing, PlanAccount, ProtocolVersion, Ready,
    Refusal, RemoveCharacterOutcome, RemoveCharacterRefusal, RosterState, RunningDraft,
    RunningTurn, Screen, ScreenCell, ScreenItem, ScreenOutcome, ScreenRange, ScreenRefusal,
    ScreenRow, ScreenTile, Settlement, StartOutcome, StartRefusal, StorageFailure, StoreApp,
    StoreAppStatus, StoreOutcome, SubmitOutcome, ToolCallStatus, TurnProgress, TurnRefusal,
    TurnStamp, TurnStatus, ViewRefusal,
};
use schemars::generate::{SchemaGenerator, SchemaSettings};
use schemars::transform::RecursiveTransform;
use schemars::{JsonSchema, Schema};
use serde_json::{Map, Value, json};
use ts_rs::{Config, TS, TypeVisitor};

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
    wire.written::<CharacterPreviewOutcome>();
    wire.written::<AddCharacterOutcome>();
    wire.written::<RemoveCharacterOutcome>();
    wire.written::<OpenOutcome>();
    wire.written::<SubmitOutcome>();
    wire.written::<HistoryOutcome>();
    wire.written::<PendingConfirmation>();
    wire.written::<ConfirmationAnswer>();
    wire.written::<ConfigView>();
    wire.written::<ChangeOutcome>();
    wire.written::<ConnectorConfigView>();
    wire.written::<PairingOutcome>();
    wire.written::<ConnectorBotsOutcome>();
    wire.written::<PairingRequest>();
    wire.written::<PairingAnswer>();
    wire.written::<PhoneOutcome>();
    wire.written::<ScreenOutcome>();
    wire.written::<StoreOutcome>();
    wire.written::<AppPreviewOutcome>();
    wire.written::<AppInstallOutcome>();
    wire.written::<AppRemoveOutcome>();
    wire.written::<AppWakeOutcome>();
    wire.written::<ChatgptOutcome>();
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
    wire.read::<ConnectorBotsBody>();
    wire.read::<ConfigChange>();
    wire.read::<ConfigTarget>();
    wire.read::<AppWakeBody>();
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
        reads::<ConnectorBotsBody>(
            "ConnectorBotsBody",
            json!({
                "bots": [
                    {
                        "target": {"scope": "character", "characterId": "mira"},
                        "username": "mira_bot",
                        "state": "on",
                    },
                    {"target": {"scope": "global"}, "state": "refused"},
                ],
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
        reads::<AppWakeBody>("AppWakeBody", json!({"allowed": false})),
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
                message: "The package's id is not its folder's.".to_owned(),
                path: "/home/person/.project02/characters/nova".to_owned(),
            }],
        },
        characters: vec![CharacterSummary {
            id: id("mira"),
            display_name: mira.clone(),
            enabled: true,
            built_in: true,
            state: RosterState::NeedsModel,
            diagnostic: Some("Choose an AI service.".to_owned()),
            maintenance: Some(maintenance.clone()),
        }],
        connectors: vec![ConnectorPresence {
            id: id("telegram"),
            connected: true,
            bots: vec![
                ConnectorBot {
                    target: ConfigTarget::Global,
                    username: None,
                    state: BotState::Unreachable,
                },
                ConnectorBot {
                    target: ConfigTarget::Character {
                        character_id: "mira".to_owned(),
                    },
                    username: Some(BotUsername::new("mira_bot").unwrap()),
                    state: BotState::On,
                },
            ],
        }],
        accounts: vec![PersonAccount {
            id: id("tavily"),
            name: "Tavily".to_owned(),
            has_key: true,
            key_from: "Get a free key at tavily.com.".to_owned(),
        }],
        chatgpt: ChatgptSignIn::SignedIn {
            email: Some("sam@example.com".to_owned()),
            plan: Some("plus".to_owned()),
        },
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
            summary: "Change her tone.".to_owned(),
            preview: json!({"fieldName": "tone"}).as_object().unwrap().clone(),
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
    let running = RunningTurn {
        character_id: id("mira"),
        conversation_id: conversation.clone(),
        source: Some(stamp("web")),
        client_message_id: Some(stamp("line-1")),
        drafts: vec![RunningDraft {
            draft_id: "1.1".to_owned(),
            text: "Hel".to_owned(),
        }],
    };
    // A turn of her own, which no line began.
    let own = RunningTurn {
        source: None,
        client_message_id: None,
        drafts: Vec::new(),
        ..running.clone()
    };
    let (clock, screen) = phone();
    let front = PhoneFront {
        app_id: id("clock"),
        view_id: id("alarms"),
        screen: Some(screen.clone()),
        message: None,
    };
    let did = PhoneDid {
        app_id: id("clock"),
        words: "Set an alarm".to_owned(),
        at: at.clone(),
    };
    let ring = PhoneRing {
        app_name: "Clock".to_owned(),
        title: "Alarm".to_owned(),
        body: Some("Wake Sam".to_owned()),
        at: at.clone(),
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
                source: stamp("web"),
                client_message_id: stamp("line-1"),
            },
        },
        Event::TurnProgress {
            character_id: id("mira"),
            conversation_id: conversation.clone(),
            progress: TurnProgress::ToolCallCompleted {
                round: NonZeroU32::MIN,
                status: ToolCallStatus::Rejected,
                plugin_id: id("notes"),
                tool_name: id("notes.add"),
            },
        },
        Event::TurnRunning(running.clone()),
        Event::TurnCompleted {
            character_id: id("mira"),
            conversation_id: conversation.clone(),
            source: Some(stamp("web")),
            client_message_id: Some(stamp("line-1")),
            status: TurnStatus::Rejected,
            committed: true,
            reason: Some("malformed_output".to_owned()),
            message: None,
        },
        Event::TurnRunning(own.clone()),
        Event::TurnCompleted {
            character_id: own.character_id,
            conversation_id: own.conversation_id,
            source: None,
            client_message_id: None,
            status: TurnStatus::Completed,
            committed: true,
            reason: None,
            message: None,
        },
        Event::ConfirmationRequested(pending.clone()),
        Event::ConfirmationSettled {
            character_id: id("mira"),
            id: pending.id.clone(),
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
        Event::PhoneChanged {
            character_id: id("mira"),
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
        value(
            "CharacterPreviewOutcome",
            &CharacterPreviewOutcome::Ok {
                id: id("nova"),
                display_name: SpeakerName::new("Nova").unwrap(),
                version: "1.0.0".to_owned(),
                about: Some("A quiet one, who notices things.".to_owned()),
                comes_with: vec![
                    CharacterFeature::Plugin {
                        id: id("character-memory"),
                        display_name: "Notebook".to_owned(),
                    },
                    CharacterFeature::Unknown { id: id("teleport") },
                ],
                installed: CharacterInstalled::OtherVersion,
                has_data: true,
            },
        ),
        value(
            "CharacterPreviewOutcome",
            &CharacterPreviewOutcome::Refused {
                reason: CharacterPreviewRefusal::Invalid,
                message: "This file is not a character file this app can read.".to_owned(),
            },
        ),
        value(
            "AddCharacterOutcome",
            &AddCharacterOutcome::Updated {
                character_id: id("nova"),
            },
        ),
        value(
            "AddCharacterOutcome",
            &AddCharacterOutcome::Refused {
                reason: AddCharacterRefusal::BuiltIn,
                message: "This character comes with the app.".to_owned(),
            },
        ),
        value(
            "AddCharacterOutcome",
            &AddCharacterOutcome::Failed(StorageFailure {
                code: "write_failed".to_owned(),
                message: "The disk is full.".to_owned(),
            }),
        ),
        value("RemoveCharacterOutcome", &RemoveCharacterOutcome::Removed),
        value(
            "RemoveCharacterOutcome",
            &RemoveCharacterOutcome::Refused {
                reason: RemoveCharacterRefusal::UnknownCharacter,
                message: "No character \"nova\" is here to remove.".to_owned(),
            },
        ),
        read_back(
            "OpenOutcome",
            &OpenOutcome::Refused {
                reason: OpenRefusal::CharacterUnavailable,
                message: "Mira is not ready.".to_owned(),
            },
        ),
        read_back("SubmitOutcome", &SubmitOutcome::AlreadyQueued),
        read_back(
            "SubmitOutcome",
            &SubmitOutcome::Refused {
                reason: TurnRefusal::DuplicateSubmission,
                message: "The line is taken already.".to_owned(),
            },
        ),
        read_back(
            "SubmitOutcome",
            &SubmitOutcome::Failed(StorageFailure {
                code: "write_failed".to_owned(),
                message: "The disk is full.".to_owned(),
            }),
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
                message: "Unknown connector \"discord\". Connectors: telegram.".to_owned(),
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
                reason: PairingRefusal::UnknownConnector,
                message: "Unknown connector \"discord\". Connectors: telegram.".to_owned(),
            },
        ),
        read_back("ConnectorBotsOutcome", &ConnectorBotsOutcome::Kept),
        read_back(
            "ConnectorBotsOutcome",
            &ConnectorBotsOutcome::Refused {
                reason: ConnectorBotsRefusal::NotConnected,
                message: "Connector \"telegram\" has no event stream open.".to_owned(),
            },
        ),
        read_back(
            "PairingSettleOutcome",
            &PairingAnswer::Settled {
                decision: Answer::Denied,
            },
        ),
        value(
            "PhoneOutcome",
            &PhoneOutcome::Ok {
                apps: vec![clock.clone()],
                front: Some(Box::new(front.clone())),
                did: Some(did),
                ringing: vec![ring],
            },
        ),
        value(
            "PhoneOutcome",
            &PhoneOutcome::Ok {
                apps: vec![clock],
                front: Some(Box::new(PhoneFront {
                    screen: None,
                    message: Some("Clock took too long and was stopped.".to_owned()),
                    ..front
                })),
                did: None,
                ringing: Vec::new(),
            },
        ),
        value(
            "PhoneOutcome",
            &PhoneOutcome::Refused {
                reason: PhoneRefusal::NoPhone,
                message: "Mira has no phone: her settings switch it off.".to_owned(),
            },
        ),
        value(
            "PhoneOutcome",
            &PhoneOutcome::Failed {
                message: "Her phone could not be read: the disk is gone.".to_owned(),
            },
        ),
        value("ScreenOutcome", &ScreenOutcome::Ok { screen }),
        value(
            "ScreenOutcome",
            &ScreenOutcome::Refused {
                reason: ScreenRefusal::UnknownView,
                message: "Clock has no view \"calendar\".".to_owned(),
            },
        ),
        value(
            "ScreenOutcome",
            &ScreenOutcome::Failed {
                message: "Her phone could not be read: the disk is gone.".to_owned(),
            },
        ),
        value(
            "StoreOutcome",
            &StoreOutcome::Ok {
                apps: vec![StoreApp {
                    id: id("reminders"),
                    name: "Reminders".to_owned(),
                    summary: "Things to do, on a day and time".to_owned(),
                    icon: "list".to_owned(),
                    tint: "orange".to_owned(),
                    version: "1.1.0".to_owned(),
                    changes: "Repeats every other week.".to_owned(),
                    wakes: true,
                    it_may: vec![
                        "Keep its own data".to_owned(),
                        "Wake her when something is due".to_owned(),
                    ],
                    status: StoreAppStatus::Update,
                }],
            },
        ),
        value(
            "StoreOutcome",
            &StoreOutcome::Failed {
                message: "The App Store cannot be reached right now.".to_owned(),
            },
        ),
        value(
            "AppPreviewOutcome",
            &AppPreviewOutcome::Ok {
                id: id("notes"),
                name: "Notes".to_owned(),
                summary: "What she writes down".to_owned(),
                icon: "doc".to_owned(),
                tint: "gray".to_owned(),
                version: "2.0.0".to_owned(),
                wakes: false,
                it_may: vec!["Keep its own data".to_owned()],
                replaces: Some("1.0.0".to_owned()),
            },
        ),
        value(
            "AppPreviewOutcome",
            &AppPreviewOutcome::Refused {
                reason: AppInstallRefusal::NotAnApp,
                message: "Manifest name must not be blank.".to_owned(),
            },
        ),
        value(
            "AppInstallOutcome",
            &AppInstallOutcome::Ok {
                app: Box::new(PhoneApp {
                    id: id("search"),
                    name: "Web Search".to_owned(),
                    summary: "Look things up on the web".to_owned(),
                    version: "1.0.0".to_owned(),
                    source: AppSource::Catalog,
                    icon: "magnifier".to_owned(),
                    tint: "mint".to_owned(),
                    wakes: false,
                    may_wake: true,
                    it_may: vec![
                        "Keep its own data".to_owned(),
                        "Reach the internet at api.tavily.com".to_owned(),
                        "Use your Tavily account".to_owned(),
                    ],
                    account: Some(AppAccount {
                        id: id("tavily"),
                        name: "Tavily".to_owned(),
                        has_key: false,
                    }),
                    views: vec![AppView {
                        id: id("results"),
                        title: "Results".to_owned(),
                        icon: "magnifier".to_owned(),
                    }],
                    opens_on: id("results"),
                }),
                replaced: Some("0.9.0".to_owned()),
            },
        ),
        value(
            "AppInstallOutcome",
            &AppInstallOutcome::Refused {
                reason: AppInstallRefusal::AlreadyInstalled,
                message: "Reminders 1.0.0 is on her phone already.".to_owned(),
            },
        ),
        value(
            "AppInstallOutcome",
            &AppInstallOutcome::Failed {
                message: "The App Store cannot be reached right now.".to_owned(),
            },
        ),
        value("AppRemoveOutcome", &AppRemoveOutcome::Ok),
        value(
            "AppRemoveOutcome",
            &AppRemoveOutcome::Refused {
                reason: AppRemoveRefusal::ComesWithPhone,
                message: "Clock comes with the phone and cannot be removed.".to_owned(),
            },
        ),
        value("AppWakeOutcome", &AppWakeOutcome::Ok),
        value(
            "AppWakeOutcome",
            &AppWakeOutcome::Refused {
                reason: AppWakeRefusal::CannotWake,
                message: "Notes cannot wake her, so there is nothing to change.".to_owned(),
            },
        ),
        read_back(
            "ChatgptOutcome",
            &ChatgptOutcome::Ok {
                sign_in: ChatgptSignIn::Waiting {
                    code: "ABCD-EFGH".to_owned(),
                    url: "https://auth.openai.com/codex/device".to_owned(),
                    expires_at: 1_793_000_000_000,
                },
            },
        ),
        read_back(
            "ChatgptOutcome",
            &ChatgptOutcome::Ok {
                sign_in: ChatgptSignIn::SignedOut {
                    message: Some(
                        "The code expired before it was approved. Start again.".to_owned(),
                    ),
                },
            },
        ),
        read_back(
            "ChatgptOutcome",
            &ChatgptOutcome::Failed {
                message: "OpenAI's sign-in could not be reached. Try again in a moment.".to_owned(),
            },
        ),
        read_back(
            "GatewayErrorBody",
            &ErrorBody {
                error: Refusal {
                    code: "unauthorized".to_owned(),
                    message: "A bearer token is required.".to_owned(),
                },
            },
        ),
        read_back(
            "GatewayReady",
            &Ready {
                protocol_version: ProtocolVersion,
                health,
                confirmations: vec![pending],
                pairings: vec![request],
                turns: vec![running],
            },
        ),
    ];

    written.extend(events.iter().map(|event| read_back("GatewayEvent", event)));
    written
}

/// Her phone's Clock as her window draws it, and a screen holding every
/// piece and field a screen has.
#[expect(clippy::too_many_lines, reason = "one of every piece and field")]
fn phone() -> (PhoneApp, Screen) {
    let id = |text: &str| Identifier::new(text).unwrap();
    let words = |text: &str| Some(text.to_owned());
    let then = 1_794_571_440_000;

    (
        PhoneApp {
            id: id("clock"),
            name: "Clock".to_owned(),
            summary: "Alarms, timers, and the time anywhere".to_owned(),
            version: "1.0.0".to_owned(),
            source: AppSource::BuiltIn,
            icon: "clock".to_owned(),
            tint: "graphite".to_owned(),
            wakes: true,
            may_wake: false,
            it_may: vec![
                "Keep its own data".to_owned(),
                "Wake her when something is due".to_owned(),
            ],
            account: None,
            views: vec![AppView {
                id: id("alarms"),
                title: "Alarms".to_owned(),
                icon: "alarm".to_owned(),
            }],
            opens_on: id("alarms"),
        },
        Screen {
            items: vec![
                ScreenItem::App {
                    id: "reminders".to_owned(),
                    tile: ScreenTile {
                        icon: "list".to_owned(),
                        tint: "orange".to_owned(),
                    },
                    name: "Reminders".to_owned(),
                    subtitle: "Reviewed · Project02 Apps".to_owned(),
                    status: "Not on her phone".to_owned(),
                },
                ScreenItem::List {
                    header: words("Laps"),
                    rows: vec![ScreenRow {
                        id: words("c1"),
                        tile: Some(ScreenTile {
                            icon: "globe".to_owned(),
                            tint: "blue".to_owned(),
                        }),
                        caption: words("Today, +8HRS"),
                        title: words("London"),
                        subtitle: words("Wake Sam, weekdays"),
                        time: words("5:41 PM"),
                        value: words("00:12.34"),
                        switch: Some(true),
                        url: words("https://example.com/london"),
                    }],
                },
                ScreenItem::Readout {
                    id: words("t1"),
                    label: words("Tea"),
                    text: "12:34".to_owned(),
                    caption: words("Ends 9:54 AM"),
                    live: Some(LiveReading::Down {
                        to: then,
                        of: 900_000,
                    }),
                },
                ScreenItem::Readout {
                    id: None,
                    label: None,
                    text: "00:00.00".to_owned(),
                    caption: None,
                    live: Some(LiveReading::Up { from: then }),
                },
                ScreenItem::Text {
                    text: "No World Clocks".to_owned(),
                },
                ScreenItem::Glance {
                    title: "Seattle".to_owned(),
                    text: "12°".to_owned(),
                    caption: words("Light Rain"),
                    detail: words("H: 14°  L: 8°"),
                },
                ScreenItem::Strip {
                    cells: vec![
                        ScreenCell {
                            label: "Now".to_owned(),
                            value: "12°".to_owned(),
                        },
                        ScreenCell {
                            label: "10AM".to_owned(),
                            value: "12°".to_owned(),
                        },
                    ],
                },
                ScreenItem::Ranges {
                    rows: vec![ScreenRange {
                        label: "Wed".to_owned(),
                        low: "8°".to_owned(),
                        high: "14°".to_owned(),
                        from: 33,
                        to: 100,
                    }],
                },
                ScreenItem::Field {
                    text: "how long to steep green tea".to_owned(),
                    icon: words("magnifier"),
                },
                ScreenItem::Note {
                    text: "Weather data by Open-Meteo.com".to_owned(),
                },
            ],
            page: words("reminders"),
        },
    )
}

/// The settings of a home whose documents each name a connector this build
/// lacks, a warning of the home's and one of Mira's overlay: the home's view,
/// whose model is not set up, Mira's, the home signed in to a ChatGPT plan,
/// and Telegram's read.
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
            .map(|(manifest, check, _)| (manifest.clone(), *check)),
    );
    let discovery = discover(home.root());

    (
        config_view(
            &home,
            &sections,
            &discovery,
            &ConfigTarget::Global,
            |_| Err("Choose an AI service.".to_owned()),
            None,
        ),
        config_view(
            &home,
            &sections,
            &discovery,
            &ConfigTarget::Character {
                character_id: mira.to_string(),
            },
            |_| Ok(()),
            Some(&PlanAccount {
                email: Some("sam@example.com".to_owned()),
                plan: Some("plus".to_owned()),
            }),
        ),
        connector_config_view(&home, &sections, &discovery, "telegram"),
    )
}
