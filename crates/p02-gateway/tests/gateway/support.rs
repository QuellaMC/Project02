//! What the tests build a gateway from: a canonical temporary home, the
//! bundled Mira, the test provider unless a test scripts the model's
//! rounds, the server on a free loopback port, a client of it, and a
//! reader of its event stream.

use std::collections::VecDeque;
use std::num::NonZeroU16;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use p02_app::{Daemon, DaemonSettings, Durations, Plugin};
use p02_contracts::{InputEnvelope, Invocation, RawOutput, ReplyDelta, RoleModelAdapter};
use p02_gateway::{Page, Server};
use p02_plugins::list;
use p02_role_model::{TestProvider, select_adapter};
use p02_shared::{DaemonToken, DanglingLinks, SseFrame, SseFrameSplitter, canonical_path};
use p02_store::Home;
use reqwest::header::{HeaderMap, HeaderName};
use reqwest::{Method, StatusCode};
use rust_embed::RustEmbed;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpStream;
use tokio::sync::Notify;

/// How long a test waits for what it expects before it fails.
pub(crate) const PATIENCE: Duration = Duration::from_secs(60);

/// A page built for the tests: an index naming its script, as a build of
/// the real page does.
#[derive(RustEmbed)]
#[folder = "tests/gateway/page/"]
pub(crate) struct FixturePage;

/// No page at all: the folder is never there.
#[derive(RustEmbed)]
#[folder = "tests/gateway/no-page/"]
#[allow_missing = true]
pub(crate) struct NoPage;

/// A home of the test's own, spelled canonically as the daemon spells its
/// home; the directory goes with it.
pub(crate) struct World {
    _directory: TempDir,
    pub(crate) home: Home,
}

impl World {
    pub(crate) fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let home = Home::new(canonical_path(directory.path(), DanglingLinks::Keep).unwrap());

        Self {
            _directory: directory,
            home,
        }
    }

    pub(crate) fn path(&self, relative: &str) -> PathBuf {
        relative
            .split('/')
            .fold(self.home.root().to_path_buf(), |path, name| path.join(name))
    }

    /// The home's settings document as it is on disk.
    pub(crate) fn settings(&self) -> Value {
        serde_json::from_str(&read(&self.path("config.json"))).unwrap()
    }
}

#[expect(
    clippy::disallowed_methods,
    reason = "a test reads a home's files as a person would"
)]
pub(crate) fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

#[expect(
    clippy::disallowed_methods,
    reason = "a test writes a home's files as a person would"
)]
pub(crate) fn write(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
}

#[cfg(unix)]
#[expect(
    clippy::disallowed_methods,
    reason = "a test lists a home's files as a person would"
)]
pub(crate) fn names(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();

    names.sort();
    names
}

/// Sets the Unix mode of `path`, as a person locking a folder would.
#[cfg(unix)]
#[expect(
    clippy::disallowed_methods,
    reason = "a test makes a home refuse its writes as a failing disk would"
)]
pub(crate) fn mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt as _;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// The waits a test runs with: the daemon's own, but for those it names.
pub(crate) fn waits(change: impl FnOnce(&mut Durations)) -> Durations {
    let mut durations = Durations::default();

    change(&mut durations);
    durations
}

/// A daemon on `world`'s home, whose characters answer through `model`,
/// with the plugins of the daemon's list.
pub(crate) async fn daemon(world: &World, model: &Arc<Model>, durations: Durations) -> Daemon {
    let plugins = list::plugins()
        .unwrap()
        .iter()
        .map(|(manifest, factory)| Plugin::new(manifest.clone(), *factory))
        .collect();

    Daemon::open(
        world.home.clone(),
        DaemonSettings {
            test_provider: Some(Arc::clone(model) as Arc<dyn RoleModelAdapter>),
            durations,
            plugins,
        },
    )
    .await
    .unwrap()
}

/// The server over a daemon, and a client of it.
pub(crate) struct Gateway {
    server: Option<Server>,
    pub(crate) port: NonZeroU16,
    pub(crate) token: DaemonToken,
    pub(crate) model: Arc<Model>,
    client: reqwest::Client,
}

