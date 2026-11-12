//! Reminders, the first app of the App Store's catalog: its one file
//! installed on her phone as the store installs it, and used through the
//! phone's own calls in Los Angeles, whose clocks go forward an hour on 14
//! March 2027.

use p02_phone::{Now, Phone, SetRing, Source};
use serde_json::{Value, json};

use crate::support::{Files, in_zone, millis, took};

/// Reminders as the catalog serves it.
const REMINDERS: &str = include_str!("../../catalog/reminders.js");
/// Wednesday 11 November 2026, 9:41 AM in Los Angeles.
const MORNING: &str = "2026-11-11T17:41:00.000Z";

fn phone() -> &'static Phone {
    Phone::bundled().unwrap()
}

/// Her phone's files, with Reminders installed on it from the catalog.
fn installed() -> Files {
    let mut files = Files::default();

    phone()
        .install(&mut files, REMINDERS, Source::Catalog)
        .unwrap();
    files
}

/// `moment` in Los Angeles.
fn at(moment: &str) -> Now {
    in_zone(moment, "America/Los_Angeles")
}

/// What Reminders answers `action` on `given` at `moment`, or the sentence
/// it is refused in.
fn act(files: &mut Files, action: &str, given: &Value, moment: &str) -> Result<Value, String> {
    took(phone(), files, "reminders", action, given, &at(moment))
        .map(|acted| acted.answer)
        .map_err(|refused| refused.to_string())
}

/// What adding the reminder `given` answers in the morning.
fn add(files: &mut Files, given: &Value) -> Result<Value, String> {
    act(files, "add_reminder", given, MORNING)
}

/// What Reminders shows at `moment`.
fn look(files: &Files, moment: &str) -> Value {
    serde_json::to_value(
        phone()
            .look(files, "reminders", "reminders", &at(moment))
            .unwrap(),
    )
    .unwrap()
}

/// The rings set on the phone, soonest first, as their apps keep them.
fn rings(files: &Files) -> Value {
    phone()
        .rings(files)
        .unwrap()
        .iter()
        .map(|set| serde_json::to_value(&set.ring).unwrap())
        .collect()
}

/// Tells her the rings due at `moment`, and their apps hear them.
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

/// A reminder of `title` that does not repeat, due on `date` at `time`, as
/// adding one takes it.
fn once(title: &str, [year, month, day]: [i32; 3], [hour, minute]: [i32; 2]) -> Value {
    json!({
        "title": title, "year": year, "month": month, "day": day, "hour": hour, "minute": minute,
    })
}

/// A reminder of `title` that `repeats`, first due on `date` at `time`.
fn repeating(title: &str, date: [i32; 3], time: [i32; 2], repeats: &str) -> Value {
    let mut reminder = once(title, date, time);

    reminder["repeats"] = json!(repeats);
    reminder
}

/// A list of the screen, under `header`.
fn list(header: &str, rows: &[Value]) -> Value {
    json!({"kind": "list", "header": header, "rows": rows})
}

/// A row of a list: a reminder's id and title, and when it is `due`.
fn row(id: &str, title: &str, due: &str) -> Value {
    json!({"id": id, "title": title, "subtitle": due})
}

/// A ring of a reminder's at `moment`.
fn ring(id: &str, moment: &str, title: &str) -> Value {
    json!({"id": id, "at": moment, "title": "Reminder", "body": title})
}

fn no_reminders() -> Value {
    json!({"items": [{"kind": "text", "text": "No Reminders"}]})
}

