//! A streamed message, Anthropic's Messages protocol's events read until the
//! one that stops it: each tool call's arguments are told as they arrive,
//! under the name its block started with, so a draft can be shown while the
//! model writes; each text block is kept, and thinking and any block of no
//! use here are read past. Why the message stopped, its calls, its text and
//! the tokens it took are what is judged.

use std::collections::BTreeMap;

use p02_contracts::TokenUsage;
use p02_shared::SseFrameSplitter;
use serde_json::{Map, Value};

use crate::draft::Fragment;
use crate::prompt::json_text;
use crate::transport::{FailureCode, StreamError, malformed, provider_error, typed_event};

/// A tool call as its block left it: the name the block started with, and
/// its arguments as written, or the input it started with when none were.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Call {
    pub(super) name: Option<String>,
    pub(super) arguments: String,
}

/// A message at its stop: why it stopped, with the category of a decline
/// when the service names one; its calls and its text, in block order; and
/// the tokens it took.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Stopped {
    pub(super) stop_reason: Option<String>,
    pub(super) category: Option<String>,
    pub(super) calls: Vec<Call>,
    pub(super) text: String,
    pub(super) usage: Option<TokenUsage>,
}

/// A block kept as far as it arrived.
#[derive(Debug)]
enum Block {
    Text(String),
    Call {
        name: Option<String>,
        opened: Value,
        arguments: String,
    },
}

