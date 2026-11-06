//! The daemon as the connector sees it: the home's record followed, the
//! event stream read frame by frame into the bot table, and the verbs the
//! bots call, each answer read with the types the daemon writes it with.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use p02_app::{
    Answer, ConfirmationAnswer, Event, Health, OpenOutcome, PROTOCOL_VERSION, PairingAnswer,
    PairingOutcome, TurnOutcome,
};
use p02_config::ConnectorConfigView;
use p02_gateway::{
    AnswerBody, ErrorBody, GatewayMessage, OpenConversationBody, PairingRequestBody,
    PairingSubjectBody, Ready, Short,
};
use p02_shared::{
    DAEMON_RECORD_FILE, DaemonRecord, DaemonToken, Identifier, SseFrame, SseFrameSplitter,
    error_sentence, http_client, read_daemon_record,
};
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

use crate::table::Table;
use crate::{Ended, Lines, Notice};

/// Between two reads of a home whose record is absent or unreadable, or
/// whose token the daemon refused.
const RECORD_RETRY: Duration = Duration::from_secs(2);

/// Between a stream lost and the next try at the same record.
const STREAM_RETRY: Duration = Duration::from_secs(1);

/// This connector's id on the daemon's wire.
pub(crate) const CONNECTOR: &str = "telegram";

/// The daemon a record names, as the connector reaches it: plain HTTP on
/// loopback, its token as the bearer, and no timeout, since a delivery
/// waits for its turn and a turn parked on a confirmation waits minutes.
#[derive(Clone, Debug)]
pub(crate) struct Daemon {
    client: reqwest::Client,
    origin: String,
    token: DaemonToken,
}

/// Why a verb has no answer to act on.
#[derive(Debug, thiserror::Error)]
pub(crate) enum Unanswered {
    #[error("the daemon at {origin} could not be reached")]
    Unreachable {
        origin: String,
        #[source]
        source: reqwest::Error,
    },
    /// A refusal of the transport, in the daemon's words when it sent some.
    #[error("{message}")]
    Refused { status: u16, message: String },
    #[error("the daemon's answer could not be read")]
    Unreadable(#[source] serde_json::Error),
}

impl Unanswered {
    fn status(&self) -> Option<u16> {
        match self {
            Self::Refused { status, .. } => Some(*status),
            Self::Unreachable { .. } | Self::Unreadable(_) => None,
        }
    }
}

impl Daemon {
    fn new(record: &DaemonRecord) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: http_client().build()?,
            origin: format!("http://127.0.0.1:{}", record.port),
            token: record.token.clone(),
        })
    }

    pub(crate) async fn health(&self) -> Result<Health, Unanswered> {
        self.get("/api/health").await
    }

    pub(crate) async fn connector_config(&self) -> Result<ConnectorConfigView, Unanswered> {
        self.get(&format!("/api/connectors/{CONNECTOR}/config"))
            .await
    }

    /// Her thread with the person, opened on her the first time.
    pub(crate) async fn open(&self, character: &Identifier) -> Result<OpenOutcome, Unanswered> {
        self.post(
            "/api/conversations/open",
            &OpenConversationBody {
                character_id: short(character.as_str()),
            },
        )
        .await
    }

    /// Waits for the line's turn, however long it is parked.
    pub(crate) async fn deliver(&self, line: &GatewayMessage) -> Result<TurnOutcome, Unanswered> {
        self.post("/api/turns", line).await
    }

    pub(crate) async fn answer_confirmation(
        &self,
        id: &str,
        decision: Answer,
    ) -> Result<ConfirmationAnswer, Unanswered> {
        self.post(
            &format!("/api/confirmations/{id}"),
            &AnswerBody { decision },
        )
        .await
    }

    pub(crate) async fn request_pairing(
        &self,
        subject: PairingSubjectBody,
    ) -> Result<PairingOutcome, Unanswered> {
        self.post(
            &format!("/api/connectors/{CONNECTOR}/pairing"),
            &PairingRequestBody { subject },
        )
        .await
    }

    pub(crate) async fn settle_pairing(
        &self,
        code: &str,
        decision: Answer,
    ) -> Result<PairingAnswer, Unanswered> {
        self.post(&format!("/api/pairing/{code}"), &AnswerBody { decision })
            .await
    }

    /// The event stream as this connector's, from after the frame it last
    /// applied when it names one.
    async fn events(&self, last_event_id: Option<&str>) -> Result<Response, Unanswered> {
        let mut request = self
            .client
            .get(format!("{}/api/events?connector={CONNECTOR}", self.origin))
            .bearer_auth(self.token.as_str());

        if let Some(id) = last_event_id {
            request = request.header("last-event-id", id);
        }

        self.sent(request).await
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, Unanswered> {
        self.answer(
            self.client
                .get(format!("{}{path}", self.origin))
                .bearer_auth(self.token.as_str()),
        )
        .await
    }

    async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, Unanswered> {
        self.answer(
            self.client
                .post(format!("{}{path}", self.origin))
                .bearer_auth(self.token.as_str())
                .json(body),
        )
        .await
    }

    async fn answer<T: DeserializeOwned>(&self, request: RequestBuilder) -> Result<T, Unanswered> {
        let body = self
            .sent(request)
            .await?
            .bytes()
            .await
            .map_err(|source| self.unreachable(source))?;

        serde_json::from_slice(&body).map_err(Unanswered::Unreadable)
    }

    /// The answer, once it is the route's; else the refusal of the
    /// transport it carries.
    async fn sent(&self, request: RequestBuilder) -> Result<Response, Unanswered> {
        let response = request
            .send()
            .await
            .map_err(|source| self.unreachable(source))?;
        let status = response.status();

        if status == StatusCode::OK {
            return Ok(response);
        }

        let body = response.bytes().await.unwrap_or_default();
        let message = serde_json::from_slice::<ErrorBody>(&body).map_or_else(
            |_| format!("The daemon answered {}.", status.as_u16()),
            |envelope| envelope.error.message().to_owned(),
        );

        Err(Unanswered::Refused {
            status: status.as_u16(),
            message,
        })
    }

    fn unreachable(&self, source: reqwest::Error) -> Unanswered {
        Unanswered::Unreachable {
            origin: self.origin.clone(),
            source,
        }
    }
}

