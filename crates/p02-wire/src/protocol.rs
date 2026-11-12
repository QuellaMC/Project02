//! The protocol a client and the daemon speak.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use ts_rs::TS;

/// The protocol a client reads, which health carries so that an old client
/// meets a clear message rather than a mystery.
pub const PROTOCOL_VERSION: u32 = 14;

/// [`PROTOCOL_VERSION`] as health and a stream's first frame carry it: the
/// one value either can say, which the contract declares as that number,
/// so a client whose own version is another does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtocolVersion;

impl Serialize for ProtocolVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(PROTOCOL_VERSION)
    }
}

/// Reads the one number it is: another version is another wire.
impl<'de> Deserialize<'de> for ProtocolVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let version = u32::deserialize(deserializer)?;

        if version == PROTOCOL_VERSION {
            Ok(Self)
        } else {
            Err(D::Error::custom(format!(
                "protocol {version} is not protocol {PROTOCOL_VERSION}"
            )))
        }
    }
}

impl JsonSchema for ProtocolVersion {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "ProtocolVersion".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({"const": PROTOCOL_VERSION})
    }
}

impl TS for ProtocolVersion {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn name(_: &ts_rs::Config) -> String {
        PROTOCOL_VERSION.to_string()
    }

    fn inline(config: &ts_rs::Config) -> String {
        Self::name(config)
    }
}
