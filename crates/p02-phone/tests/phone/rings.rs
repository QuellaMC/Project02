//! Rings: set by an app, listed by the phone across its apps, and heard
//! once they were told to her.

use p02_phone::{App, Phone, SetRing};
use serde_json::{Value, json};

use crate::support::{Files, actions, app, at, input, millis, now};

/// An app named `name`, which says it wakes her when it `wakes`, that sets
/// and cancels rings on request, and hears them with `rang` when it is
/// given one.
fn ringing(name: &str, wakes: bool, rang: &str) -> App {
    app(
        &json!({
            "id": name.to_lowercase(),
            "name": name,
            "wakes": wakes,
            "actions": actions(&["ring", "cancel"]),
        }),
        &format!(
            "export function screen() {{ return {{ items: [] }}; }}

            export function ring(ring) {{
                phone.rings.set(ring);
                return phone.rings.list();
            }}

            export function cancel({{ id }}) {{
                phone.rings.cancel(id);
                return phone.rings.list();
            }}

            {rang}"
        ),
    )
}

/// Alarms: it writes down each ring it hears, sets its daily one again a
/// day later, and breaks on its broken one.
fn alarms() -> App {
    ringing(
        "Alarms",
        true,
        "export function rang(ring) {
            phone.storage.set('heard', [...(phone.storage.get('heard') ?? []), ring]);

            if (ring.id === 'daily') {
                phone.rings.set({ ...ring, at: ring.at + 24 * 60 * 60 * 1000 });
            }
            if (ring.id === 'broken') {
                throw new Error('the bell is broken');
            }
        }",
    )
}

/// Timers, which does not hear its rings.
fn timers() -> App {
    ringing("Timers", true, "")
}

/// What `phone`'s `app` answers when asked to set `ring`.
fn ring(phone: &Phone, files: &mut Files, app: &str, ring: &Value) -> Result<Value, String> {
    phone
        .act(files, app, "ring", &input(ring), &now())
        .map(|acted| acted.answer)
        .map_err(|refused| refused.to_string())
}

/// A ring as a script meets it, at `moment`.
fn shown(id: &str, moment: &str, title: &str) -> Value {
    json!({"id": id, "at": millis(moment), "title": title})
}

#[test]
fn an_app_sets_replaces_cancels_and_lists_its_rings() {
    let phone = Phone::new(vec![alarms()]);
    let mut files = Files::default();
    let tea = shown("tea", "2026-03-07T19:00:00.000Z", "Tea");
    let run = json!({
        "id": "run",
        "at": millis("2026-03-07T18:00:00.000Z"),
        "title": "Run",
        "body": "Shoes by the door",
    });
    let sooner_tea = shown("tea", "2026-03-07T17:30:00.000Z", "Tea");

    assert_eq!(ring(&phone, &mut files, "alarms", &tea), Ok(json!([tea])));
    assert_eq!(
        ring(&phone, &mut files, "alarms", &run),
        Ok(json!([run, tea]))
    );
    assert_eq!(
        ring(&phone, &mut files, "alarms", &sooner_tea),
        Ok(json!([sooner_tea, run]))
    );

    for id in ["run", "nothing"] {
        assert_eq!(
            phone
                .act(
                    &mut files,
                    "alarms",
                    "cancel",
                    &input(&json!({"id": id})),
                    &now()
                )
                .unwrap()
                .answer,
            json!([sooner_tea]),
            "{id}"
        );
    }

    let six = millis("2026-03-07T18:00:00.000Z");

    for refused in [
        json!({"id": "tea", "at": six, "title": " "}),
        json!({"id": "tea", "at": 1.5, "title": "Tea"}),
        json!({"at": six, "title": "Tea"}),
        json!({"id": "tea", "at": six, "title": "Tea", "colour": "red"}),
        json!({"id": "tea", "at": six, "title": "T".repeat(41)}),
        json!({"id": "tea", "at": six, "title": "Tea\nfor two"}),
        json!({"id": "tea", "at": six, "title": "Tea", "body": "b".repeat(121)}),
        json!({"id": "tea", "at": six, "title": "Tea", "body": "Milk\rfirst"}),
    ] {
        assert_eq!(
            ring(&phone, &mut files, "alarms", &refused),
            Err(
                "Alarms failed: TypeError: phone.rings.set takes {id, at, title, body}: an id \
                 that is not blank, at in whole milliseconds since the epoch, a title of one \
                 line that is not blank, of 40 characters at most, and, if it has one, a body \
                 of one line of 120 characters at most"
                    .to_owned()
            ),
            "{refused}"
        );
    }

    let full = json!({"id": "full", "at": six, "title": "T".repeat(40), "body": "b".repeat(120)});

    assert!(ring(&phone, &mut files, "alarms", &full).is_ok());
    phone
        .act(
            &mut files,
            "alarms",
            "cancel",
            &input(&json!({"id": "full"})),
            &now(),
        )
        .unwrap();

    assert_eq!(
        files.documents["apps/alarms.json"],
        json!({
            "storage": {},
            "rings": [{"id": "tea", "at": "2026-03-07T17:30:00.000Z", "title": "Tea"}],
        })
    );
}

