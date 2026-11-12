//! `phone.time`, read from the moment and the zone each call is given: in
//! New York, whose clocks go forward on 8 March 2026 and back on 1
//! November.

use p02_phone::{Now, Phone};
use serde_json::{Value, json};

use crate::support::{Files, actions, app, at, millis, now, took};

/// Clock, which answers what `phone.time` does.
fn clock() -> Phone {
    Phone::new(vec![app(
        &json!({
            "id": "clock",
            "name": "Clock",
            "actions": actions(&["now", "local", "at", "next"]),
        }),
        "export function screen() { return { items: [] }; }
        export function now() { return phone.time.now(); }
        export function local({ at, zone }) { return phone.time.local(at, zone); }
        export function at(wanted) { return phone.time.at(wanted); }
        export function next(wanted) { return phone.time.next(wanted); }",
    )])
}

/// What Clock's `function` answers `asked` at `now`.
fn asked(function: &str, asked: &Value, now: &Now) -> Result<Value, String> {
    took(
        &clock(),
        &mut Files::default(),
        "clock",
        function,
        asked,
        now,
    )
    .map(|acted| acted.answer)
    .map_err(|refused| refused.to_string())
}

/// A day and a time of it, as `phone.time.at` takes them.
fn day_and_time([year, month, day, hour, minute]: [i32; 5]) -> Value {
    json!({"year": year, "month": month, "day": day, "hour": hour, "minute": minute})
}

#[test]
fn local_reads_a_moment_where_the_person_is_or_in_a_named_zone() {
    assert_eq!(
        asked("now", &json!({}), &now()),
        Ok(json!(millis("2026-03-07T17:00:00.000Z")))
    );
    assert_eq!(
        asked("local", &json!({}), &now()),
        Ok(json!({
            "year": 2026, "month": 3, "day": 7, "hour": 12, "minute": 0, "second": 0,
            "weekday": 6, "zone": "America/New_York", "offsetMinutes": -300,
        }))
    );
    assert_eq!(
        asked(
            "local",
            &json!({"at": millis("2026-06-21T23:30:15.000Z"), "zone": "Asia/Kathmandu"}),
            &now()
        ),
        Ok(json!({
            "year": 2026, "month": 6, "day": 22, "hour": 5, "minute": 15, "second": 15,
            "weekday": 1, "zone": "Asia/Kathmandu", "offsetMinutes": 345,
        }))
    );
    assert_eq!(
        asked("local", &json!({"zone": "Mars/Olympus_Mons"}), &now()),
        Err(
            "Clock failed: TypeError: phone.time.local knows no time zone \
             \"Mars/Olympus_Mons\": it takes an IANA name such as \"Europe/London\""
                .to_owned()
        )
    );
}

#[test]
fn at_finds_the_moment_a_clock_reads_a_day_and_a_time_and_refuses_a_day_not_on_the_calendar() {
    for (wanted, moment, read) in [
        (
            [2026, 3, 7, 12, 0],
            "2026-03-07T17:00:00.000Z",
            [2026, 3, 7, 12, 0],
        ),
        (
            [2028, 2, 29, 9, 30],
            "2028-02-29T14:30:00.000Z",
            [2028, 2, 29, 9, 30],
        ),
        // A time the clocks skip comes as much later as they jumped.
        (
            [2026, 3, 8, 2, 30],
            "2026-03-08T07:30:00.000Z",
            [2026, 3, 8, 3, 30],
        ),
        // One they pass twice comes the first time.
        (
            [2026, 11, 1, 1, 30],
            "2026-11-01T05:30:00.000Z",
            [2026, 11, 1, 1, 30],
        ),
    ] {
        assert_eq!(
            asked("at", &day_and_time(wanted), &now()),
            Ok(json!(millis(moment))),
            "{wanted:?}"
        );

        let reading = asked("local", &json!({"at": millis(moment)}), &now()).unwrap();

        assert_eq!(
            ["year", "month", "day", "hour", "minute"].map(|field| reading[field].clone()),
            read.map(|number| json!(number)),
            "{wanted:?}"
        );
    }

    for refused in [
        day_and_time([2026, 2, 29, 9, 0]),
        day_and_time([2026, 4, 31, 9, 0]),
        day_and_time([2026, 13, 1, 9, 0]),
        day_and_time([2026, 3, 7, 24, 0]),
        day_and_time([2026, 3, 7, 12, 60]),
        json!({"year": 2026, "month": 3, "day": 7, "hour": 12}),
        json!({"year": 2026, "month": 3, "day": 7, "hour": 12, "minute": 0, "second": 0}),
    ] {
        assert_eq!(
            asked("at", &refused, &now()),
            Err(
                "Clock failed: TypeError: phone.time.at takes {year, month, day, hour, minute}: \
                 a day on the calendar, an hour from 0 to 23 and a minute from 0 to 59"
                    .to_owned()
            ),
            "{refused}"
        );
    }
}

#[test]
fn next_finds_the_next_time_a_clock_reads_across_a_day_the_clocks_change() {
    for (wanted, now, next) in [
        (
            json!({"hour": 13, "minute": 0}),
            now(),
            "2026-03-07T18:00:00.000Z",
        ),
        (
            json!({"hour": 12, "minute": 0}),
            now(),
            "2026-03-08T16:00:00.000Z",
        ),
        (
            json!({"hour": 7, "minute": 0}),
            now(),
            "2026-03-08T11:00:00.000Z",
        ),
        (
            json!({"hour": 2, "minute": 30}),
            now(),
            "2026-03-08T07:30:00.000Z",
        ),
        (
            json!({"hour": 7, "minute": 0, "weekdays": [1, 2, 3, 4, 5]}),
            now(),
            "2026-03-09T11:00:00.000Z",
        ),
        (
            json!({"hour": 1, "minute": 30}),
            at("2026-10-31T16:00:00.000Z"),
            "2026-11-01T05:30:00.000Z",
        ),
    ] {
        assert_eq!(
            asked("next", &wanted, &now),
            Ok(json!(millis(next))),
            "{wanted}"
        );
    }

    for refused in [
        json!({"hour": 24, "minute": 0}),
        json!({"hour": 7}),
        json!({"hour": 7, "minute": 0, "weekdays": []}),
        json!({"hour": 7, "minute": 0, "weekdays": [8]}),
    ] {
        assert_eq!(
            asked("next", &refused, &now()),
            Err(
                "Clock failed: TypeError: phone.time.next takes {hour, minute, weekdays}: an \
                 hour from 0 to 23, a minute from 0 to 59 and, if it has them, weekdays, a \
                 list of days from 1 (Monday) to 7 (Sunday)"
                    .to_owned()
            ),
            "{refused}"
        );
    }
}
