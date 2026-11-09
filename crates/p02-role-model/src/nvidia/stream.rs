//! A streamed chat completion, OpenAI's shape as the NVIDIA endpoint
//! speaks it, read back into one message: content pieces joined, each tool
//! call's pieces joined by index under the name its first pieces carried,
//! the last finish reason and token counts seen. Each named call's pieces
//! are told as they arrive, so a draft can be shown while the model writes;
//! the reassembled message is what is judged.

use std::collections::BTreeMap;

use p02_contracts::TokenUsage;
use p02_shared::SseFrameSplitter;
use serde_json::{Map, Value};

use super::FailureCode;
use super::transport::provider_error;

/// A piece of a named tool call's arguments: when the name first arrives,
/// everything so far, possibly nothing; after that, each piece.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Fragment<'a> {
    pub(super) index: u64,
    pub(super) name: &'a str,
    pub(super) text: &'a str,
}

/// A tool call as its pieces left it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct StreamedCall {
    pub(super) name: Option<String>,
    pub(super) arguments: String,
}

/// The whole message, as a body that was not streamed would carry it.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Completion {
    pub(super) content: Option<String>,
    pub(super) finish_reason: Option<String>,
    pub(super) calls: Vec<StreamedCall>,
    pub(super) usage: Option<TokenUsage>,
}

/// A chunk that is no part of a completion, or the provider's error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct StreamError {
    pub(super) code: FailureCode,
    pub(super) message: String,
}

/// Whether the stream said all it has to say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Flow {
    More,
    Done,
}

#[derive(Debug, Default)]
pub(super) struct StreamFold {
    frames: SseFrameSplitter,
    content: Option<String>,
    finish_reason: Option<String>,
    usage: Option<TokenUsage>,
    calls: BTreeMap<u64, StreamedCall>,
}

