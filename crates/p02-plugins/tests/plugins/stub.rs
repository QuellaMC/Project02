//! A service on the loopback interface for the mem0 package to call: a
//! Mem0 REST backend, or an OpenAI-wire model and embedder. It answers each
//! request on a path with the next answer the test scripted for that path,
//! or as the service would by default, and keeps every request it was sent.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// The width of every vector the stub embedder answers with.
const WIDTH: usize = 64;

/// How long a test waits for what it expects of the package.
const PATIENCE: Duration = Duration::from_secs(10);

/// A request as the stub received it.
#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Value,
}

impl Request {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }
}

/// How the stub answers one request.
#[derive(Clone, Debug)]
pub(crate) struct Answer {
    status: u16,
    location: Option<String>,
    body: String,
}

impl Answer {
    pub(crate) fn json(status: u16, body: &Value) -> Self {
        Self {
            status,
            location: None,
            body: body.to_string(),
        }
    }

    /// A body as written, which need not be JSON.
    pub(crate) fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            location: None,
            body: body.to_owned(),
        }
    }

    pub(crate) fn redirect(location: &str) -> Self {
        Self {
            status: 302,
            location: Some(location.to_owned()),
            body: String::new(),
        }
    }

    /// A chat completion holding `content` as the model's answer.
    pub(crate) fn completion(content: &str) -> Self {
        Self::json(
            200,
            &json!({
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": content},
                }],
            }),
        )
    }

    /// The model extracting `memories` from a turn.
    pub(crate) fn extraction(memories: &[&str]) -> Self {
        let memory: Vec<Value> = memories
            .iter()
            .enumerate()
            .map(|(at, text)| json!({"id": at.to_string(), "text": text}))
            .collect();

        Self::completion(&json!({"memory": memory}).to_string())
    }
}

enum Step {
    Answer(Answer),
    Default,
    Hold {
        arrived: oneshot::Sender<Request>,
        release: oneshot::Receiver<Answer>,
    },
}

#[derive(Clone, Copy)]
enum Kind {
    Mem0,
    OpenAi,
}

struct Shared {
    kind: Kind,
    steps: Mutex<HashMap<String, VecDeque<Step>>>,
    requests: Mutex<Vec<Request>>,
}

pub(crate) struct Stub {
    address: SocketAddr,
    shared: Arc<Shared>,
    server: JoinHandle<()>,
}

/// A request the stub holds until the test releases it.
pub(crate) struct Held {
    arrived: oneshot::Receiver<Request>,
    release: oneshot::Sender<Answer>,
}

impl Stub {
    /// A Mem0 backend, which answers what nobody scripted with no results.
    pub(crate) async fn mem0() -> Self {
        Self::start(Kind::Mem0).await
    }

    /// An OpenAI-wire service under `/v1`: it embeds deterministically, each
    /// word of a text adding to a dimension the model and the word choose, and
    /// a model it serves extracts nothing unless the test scripted otherwise.
    pub(crate) async fn openai() -> Self {
        Self::start(Kind::OpenAi).await
    }