#[test]
fn reminders_are_listed_under_today_and_scheduled_saying_when_each_is_due() {
    let mut files = installed();

    assert_eq!(look(&files, MORNING), no_reminders());
    assert_eq!(
        add(
            &mut files,
            &once("Dentist appointment", [2026, 11, 13], [15, 0])
        ),
        Ok(json!({"id": "r1", "title": "Dentist appointment", "due": "Friday, 3:00 PM"}))
    );
    assert_eq!(
        look(&files, MORNING),
        json!({"items": [
            list("Scheduled", &[row("r1", "Dentist appointment", "Friday, 3:00 PM")]),
        ]})
    );

    for (given, due) in [
        (once("Call the dentist", [2026, 11, 11], [15, 0]), "3:00 PM"),
        (
            once("Return the library books", [2026, 11, 10], [18, 30]),
            "November 10, 6:30 PM",
        ),
        (
            once("Pick up the dry cleaning", [2026, 11, 17], [17, 0]),
            "Tuesday, 5:00 PM",
        ),
        (
            once("Renew the passport", [2026, 11, 18], [9, 0]),
            "November 18, 9:00 AM",
        ),
        (
            once("Book the summer trip", [2027, 1, 5], [9, 0]),
            "January 5, 2027, 9:00 AM",
        ),
        (
            repeating("Water the fern", [2026, 11, 15], [10, 0], "weekly"),
            "Every Sunday, 10:00 AM",
        ),
    ] {
        assert_eq!(add(&mut files, &given).unwrap()["due"], due, "{given}");
    }

    assert_eq!(
        look(&files, MORNING),
        json!({"items": [
            list("Today", &[
                row("r3", "Return the library books", "November 10, 6:30 PM"),
                row("r2", "Call the dentist", "3:00 PM"),
            ]),
            list("Scheduled", &[
                row("r1", "Dentist appointment", "Friday, 3:00 PM"),
                row("r7", "Water the fern", "Every Sunday, 10:00 AM"),
                row("r4", "Pick up the dry cleaning", "Tuesday, 5:00 PM"),
                row("r5", "Renew the passport", "November 18, 9:00 AM"),
                row("r6", "Book the summer trip", "January 5, 2027, 9:00 AM"),
            ]),
        ]})
    );
}

#[test]
fn a_reminder_on_a_day_not_on_the_calendar_or_with_a_title_no_ring_can_carry_is_refused() {
    let mut files = installed();
    let written = files.writes;
    let on_friday = |title: &str| once(title, [2026, 11, 13], [15, 0]);
    let too_long = "Reminders: A reminder's title is one line of 120 characters at most.";

    for (given, refusal) in [
        (
            once("Call the dentist", [2026, 2, 29], [9, 0]),
            "Reminders: There is no February 29, 2026.",
        ),
        (
            once("Call the dentist", [2026, 11, 31], [9, 0]),
            "Reminders: There is no November 31, 2026.",
        ),
        (
            on_friday(" "),
            "Reminders: A reminder needs a title: what there is to do.",
        ),
        (on_friday(&"a".repeat(121)), too_long),
        (on_friday("Call\nthe dentist"), too_long),
        (
            once("Call the dentist", [2026, 13, 1], [9, 0]),
            "Reminders cannot take that: add_reminder input field \"month\" is refused: its \
             value is greater than the maximum of 12",
        ),
        (
            repeating("Call the dentist", [2026, 11, 13], [15, 0], "fortnightly"),
            "Reminders cannot take that: add_reminder input field \"repeats\" is refused: its \
             value is not one of \"never\", \"daily\" or 3 other candidates",
        ),
    ] {
        assert_eq!(add(&mut files, &given), Err(refusal.to_owned()), "{given}");
    }

    assert_eq!(files.writes, written);
    assert_eq!(
        add(&mut files, &on_friday(&"a".repeat(120))).map(|added| added["id"].clone()),
        Ok(json!("r1"))
    );
}

#[test]
fn a_reminder_that_does_not_repeat_rings_once_and_stays_due_until_it_is_done() {
    let mut files = installed();
    // 3 PM, when it is due, and the next morning.
    let due = "2026-11-11T23:00:00.000Z";
    let next_morning = "2026-11-12T17:00:00.000Z";

    add(
        &mut files,
        &once("Call the dentist", [2026, 11, 11], [15, 0]),
    )
    .unwrap();

    assert_eq!(rings(&files), json!([ring("r1", due, "Call the dentist")]));

    tell(&mut files, due);

    assert_eq!(rings(&files), json!([]));
    assert_eq!(
        look(&files, next_morning),
        json!({"items": [
            list("Today", &[row("r1", "Call the dentist", "November 11, 3:00 PM")]),
        ]})
    );
    assert_eq!(
        act(&mut files, "mark_done", &json!({"id": "r1"}), next_morning),
        Ok(json!({
            "id": "r1", "title": "Call the dentist", "due": "November 11, 3:00 PM", "done": true,
        }))
    );
    assert_eq!(look(&files, next_morning), no_reminders());
}

