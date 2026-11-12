//! The time a call into the phone is given, and what `phone.time` reads
//! from it.

use jiff::ToSpan;
use jiff::civil::Time;
use jiff::tz::TimeZone;
use p02_core::Timestamp;
use serde::Serialize;

/// The moment a call into the phone is made and the time zone the person
/// is in: everything `phone.time` answers from.
#[derive(Clone, Debug)]
pub struct Now {
    at: Timestamp,
    zone: TimeZone,
}

/// A clock's reading of a moment in a zone, as `phone.time.local` answers
/// it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reading {
    year: i16,
    /// 1 to 12.
    month: i8,
    day: i8,
    hour: i8,
    minute: i8,
    second: i8,
    /// 1, Monday, to 7, Sunday.
    weekday: i8,
    /// The zone's IANA name, or `null` for a zone that has none.
    zone: Option<String>,
    offset_minutes: i32,
}

impl Now {
    #[must_use]
    pub fn new(at: Timestamp, zone: TimeZone) -> Self {
        Self { at, zone }
    }

    /// The moment it is by the system clock, where the machine's time zone
    /// says the person is; a zone that cannot be read is taken as UTC.
    #[must_use]
    pub fn system() -> Self {
        Self::new(Timestamp::now(), TimeZone::system())
    }

    /// The Unix epoch in UTC: the time of an app's first run, when it is
    /// made, before any call gives it one.
    pub(crate) fn epoch() -> Self {
        Self::new(
            Timestamp::from_unix_millis(0).expect("the epoch is a moment"),
            TimeZone::UTC,
        )
    }

    pub(crate) fn at(&self) -> &Timestamp {
        &self.at
    }

    pub(crate) fn millis(&self) -> i64 {
        self.at.unix_millis()
    }

    pub(crate) fn moment(&self) -> jiff::Timestamp {
        self.at.in_zone(TimeZone::UTC).timestamp()
    }

    pub(crate) fn zone(&self) -> &TimeZone {
        &self.zone
    }
}

/// `at` as a clock in `zone` reads it.
pub(crate) fn reading(at: jiff::Timestamp, zone: TimeZone) -> Reading {
    let clock = at.to_zoned(zone);

    Reading {
        year: clock.year(),
        month: clock.month(),
        day: clock.day(),
        hour: clock.hour(),
        minute: clock.minute(),
        second: clock.second(),
        weekday: clock.weekday().to_monday_one_offset(),
        zone: clock.time_zone().iana_name().map(str::to_owned),
        offset_minutes: clock.offset().seconds() / 60,
    }
}

/// The first moment after `now` at which a clock in `zone` reads `time`,
/// on a day of `weekdays` (1, Monday, to 7, Sunday). A time the clocks skip
/// that day comes as much later as they jumped, and one they pass twice
/// comes the first time, as jiff resolves them.
pub(crate) fn next(
    now: jiff::Timestamp,
    zone: &TimeZone,
    time: Time,
    weekdays: &[i8],
) -> Option<jiff::Timestamp> {
    let today = now.to_zoned(zone.clone()).date();

    (0..=7).find_map(|days| {
        let day = today.checked_add(days.days()).ok()?;

        if !weekdays.contains(&day.weekday().to_monday_one_offset()) {
            return None;
        }

        let moment = day
            .to_datetime(time)
            .to_zoned(zone.clone())
            .ok()?
            .timestamp();

        (moment > now).then_some(moment)
    })
}