impl StreamFold {
    /// Takes the next bytes, cut anywhere, and tells `heard` each named
    /// call's pieces. `data: [DONE]` ends the stream; what follows it is
    /// not read.
    pub(super) fn push(
        &mut self,
        bytes: &[u8],
        heard: &mut impl FnMut(Fragment<'_>),
    ) -> Result<Flow, StreamError> {
        for frame in self.frames.push(bytes) {
            match frame.data.as_deref() {
                None => {}
                Some("[DONE]") => return Ok(Flow::Done),
                Some(data) => self.take(data, heard)?,
            }
        }

        Ok(Flow::More)
    }

    pub(super) fn finish(self) -> Completion {
        Completion {
            content: self.content,
            finish_reason: self.finish_reason,
            calls: self.calls.into_values().collect(),
            usage: self.usage,
        }
    }

    fn take(
        &mut self,
        data: &str,
        heard: &mut impl FnMut(Fragment<'_>),
    ) -> Result<(), StreamError> {
        let chunk = serde_json::from_str::<Value>(data)
            .map_err(|_| malformed("NVIDIA stream chunk must be JSON."))?;
        let Value::Object(chunk) = chunk else {
            return Err(malformed("NVIDIA stream chunk must be an object."));
        };

        // A 200 can still carry the provider's error, as a chunk of its own.
        if let Some(message) = provider_error(&chunk) {
            return Err(StreamError {
                code: FailureCode::ProviderError,
                message,
            });
        }

        if let Some(usage) = chunk.get("usage").and_then(token_usage) {
            self.usage = Some(usage);
        }

        let Some(Value::Array(choices)) = chunk.get("choices") else {
            return Err(malformed("NVIDIA stream chunk must carry choices."));
        };
        let Some(choice) = choices.first() else {
            return Ok(());
        };
        let Value::Object(choice) = choice else {
            return Err(malformed(
                "NVIDIA stream chunk choices[0] must be an object.",
            ));
        };

        if let Some(Value::String(reason)) = choice.get("finish_reason") {
            self.finish_reason = Some(reason.clone());
        }

        match choice.get("delta") {
            None | Some(Value::Null) => Ok(()),
            Some(Value::Object(delta)) => self.take_delta(delta, heard),
            Some(_) => Err(malformed("NVIDIA stream chunk delta must be an object.")),
        }
    }

    fn take_delta(
        &mut self,
        delta: &Map<String, Value>,
        heard: &mut impl FnMut(Fragment<'_>),
    ) -> Result<(), StreamError> {
        if let Some(Value::String(content)) = delta.get("content") {
            self.content
                .get_or_insert_with(String::new)
                .push_str(content);
        }

        match delta.get("tool_calls") {
            None | Some(Value::Null) => Ok(()),
            Some(Value::Array(pieces)) => pieces
                .iter()
                .try_for_each(|piece| self.take_call(piece, heard)),
            Some(_) => Err(malformed(
                "NVIDIA stream chunk tool_calls must be an array.",
            )),
        }
    }

    fn take_call(
        &mut self,
        piece: &Value,
        heard: &mut impl FnMut(Fragment<'_>),
    ) -> Result<(), StreamError> {
        let Some(index) = piece.get("index").and_then(Value::as_u64) else {
            return Err(malformed(
                "NVIDIA stream chunk tool_calls[] must carry a numeric index.",
            ));
        };
        let call = self.calls.entry(index).or_default();
        let Some(function) = piece
            .get("function")
            .filter(|function| function.is_object())
        else {
            return Ok(());
        };
        let named = call.name.is_none()
            && function
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty());

        if named {
            call.name = function
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }

        let text = function
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("");

        call.arguments.push_str(text);

        if let Some(name) = &call.name
            && (named || !text.is_empty())
        {
            heard(Fragment {
                index,
                name,
                text: if named { &call.arguments } else { text },
            });
        }

        Ok(())
    }
}

/// The token counts of a chunk's usage, when it has both.
fn token_usage(usage: &Value) -> Option<TokenUsage> {
    Some(TokenUsage {
        prompt_tokens: usage.get("prompt_tokens")?.as_u64()?,
        completion_tokens: usage.get("completion_tokens")?.as_u64()?,
    })
}

fn malformed(message: &str) -> StreamError {
    StreamError {
        code: FailureCode::MalformedResponse,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Written by hand after the endpoint's shape: content beside a ping
    /// and a reasoning chunk, two tool calls whose pieces interleave by
    /// index with the name on their first, one named only after its
    /// arguments began, the finish reason, usage on a chunk without
    /// choices, the terminator, and a chunk after it that is never read.
    /// CRLF and LF both end lines, and the text is not all ASCII.
    const SAMPLE: &str = concat!(
        ": ping\r\n\r\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"hmm\"},\"finish_reason\":null}]}\r\n\r\n",
        "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ダーリン、\"},\"finish_reason\":null}]}\r\n\r\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"visible_reply\",\"arguments\":\"\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"text\\\":\\\"ゼロ\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_b\",\"function\":{\"arguments\":\"{\\\"q\\\":\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"一緒に\"}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"name\":\"memory_search\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"ツー💖\\\"}\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"\\\"sky\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":42,\"completion_tokens\":17}}\n\n",
        "data: [DONE]\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"never read\"}}]}\n\n",
    );

    type Heard = Vec<(u64, String, String)>;

    fn read(pieces: &[&[u8]]) -> (Result<Completion, StreamError>, Heard) {
        let mut fold = StreamFold::default();
        let mut heard = Vec::new();
        let mut record = |fragment: Fragment<'_>| {
            heard.push((
                fragment.index,
                fragment.name.to_owned(),
                fragment.text.to_owned(),
            ));
        };

        for piece in pieces {
            match fold.push(piece, &mut record) {
                Ok(Flow::More) => {}
                Ok(Flow::Done) => return (Ok(fold.finish()), heard),
                Err(error) => return (Err(error), heard),
            }
        }

        (Ok(fold.finish()), heard)
    }

    fn call(name: &str, arguments: &str) -> StreamedCall {
        StreamedCall {
            name: Some(name.to_owned()),
            arguments: arguments.to_owned(),
        }
    }

    #[test]
    fn a_stream_cut_at_any_byte_reads_back_as_one_message() {
        let bytes = SAMPLE.as_bytes();
        let whole = read(&[bytes]);

        assert_eq!(
            whole,
            (
                Ok(Completion {
                    content: Some("ダーリン、一緒に".to_owned()),
                    finish_reason: Some("tool_calls".to_owned()),
                    calls: vec![
                        call("visible_reply", "{\"text\":\"ゼロツー💖\"}"),
                        call("memory_search", "{\"q\":\"sky\"}"),
                    ],
                    usage: Some(TokenUsage {
                        prompt_tokens: 42,
                        completion_tokens: 17,
                    }),
                }),
                vec![
                    (0, "visible_reply".to_owned(), String::new()),
                    (0, "visible_reply".to_owned(), "{\"text\":\"ゼロ".to_owned()),
                    (1, "memory_search".to_owned(), "{\"q\":".to_owned()),
                    (0, "visible_reply".to_owned(), "ツー💖\"}".to_owned()),
                    (1, "memory_search".to_owned(), "\"sky\"}".to_owned()),
                ]
            )
        );

        for cut in 0..=bytes.len() {
            assert_eq!(
                read(&[&bytes[..cut], &bytes[cut..]]),
                whole,
                "cut at byte {cut}"
            );
        }

        for size in 1..=16 {
            let pieces: Vec<&[u8]> = bytes.chunks(size).collect();

            assert_eq!(read(&pieces), whole, "pieces of {size} bytes");
        }
    }

    #[test]
    fn a_stream_says_no_more_than_arrived() {
        let (completion, heard) =
            read(&[b"data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n"]);

        assert_eq!((completion, heard), (Ok(Completion::default()), Vec::new()));

        let (completion, _) = read(&[b"data: {\"choices\":[{\"delta\":{\"content\":\"\"}}]}\n\n"]);

        assert_eq!(completion.unwrap().content.as_deref(), Some(""));
    }

    #[test]
    fn a_chunk_that_is_no_completion_is_refused_and_a_provider_error_named() {
        for (data, code, message) in [
            (
                "{oops",
                FailureCode::MalformedResponse,
                "NVIDIA stream chunk must be JSON.",
            ),
            (
                "[]",
                FailureCode::MalformedResponse,
                "NVIDIA stream chunk must be an object.",
            ),
            (
                "{\"choices\":\"nope\"}",
                FailureCode::MalformedResponse,
                "NVIDIA stream chunk must carry choices.",
            ),
            (
                "{\"object\":\"chat.completion.chunk\"}",
                FailureCode::MalformedResponse,
                "NVIDIA stream chunk must carry choices.",
            ),
            (
                "{\"choices\":[7]}",
                FailureCode::MalformedResponse,
                "NVIDIA stream chunk choices[0] must be an object.",
            ),
            (
                "{\"choices\":[{\"delta\":\"x\"}]}",
                FailureCode::MalformedResponse,
                "NVIDIA stream chunk delta must be an object.",
            ),
            (
                "{\"choices\":[{\"delta\":{\"tool_calls\":{}}}]}",
                FailureCode::MalformedResponse,
                "NVIDIA stream chunk tool_calls must be an array.",
            ),
            (
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{}]}}]}",
                FailureCode::MalformedResponse,
                "NVIDIA stream chunk tool_calls[] must carry a numeric index.",
            ),
            (
                "{\"error\":{\"message\":\"model overloaded\",\"type\":\"server\"}}",
                FailureCode::ProviderError,
                "NVIDIA provider error: model overloaded",
            ),
            (
                "{\"message\":\"slow down\",\"choices\":[]}",
                FailureCode::ProviderError,
                "NVIDIA provider error: slow down",
            ),
        ] {
            let frame = format!("data: {data}\n\n");

            assert_eq!(
                read(&[frame.as_bytes()]).0,
                Err(StreamError {
                    code,
                    message: message.to_owned(),
                }),
                "{data}"
            );
        }
    }
}
