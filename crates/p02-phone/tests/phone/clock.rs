//! The Clock every phone comes with, used through the phone's own calls in
//! Los Angeles, whose clocks go forward an hour on 8 March 2026 and back on
//! 1 November.

use p02_phone::{Now, Phone, SetRing};
use serde_json::{Value, json};

use crate::support::{Files, in_zone, input, millis};

/// Wednesday 11 November 2026, 9:41 AM in Los Angeles.
const MORNING: &str = "2026-11-11T17:41:00.000Z";

fn phone() -> &'static Phone {
    Phone::bundled().unwrap()
}

/// `moment` in Los Angeles.
fn at(moment: &str) -> Now {
    in_zone(moment, "America/Los_Angeles")
}

/// What the Clock answers `action` on `given` at `moment`, or the sentence
/// it is refused in.
fn act(files: &mut Files, action: &str, given: &Value, moment: &str) -> Result<Value, String> {
    phone()
        .act(files, "clock", action, &input(given), &at(moment))
        .map(|acted| acted.answer)
        .map_err(|refused| refused.to_string())
}

/// What the Clock's `view` shows at `moment`.
fn look(files: &Files, view: &str, moment: &str) -> Value {
    serde_json::to_value(phone().look(files, "clock", view, &at(moment)).unwrap()).unwrap()
}

/// The rings set on the phone, soonest first, as the Clock's file keeps
/// them.
fn rings(files: &Files) -> Value {
    phone()
        .rings(files)
        .unwrap()
        .iter()
        .map(|set| serde_json::to_value(&set.ring).unwrap())
        .collect()
}

/// Tells her the rings due at `moment`, and the Clock hears them.
fn tell(files: &mut Files, moment: &str) {
    let due: Vec<SetRing> = phone()
        .rings(files)
        .unwrap()
        .into_iter()
        .filter(|set| set.ring.at().unix_millis() <= millis(moment))
        .collect();
    let failures = phone().told(files, &due, &at(moment)).unwrap();

    assert!(failures.is_empty(), "{failures:?}");
}

/// A screen of one list of `rows`.
fn list(rows: &Value) -> Value {
    json!({"items": [{"kind": "list", "rows": rows}]})
}

/// A screen of a line of words alone.
fn nothing(text: &str) -> Value {
    json!({"items": [{"kind": "text", "text": text}]})
}

#[test]
fn the_bundled_phone_holds_the_clock_which_opens_on_its_alarms() {
    let [clock] = phone().apps() else {
        panic!("the bundled phone holds the Clock alone");
    };

    assert_eq!(
        (clock.id().as_str(), clock.name(), clock.summary()),
        ("clock", "Clock", "Alarms, timers, and the time anywhere")
    );
    assert_eq!(
        clock
            .views()
            .iter()
            .map(|view| (view.id().as_str(), view.title()))
            .collect::<Vec<_>>(),
        [
            ("world", "World Clock"),
            ("alarms", "Alarms"),
            ("stopwatch", "Stopwatch"),
            ("timers", "Timers"),
        ]
    );
    assert_eq!(
        clock
            .actions()
            .iter()
            .map(|action| (action.name().as_str(), action.view().as_str()))
            .collect::<Vec<_>>(),
        [
            ("set_alarm", "alarms"),
            ("change_alarm", "alarms"),
            ("delete_alarm", "alarms"),
            ("start_timer", "timers"),
            ("cancel_timer", "timers"),
            ("start_stopwatch", "stopwatch"),
            ("stop_stopwatch", "stopwatch"),
            ("lap_stopwatch", "stopwatch"),
            ("reset_stopwatch", "stopwatch"),
            ("add_city", "world"),
            ("remove_city", "world"),
        ]
    );

    let opened = phone()
        .open(&mut Files::default(), "clock", None, &at(MORNING))
        .unwrap();

    assert_eq!(opened.view.as_str(), "alarms");
    assert_eq!(
        serde_json::to_value(opened.screen).unwrap(),
        nothing("No Alarms")
    );
}