impl Gateway {
    /// The server on a free port over a daemon of `world`, with the test
    /// page.
    pub(crate) async fn start(world: &World) -> Self {
        Self::serving(world, Durations::default(), Page::embedded::<FixturePage>()).await
    }

    pub(crate) async fn with(world: &World, durations: Durations) -> Self {
        Self::serving(world, durations, Page::embedded::<FixturePage>()).await
    }

    pub(crate) async fn serving(world: &World, durations: Durations, page: Page) -> Self {
        let model = Arc::new(Model::default());
        let daemon = daemon(world, &model, durations).await;
        let token = DaemonToken::new("the-token_of.this~test").unwrap();
        let server = Server::bind(daemon, &token, None, page).await.unwrap();

        Self {
            port: server.port(),
            server: Some(server),
            token,
            model,
            client: p02_shared::http_client().build().unwrap(),
        }
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// The daemon's own origin, the one its page is served from.
    pub(crate) fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// A request to `path` presenting nothing.
    pub(crate) fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.client.request(method, self.url(path))
    }

    /// A request to `path` with the bearer token.
    pub(crate) fn authorized(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.request(method, path).bearer_auth(self.token.as_str())
    }

    /// The answer's body, which must be 200.
    pub(crate) async fn verb(&self, method: Method, path: &str, body: Option<&Value>) -> Value {
        let request = self.authorized(method, path);
        let answer = Answer::of(match body {
            Some(body) => request.json(body),
            None => request,
        })
        .await;

        assert_eq!(answer.status, StatusCode::OK, "{path}: {}", answer.text);
        answer.json()
    }

    /// Mira's thread with the person, started and opened.
    pub(crate) async fn conversation(&self) -> String {
        let opened = self.converse().await;

        opened["conversationId"].as_str().unwrap().to_owned()
    }

    async fn converse(&self) -> Value {
        self.verb(Method::POST, "/api/characters/mira/start", None)
            .await;
        self.verb(
            Method::POST,
            "/api/conversations/open",
            Some(&json!({"characterId": "mira"})),
        )
        .await
    }

    /// The person's `text` on `conversation`, as the page sends it.
    pub(crate) fn line(conversation: &str, text: &str, id: &str) -> Value {
        json!({
            "conversationId": conversation,
            "senderId": "local-user",
            "text": text,
            "source": "web",
            "clientMessageId": id,
        })
    }

    /// Says `text` on `conversation` and answers with the turn's outcome.
    pub(crate) async fn say(&self, conversation: &str, text: &str, id: &str) -> Value {
        self.verb(
            Method::POST,
            "/api/turns",
            Some(&Self::line(conversation, text, id)),
        )
        .await
    }

    /// The event stream, asked for as a client with `headers` asks for it.
    pub(crate) async fn events_with(&self, query: &str, headers: &[(&str, &str)]) -> Events {
        let mut request = self.authorized(Method::GET, &format!("/api/events{query}"));

        for (name, value) in headers {
            request = request.header(*name, *value);
        }

        Events::of(request.send().await.unwrap())
    }

    pub(crate) async fn events(&self) -> Events {
        self.events_with("", &[]).await
    }

