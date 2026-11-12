//! What the tests build a gateway from: a canonical temporary home, the
//! bundled Mira, the test provider unless a test scripts the model's
//! replies, the server on a free loopback port, a client of it, and a
//! reader of its event stream.

use std::collections::VecDeque;
use std::num::NonZeroU16;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use p02_app::{Daemon, DaemonSettings, Durations, Plugin};
use p02_contracts::{Invocation, ModelOutput, ProviderAnswer, RoleModelAdapter};
use p02_gateway::Server;
use p02_plugins::list;
use p02_role_model::{TestProvider, select_adapter};
use p02_shared::{BaseUrl, DaemonToken, DanglingLinks, SseFrame, SseFrameSplitter, canonical_path};
use p02_store::Home;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use tempfile::TempDir;

/// How long a test waits for what it expects before it fails.
pub(crate) const PATIENCE: Duration = Duration::from_secs(60);

/// A home of the test's own, spelled canonically as the daemon spells its
/// home; the directory goes with it.
pub(crate) struct World {
    _directory: TempDir,
    home: Home,
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
}

/// The waits a test runs with: the daemon's own, but for those it names.
pub(crate) fn waits(change: impl FnOnce(&mut Durations)) -> Durations {
    let mut durations = Durations::default();

    change(&mut durations);
    durations
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
    /// The server on a free port over a daemon of `world`.
    pub(crate) async fn start(world: &World) -> Self {
        Self::with(world, Durations::default()).await
    }

    /// The server over a daemon of `world` that keeps `durations`, its
    /// characters answering through the test's model, with the plugins of
    /// the daemon's list.
    pub(crate) async fn with(world: &World, durations: Durations) -> Self {
        let model = Arc::new(Model::default());
        let plugins = list::plugins()
            .unwrap()
            .iter()
            .map(|(manifest, check, factory)| Plugin::new(manifest.clone(), *check, *factory))
            .collect();
        let daemon = Daemon::open(
            world.home.clone(),
            DaemonSettings {
                test_provider: Some(Arc::clone(&model) as Arc<dyn RoleModelAdapter>),
                durations,
                plugins,
                // An App Store and an internet nothing serves: no test of
                // these reaches either.
                app_catalog: BaseUrl::parse("http://127.0.0.1:9").unwrap(),
                app_internet: Some(BaseUrl::parse("http://127.0.0.1:9").unwrap()),
            },
        )
        .await
        .unwrap();
        let token = DaemonToken::new("the-token_of.this~test").unwrap();
        let server = Server::bind(daemon, &token, None).await.unwrap();

        Self {
            port: server.port(),
            server: Some(server),
            token,
            model,
            client: p02_shared::http_client().build().unwrap(),
        }
    }

    /// A request to `path` presenting nothing.
    pub(crate) fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("http://127.0.0.1:{}{path}", self.port))
    }

    /// A request to `path` with the bearer token.
    pub(crate) fn authorized(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.request(method, path).bearer_auth(self.token.as_str())
    }

    /// The answer's body, which must be 200.
    async fn verb(&self, method: Method, path: &str, body: Option<&Value>) -> Value {
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
        self.verb(Method::POST, "/api/characters/mira/start", None)
            .await;
        self.verb(
            Method::POST,
            "/api/conversations/open",
            Some(&json!({"characterId": "mira"})),
        )
        .await["conversationId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// The person's `text` on `conversation`, as the page sends it.
    pub(crate) fn line(conversation: &str, text: &str, id: &str) -> Value {
        json!({
            "conversationId": conversation,
            "text": text,
            "source": "web",
            "clientMessageId": id,
        })
    }

    pub(crate) async fn events(&self) -> Events {
        Events::of(
            self.authorized(Method::GET, "/api/events")
                .send()
                .await
                .unwrap(),
        )
    }

    /// Stops it as the binary does.
    pub(crate) async fn close(&mut self) {
        self.server.take().unwrap().close().await;
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
    pub(crate) text: String,
}

impl Answer {
    pub(crate) async fn of(request: reqwest::RequestBuilder) -> Self {
        let response = request.send().await.unwrap();

        Self {
            status: response.status(),
            text: response.text().await.unwrap(),
        }
    }

    pub(crate) fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or_else(|_| panic!("not JSON: {}", self.text))
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

/// A reader of an event stream: its frames as they come.
pub(crate) struct Events {
    response: reqwest::Response,
    splitter: SseFrameSplitter,
    frames: Vec<SseFrame>,
    seen: usize,
}

impl Events {
    fn of(response: reqwest::Response) -> Self {
        Self {
            response,
            splitter: SseFrameSplitter::new(),
            frames: Vec::new(),
            seen: 0,
        }
    }

    /// The next event of `kind` not yet handed out whose data `matches`,
    /// read as it comes.
    pub(crate) async fn event_where(&mut self, kind: &str, matches: impl Fn(&Value) -> bool) {
        tokio::time::timeout(PATIENCE, async {
            loop {
                while self.seen < self.frames.len() {
                    let frame = &self.frames[self.seen];

                    self.seen += 1;

                    if frame.event.as_deref() == Some(kind)
                        && matches(&serde_json::from_str(frame.data.as_deref().unwrap()).unwrap())
                    {
                        return;
                    }
                }

                let chunk = self.response.chunk().await.unwrap();

                self.frames.extend(
                    self.splitter
                        .push(&chunk.expect("the stream goes on until the frame")),
                );
            }
        })
        .await
        .expect("the frame comes");
    }
}

/// The model every character answers through: the replies a test scripts,
/// in order, and the test provider for every other round.
pub(crate) struct Model {
    replies: Mutex<VecDeque<String>>,
    fallback: Arc<dyn RoleModelAdapter>,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            replies: Mutex::default(),
            fallback: select_adapter(Some(TestProvider::Deterministic), None, None)
                .unwrap()
                .unwrap(),
        }
    }
}

impl Model {
    /// The next round says `reply`.
    pub(crate) fn says(&self, reply: &str) {
        self.replies.lock().unwrap().push_back(reply.to_owned());
    }
}

impl std::fmt::Debug for Model {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Model").finish_non_exhaustive()
    }
}

#[async_trait]
impl RoleModelAdapter for Model {
    async fn invoke(&self, invocation: &Invocation<'_>) -> ProviderAnswer {
        let reply = self.replies.lock().unwrap().pop_front();
        let Some(reply) = reply else {
            return self.fallback.invoke(invocation).await;
        };

        ProviderAnswer::Answered {
            output: ModelOutput {
                tool_calls: Vec::new(),
                text: Some(reply),
            },
            finish_reason: Some("stop".to_owned()),
            usage: None,
        }
    }
}
