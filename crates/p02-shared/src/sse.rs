/// A server-sent event: the fields of one frame this repository reads;
/// others are skipped.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SseFrame {
    pub id: Option<String>,
    pub event: Option<String>,
    /// Every `data` line of the frame, joined with `\n`.
    pub data: Option<String>,
    /// The frame's last comment, trimmed: `: ping` is `ping`.
    pub comment: Option<String>,
}

/// Splits a byte stream into frames, whatever chunks it arrives in. A frame
/// ends at a blank line; a line ends in LF, CRLF or CR, a CRLF may be split
/// between chunks, and so may a UTF-8 sequence, since a frame is decoded
/// only once it is whole.
#[derive(Debug, Default)]
pub struct SseFrameSplitter {
    frame: Vec<u8>,
    after_cr: bool,
}

impl SseFrameSplitter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the next chunk and returns the frames it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseFrame> {
        let mut frames = Vec::new();

        for &byte in chunk {
            let second_half_of_crlf = byte == b'\n' && self.after_cr;

            self.after_cr = byte == b'\r';
            if second_half_of_crlf {
                continue;
            }

            if byte != b'\n' && byte != b'\r' {
                self.frame.push(byte);
            } else if self.frame.last() == Some(&b'\n') {
                // A line that ends as soon as it starts is blank: the frame is whole.
                self.frame.pop();
                frames.push(SseFrame::parse(&String::from_utf8_lossy(&self.frame)));
                self.frame.clear();
            } else {
                self.frame.push(b'\n');
            }
        }

        frames
    }
}

impl SseFrame {
    fn parse(text: &str) -> Self {
        let mut frame = Self::default();
        let mut data = Vec::new();

        for line in text.split('\n') {
            if let Some(comment) = line.strip_prefix(':') {
                frame.comment = Some(comment.trim().to_owned());
                continue;
            }

            let (field, value) = line.split_once(':').map_or((line, ""), |(field, value)| {
                (field, value.strip_prefix(' ').unwrap_or(value))
            });

            match field {
                "id" => frame.id = Some(value.to_owned()),
                "event" => frame.event = Some(value.to_owned()),
                "data" => data.push(value),
                _ => {}
            }
        }

        if !data.is_empty() {
            frame.data = Some(data.join("\n"));
        }

        frame
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(event: Option<&str>, data: Option<&str>, comment: Option<&str>) -> SseFrame {
        SseFrame {
            id: None,
            event: event.map(str::to_owned),
            data: data.map(str::to_owned),
            comment: comment.map(str::to_owned),
        }
    }

    #[test]
    fn reassembles_frames_split_across_chunks_whatever_the_line_ending() {
        let mut splitter = SseFrameSplitter::new();

        assert_eq!(
            splitter.push(b"event: ready\ndata: {\"protocolVersion\":1}\n"),
            []
        );
        assert_eq!(
            splitter.push(b"\nevent: turn_completed\r\ndata: {\"a\":1}\r"),
            [frame(Some("ready"), Some("{\"protocolVersion\":1}"), None)]
        );
        assert_eq!(
            splitter.push(b"\n\r\n: ping\n\n"),
            [
                frame(Some("turn_completed"), Some("{\"a\":1}"), None),
                frame(None, None, Some("ping")),
            ]
        );
    }

    #[test]
    fn joins_data_lines_strips_one_space_reads_the_id_and_skips_unknown_fields() {
        let mut splitter = SseFrameSplitter::new();

        assert_eq!(
            splitter
                .push(b"event:state_changed\ndata: {\"kind\":\ndata:  \"x\"}\nid: 7\nretry\n\n"),
            [SseFrame {
                id: Some("7".to_owned()),
                event: Some("state_changed".to_owned()),
                data: Some("{\"kind\":\n \"x\"}".to_owned()),
                comment: None,
            }]
        );
    }

    #[test]
    fn a_utf8_sequence_cut_between_chunks_survives() {
        let bytes = "data: \u{30bc}\u{30ed}\u{30c4}\u{30fc}\n\n".as_bytes();
        let mut splitter = SseFrameSplitter::new();

        assert_eq!(splitter.push(&bytes[..8]), []);
        assert_eq!(
            splitter.push(&bytes[8..]),
            [frame(None, Some("\u{30bc}\u{30ed}\u{30c4}\u{30fc}"), None)]
        );
    }
}
