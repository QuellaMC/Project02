use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};

/// How big a rendered prompt was: per frame kind in wire order, plus the
/// tools, in characters of the serialized wire, the one fact measured. The
/// frames sum to the wire messages and tokens are an estimate applied when
/// read, so nothing stored can disagree with anything else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "UncheckedPromptSize")]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedPromptSize {
    frames: Vec<FrameSize>,
    tool_chars: u64,
}

/// Why a prompt size is refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PromptSizeError {
    #[error("a prompt size has at least the frames every prompt carries")]
    NoFrames,
    #[error("a prompt size frame must name its kind")]
    UnnamedFrame,
    #[error("a prompt size lists frame kind \"{kind}\" twice, which would count it twice")]
    RepeatedKind { kind: String },
}

impl PromptSize {
    /// # Errors
    ///
    /// [`PromptSizeError`] for no frames, a frame without a kind, or a kind
    /// listed twice.
    pub fn new(frames: Vec<FrameSize>, tool_chars: u64) -> Result<Self, PromptSizeError> {
        if frames.is_empty() {
            return Err(PromptSizeError::NoFrames);
        }

        for (index, frame) in frames.iter().enumerate() {
            if frame.kind.is_empty() {
                return Err(PromptSizeError::UnnamedFrame);
            }

            if frames[..index]
                .iter()
                .any(|earlier| earlier.kind == frame.kind)
            {
                return Err(PromptSizeError::RepeatedKind {
                    kind: frame.kind.clone(),
                });
            }
        }

        Ok(Self { frames, tool_chars })
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

impl TryFrom<UncheckedPromptSize> for PromptSize {
    type Error = PromptSizeError;

    fn try_from(unchecked: UncheckedPromptSize) -> Result<Self, Self::Error> {
        Self::new(unchecked.frames, unchecked.tool_chars)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_prompt_size_lists_each_sent_frame_kind_once() {
        let size = json!({
            "frames": [
                {"kind": "system_protocol", "count": 1, "chars": 2048},
                {"kind": "conversation_history", "count": 6, "chars": 900},
            ],
            "toolChars": 0,
        });
        let parsed: PromptSize = serde_json::from_value(size.clone()).unwrap();

        assert_eq!(serde_json::to_value(&parsed).unwrap(), size);

        let frame = |kind: &str| FrameSize {
            kind: kind.to_owned(),
            count: NonZeroU64::MIN,
            chars: NonZeroU64::MIN,
        };

        assert_eq!(
            PromptSize::new(Vec::new(), 0),
            Err(PromptSizeError::NoFrames)
        );
        assert_eq!(
            PromptSize::new(vec![frame("")], 0),
            Err(PromptSizeError::UnnamedFrame)
        );
        assert_eq!(
            PromptSize::new(vec![frame("user"), frame("user")], 0),
            Err(PromptSizeError::RepeatedKind {
                kind: "user".to_owned()
            })
        );
        assert!(
            serde_json::from_value::<PromptSize>(json!({
                "frames": [{"kind": "system_protocol", "count": 0, "chars": 1}],
                "toolChars": 0,
            }))
            .is_err()
        );
    }
}