#[test]
fn an_alarm_that_rings_once_rings_the_next_morning_and_is_then_off() {
    let mut files = Files::default();
    // Wednesday, 9 PM.
    let evening = "2026-11-12T05:00:00.000Z";
    // Thursday, 7 AM.
    let morning = "2026-11-12T15:00:00.000Z";

    assert_eq!(
        act(
            &mut files,
            "set_alarm",
            &json!({"hour": 7, "minute": 0, "label": "Wake Sam"}),
            evening
        ),
        Ok(json!({
            "id": "a1", "time": "7:00 AM", "label": "Wake Sam", "repeats": "never", "on": true,
            "rings": "tomorrow",
        }))
    );
    assert_eq!(
        rings(&files),
        json!([{"id": "a1", "at": morning, "title": "Alarm", "body": "Wake Sam"}])
    );
    assert_eq!(
        look(&files, "alarms", evening),
        list(&json!([
            {"id": "a1", "time": "7:00 AM", "subtitle": "Wake Sam, tomorrow", "switch": true},
        ]))
    );

    tell(&mut files, morning);

    assert_eq!(rings(&files), json!([]));
    assert_eq!(
        look(&files, "alarms", morning),
        list(&json!([
            {"id": "a1", "time": "7:00 AM", "subtitle": "Wake Sam", "switch": false},
        ]))
    );
}

#[test]
fn a_weekday_alarm_set_on_friday_rings_monday_then_tuesday_at_the_same_clock_time() {
    let mut files = Files::default();
    // Friday 6 March, 8 PM, before the clocks go forward on Sunday: 7 AM on
    // Friday was 15:00 UTC, and on Monday it is 14:00.
    let friday = "2026-03-07T04:00:00.000Z";
    let monday = "2026-03-09T14:00:00.000Z";

    assert_eq!(
        act(
            &mut files,
            "set_alarm",
            &json!({"hour": 7, "minute": 0, "days": [5, 4, 3, 2, 1]}),
            friday
        ),
        Ok(json!({
            "id": "a1", "time": "7:00 AM", "repeats": "weekdays", "on": true, "rings": "Monday",
        }))
    );
    assert_eq!(
        rings(&files),
        json!([{"id": "a1", "at": monday, "title": "Alarm"}])
    );

    tell(&mut files, monday);

    assert_eq!(
        rings(&files),
        json!([{"id": "a1", "at": "2026-03-10T14:00:00.000Z", "title": "Alarm"}])
    );
    assert_eq!(
        look(&files, "alarms", monday),
        list(&json!([
            {"id": "a1", "time": "7:00 AM", "subtitle": "Alarm, weekdays", "switch": true},
        ]))
    );
}

#[test]
fn an_alarm_switched_off_has_no_ring_switched_on_has_one_and_deleted_is_gone_with_it() {
    let mut files = Files::default();
    let wake =
        json!({"id": "a1", "at": "2026-11-12T15:00:00.000Z", "title": "Alarm", "body": "Wake Sam"});

    for set in [
        json!({"hour": 7, "minute": 0, "label": "Wake Sam"}),
        json!({"hour": 6, "minute": 30, "label": "Yoga", "days": [1, 2, 3, 4, 5]}),
    ] {
        act(&mut files, "set_alarm", &set, MORNING).unwrap();
    }

    assert_eq!(
        act(
            &mut files,
            "change_alarm",
            &json!({"id": "a2", "on": false}),
            MORNING
        ),
        Ok(json!({
            "id": "a2", "time": "6:30 AM", "label": "Yoga", "repeats": "weekdays", "on": false,
        }))
    );
    assert_eq!(rings(&files), json!([wake]));
    assert_eq!(
        look(&files, "alarms", MORNING),
        list(&json!([
            {"id": "a2", "time": "6:30 AM", "subtitle": "Yoga, weekdays", "switch": false},
            {"id": "a1", "time": "7:00 AM", "subtitle": "Wake Sam, tomorrow", "switch": true},
        ]))
    );

    act(
        &mut files,
        "change_alarm",
        &json!({"id": "a2", "minute": 45, "on": true}),
        MORNING,
    )
    .unwrap();

    assert_eq!(
        rings(&files),
        json!([
            {"id": "a2", "at": "2026-11-12T14:45:00.000Z", "title": "Alarm", "body": "Yoga"},
            wake,
        ])
    );
    assert_eq!(
        act(&mut files, "delete_alarm", &json!({"id": "a2"}), MORNING),
        Ok(json!({
            "id": "a2", "time": "6:45 AM", "label": "Yoga", "repeats": "weekdays", "deleted": true,
        }))
    );
    assert_eq!(rings(&files), json!([wake]));
    assert_eq!(
        act(&mut files, "delete_alarm", &json!({"id": "a2"}), MORNING),
        Err("Clock: There is no alarm with the id \"a2\".".to_owned())
    );

    act(&mut files, "delete_alarm", &json!({"id": "a1"}), MORNING).unwrap();

    assert_eq!(rings(&files), json!([]));
    assert_eq!(look(&files, "alarms", MORNING), nothing("No Alarms"));
    assert_eq!(
        act(
            &mut files,
            "set_alarm",
            &json!({"hour": 7, "minute": 0}),
            MORNING
        )
        .unwrap()["id"],
        "a3"
    );
}