#[derive(Debug, Default)]
pub(super) struct MessageFold {
    frames: SseFrameSplitter,
    /// Each block of use here, by its index in the message.
    blocks: BTreeMap<u64, Block>,
    stop_reason: Option<String>,
    category: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

impl MessageFold {
    /// Takes the next bytes, cut anywhere, and tells `heard` each tool
    /// call's pieces: the message once an event stops it; what follows it
    /// is not read.
    pub(super) fn push(
        &mut self,
        bytes: &[u8],
        heard: &mut impl FnMut(Fragment<'_>),
    ) -> Result<Option<Stopped>, StreamError> {
        for frame in self.frames.push(bytes) {
            if let Some(data) = frame.data.as_deref()
                && let Some(stopped) = self.take(data, heard)?
            {
                return Ok(Some(stopped));
            }
        }

        Ok(None)
    }

    fn take(
        &mut self,
        data: &str,
        heard: &mut impl FnMut(Fragment<'_>),
    ) -> Result<Option<Stopped>, StreamError> {
        let (kind, event) = typed_event(data)?;

        match kind.as_str() {
            "message_start" => {
                self.input_tokens = event
                    .get("message")
                    .and_then(|message| message.pointer("/usage/input_tokens"))
                    .and_then(Value::as_u64);
            }
            "content_block_start" => self.started(&event, heard)?,
            "content_block_delta" => self.delta(&event, heard)?,
            "message_delta" => self.message_delta(&event),
            "message_stop" => return Ok(Some(self.stopped())),
            "error" => {
                return Err(StreamError {
                    code: FailureCode::ProviderError,
                    message: provider_error(&event).unwrap_or_else(|| "provider error.".to_owned()),
                });
            }
            _ => {}
        }

        Ok(None)
    }

    /// A block, started: a text block, or a tool call under its name, which
    /// a draft is told; thinking and any other block are read past. The
    /// block that marks Anthropic's fallback taking over lets go every call
    /// before it: the model that declined left them unfinished, and only
    /// its text is carried on.
    fn started(
        &mut self,
        event: &Map<String, Value>,
        heard: &mut impl FnMut(Fragment<'_>),
    ) -> Result<(), StreamError> {
        let index = index(event)?;
        let block = event.get("content_block");
        let field = |name: &str| block.and_then(|block| block.get(name));
        let kept = match field("type").and_then(Value::as_str) {
            Some("text") => Block::Text(
                field("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            ),
            Some("tool_use") => {
                let name = field("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned);

                if let Some(name) = &name {
                    heard(Fragment {
                        index,
                        name,
                        text: "",
                    });
                }

                Block::Call {
                    name,
                    opened: field("input").cloned().unwrap_or(Value::Null),
                    arguments: String::new(),
                }
            }
            Some("fallback") => {
                self.blocks
                    .retain(|_, block| matches!(block, Block::Text(_)));
                return Ok(());
            }
            _ => return Ok(()),
        };

        self.blocks.insert(index, kept);
        Ok(())
    }

    /// The next piece of a block kept: its text, or a named call's
    /// arguments, which a draft is told.
    fn delta(
        &mut self,
        event: &Map<String, Value>,
        heard: &mut impl FnMut(Fragment<'_>),
    ) -> Result<(), StreamError> {
        let index = index(event)?;
        let delta = event.get("delta");
        let field = |name: &str| {
            delta
                .and_then(|delta| delta.get(name))
                .and_then(Value::as_str)
        };

        match (self.blocks.get_mut(&index), field("type")) {
            (Some(Block::Text(text)), Some("text_delta")) => {
                text.push_str(field("text").unwrap_or(""));
            }
            (
                Some(Block::Call {
                    name, arguments, ..
                }),
                Some("input_json_delta"),
            ) => {
                let piece = field("partial_json").unwrap_or("");

                arguments.push_str(piece);

                if let Some(name) = name
                    && !piece.is_empty()
                {
                    heard(Fragment {
                        index,
                        name,
                        text: piece,
                    });
                }
            }
            _ => {}
        }

        Ok(())
    }

    /// Why the message stops, with a decline's category, and the tokens it
    /// wrote.
    fn message_delta(&mut self, event: &Map<String, Value>) {
        let delta = event.get("delta");

        if let Some(reason) = delta
            .and_then(|delta| delta.get("stop_reason"))
            .and_then(Value::as_str)
        {
            self.stop_reason = Some(reason.to_owned());
        }

        if let Some(category) = delta
            .and_then(|delta| delta.pointer("/stop_details/category"))
            .and_then(Value::as_str)
        {
            self.category = Some(category.to_owned());
        }

        if let Some(tokens) = event
            .get("usage")
            .and_then(|usage| usage.get("output_tokens"))
            .and_then(Value::as_u64)
        {
            self.output_tokens = Some(tokens);
        }
    }

    /// The message as it stopped: each call's arguments as written, or,
    /// where none were, the input its block started with.
    fn stopped(&mut self) -> Stopped {
        let fold = std::mem::take(self);
        let mut calls = Vec::new();
        let mut text = String::new();

        for block in fold.blocks.into_values() {
            match block {
                Block::Text(piece) => text.push_str(&piece),
                Block::Call {
                    name,
                    opened,
                    arguments,
                } => calls.push(Call {
                    name,
                    arguments: if arguments.is_empty() {
                        json_text(&opened)
                    } else {
                        arguments
                    },
                }),
            }
        }

        Stopped {
            stop_reason: fold.stop_reason,
            category: fold.category,
            calls,
            text,
            usage: fold.input_tokens.zip(fold.output_tokens).map(
                |(prompt_tokens, completion_tokens)| TokenUsage {
                    prompt_tokens,
                    completion_tokens,
                },
            ),
        }
    }
}

/// Which block of the message an event is of.
fn index(event: &Map<String, Value>) -> Result<u64, StreamError> {
    event
        .get("index")
        .and_then(Value::as_u64)
        .ok_or_else(|| malformed("stream event must carry its block's index."))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Written by hand after the protocol's events: the message started
    /// with its input tokens, a ping, a thinking block with its signature,
    /// a text block in two pieces, her reply's call in two pieces, a call
    /// that wrote no arguments, the stop with the tokens written, and an
    /// event after it that is never read. CRLF and LF both end lines, and
    /// the text is not all ASCII.
    const SAMPLE: &str = concat!(
        "event: message_start\r\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":42,\"output_tokens\":1}}}\r\n\r\n",
        "event: ping\ndata: {\"type\":\"ping\"}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"c2ln\"}}\n\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"ダーリン、\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"一緒に\"}}\n\n",
        "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_a\",\"name\":\"visible_reply\",\"input\":{}}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"text\\\":\\\"ゼロ\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"ツー💖\\\"}\"}}\n\n",
        "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_b\",\"name\":\"runtime_plugin_list\",\"input\":{}}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\"}}\n\n",
        "data: {\"type\":\"content_block_stop\",\"index\":3}\n\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":17}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n",
        "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"never read\"}}\n\n",
    );

    type Heard = Vec<(u64, String, String)>;

    fn read(pieces: &[&[u8]]) -> (Result<Option<Stopped>, StreamError>, Heard) {
        let mut fold = MessageFold::default();
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
                Ok(None) => {}
                stopped => return (stopped, heard),
            }
        }

        (Ok(None), heard)
    }

    /// A decline in the middle of a message, taken over by the fallback: the
    /// call the declining model left unfinished is let go, its text stays,
    /// and the fallback's own call is the answer's.
    #[test]
    fn a_fallback_taking_over_lets_go_the_calls_before_it_and_keeps_the_text() {
        let stream = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"A note. \"}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_a\",\"name\":\"visible_reply\",\"input\":{}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"text\\\":\\\"Half a\"}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"fallback\",\"from\":{\"model\":\"claude-opus-5-5\"},\"to\":{\"model\":\"claude-opus-4-8\"}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_b\",\"name\":\"visible_reply\",\"input\":{}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"text\\\":\\\"Whole.\\\"}\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":9}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let (stopped, _) = read(&[stream.as_bytes()]);
        let stopped = stopped.unwrap().unwrap();

        assert_eq!(
            stopped.calls,
            [Call {
                name: Some("visible_reply".to_owned()),
                arguments: "{\"text\":\"Whole.\"}".to_owned(),
            }]
        );
        assert_eq!(stopped.text, "A note. ");
    }

    fn call(name: &str, arguments: &str) -> Call {
        Call {
            name: Some(name.to_owned()),
            arguments: arguments.to_owned(),
        }
    }

    #[test]
    fn a_stream_cut_at_any_byte_tells_the_same_pieces_and_stops_with_the_same_message() {
        let bytes = SAMPLE.as_bytes();
        let whole = read(&[bytes]);

        assert_eq!(
            whole,
            (
                Ok(Some(Stopped {
                    stop_reason: Some("tool_use".to_owned()),
                    category: None,
                    calls: vec![
                        call("visible_reply", "{\"text\":\"ゼロツー💖\"}"),
                        call("runtime_plugin_list", "{}"),
                    ],
                    text: "ダーリン、一緒に".to_owned(),
                    usage: Some(TokenUsage {
                        prompt_tokens: 42,
                        completion_tokens: 17,
                    }),
                })),
                vec![
                    (2, "visible_reply".to_owned(), String::new()),
                    (2, "visible_reply".to_owned(), "{\"text\":\"ゼロ".to_owned()),
                    (2, "visible_reply".to_owned(), "ツー💖\"}".to_owned()),
                    (3, "runtime_plugin_list".to_owned(), String::new()),
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
    }
}