    async fn start(kind: Kind) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let shared = Arc::new(Shared {
            kind,
            steps: Mutex::new(HashMap::new()),
            requests: Mutex::new(Vec::new()),
        });
        let app = Router::new()
            .fallback(respond)
            .with_state(Arc::clone(&shared));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        Self {
            address,
            shared,
            server,
        }
    }

    pub(crate) fn base_url(&self) -> String {
        match self.shared.kind {
            Kind::Mem0 => format!("http://{}", self.address),
            Kind::OpenAi => format!("http://{}/v1", self.address),
        }
    }

    /// The next request on `path` gets `answer`, after those scripted
    /// before it.
    pub(crate) fn answer(&self, path: &str, answer: Answer) {
        self.script(path, Step::Answer(answer));
    }

    /// The next `count` requests on `path` get the default answer.
    pub(crate) fn pass(&self, path: &str, count: usize) {
        for _ in 0..count {
            self.script(path, Step::Default);
        }
    }

    /// The next request on `path` waits until the test releases it.
    pub(crate) fn hold(&self, path: &str) -> Held {
        let (arrival, arrived) = oneshot::channel();
        let (release, released) = oneshot::channel();

        self.script(
            path,
            Step::Hold {
                arrived: arrival,
                release: released,
            },
        );
        Held { arrived, release }
    }

    pub(crate) fn requests(&self) -> Vec<Request> {
        self.shared.requests.lock().unwrap().clone()
    }

    pub(crate) fn requests_to(&self, path: &str) -> Vec<Request> {
        self.requests()
            .into_iter()
            .filter(|request| request.path == path)
            .collect()
    }

    /// Waits until `count` requests reached `path`, and returns them.
    pub(crate) async fn requests_once(&self, path: &str, count: usize) -> Vec<Request> {
        eventually(&format!("{count} request(s) to reach {path}"), || {
            let requests = self.requests_to(path);

            (requests.len() >= count).then_some(requests)
        })
        .await
    }

    fn script(&self, path: &str, step: Step) {
        self.shared
            .steps
            .lock()
            .unwrap()
            .entry(path.to_owned())
            .or_default()
            .push_back(step);
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Held {
    pub(crate) async fn arrived(&mut self) -> Request {
        tokio::time::timeout(PATIENCE, &mut self.arrived)
            .await
            .expect("the held request did not arrive")
            .unwrap()
    }

    pub(crate) fn release(self, answer: Answer) {
        drop(self.release.send(answer));
    }
}

/// What `probe` finds, once it finds something.
async fn eventually<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + PATIENCE;

    loop {
        if let Some(found) = probe() {
            return found;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "waited in vain for {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The vector the stub embeds `text` as under `model`.
pub(crate) fn embedding(model: &str, text: &str) -> Vec<f32> {
    let mut vector = vec![0.0; WIDTH];
    let words: Vec<String> = text
        .to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect();

    for word in &words {
        vector[bucket(model, word)] += 1.0;
    }

    if words.is_empty() {
        vector[bucket(model, "")] = 1.0;
    }

    vector
}

fn bucket(model: &str, word: &str) -> usize {
    let hash = format!("{model}\u{0}{word}")
        .bytes()
        .fold(0x811c_9dc5_u32, |hash, byte| {
            (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
        });

    usize::try_from(hash).unwrap() % WIDTH
}

async fn respond(
    State(shared): State<Arc<Shared>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request = Request {
        method: method.to_string(),
        path: uri.path().to_owned(),
        headers,
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    };

    shared.requests.lock().unwrap().push(request.clone());

    let step = shared
        .steps
        .lock()
        .unwrap()
        .get_mut(&request.path)
        .and_then(VecDeque::pop_front)
        .unwrap_or(Step::Default);
    let answer = match step {
        Step::Answer(answer) => answer,
        Step::Default => default_answer(shared.kind, &request),
        Step::Hold { arrived, release } => {
            drop(arrived.send(request));

            match release.await {
                Ok(answer) => answer,
                Err(_) => Answer::text(503, "the test let go of this request"),
            }
        }
    };
    let mut response = (
        StatusCode::from_u16(answer.status).unwrap(),
        [(header::CONTENT_TYPE, "application/json")],
        answer.body,
    )
        .into_response();

    if let Some(location) = answer.location {
        response
            .headers_mut()
            .insert(header::LOCATION, location.parse().unwrap());
    }

    response
}

fn default_answer(kind: Kind, request: &Request) -> Answer {
    match kind {
        Kind::Mem0 => Answer::json(200, &json!({"results": []})),
        Kind::OpenAi if request.path.ends_with("/embeddings") => {
            let model = request.body["model"].as_str().unwrap_or_default();
            let texts: Vec<&str> = match &request.body["input"] {
                Value::String(text) => vec![text],
                Value::Array(texts) => texts.iter().filter_map(Value::as_str).collect(),
                _ => Vec::new(),
            };
            let data: Vec<Value> = texts
                .iter()
                .enumerate()
                .map(|(index, text)| {
                    json!({"object": "embedding", "index": index, "embedding": embedding(model, text)})
                })
                .collect();

            Answer::json(
                200,
                &json!({"object": "list", "data": data, "model": model}),
            )
        }
        Kind::OpenAi if request.path.ends_with("/chat/completions") => Answer::extraction(&[]),
        Kind::OpenAi => Answer::text(404, "{}"),
    }
}