#[test]
fn a_timer_rings_when_it_ends_counts_down_and_is_gone_once_told_or_cancelled() {
    let mut files = Files::default();
    // 9:42:26.5 AM.
    let later = "2026-11-11T17:42:26.500Z";
    // 9:46 AM, when the shorter timer ends.
    let ended = "2026-11-11T17:46:00.000Z";
    let tea_ends = "2026-11-11T17:56:00.000Z";
    let tea = |left: &str| {
        json!({
            "kind": "readout", "id": "t1", "label": "Tea", "text": left, "caption": "Ends 9:56 AM",
            "live": {"counts": "down", "to": millis(tea_ends), "of": 900_000},
        })
    };
    let recents = |rows: Value| json!({"kind": "list", "header": "Recents", "rows": rows});
    let five = json!({"time": "5:00", "subtitle": "5 min"});
    let fifteen = json!({"time": "15:00", "subtitle": "15 min"});

    assert_eq!(look(&files, "timers", MORNING), nothing("No Timers"));
    assert_eq!(
        act(&mut files, "start_timer", &json!({}), MORNING),
        Err("Clock: A timer needs a length: give it hours, minutes or seconds.".to_owned())
    );
    assert_eq!(
        act(
            &mut files,
            "start_timer",
            &json!({"minutes": 15, "label": "Tea"}),
            MORNING
        ),
        Ok(json!({"id": "t1", "label": "Tea", "length": "15 min", "ends": "9:56 AM"}))
    );
    assert_eq!(
        act(&mut files, "start_timer", &json!({"minutes": 5}), MORNING),
        Ok(json!({"id": "t2", "length": "5 min", "ends": "9:46 AM"}))
    );
    assert_eq!(
        rings(&files),
        json!([
            {"id": "t2", "at": ended, "title": "Timer", "body": "5 min"},
            {"id": "t1", "at": tea_ends, "title": "Timer", "body": "Tea"},
        ])
    );
    assert_eq!(
        look(&files, "timers", later),
        json!({"items": [
            {"kind": "readout", "id": "t2", "label": "5 min", "text": "3:34",
             "caption": "Ends 9:46 AM",
             "live": {"counts": "down", "to": millis(ended), "of": 300_000}},
            tea("13:34"),
            recents(json!([five, fifteen])),
        ]})
    );

    tell(&mut files, ended);

    assert_eq!(
        rings(&files),
        json!([{"id": "t1", "at": tea_ends, "title": "Timer", "body": "Tea"}])
    );
    assert_eq!(
        look(&files, "timers", ended),
        json!({"items": [tea("10:00"), recents(json!([five, fifteen]))]})
    );
    assert_eq!(
        act(&mut files, "cancel_timer", &json!({"id": "t1"}), ended),
        Ok(json!({"id": "t1", "label": "Tea", "length": "15 min", "cancelled": true}))
    );
    assert_eq!(rings(&files), json!([]));

    act(&mut files, "start_timer", &json!({"minutes": 15}), ended).unwrap();
    act(&mut files, "cancel_timer", &json!({"id": "t3"}), ended).unwrap();

    assert_eq!(
        look(&files, "timers", ended),
        json!({"items": [recents(json!([fifteen, five]))]})
    );
    assert_eq!(
        act(&mut files, "start_timer", &json!({"minutes": 90}), ended),
        Ok(json!({"id": "t4", "length": "1 hr 30 min", "ends": "11:16 AM"}))
    );
}