    /// The fingerprint the settings of `target` have now.
    pub(crate) async fn fingerprint(&self, query: &str) -> String {
        self.verb(Method::GET, &format!("/api/config{query}"), None)
            .await["fingerprint"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// Stops it as the binary does.
    pub(crate) async fn close(&mut self) {
        self.closing().await.unwrap();
    }

    /// Begins its stop, which from now on answers new API requests 503,
    /// and runs it on a task of its own.
    pub(crate) fn closing(&mut self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(self.server.take().unwrap().close())
    }

    /// A raw connection to the server, for what no polite client does.
    pub(crate) async fn socket(&self) -> TcpStream {
        TcpStream::connect(("127.0.0.1", self.port.get()))
            .await
            .unwrap()
    }

    /// The head of a raw request to `path`, with the host and the token.
    pub(crate) fn head_of(&self, method: &str, path: &str, headers: &[(&str, &str)]) -> String {
        let headers: String = headers
            .iter()
            .flat_map(|(name, value)| [name, ": ", value, "\r\n"])
            .collect();

        format!(
            "{method} {path} HTTP/1.1\r\nhost: 127.0.0.1:{}\r\nauthorization: Bearer {}\r\n{headers}\r\n",
            self.port,
            self.token.as_str()
        )
    }
}

/// An answer, read whole.
#[derive(Debug)]
pub(crate) struct Answer {
    pub(crate) status: StatusCode,
    pub(crate) headers: HeaderMap,
    pub(crate) text: String,
}

impl Answer {
    pub(crate) async fn of(request: reqwest::RequestBuilder) -> Self {
        let response = request.send().await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();

        Self {
            status,
            headers,
            text: response.text().await.unwrap(),
        }
    }

    pub(crate) fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or_else(|_| panic!("not JSON: {}", self.text))
    }

    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(HeaderName::from_bytes(name.as_bytes()).unwrap())
            .map(|value| value.to_str().unwrap())
    }

    /// Whether this is the transport refusal `code` under `status`, and
    /// nothing more than its envelope.
    pub(crate) fn refused(&self, status: StatusCode, code: &str) -> bool {
        let body = self.json();

        self.status == status
            && body["error"]["code"] == code
            && body["error"]["message"].is_string()
            && body.as_object().is_some_and(|fields| fields.len() == 1)
            && body["error"]
                .as_object()
                .is_some_and(|fields| fields.len() == 2)
    }
}

/// A reader of an event stream: its bytes as they came, and its frames.
pub(crate) struct Events {
    response: reqwest::Response,
    splitter: SseFrameSplitter,
    pub(crate) raw: Vec<u8>,
    pub(crate) frames: Vec<SseFrame>,
    seen: usize,
    ended: bool,
}

impl Events {
    pub(crate) fn of(response: reqwest::Response) -> Self {
        Self {
            response,
            splitter: SseFrameSplitter::new(),
            raw: Vec::new(),
            frames: Vec::new(),
            seen: 0,
            ended: false,
        }
    }

    pub(crate) fn status(&self) -> StatusCode {
        self.response.status()
    }

    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap())
    }

    /// Reads one more chunk; false once the stream ended.
    async fn more(&mut self) -> bool {
        if self.ended {
            return false;
        }

        if let Ok(Some(chunk)) = self.response.chunk().await {
            self.raw.extend_from_slice(&chunk);
            self.frames.extend(self.splitter.push(&chunk));
            true
        } else {
            self.ended = true;
            false
        }
    }

    /// The next frame not yet handed out that `matches`, read as it comes.
    pub(crate) async fn next(&mut self, matches: impl Fn(&SseFrame) -> bool) -> SseFrame {
        tokio::time::timeout(PATIENCE, async {
            loop {
                while self.seen < self.frames.len() {
                    let frame = self.frames[self.seen].clone();

                    self.seen += 1;

                    if matches(&frame) {
                        return frame;
                    }
                }

                assert!(
                    self.more().await,
                    "the stream ended first: {:?}",
                    self.frames
                );
            }
        })
        .await
        .expect("the frame comes")
    }

    /// The next event of `kind`, its data as JSON.
    pub(crate) async fn event(&mut self, kind: &str) -> Value {
        let frame = self
            .next(|frame| frame.event.as_deref() == Some(kind))
            .await;

        data(&frame)
    }

    /// The next event of `kind` whose data `matches`.
    pub(crate) async fn event_where(
        &mut self,
        kind: &str,
        matches: impl Fn(&Value) -> bool,
    ) -> Value {
        let frame = self
            .next(|frame| frame.event.as_deref() == Some(kind) && matches(&data(frame)))
            .await;

        data(&frame)
    }

    /// Reads until the server ends the stream.
    pub(crate) async fn ended(&mut self) {
        tokio::time::timeout(PATIENCE, async { while self.more().await {} })
            .await
            .expect("the stream ends");
    }

    /// The events of `kind` read so far, their data as JSON.
    pub(crate) fn all(&self, kind: &str) -> Vec<Value> {
        self.frames
            .iter()
            .filter(|frame| frame.event.as_deref() == Some(kind))
            .map(data)
            .collect()
    }
}