#[test]
fn an_app_that_does_not_say_it_wakes_her_sets_no_ring_and_cancels_and_lists_as_any_does() {
    let phone = Phone::new(vec![ringing("Notes", false, "")]);
    let mut files = Files::default();

    assert_eq!(
        ring(
            &phone,
            &mut files,
            "notes",
            &shown("tea", "2026-03-07T19:00:00.000Z", "Tea")
        ),
        Err(
            "Notes failed: TypeError: phone.rings.set sets no ring here: an app must say it \
             wakes her, with wakes: true in its manifest, to set a ring"
                .to_owned()
        )
    );
    assert_eq!(
        phone
            .act(
                &mut files,
                "notes",
                "cancel",
                &input(&json!({"id": "tea"})),
                &now()
            )
            .unwrap()
            .answer,
        json!([])
    );
    assert_eq!(phone.rings(&files).unwrap(), []);
}

#[test]
fn the_phone_lists_the_rings_of_all_its_apps_soonest_first() {
    let phone = Phone::new(vec![alarms(), timers()]);
    let mut files = Files::default();

    for (app, set) in [
        (
            "alarms",
            shown("wake", "2026-03-08T12:00:00.000Z", "Wake up"),
        ),
        ("timers", shown("tea", "2026-03-07T17:05:00.000Z", "Tea")),
        ("alarms", shown("run", "2026-03-07T18:00:00.000Z", "Run")),
    ] {
        ring(&phone, &mut files, app, &set).unwrap();
    }

    let rings = phone.rings(&files).unwrap();
    let listed: Vec<(&str, &str, &str, &str)> = rings
        .iter()
        .map(|set| {
            (
                set.app.as_str(),
                set.app_name.as_str(),
                set.ring.id(),
                set.ring.at().as_str(),
            )
        })
        .collect();

    assert_eq!(
        listed,
        [
            ("timers", "Timers", "tea", "2026-03-07T17:05:00.000Z"),
            ("alarms", "Alarms", "run", "2026-03-07T18:00:00.000Z"),
            ("alarms", "Alarms", "wake", "2026-03-08T12:00:00.000Z"),
        ]
    );
}

#[test]
fn a_ring_told_to_her_is_heard_and_let_go_unless_it_was_set_anew() {
    let phone = Phone::new(vec![alarms(), timers()]);
    let mut files = Files::default();
    let once = shown("once", "2026-03-07T17:01:00.000Z", "Once");
    let daily = shown("daily", "2026-03-07T17:02:00.000Z", "Daily");

    for (app, set) in [
        ("alarms", once.clone()),
        ("alarms", daily.clone()),
        (
            "alarms",
            shown("broken", "2026-03-07T17:03:00.000Z", "Broken"),
        ),
        (
            "alarms",
            shown("moved", "2026-03-07T17:04:00.000Z", "Moved"),
        ),
        ("timers", shown("tea", "2026-03-07T17:01:30.000Z", "Tea")),
    ] {
        ring(&phone, &mut files, app, &set).unwrap();
    }

    let told: Vec<SetRing> = phone.rings(&files).unwrap();

    ring(
        &phone,
        &mut files,
        "alarms",
        &shown("moved", "2026-03-07T17:05:00.000Z", "Moved"),
    )
    .unwrap();

    let failures: Vec<String> = phone
        .told(&mut files, &told, &at("2026-03-07T17:10:00.000Z"))
        .unwrap()
        .iter()
        .map(ToString::to_string)
        .collect();

    assert_eq!(failures, ["Alarms: the bell is broken"]);
    assert_eq!(
        files.documents["apps/alarms.json"],
        json!({
            "storage": {"heard": [once, daily]},
            "rings": [
                {"id": "moved", "at": "2026-03-07T17:05:00.000Z", "title": "Moved"},
                {"id": "daily", "at": "2026-03-08T17:02:00.000Z", "title": "Daily"},
            ],
        })
    );
    assert_eq!(
        files.documents["apps/timers.json"],
        json!({"storage": {}, "rings": []})
    );
}
