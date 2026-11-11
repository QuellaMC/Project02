//! `phone.time`, read from the moment and the zone each call is given: in
//! New York, whose clocks go forward on 8 March 2026 and back on 1
//! November.

use p02_phone::{Now, Phone};
use serde_json::{Value, json};

use crate::support::{Files, actions, app, at, input, millis, now};

/// Clock, which answers what `phone.time` does.
fn clock() -> Phone {
    Phone::new(vec![app(
        &json!({"id": "clock", "name": "Clock", "actions": actions(&["now", "local", "next"])}),
        "export function screen() { return { items: [] }; }
        export function now() { return phone.time.now(); }
        export function local({ at, zone }) { return phone.time.local(at, zone); }
        export function next(wanted) { return phone.time.next(wanted); }",
    )])
}

/// What Clock's `function` answers `asked` at `now`.
fn asked(function: &str, asked: &Value, now: &Now) -> Result<Value, String> {
    clock()
        .act(&mut Files::default(), "clock", function, &input(asked), now)
        .map(|acted| acted.answer)
        .map_err(|refused| refused.to_string())
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