#[test]
fn a_reminder_that_repeats_rings_and_moves_on_to_its_next_time_each_way_it_repeats() {
    for (given, due, told) in [
        (
            repeating("Take the vitamins", [2026, 11, 30], [9, 0], "daily"),
            "Every day, 9:00 AM",
            &[
                // Past the month's end.
                ("2026-11-30T17:00:00.000Z", "2026-12-01T17:00:00.000Z"),
                // Told days late, it moves on from when it was told.
                ("2026-12-03T20:00:00.000Z", "2026-12-04T17:00:00.000Z"),
            ][..],
        ),
        (
            repeating("Water the fern", [2026, 12, 27], [10, 0], "weekly"),
            "Every Sunday, 10:00 AM",
            &[("2026-12-27T18:00:00.000Z", "2027-01-03T18:00:00.000Z")][..],
        ),
        (
            repeating("Pay the rent", [2026, 12, 31], [9, 0], "monthly"),
            "Every month on the 31st, 9:00 AM",
            &[
                ("2026-12-31T17:00:00.000Z", "2027-01-31T17:00:00.000Z"),
                // A month without its day: the month's last.
                ("2027-01-31T17:00:00.000Z", "2027-02-28T17:00:00.000Z"),
                // Back on its day, at its time once the clocks went forward.
                ("2027-02-28T17:00:00.000Z", "2027-03-31T16:00:00.000Z"),
            ][..],
        ),
        (
            repeating("Celebrate the leap day", [2028, 2, 29], [9, 0], "yearly"),
            "Every year on February 29, 9:00 AM",
            &[
                // Years without its date: February's last day.
                ("2028-02-29T17:00:00.000Z", "2029-02-28T17:00:00.000Z"),
                ("2029-02-28T17:00:00.000Z", "2030-02-28T17:00:00.000Z"),
                ("2030-02-28T17:00:00.000Z", "2031-02-28T17:00:00.000Z"),
                ("2031-02-28T17:00:00.000Z", "2032-02-29T17:00:00.000Z"),
            ][..],
        ),
    ] {
        let mut files = installed();
        let title = given["title"].as_str().unwrap().to_owned();

        assert_eq!(add(&mut files, &given).unwrap()["due"], due);
        // Its first ring is at the day and the time she gave it.
        assert_eq!(
            rings(&files),
            json!([ring("r1", told[0].0, &title)]),
            "{due}"
        );

        for (rang, next) in told {
            tell(&mut files, rang);

            assert_eq!(
                rings(&files),
                json!([ring("r1", next, &title)]),
                "{due}, told at {rang}"
            );
        }
    }
}

#[test]
fn a_reminder_that_repeats_from_a_time_already_past_first_rings_at_its_next_time() {
    let mut files = installed();

    // Each morning at 9:00, added at 9:41 for that same day.
    add(
        &mut files,
        &repeating("Take the vitamins", [2026, 11, 11], [9, 0], "daily"),
    )
    .unwrap();

    assert_eq!(
        rings(&files),
        json!([ring("r1", "2026-11-12T17:00:00.000Z", "Take the vitamins")])
    );
}

#[test]
fn done_and_removed_take_a_reminder_and_its_ring_and_done_takes_nothing_from_one_that_repeats() {
    let mut files = installed();
    let sunday = ring("r2", "2026-11-15T18:00:00.000Z", "Water the fern");
    let friday = ring("r3", "2026-11-13T23:00:00.000Z", "Dentist appointment");

    for given in [
        once("Call the dentist", [2026, 11, 11], [15, 0]),
        repeating("Water the fern", [2026, 11, 15], [10, 0], "weekly"),
        once("Dentist appointment", [2026, 11, 13], [15, 0]),
    ] {
        add(&mut files, &given).unwrap();
    }

    assert_eq!(
        act(&mut files, "mark_done", &json!({"id": "r1"}), MORNING),
        Ok(json!({"id": "r1", "title": "Call the dentist", "due": "3:00 PM", "done": true}))
    );
    assert_eq!(
        act(&mut files, "mark_done", &json!({"id": "r2"}), MORNING),
        Ok(json!({
            "id": "r2", "title": "Water the fern", "due": "Every Sunday, 10:00 AM", "done": true,
        }))
    );
    // Done or not, it rings on its Sunday.
    assert_eq!(rings(&files), json!([friday, sunday]));
    assert_eq!(
        act(&mut files, "remove_reminder", &json!({"id": "r2"}), MORNING),
        Ok(json!({
            "id": "r2", "title": "Water the fern", "due": "Every Sunday, 10:00 AM",
            "removed": true,
        }))
    );
    assert_eq!(rings(&files), json!([friday]));
    assert_eq!(
        look(&files, MORNING),
        json!({"items": [
            list("Scheduled", &[row("r3", "Dentist appointment", "Friday, 3:00 PM")]),
        ]})
    );

    for action in ["mark_done", "remove_reminder"] {
        assert_eq!(
            act(&mut files, action, &json!({"id": "r1"}), MORNING),
            Err("Reminders: There is no reminder with the id \"r1\".".to_owned()),
            "{action}"
        );
    }
}
