use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};

/// How big a rendered prompt was: per frame kind in wire order, plus the
/// tools, in characters of the serialized wire, the one fact measured. The
/// frames sum to the wire messages and tokens are an estimate applied when
/// read, so nothing stored can disagree with anything else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSize {
    frames: Vec<FrameSize>,
    tool_chars: u64,
}

/// The size of the wire messages of one frame kind. A frame kind is listed
/// only when it was sent, so both figures are at least one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSize {
    pub kind: String,
    /// How many wire messages of the kind: history and tool rounds have many.
    pub count: NonZeroU64,
    pub chars: NonZeroU64,
}

impl PromptSize {
    /// The size of a prompt of `frames`, each kind listed once in wire
    /// order, and of tools taking `tool_chars`.
    #[must_use]
    pub fn new(frames: Vec<FrameSize>, tool_chars: u64) -> Self {
        Self { frames, tool_chars }
    }

    #[must_use]
    pub fn frames(&self) -> &[FrameSize] {
        &self.frames
    }

    /// The tools' characters; a turn without tools sends none.
    #[must_use]
    pub fn tool_chars(&self) -> u64 {
        self.tool_chars
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_prompt_size_reads_back_as_written() {
        let size = json!({
            "frames": [
                {"kind": "system_protocol", "count": 1, "chars": 2048},
                {"kind": "conversation_history", "count": 6, "chars": 900},
            ],
            "toolChars": 0,
        });
        let parsed: PromptSize = serde_json::from_value(size.clone()).unwrap();

        assert_eq!(serde_json::to_value(&parsed).unwrap(), size);
    }
}