#[test]
fn the_stopwatch_runs_laps_stops_goes_on_and_resets_and_refuses_what_it_cannot_do() {
    fn press(files: &mut Files, action: &str, moment: &str) -> Result<Value, String> {
        act(files, action, &json!({}), moment)
    }

    let mut files = Files::default();
    let not_running = Err("Clock: The stopwatch is not running.".to_owned());
    // An hour after it went on again.
    let an_hour_on = "2026-11-11T18:42:40.000Z";

    assert_eq!(press(&mut files, "stop_stopwatch", MORNING), not_running);
    assert_eq!(press(&mut files, "lap_stopwatch", MORNING), not_running);
    assert_eq!(
        press(&mut files, "start_stopwatch", MORNING),
        Ok(json!({"running": true, "time": "00:00.00"}))
    );
    assert_eq!(
        press(&mut files, "start_stopwatch", "2026-11-11T17:41:01.000Z"),
        Err("Clock: The stopwatch is already running.".to_owned())
    );
    assert_eq!(
        press(&mut files, "lap_stopwatch", "2026-11-11T17:41:12.340Z"),
        Ok(json!({"running": true, "time": "00:12.34", "lap": 1, "length": "00:12.34"}))
    );
    assert_eq!(
        press(&mut files, "lap_stopwatch", "2026-11-11T17:41:30.000Z"),
        Ok(json!({"running": true, "time": "00:30.00", "lap": 2, "length": "00:17.66"}))
    );
    assert_eq!(
        look(&files, "stopwatch", "2026-11-11T17:41:45.678Z"),
        json!({"items": [
            {"kind": "readout", "text": "00:45.67", "caption": "Running",
             "live": {"counts": "up", "from": millis(MORNING)}},
            {"kind": "list", "header": "Laps", "rows": [
                {"title": "Lap 2", "value": "00:17.66"},
                {"title": "Lap 1", "value": "00:12.34"},
            ]},
        ]})
    );
    assert_eq!(
        press(&mut files, "stop_stopwatch", "2026-11-11T17:42:01.500Z"),
        Ok(json!({"running": false, "time": "01:01.50"}))
    );
    assert_eq!(
        press(&mut files, "lap_stopwatch", "2026-11-11T17:42:02.000Z"),
        not_running
    );
    assert_eq!(
        press(&mut files, "start_stopwatch", "2026-11-11T17:42:40.000Z"),
        Ok(json!({"running": true, "time": "01:01.50"}))
    );
    assert_eq!(
        look(&files, "stopwatch", an_hour_on)["items"][0],
        json!({"kind": "readout", "text": "1:01:01.50", "caption": "Running",
               "live": {"counts": "up", "from": millis("2026-11-11T17:41:38.500Z")}})
    );
    assert_eq!(
        press(&mut files, "reset_stopwatch", an_hour_on),
        Ok(json!({"running": false, "time": "00:00.00"}))
    );
    assert_eq!(
        look(&files, "stopwatch", an_hour_on),
        json!({"items": [{"kind": "readout", "text": "00:00.00", "caption": "Not running"}]})
    );
}

#[test]
fn the_world_clock_shows_cities_against_the_persons_day_and_refuses_an_unknown_zone() {
    let mut files = Files::default();
    let cities = [
        ("Seattle", "America/Los_Angeles", "9:41 AM", "Today, +0HRS"),
        ("London", "Europe/London", "5:41 PM", "Today, +8HRS"),
        ("Tokyo", "Asia/Tokyo", "2:41 AM", "Tomorrow, +17HRS"),
        ("Kolkata", "Asia/Kolkata", "11:11 PM", "Today, +13:30HRS"),
        ("Honolulu", "Pacific/Honolulu", "7:41 AM", "Today, -2HRS"),
    ];

    assert_eq!(look(&files, "world", MORNING), nothing("No World Clocks"));

    for (number, (city, zone, time, offset)) in (1..).zip(cities) {
        assert_eq!(
            act(
                &mut files,
                "add_city",
                &json!({"city": city, "zone": zone}),
                MORNING
            ),
            Ok(json!({
                "id": format!("c{number}"), "city": city, "zone": zone, "time": time,
                "offset": offset,
            }))
        );
    }

    assert_eq!(
        act(
            &mut files,
            "add_city",
            &json!({"city": "Olympus Mons", "zone": "Mars/Olympus_Mons"}),
            MORNING
        ),
        Err(
            "Clock: The phone knows no time zone \"Mars/Olympus_Mons\": give an \
             IANA name, such as \"Asia/Tokyo\"."
                .to_owned()
        )
    );
    assert_eq!(
        look(&files, "world", MORNING),
        list(&json!([
            {"id": "c1", "caption": "Today, +0HRS", "title": "Seattle", "time": "9:41 AM"},
            {"id": "c2", "caption": "Today, +8HRS", "title": "London", "time": "5:41 PM"},
            {"id": "c3", "caption": "Tomorrow, +17HRS", "title": "Tokyo", "time": "2:41 AM"},
            {"id": "c4", "caption": "Today, +13:30HRS", "title": "Kolkata", "time": "11:11 PM"},
            {"id": "c5", "caption": "Today, -2HRS", "title": "Honolulu", "time": "7:41 AM"},
        ]))
    );
    assert_eq!(
        act(&mut files, "remove_city", &json!({"id": "c2"}), MORNING),
        Ok(json!({"id": "c2", "city": "London", "zone": "Europe/London", "removed": true}))
    );
    assert_eq!(
        look(&files, "world", MORNING)["items"][0]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["title"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Seattle", "Tokyo", "Kolkata", "Honolulu"]
    );
}
