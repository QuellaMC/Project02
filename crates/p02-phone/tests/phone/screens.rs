//! What a view shows: read into the pieces the phone knows, and read only.

use p02_phone::{Phone, Screen};
use serde_json::{Value, json};

use crate::support::{Files, app, now};

/// An app whose view `name` shows what `screens` holds under that name.
fn showing(screens: &Value) -> Phone {
    let views: Vec<Value> = screens
        .as_object()
        .unwrap()
        .keys()
        .map(|name| json!({"id": name, "title": name}))
        .collect();

    Phone::new(vec![app(
        &json!({"views": views, "opensOn": views[0]["id"]}),
        &format!("export function screen(view) {{ return ({screens})[view]; }}"),
    )])
}

#[test]
fn a_screen_reads_into_the_pieces_the_phone_knows_and_back() {
    let everything = json!({"items": [
        {"kind": "list", "header": "Recents", "rows": [
            {"id": "a1", "caption": "Today, +8HRS", "title": "London",
             "subtitle": "Wake Sam, weekdays", "time": "7:00 AM", "value": "00:12.34",
             "switch": true},
            {"time": "6:30 AM", "switch": false},
        ]},
        {"kind": "readout", "id": "t1", "label": "Tea", "text": "12:34",
         "caption": "Ends 9:54 AM",
         "live": {"counts": "down", "to": 1_794_571_440_000_i64, "of": 900_000}},
        {"kind": "readout", "text": "00:00.00",
         "live": {"counts": "up", "from": 1_794_571_440_000_i64}},
        {"kind": "text", "text": "No alarms"},
    ]});
    let phone = showing(&json!({"everything": everything}));
    let screen = phone
        .open(&Files::default(), "notes", None, &now())
        .unwrap();

    assert_eq!(serde_json::to_value(&screen).unwrap(), everything);
    assert_eq!(
        serde_json::from_value::<Screen>(everything).unwrap(),
        screen
    );
}

#[test]
fn a_screen_with_what_the_phone_does_not_know_is_refused_by_name() {
    let phone = showing(&json!({
        "chart": {"items": [{"kind": "chart"}]},
        "colour": {"items": [{"kind": "list", "rows": [{"title": "London", "colour": "red"}]}]},
        "size": {"items": [{"kind": "text", "text": "No alarms", "size": "large"}]},
        "untitled": {"items": [{"kind": "list", "rows": [{"subtitle": "Weekdays"}]}]},
        "nothing": null,
    }));

    for (view, refusal) in [
        (
            "chart",
            "Notes showed a screen the phone does not take: unknown variant `chart`, expected \
             one of `list`, `readout`, `text`",
        ),
        (
            "colour",
            "Notes showed a screen the phone does not take: unknown field `colour`, expected \
             one of `id`, `caption`, `title`, `subtitle`, `time`, `value`, `switch`",
        ),
        (
            "size",
            "Notes showed a screen the phone does not take: unknown field `size`, expected \
             `text`",
        ),
        (
            "untitled",
            "Notes showed a screen the phone does not take: a row of a list has neither a \
             title nor a time",
        ),
        (
            "nothing",
            "Notes showed a screen the phone does not take: invalid type: null, expected \
             struct Screen",
        ),
    ] {
        assert_eq!(
            phone
                .open(&Files::default(), "notes", Some(view), &now())
                .unwrap_err()
                .to_string(),
            refusal
        );
    }
}

#[test]
fn a_screen_only_reads() {
    let phone = Phone::new(vec![app(
        &json!({"views": [{"id": "all", "title": "All"}]}),
        "export function screen() {
            const tried = [
                () => phone.storage.set('seen', true),
                () => phone.storage.remove('seen'),
                () => phone.rings.set({ id: 'tea', at: 0, title: 'Tea' }),
                () => phone.rings.cancel('tea'),
            ];

            return { items: tried.map((write) => {
                try {
                    write();
                    return { kind: 'text', text: 'written' };
                } catch (error) {
                    return { kind: 'text', text: String(error) };
                }
            }) };
        }",
    )]);
    let screen = phone
        .open(&Files::default(), "notes", None, &now())
        .unwrap();
    let refused = |function: &str| {
        json!({
            "kind": "text",
            "text": format!("TypeError: {function} changes nothing here: a screen only reads"),
        })
    };

    assert_eq!(
        serde_json::to_value(screen).unwrap(),
        json!({"items": [
            refused("phone.storage.set"),
            refused("phone.storage.remove"),
            refused("phone.rings.set"),
            refused("phone.rings.cancel"),
        ]})
    );
}
