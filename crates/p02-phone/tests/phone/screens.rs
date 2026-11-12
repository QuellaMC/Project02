//! What a view shows: read into the pieces the phone knows, held to their
//! rules, and read only.

use p02_phone::Phone;
use p02_wire::Screen;
use serde_json::{Value, json};

use crate::support::{Files, app, now, view};

/// An app whose view `name` shows what `screens` holds under that name.
fn showing(screens: &Value) -> Phone {
    let views: Vec<Value> = screens
        .as_object()
        .unwrap()
        .keys()
        .map(|name| view(name, name))
        .collect();

    Phone::new(vec![app(
        &json!({"views": views, "opensOn": views[0]["id"]}),
        &format!("export function screen(view) {{ return ({screens})[view]; }}"),
    )])
}

#[test]
fn a_screen_reads_into_the_pieces_the_phone_knows_and_back() {
    let everything = json!({"page": "tea", "items": [
        {"kind": "app", "id": "tea", "tile": {"icon": "timer", "tint": "mint"}, "name": "Tea",
         "subtitle": "Reviewed", "status": "Installed"},
        {"kind": "list", "header": "Recents", "rows": [
            {"id": "a1", "tile": {"icon": "globe", "tint": "blue"}, "caption": "Today, +8HRS",
             "title": "London", "subtitle": "Wake Sam, weekdays", "time": "7:00 AM",
             "value": "00:12.34", "switch": true, "url": "https://example.com/london"},
            {"time": "6:30 AM", "switch": false},
            {"title": "Tea", "url": "http://example.com/tea"},
        ]},
        {"kind": "readout", "id": "t1", "label": "Tea", "text": "12:34",
         "caption": "Ends 9:54 AM",
         "live": {"counts": "down", "to": 1_794_571_440_000_i64, "of": 900_000}},
        {"kind": "readout", "text": "00:00.00",
         "live": {"counts": "up", "from": 1_794_571_440_000_i64}},
        {"kind": "text", "text": "No alarms"},
        {"kind": "glance", "title": "Seattle", "text": "12°", "caption": "Light Rain",
         "detail": "H: 14°  L: 8°"},
        {"kind": "glance", "title": "Seattle", "text": "12°"},
        {"kind": "strip", "cells": [
            {"label": "Now", "value": "12°"},
            {"label": "10AM", "value": "13°"},
        ]},
        {"kind": "ranges", "rows": [
            {"label": "Wed", "low": "5°", "high": "14°", "from": 0, "to": 100},
            {"label": "Thu", "low": "9°", "high": "9°", "from": 44, "to": 44},
        ]},
        {"kind": "field", "text": "how long to steep green tea", "icon": "magnifier"},
        {"kind": "field", "text": "green tea"},
        {"kind": "note", "text": "Weather data by Open-Meteo.com"},
        {"kind": "bubble", "from": "her", "text": "How long do I steep green tea?"},
        {"kind": "bubble", "from": "them", "text": "Two to three minutes."},
    ]});
    let phone = showing(&json!({"everything": everything}));
    let screen = phone
        .look(&Files::default(), "notes", "everything", &now())
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
        "mine": {"items": [{"kind": "bubble", "from": "me", "text": "Hello"}]},
        "nothing": null,
    }));

    for (view, refusal) in [
        (
            "chart",
            "Notes showed a screen the phone does not take: unknown variant `chart`, expected \
             one of `list`, `readout`, `text`, `app`, `glance`, `strip`, `ranges`, `field`, \
             `note`, `bubble`",
        ),
        (
            "colour",
            "Notes showed a screen the phone does not take: unknown field `colour`, expected \
             one of `id`, `tile`, `caption`, `title`, `subtitle`, `time`, `value`, `switch`, \
             `url`",
        ),
        (
            "size",
            "Notes showed a screen the phone does not take: unknown field `size`, expected \
             `text`",
        ),
        (
            "mine",
            "Notes showed a screen the phone does not take: unknown variant `me`, expected \
             `her` or `them`",
        ),
        (
            "nothing",
            "Notes showed a screen the phone does not take: invalid type: null, expected \
             struct Screen",
        ),
    ] {
        assert_eq!(
            phone
                .look(&Files::default(), "notes", view, &now())
                .unwrap_err()
                .to_string(),
            refusal
        );
    }
}

#[test]
fn a_screen_whose_piece_breaks_its_rule_is_refused_by_the_rule() {
    let strip = |cells: usize| {
        json!({"items": [
            {"kind": "strip", "cells": vec![json!({"label": "Now", "value": "12°"}); cells]},
        ]})
    };
    let ranges = |bars: &[(u32, u32)]| {
        let rows: Vec<Value> = bars
            .iter()
            .map(|(from, to)| {
                json!({"label": "Wed", "low": "8°", "high": "14°", "from": from, "to": to})
            })
            .collect();

        json!({"items": [{"kind": "ranges", "rows": rows}]})
    };
    let linked =
        |url: &str| json!({"items": [{"kind": "list", "rows": [{"title": "Tea", "url": url}]}]});
    let address = |chars: usize| {
        let start = "https://example.com/";

        format!("{start}{}", "a".repeat(chars - start.len()))
    };
    let said = |text: &str| json!({"items": [{"kind": "bubble", "from": "them", "text": text}]});
    let phone = showing(&json!({
        "untitled": {"items": [{"kind": "list", "rows": [{"subtitle": "Weekdays"}]}]},
        "one": strip(1),
        "eight": strip(8),
        "nine": strip(9),
        "bare": ranges(&[]),
        "ten": ranges(&[(0, 100); 10]),
        "eleven": ranges(&[(0, 100); 11]),
        "past": ranges(&[(20, 101)]),
        "backwards": ranges(&[(60, 40)]),
        "unaddressed": linked("example.com/tea"),
        "longest": linked(&address(2_048)),
        "longer": linked(&address(2_049)),
        "blank": said(" \n "),
        "said": said("Steep it for two minutes."),
    }));
    let strips = "a strip has fewer than 2 cells or more than 8";
    let counted = "ranges have no row or more than 10";
    let addressed =
        "a row's `url` is not an https:// or http:// address of 2,048 characters at most";

    for (view, rule) in [
        (
            "untitled",
            Some("a row of a list has neither a title nor a time"),
        ),
        ("one", Some(strips)),
        ("eight", None),
        ("nine", Some(strips)),
        ("bare", Some(counted)),
        ("ten", None),
        ("eleven", Some(counted)),
        ("past", Some("a range's `from` or `to` is past 100")),
        ("backwards", Some("a range's `from` is past its `to`")),
        ("unaddressed", Some(addressed)),
        ("longest", None),
        ("longer", Some(addressed)),
        ("blank", Some("a bubble's `text` is blank")),
        ("said", None),
    ] {
        assert_eq!(
            phone
                .look(&Files::default(), "notes", view, &now())
                .err()
                .map(|refusal| refusal.to_string()),
            rule.map(|rule| format!("Notes showed a screen the phone does not take: {rule}")),
            "{view}"
        );
    }
}

#[test]
fn a_screen_only_reads() {
    let phone = Phone::new(vec![app(
        &json!({}),
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
        .look(&Files::default(), "notes", "all", &now())
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
