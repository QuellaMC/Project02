use std::fmt::{self, Write as _};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use ts_rs::TS;

/// `value` as compact JSON with every object's keys in code-point order, so
/// two values that differ only in key order have one text. Strings and
/// numbers are written as `serde_json` writes them: `1` and `1.0` keep two
/// spellings, as they are two values to `==`.
#[must_use]
pub fn canonical_json(value: &Value) -> String {
    let mut sorted = value.clone();

    sorted.sort_all_objects();
    sorted.to_string()
}

/// A value's identity, comparable without the value: `sha256:` and the
/// lowercase hex SHA-256 of its [`canonical_json`].
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(try_from = "String")]
pub struct Fingerprint(String);

/// Why a text is not a [`Fingerprint`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("not a fingerprint: \"sha256:\" and 64 lowercase hex digits")]
pub struct ParseFingerprintError;

impl Fingerprint {
    const PREFIX: &str = "sha256:";

    /// A fingerprint as a record keeps it.
    ///
    /// # Errors
    ///
    /// [`ParseFingerprintError`] when `text` is not `sha256:` and 64
    /// lowercase hex digits.
    pub fn parse(text: &str) -> Result<Self, ParseFingerprintError> {
        let digest = text
            .strip_prefix(Self::PREFIX)
            .ok_or(ParseFingerprintError)?;

        if digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            Ok(Self(text.to_owned()))
        } else {
            Err(ParseFingerprintError)
        }
    }

    #[must_use]
    pub fn new(value: &Value) -> Self {
        let mut text = String::from(Self::PREFIX);

        for byte in Sha256::digest(canonical_json(value)) {
            // Writing to a String cannot fail.
            let _ = write!(text, "{byte:02x}");
        }

        Self(text)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Fingerprint {
    type Error = ParseFingerprintError;

    fn try_from(text: String) -> Result<Self, Self::Error> {
        Self::parse(&text)
    }
}

impl fmt::Display for Fingerprint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Sorted by UTF-16 unit, as JavaScript sorts, the emoji would come
    /// before U+E000 and U+FF71.
    #[test]
    fn keys_sort_by_code_point_at_every_depth_and_arrays_keep_their_order() {
        let value = json!({
            "b": [{"z": 1, "y": 2}, 3],
            "a": {"d": null, "c": true},
            "10": 0,
            "9": 0,
            "\u{ff71}": 0,
            "\u{1f600}": 0,
            "\u{e000}": 0,
        });

        assert_eq!(
            canonical_json(&value),
            concat!(
                r#"{"10":0,"9":0,"a":{"c":true,"d":null},"b":[{"y":2,"z":1},3],"#,
                "\"\u{e000}\":0,\"\u{ff71}\":0,\"\u{1f600}\":0}"
            )
        );
    }

    #[test]
    fn strings_and_numbers_are_written_as_serde_json_writes_them() {
        let controls: String = (0_u8..0x20).map(char::from).collect();
        let value = json!([
            format!("{controls}\u{7f}\"\\/\u{2028}\u{2029}"),
            1,
            1.0,
            1e21,
            0.1,
            9_007_199_254_740_993_u64,
            u64::MAX,
            i64::MIN,
        ]);

        assert_eq!(
            canonical_json(&value),
            concat!(
                r#"["\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\b\t\n\u000b\f\r"#,
                r#"\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018"#,
                r#"\u0019\u001a\u001b\u001c\u001d\u001e\u001f"#,
                "\u{7f}\\\"\\\\/\u{2028}\u{2029}\",",
                "1,1.0,1e+21,0.1,9007199254740993,18446744073709551615,-9223372036854775808]"
            )
        );
    }

    #[test]
    fn a_fingerprint_is_the_sha256_of_the_canonical_text() {
        let fingerprint = Fingerprint::new(&json!({"b": 1, "a": [true, null]}));

        assert_eq!(
            fingerprint,
            Fingerprint::new(&json!({"a": [true, null], "b": 1}))
        );
        assert_eq!(
            fingerprint.as_str(),
            "sha256:51705a2c9eb3e7e410a58f696a770c3ac3885a0cf43eb7fc88f5e47c11d4d30d"
        );
    }

    #[test]
    fn a_fingerprint_reads_back_only_in_its_own_spelling() {
        let fingerprint = Fingerprint::new(&json!({"persona": {"system": ["Kind."]}}));
        let record = serde_json::to_value(&fingerprint).unwrap();

        assert_eq!(
            serde_json::from_value::<Fingerprint>(record).unwrap(),
            fingerprint
        );

        for refused in [
            "51705a2c9eb3e7e410a58f696a770c3ac3885a0cf43eb7fc88f5e47c11d4d30d",
            "sha256:51705A2C9EB3E7E410A58F696A770C3AC3885A0CF43EB7FC88F5E47C11D4D30D",
            "sha256:51705a2c",
            "md5:51705a2c9eb3e7e410a58f696a770c3ac3885a0cf43eb7fc88f5e47c11d4d30d",
        ] {
            assert_eq!(
                Fingerprint::parse(refused),
                Err(ParseFingerprintError),
                "{refused}"
            );
        }
    }

    /// Doubles with the spelling Node 24's `JSON.stringify` gave each: the
    /// edge cases here, and in the file 20,000 random bit patterns and 20,000
    /// everyday decimals. Without `float_roundtrip`, about a sixth of them
    /// parse one unit in the last place away.
    const EDGES: [(&str, u64); 21] = [
        ("0", 0x0000_0000_0000_0000),
        ("1", 0x3ff0_0000_0000_0000),
        ("1.5", 0x3ff8_0000_0000_0000),
        ("0.30000000000000004", 0x3fd3_3333_3333_3334),
        ("1e+21", 0x444b_1ae4_d6e2_ef50),
        ("1e-7", 0x3e7a_d7f2_9abc_af48),
        ("123456789012345680000", 0x441a_c53a_7e04_bcda),
        ("9007199254740992", 0x4340_0000_0000_0000),
        ("0.3333333333333333", 0x3fd5_5555_5555_5555),
        ("5e-324", 0x0000_0000_0000_0001),
        ("1.7976931348623157e+308", 0x7fef_ffff_ffff_ffff),
        ("-1e-10", 0xbddb_7cdf_d9d7_bdbb),
        ("100", 0x4059_0000_0000_0000),
        ("0.000001", 0x3eb0_c6f7_a0b5_ed8d),
        ("100000000000000000000", 0x4415_af1d_78b5_8c40),
        ("0.1", 0x3fb9_9999_9999_999a),
        ("-1.5e+300", 0xfe41_eb2d_6600_5835),
        ("2147483648", 0x41e0_0000_0000_0000),
        ("4294967295.5", 0x41ef_ffff_fff0_0000),
        ("1.23e-18", 0x3c36_b082_c214_8b8e),
        ("1.2345678901234566e-7", 0x3e80_91f1_667f_0595),
    ];

    #[test]
    fn every_javascript_spelling_parses_to_its_double_and_its_canonical_text_reads_back() {
        let corpus = include_str!("../fixtures/js-random-numbers.txt")
            .lines()
            .map(|line| {
                let (bits, spelling) = line.split_once(' ').unwrap();

                (spelling, u64::from_str_radix(bits, 16).unwrap())
            });

        for (spelling, bits) in EDGES.into_iter().chain(corpus) {
            let value: Value = serde_json::from_str(spelling).unwrap();
            let reread: Value = serde_json::from_str(&canonical_json(&value)).unwrap();

            assert_eq!(value.as_f64().map(f64::to_bits), Some(bits), "{spelling}");
            assert_eq!(reread, value, "{spelling}");
        }
    }
}
