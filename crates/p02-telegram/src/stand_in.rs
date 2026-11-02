//! Telegram's Bot API in memory for this crate's tests, answering on the
//! clock the test runs on, so a paused clock never races a socket: every
//! call kept with the moment it came, and answered as Telegram answers it,
//! but for a poll the test ends with a 409 and a call it has refused or
//! asked to wait.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

use crate::Lines;
use crate::bot_api::{Failure, Transport};

/// A call as the stand-in received it.
#[derive(Clone, Debug)]
pub(crate) struct Call {
    pub(crate) method: String,
    pub(crate) body: Value,
    pub(crate) at: Instant,
}

#[derive(Debug, Default)]
struct Shared {
    calls: watch::Sender<Vec<Call>>,
    /// The next poll waits for this, and is then ended as another program's
    /// newer poll ends it.
    conflict: Mutex<Option<oneshot::Receiver<()>>>,
    /// Calls to refuse: the method, how many more of its calls go through
    /// first, and the envelope Telegram answers it with.
    refusals: Mutex<VecDeque<(String, usize, Value)>>,
}

/// Its clones are one Bot API: a test keeps one and hands a bot another.
#[derive(Clone, Debug)]
pub(crate) struct StandIn {
    shared: Arc<Shared>,
}

impl StandIn {
    pub(crate) fn new() -> Self {
        Self {
            shared: Arc::new(Shared::default()),
        }
    }

    /// The next poll waits until the sender is used, and is then answered
    /// 409.
    pub(crate) fn conflict_next_poll(&self) -> oneshot::Sender<()> {
        let (end, ended) = oneshot::channel();

        *self.shared.conflict.lock().unwrap() = Some(ended);
        end
    }

    /// The call of `method` after `through` more of them is refused.
    pub(crate) fn refuse(&self, method: &str, through: usize, code: i64, description: &str) {
        self.refuse_with(
            method,
            through,
            json!({"ok": false, "error_code": code, "description": description}),
        );
    }

    /// The call of `method` after `through` more of them is asked to wait
    /// `seconds` before it is made again.
    pub(crate) fn ask_to_wait(&self, method: &str, through: usize, seconds: u64) {
        self.refuse_with(
            method,
            through,
            json!({
                "ok": false,
                "error_code": 429,
                "description": format!("Too Many Requests: retry after {seconds}"),
                "parameters": {"retry_after": seconds},
            }),
        );
    }

    fn refuse_with(&self, method: &str, through: usize, answer: Value) {
        self.shared
            .refusals
            .lock()
            .unwrap()
            .push_back((method.to_owned(), through, answer));
    }

    pub(crate) fn calls(&self, method: &str) -> Vec<Call> {
        self.shared
            .calls
            .borrow()
            .iter()
            .filter(|call| call.method == method)
            .cloned()
            .collect()
    }

    /// The calls of `method`, once there are `count` of them.
    pub(crate) async fn called(&self, method: &str, count: usize) -> Vec<Call> {
        let mut calls = self.shared.calls.subscribe();

        calls
            .wait_for(|calls| calls.iter().filter(|call| call.method == method).count() >= count)
            .await
            .unwrap();
        self.calls(method)
    }
}

#[async_trait]
impl Transport for StandIn {
    async fn post(
        &self,
        path: &str,
        body: Vec<u8>,
        _bound: Duration,
    ) -> Result<(u16, Vec<u8>), Failure> {
        let envelope = answer(&self.shared, path, &body).await;

        Ok((200, envelope.to_string().into_bytes()))
    }
}

/// The envelope Telegram answers the call with.
async fn answer(shared: &Shared, path: &str, body: &[u8]) -> Value {
    let method = path.rsplit('/').next().unwrap_or_default().to_owned();
    let body: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let refused = {
        let mut refusals = shared.refusals.lock().unwrap();

        match refusals.iter().position(|refusal| refusal.0 == method) {
            Some(at) if refusals[at].1 == 0 => refusals.remove(at).map(|(_, _, answer)| answer),
            Some(at) => {
                refusals[at].1 -= 1;
                None
            }
            None => None,
        }
    };

    shared.calls.send_modify(|calls| {
        calls.push(Call {
            method: method.clone(),
            body: body.clone(),
            at: Instant::now(),
        });
    });

    if let Some(answer) = refused {
        return answer;
    }

    match method.as_str() {
        "getMe" => json!({
            "ok": true,
            "result": {"id": 123_456, "is_bot": true, "first_name": "home_bot", "username": "home_bot"},
        }),
        "getUpdates" => {
            let conflict = shared.conflict.lock().unwrap().take();

            if let Some(ended) = conflict {
                let _ = ended.await;

                return json!({
                    "ok": false,
                    "error_code": 409,
                    "description": "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
                });
            }

            tokio::time::sleep(Duration::from_secs(
                body["timeout"].as_u64().unwrap_or_default(),
            ))
            .await;
            json!({"ok": true, "result": []})
        }
        "sendMessage" => {
            let sent = shared
                .calls
                .borrow()
                .iter()
                .filter(|call| call.method == method)
                .count();

            json!({
                "ok": true,
                "result": {
                    "message_id": sent,
                    "chat": {"id": body["chat_id"], "type": "private"},
                    "text": body["text"],
                },
            })
        }
        _ => json!({"ok": true, "result": true}),
    }
}

/// What a connector said, in order, each line with the stream it went to.
#[derive(Debug, Default)]
pub(crate) struct Heard(watch::Sender<Vec<(bool, String)>>);

impl Heard {
    /// The lines said on stderr.
    pub(crate) fn reports(&self) -> Vec<String> {
        self.0
            .borrow()
            .iter()
            .filter(|(report, _)| *report)
            .map(|(_, line)| line.clone())
            .collect()
    }

    /// Answers once `line` was said on stderr.
    pub(crate) async fn reported(&self, line: &str) {
        self.0
            .subscribe()
            .wait_for(|lines| lines.iter().any(|(report, said)| *report && said == line))
            .await
            .unwrap();
    }
}

impl Lines for Heard {
    fn say(&self, line: &str) {
        self.0
            .send_modify(|lines| lines.push((false, line.to_owned())));
    }

    fn report(&self, line: &str) {
        self.0
            .send_modify(|lines| lines.push((true, line.to_owned())));
    }
}