/// An id as a body carries it: ids are well within the bound.
pub(crate) fn short(id: &str) -> Short {
    Short::new(id).expect("an id is within the bound of a name")
}

/// How following one record ended.
enum Following {
    Stopped,
    /// The record names another daemon now.
    Moved,
    /// The daemon refused the record's token.
    Refused,
    Failed(String),
}

/// How reading one stream ended.
enum Read {
    Lost,
    Stopped,
    Failed(String),
}

/// The first thing read of a `ready` frame, before anything else of it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spoken {
    protocol_version: u64,
}

/// Follows the daemon the home's record names, the record read again
/// every 2 s while it is absent, unreadable or refused, until the stop.
pub(crate) async fn follow_home(
    home: &Path,
    table: &mut Table,
    lines: &Arc<dyn Lines>,
    stop: &CancellationToken,
) -> Ended {
    let lines = lines.as_ref();
    let mut notice = Notice::default();

    loop {
        match read_daemon_record(home) {
            Ok(Some(record)) => {
                match follow(home, &record, table, &mut notice, lines, stop).await {
                    Following::Stopped => return Ended::Stopped,
                    Following::Moved => continue,
                    Following::Refused => {}
                    Following::Failed(sentence) => {
                        lines.report(&sentence);
                        return Ended::Failed;
                    }
                }
            }
            Ok(None) => notice.say(lines, waiting(home)),
            Err(error) => notice.report(
                lines,
                format!(
                    "Telegram connector: {} Trying again.",
                    error_sentence(&error)
                ),
            ),
        }

        if table.during(sleep(RECORD_RETRY), stop).await.is_none() {
            return Ended::Stopped;
        }
    }
}