pub(crate) fn data(frame: &SseFrame) -> Value {
    serde_json::from_str(frame.data.as_deref().unwrap()).unwrap()
}

/// Whether `event` is a health change saying whether Telegram is connected.
pub(crate) fn telegram_connected(event: &Value) -> Option<bool> {
    event["health"]["connectors"][0]["connected"].as_bool()
}

/// A gate a model round waits at while it is shut, to hold a turn in
/// flight.
#[derive(Debug, Default)]
pub(crate) struct Gate {
    shut: Mutex<bool>,
    opened: Notify,
    reached: Notify,
}

impl Gate {
    pub(crate) fn shut() -> Arc<Self> {
        let gate = Arc::new(Self::default());

        *gate.shut.lock().unwrap() = true;
        gate
    }

    pub(crate) fn open(&self) {
        *self.shut.lock().unwrap() = false;
        self.opened.notify_waiters();
    }

    /// Answered once a round is held here.
    pub(crate) async fn reached(&self) {
        tokio::time::timeout(PATIENCE, self.reached.notified())
            .await
            .expect("a round reaches the gate");
    }

    async fn pass(&self) {
        if *self.shut.lock().unwrap() {
            self.reached.notify_one();
        }

        loop {
            let opened = self.opened.notified();

            if !*self.shut.lock().unwrap() {
                return;
            }

            opened.await;
        }
    }
}

/// One scripted round of the model: the pieces it drafts of its reply, a
/// gate it then waits at, and its reply.
pub(crate) struct Round {
    drafts: Vec<String>,
    gate: Option<Arc<Gate>>,
    reply: String,
}

impl Round {
    pub(crate) fn says(reply: &str) -> Self {
        Self {
            drafts: Vec::new(),
            gate: None,
            reply: reply.to_owned(),
        }
    }

    /// Drafts its reply in `pieces` before anything else.
    pub(crate) fn drafting(mut self, pieces: &[&str]) -> Self {
        self.drafts = pieces.iter().map(|piece| (*piece).to_owned()).collect();
        self
    }

    /// Waits at `gate` once it drafted.
    pub(crate) fn held(mut self, gate: &Arc<Gate>) -> Self {
        self.gate = Some(Arc::clone(gate));
        self
    }
}

/// The model every character answers through: the rounds a test scripts,
/// in order, and the test provider for every other.
pub(crate) struct Model {
    rounds: Mutex<VecDeque<Round>>,
    fallback: Arc<dyn RoleModelAdapter>,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            rounds: Mutex::default(),
            fallback: select_adapter(Some(TestProvider::Deterministic), None, None)
                .unwrap()
                .unwrap(),
        }
    }
}

impl Model {
    pub(crate) fn script(&self, rounds: impl IntoIterator<Item = Round>) {
        self.rounds.lock().unwrap().extend(rounds);
    }
}

impl std::fmt::Debug for Model {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Model").finish_non_exhaustive()
    }
}

#[async_trait]
impl RoleModelAdapter for Model {
    async fn invoke(&self, envelope: &InputEnvelope, invocation: &Invocation<'_>) -> RawOutput {
        let round = self.rounds.lock().unwrap().pop_front();
        let Some(round) = round else {
            return self.fallback.invoke(envelope, invocation).await;
        };

        for text in round.drafts {
            invocation.hear(ReplyDelta { reply: 0, text });
        }

        if let Some(gate) = round.gate {
            gate.pass().await;
        }

        RawOutput::text(
            json!({"toolCalls": [{"name": "visible_reply", "input": {"text": round.reply}}]})
                .to_string(),
        )
    }
}
