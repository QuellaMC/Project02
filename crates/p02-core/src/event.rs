use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// The event a runtime record answers to.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct EventId(String);

/// The trace an event belongs to.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct TraceId(String);

/// Why a text is not an [`EventId`] or a [`TraceId`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("an event or trace id must not be blank")]
pub struct ParseIdError;

fn non_blank(value: &str) -> Result<String, ParseIdError> {
    if value.trim().is_empty() {
        Err(ParseIdError)
    } else {
        Ok(value.to_owned())
    }
}

impl EventId {
    /// # Errors
    ///
    /// [`ParseIdError`] when `value` is blank.
    pub fn new(value: &str) -> Result<Self, ParseIdError> {
        non_blank(value).map(Self)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TraceId {
    /// # Errors
    ///
    /// [`ParseIdError`] when `value` is blank.
    pub fn new(value: &str) -> Result<Self, ParseIdError> {
        non_blank(value).map(Self)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for EventId {
    type Error = ParseIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl TryFrom<String> for TraceId {
    type Error = ParseIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Display for EventId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl fmt::Display for TraceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A moment, in the one spelling every record uses: UTC to the
/// millisecond, `2026-06-15T00:00:00.000Z`. Text order is time order.
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(try_from = "String")]
pub struct Timestamp(String);

/// Why a text is not a [`Timestamp`].
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("not a canonical UTC timestamp such as 2026-06-15T00:00:00.000Z")]
pub struct ParseTimestampError;

impl Timestamp {
    /// The moment it is now, to the millisecond: the one way a moment is
    /// minted.
    ///
    /// # Panics
    ///
    /// When the system clock reads a year before 0 or after 9999, which no
    /// moment of a conversation is.
    #[must_use]
    pub fn now() -> Self {
        // A precision of 3 truncates to the millisecond.
        Self::new(&format!("{:.3}", jiff::Timestamp::now()))
            .expect("the system clock reads a year from 0 to 9999")
    }

    /// # Errors
    ///
    /// [`ParseTimestampError`] when `value` is not a real moment written as
    /// `YYYY-MM-DDTHH:MM:SS.mmmZ`.
    pub fn new(value: &str) -> Result<Self, ParseTimestampError> {
        if is_canonical_timestamp(value.as_bytes()) {
            Ok(Self(value.to_owned()))
        } else {
            Err(ParseTimestampError)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The moment as a clock in `zone` reads it.
    #[must_use]
    #[expect(
        clippy::missing_panics_doc,
        reason = "a moment of the years 0 to 9999 is one jiff keeps"
    )]
    pub fn in_zone(&self, zone: jiff::tz::TimeZone) -> jiff::Zoned {
        jiff::Timestamp::from_millisecond(self.unix_millis())
            .expect("a moment of the years 0 to 9999 is one jiff keeps")
            .to_zoned(zone)
    }

    /// The moment in milliseconds since the Unix epoch, as a client's clock
    /// reads a deadline.
    #[must_use]
    pub fn unix_millis(&self) -> i64 {
        let digits = self.0.as_bytes();
        let number = |from: usize, to: usize| {
            digits[from..to]
                .iter()
                .fold(0_i64, |value, digit| value * 10 + i64::from(digit - b'0'))
        };
        let (month, day) = (number(5, 7), number(8, 10));
        // Days since 1970-01-01 in the proleptic Gregorian calendar, counted
        // in years that begin in March, so a leap day ends its year.
        let year = number(0, 4) - i64::from(month <= 2);
        let era = year.div_euclid(400);
        let year_of_era = year - era * 400;
        let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
        let days = era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100
            + day_of_year
            - 719_468;
        let seconds = ((days * 24 + number(11, 13)) * 60 + number(14, 16)) * 60 + number(17, 19);

        seconds * 1000 + number(20, 23)
    }
}

fn is_canonical_timestamp(text: &[u8]) -> bool {
    const SHAPE: &[u8; 24] = b"dddd-dd-ddTdd:dd:dd.dddZ";

    let shaped = text.len() == SHAPE.len()
        && text.iter().zip(SHAPE).all(|(byte, expected)| {
            if *expected == b'd' {
                byte.is_ascii_digit()
            } else {
                byte == expected
            }
        });

    if !shaped {
        return false;
    }

    let number = |from: usize, to: usize| {
        text[from..to]
            .iter()
            .fold(0_u32, |value, digit| value * 10 + u32::from(digit - b'0'))
    };
    let (year, month, day) = (number(0, 4), number(5, 7), number(8, 10));

    (1..=days_in_month(year, month)).contains(&day)
        && number(11, 13) < 24
        && number(14, 16) < 60
        && number(17, 19) < 60
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

impl TryFrom<String> for Timestamp {
    type Error = ParseTimestampError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Which runtime event a record belongs to, and when that event was made.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "UncheckedEventIdentity")]
pub struct EventIdentity {
    event_id: EventId,
    trace_id: TraceId,
    created_at: Timestamp,
}

/// Why an [`EventIdentity`] cannot be made.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("an event identity needs an event id apart from its trace id")]
pub struct ParseEventIdentityError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedEventIdentity {
    event_id: EventId,
    trace_id: TraceId,
    created_at: Timestamp,
}

impl EventIdentity {
    /// A new event, made now: `evt_` and `trace_`, each with a random UUID,
    /// and the moment it is. The one way an event is minted.
    #[must_use]
    pub fn mint() -> Self {
        Self {
            event_id: EventId(format!("evt_{}", Uuid::new_v4())),
            trace_id: TraceId(format!("trace_{}", Uuid::new_v4())),
            created_at: Timestamp::now(),
        }
    }

    /// # Errors
    ///
    /// [`ParseEventIdentityError`] when the event id and the trace id are
    /// the same text.
    pub fn new(
        event_id: EventId,
        trace_id: TraceId,
        created_at: Timestamp,
    ) -> Result<Self, ParseEventIdentityError> {
        if event_id.as_str() == trace_id.as_str() {
            return Err(ParseEventIdentityError);
        }

        Ok(Self {
            event_id,
            trace_id,
            created_at,
        })
    }

    #[must_use]
    pub fn event_id(&self) -> &EventId {
        &self.event_id
    }

    #[must_use]
    pub fn trace_id(&self) -> &TraceId {
        &self.trace_id
    }

    #[must_use]
    pub fn created_at(&self) -> &Timestamp {
        &self.created_at
    }
}

impl TryFrom<UncheckedEventIdentity> for EventIdentity {
    type Error = ParseEventIdentityError;

    fn try_from(unchecked: UncheckedEventIdentity) -> Result<Self, Self::Error> {
        Self::new(unchecked.event_id, unchecked.trace_id, unchecked.created_at)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_timestamp_is_a_real_moment_in_the_canonical_spelling() {
        for (text, accepted) in [
            ("2026-06-15T00:00:00.000Z", true),
            ("2024-02-29T23:59:59.999Z", true),
            ("2000-02-29T12:00:00.000Z", true),
            ("2026-06-15T00:00:00Z", false),
            ("2026-06-15T00:00:00.000+00:00", false),
            ("2026-6-15T00:00:00.000Z", false),
            ("2026-06-15 00:00:00.000Z", false),
            ("2025-02-29T00:00:00.000Z", false),
            ("1900-02-29T00:00:00.000Z", false),
            ("2026-13-01T00:00:00.000Z", false),
            ("2026-04-31T00:00:00.000Z", false),
            ("2026-06-15T24:00:00.000Z", false),
            ("2026-06-15T23:59:60.000Z", false),
        ] {
            assert_eq!(Timestamp::new(text).is_ok(), accepted, "{text}");
        }
    }

    #[test]
    fn a_timestamp_reads_as_the_milliseconds_since_the_epoch() {
        for text in [
            "1970-01-01T00:00:00.000Z",
            "1969-12-31T23:59:59.999Z",
            "2000-02-29T12:34:56.789Z",
            "2026-06-15T00:00:00.000Z",
            "2100-03-01T00:00:00.001Z",
            "0001-01-01T00:00:00.000Z",
        ] {
            let expected = text.parse::<jiff::Timestamp>().unwrap().as_millisecond();

            assert_eq!(
                Timestamp::new(text).unwrap().unix_millis(),
                expected,
                "{text}"
            );
        }
    }

    #[test]
    fn now_is_a_canonical_moment_that_never_runs_backwards_in_text() {
        let earlier = Timestamp::now();
        let later = Timestamp::now();

        assert_eq!(Timestamp::new(earlier.as_str()), Ok(earlier.clone()));
        assert!(earlier <= later, "{earlier} then {later}");
    }

    #[test]
    fn a_minted_identity_is_a_new_event_and_trace() {
        let minted = EventIdentity::mint();
        let again = EventIdentity::mint();
        let uuid_of = |text: &str, prefix: &str| {
            Uuid::try_parse(text.strip_prefix(prefix).unwrap())
                .unwrap()
                .get_version_num()
        };

        assert_eq!(uuid_of(minted.event_id().as_str(), "evt_"), 4);
        assert_eq!(uuid_of(minted.trace_id().as_str(), "trace_"), 4);
        assert_ne!(minted.event_id(), again.event_id());
        assert_ne!(minted.trace_id(), again.trace_id());
    }

    #[test]
    fn an_event_identity_keeps_its_event_and_trace_apart() {
        let identity = json!({
            "eventId": "evt_1",
            "traceId": "trace_1",
            "createdAt": "2026-06-15T00:00:00.000Z",
        });
        let parsed: EventIdentity = serde_json::from_value(identity.clone()).unwrap();

        assert_eq!(parsed.event_id().as_str(), "evt_1");
        assert_eq!(serde_json::to_value(&parsed).unwrap(), identity);

        for refused in [
            json!({"eventId": "same", "traceId": "same", "createdAt": "2026-06-15T00:00:00.000Z"}),
            json!({"eventId": " ", "traceId": "trace_1", "createdAt": "2026-06-15T00:00:00.000Z"}),
            json!({"eventId": "evt_1", "traceId": "trace_1", "createdAt": "yesterday"}),
        ] {
            assert!(
                serde_json::from_value::<EventIdentity>(refused.clone()).is_err(),
                "{refused}"
            );
        }
    }
}