/// Follows the daemon `record` names until its stream is refused, the
/// record names another, or the stop: a stream that ends, breaks, or
/// meets a daemon down or stopping is opened again.
async fn follow(
    home: &Path,
    record: &DaemonRecord,
    table: &mut Table,
    notice: &mut Notice,
    lines: &dyn Lines,
    stop: &CancellationToken,
) -> Following {
    let daemon = match Daemon::new(record) {
        Ok(daemon) => daemon,
        Err(error) => {
            return Following::Failed(format!(
                "Telegram connector: {}",
                error_sentence(&error.without_url())
            ));
        }
    };
    let mut last_event_id = None;

    table.follow(daemon.clone());

    loop {
        let Some(opened) = table
            .during(daemon.events(last_event_id.as_deref()), stop)
            .await
        else {
            return Following::Stopped;
        };

        match opened {
            Ok(stream) => {
                match read(
                    stream,
                    &daemon.origin,
                    &mut last_event_id,
                    table,
                    notice,
                    lines,
                    stop,
                )
                .await
                {
                    Read::Lost => {}
                    Read::Stopped => return Following::Stopped,
                    Read::Failed(sentence) => return Following::Failed(sentence),
                }
            }
            Err(Unanswered::Unreachable { .. }) => {}
            Err(stopping) if stopping.status() == Some(503) => {}
            Err(refused) if refused.status() == Some(401) => {
                table.hold();
                notice.report(
                    lines,
                    format!(
                        "Telegram connector: the daemon at {} refused the token in {}; trying \
                         again.",
                        daemon.origin,
                        home.join(DAEMON_RECORD_FILE).display()
                    ),
                );
                return Following::Refused;
            }
            Err(other) => {
                return Following::Failed(format!(
                    "Telegram connector: the daemon refused its event stream: {}",
                    error_sentence(&other)
                ));
            }
        }

        table.hold();

        if moved(home, record) {
            return Following::Moved;
        }

        notice.say(lines, waiting(home));

        if table.during(sleep(STREAM_RETRY), stop).await.is_none() {
            return Following::Stopped;
        }
    }
}

/// Reads the stream frame by frame into the table until it ends.
async fn read(
    mut stream: Response,
    origin: &str,
    last_event_id: &mut Option<String>,
    table: &mut Table,
    notice: &mut Notice,
    lines: &dyn Lines,
    stop: &CancellationToken,
) -> Read {
    let mut frames = SseFrameSplitter::new();

    loop {
        let Some(chunk) = table.during(stream.chunk(), stop).await else {
            return Read::Stopped;
        };
        let Ok(Some(bytes)) = chunk else {
            return Read::Lost;
        };

        for frame in frames.push(&bytes) {
            if let Err(sentence) = take(frame, origin, last_event_id, table, notice, lines) {
                return Read::Failed(sentence);
            }
        }
    }
}

/// Hands one frame to the table, and remembers its id once it is applied.
/// A `ready` is first read for its protocol alone: a daemon of another
/// version writes another shape.
fn take(
    frame: SseFrame,
    origin: &str,
    last_event_id: &mut Option<String>,
    table: &mut Table,
    notice: &mut Notice,
    lines: &dyn Lines,
) -> Result<(), String> {
    match (frame.event.as_deref(), frame.data.as_deref()) {
        (Some("ready"), Some(data)) => {
            let spoken: Spoken =
                serde_json::from_str(data).map_err(|error| unreadable("ready", &error))?;

            if spoken.protocol_version != u64::from(PROTOCOL_VERSION) {
                return Err(format!(
                    "The daemon speaks protocol {}; this client speaks {PROTOCOL_VERSION}. Update \
                     one of them.",
                    spoken.protocol_version
                ));
            }

            let ready: Ready =
                serde_json::from_str(data).map_err(|error| unreadable("ready", &error))?;

            notice.say(lines, connected(origin));
            table.ready(ready);
        }
        (Some("resumed"), _) => {
            notice.say(lines, connected(origin));
            table.resumed();
        }
        (Some(kind), Some(data)) => {
            let event: Event =
                serde_json::from_str(data).map_err(|error| unreadable(kind, &error))?;

            table.event(event);
        }
        _ => {}
    }

    if let Some(id) = frame.id {
        *last_event_id = Some(id);
    }

    Ok(())
}

/// Whether the home's record now names another address or token than the
/// one followed.
fn moved(home: &Path, followed: &DaemonRecord) -> bool {
    matches!(
        read_daemon_record(home),
        Ok(Some(record)) if record.port != followed.port || record.token != followed.token
    )
}

fn waiting(home: &Path) -> String {
    format!(
        "Telegram connector: waiting for the daemon on {}.",
        home.display()
    )
}

fn connected(origin: &str) -> String {
    format!("Telegram connector: connected to {origin}.")
}

fn unreadable(kind: &str, error: &serde_json::Error) -> String {
    format!("Telegram connector: the daemon's {kind} frame could not be read: {error}.")
}
