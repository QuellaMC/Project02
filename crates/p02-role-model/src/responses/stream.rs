//! A streamed response, the Responses protocol's events read until the one
//! that ends it: each function call's arguments are told as they arrive,
//! under the name its item carried when it was added, so a draft can be
//! shown while the model writes; the response the ending event carries is
//! what is judged.

use std::collections::BTreeMap;

use p02_shared::SseFrameSplitter;
use serde_json::{Map, Value};

use crate::draft::Fragment;
use crate::transport::{FailureCode, StreamError, malformed, provider_error};

#[derive(Debug, Default)]
pub(super) struct EventFold {
    frames: SseFrameSplitter,
    /// Each function call's name, by its item's place in the output.
    names: BTreeMap<u64, String>,
}

impl EventFold {
    /// Takes the next bytes, cut anywhere, and tells `heard` each function
    /// call's pieces: the response an ending event carries, once one
    /// arrives; what follows it is not read.
    pub(super) fn push(
        &mut self,
        bytes: &[u8],
        heard: &mut impl FnMut(Fragment<'_>),
    ) -> Result<Option<Value>, StreamError> {
        for frame in self.frames.push(bytes) {
            if let Some(data) = frame.data.as_deref()
                && let Some(ended) = self.take(data, heard)?
            {
                return Ok(Some(ended));
            }
        }

        Ok(None)
    }

    fn take(
        &mut self,
        data: &str,
        heard: &mut impl FnMut(Fragment<'_>),
    ) -> Result<Option<Value>, StreamError> {
        let event = serde_json::from_str::<Value>(data)
            .map_err(|_| malformed("stream event must be JSON."))?;
        let Value::Object(mut event) = event else {
            return Err(malformed("stream event must be an object."));
        };

        match event.get("type").and_then(Value::as_str) {
            Some("response.completed" | "response.incomplete" | "response.failed") => {
                match event.remove("response") {
                    Some(response @ Value::Object(_)) => Ok(Some(response)),
                    _ => Err(malformed("stream event response must be an object.")),
                }
            }
            Some("error") => Err(StreamError {
                code: FailureCode::ProviderError,
                message: provider_error(&event).unwrap_or_else(|| "provider error.".to_owned()),
            }),
            Some("response.output_item.added") => {
                self.added(&event, heard);
                Ok(None)
            }
            Some("response.function_call_arguments.delta") => {
                self.delta(&event, heard);
                Ok(None)
            }
            Some(_) => Ok(None),
            None => Err(malformed("stream event must carry its type.")),
        }
    }

    /// A function call's item, added: its name, and the arguments it opens
    /// with. A draft is only a preview, so one that cannot be read is let
    /// go.
    fn added(&mut self, event: &Map<String, Value>, heard: &mut impl FnMut(Fragment<'_>)) {
        let item = event.get("item");
        let index = event.get("output_index").and_then(Value::as_u64);
        let name = item
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            .and_then(|item| item.get("name"))
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty());

        if let (Some(index), Some(name)) = (index, name) {
            let name = self.names.entry(index).or_insert_with(|| name.to_owned());

            heard(Fragment {
                index,
                name,
                text: item
                    .and_then(|item| item.get("arguments"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            });
        }
    }

    /// The next piece of a named call's arguments.
    fn delta(&self, event: &Map<String, Value>, heard: &mut impl FnMut(Fragment<'_>)) {
        let index = event.get("output_index").and_then(Value::as_u64);
        let text = event.get("delta").and_then(Value::as_str);

        if let (Some(index), Some(text)) = (index, text)
            && let Some(name) = self.names.get(&index)
            && !text.is_empty()
        {
            heard(Fragment { index, name, text });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Written by hand after the protocol's events: a reasoning item and a
    /// message whose text streams, then two function calls whose argument
    /// pieces interleave by their place in the output, a call's name on
    /// its added item, the completed response, and an event after it that
    /// is never read. CRLF and LF both end lines, and the text is not all
    /// ASCII.
    const SAMPLE: &str = concat!(
        "event: response.created\r\ndata: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\",\"output\":[]}}\r\n\r\n",
        "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_1\",\"summary\":[]}}\n\n",
        "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"output_index\":1,\"content_index\":0,\"delta\":\"ダーリン、\"}\n\n",
        "data: {\"type\":\"response.output_item.added\",\"output_index\":2,\"item\":{\"type\":\"function_call\",\"id\":\"fc_a\",\"call_id\":\"call_a\",\"name\":\"visible_reply\",\"arguments\":\"\"}}\n\n",
        "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":2,\"item_id\":\"fc_a\",\"delta\":\"{\\\"text\\\":\\\"ゼロ\"}\n\n",
        "data: {\"type\":\"response.output_item.added\",\"output_index\":3,\"item\":{\"type\":\"function_call\",\"id\":\"fc_b\",\"call_id\":\"call_b\",\"name\":\"memory_search\",\"arguments\":\"\"}}\n\n",
        "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":3,\"item_id\":\"fc_b\",\"delta\":\"{\\\"q\\\":\"}\n\n",
        "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":2,\"item_id\":\"fc_a\",\"delta\":\"ツー💖\\\"}\"}\n\n",
        "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":3,\"item_id\":\"fc_b\",\"delta\":\"\\\"sky\\\"}\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n",
        "data: {\"type\":\"error\",\"message\":\"never read\"}\n\n",
    );

    type Heard = Vec<(u64, String, String)>;

    fn read(pieces: &[&[u8]]) -> (Result<Option<Value>, StreamError>, Heard) {
        let mut fold = EventFold::default();
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
                ended => return (ended, heard),
            }
        }

        (Ok(None), heard)
    }

    #[test]
    fn a_stream_cut_at_any_byte_tells_the_same_pieces_and_ends_with_the_same_response() {
        let bytes = SAMPLE.as_bytes();
        let whole = read(&[bytes]);

        assert_eq!(
            whole,
            (
                Ok(Some(
                    serde_json::json!({"status": "completed", "output": []})
                )),
                vec![
                    (2, "visible_reply".to_owned(), String::new()),
                    (2, "visible_reply".to_owned(), "{\"text\":\"ゼロ".to_owned()),
                    (3, "memory_search".to_owned(), String::new()),
                    (3, "memory_search".to_owned(), "{\"q\":".to_owned()),
                    (2, "visible_reply".to_owned(), "ツー💖\"}".to_owned()),
                    (3, "memory_search".to_owned(), "\"sky\"}".to_owned()),
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

    #[test]
    fn an_event_that_is_no_part_of_a_response_is_refused_and_an_error_named() {
        for (data, code, message) in [
            (
                "{oops",
                FailureCode::MalformedResponse,
                "stream event must be JSON.",
            ),
            (
                "[]",
                FailureCode::MalformedResponse,
                "stream event must be an object.",
            ),
            (
                "{\"delta\":\"x\"}",
                FailureCode::MalformedResponse,
                "stream event must carry its type.",
            ),
            (
                "{\"type\":\"response.completed\",\"response\":\"done\"}",
                FailureCode::MalformedResponse,
                "stream event response must be an object.",
            ),
            (
                "{\"type\":\"error\",\"code\":\"server_error\",\"message\":\"The server had an error.\"}",
                FailureCode::ProviderError,
                "provider error: The server had an error.",
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
