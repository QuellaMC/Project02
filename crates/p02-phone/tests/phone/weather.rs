//! Weather, an app of the App Store's catalog: its one file installed on
//! her phone as the store installs it, used through the phone's own calls
//! in Los Angeles on a Wednesday morning, each place she looks up answered
//! as Open-Meteo's pages show its answers.

use p02_phone::{Acting, Ask, Exchange, Fetch, Fetched, Method, Now, Phone, Source};
use serde_json::{Value, json};

use crate::support::{Files, in_zone, input, millis};

/// Weather as the catalog serves it.
const WEATHER: &str = include_str!("../../catalog/weather.js");
/// Wednesday 11 November 2026, 9:41 AM in Los Angeles, as in Seattle.
const MORNING: &str = "2026-11-11T17:41:00.000Z";

fn phone() -> &'static Phone {
    Phone::bundled().unwrap()
}

/// Her phone's files, with Weather installed on it from the catalog.
fn installed() -> Files {
    let mut files = Files::default();

    phone()
        .install(&mut files, WEATHER, Source::Catalog)
        .unwrap();
    files
}

/// `moment` in Los Angeles.
fn at(moment: &str) -> Now {
    in_zone(moment, "America/Los_Angeles")
}

/// Her look-up of `given` in the morning, each request it asks for answered
/// in turn from `answers`: the requests it asked for, and what it answered
/// or the sentence it was refused in, none while it asks for a request
/// `answers` does not answer.
fn look_up(
    files: &mut Files,
    given: &Value,
    answers: &[Result<Fetched, String>],
) -> (Vec<Fetch>, Option<Result<Value, String>>) {
    let mut asked = Vec::new();
    let mut exchanges = Vec::new();
    let came = loop {
        match phone().act(
            files,
            "weather",
            "look_up",
            &input(given),
            &exchanges,
            &at(MORNING),
        ) {
            Ok(Acting::Asks(Ask::Fetch(fetch))) => {
                asked.push(fetch.clone());

                let Some(fetched) = answers.get(exchanges.len()) else {
                    break None;
                };

                exchanges.push(Exchange::Fetch {
                    fetch,
                    fetched: fetched.clone(),
                });
            }
            Ok(Acting::Asks(ask)) => panic!("it asks for {ask:?}"),
            Ok(Acting::Acted(acted)) => break Some(Ok(acted.answer)),
            Err(refused) => break Some(Err(refused.to_string())),
        }
    };

    (asked, came)
}

/// What Weather shows at `moment`.
fn look(files: &Files, moment: &str) -> Value {
    serde_json::to_value(
        phone()
            .look(files, "weather", "weather", &at(moment))
            .unwrap(),
    )
    .unwrap()
}

/// An answer of the service's of `status` and `body`.
fn answer(status: u16, body: &str) -> Fetched {
    Fetched {
        status,
        body: body.to_owned(),
    }
}

/// Answers of the service's with success, of `bodies` in turn.
fn answered(bodies: &[Value]) -> Vec<Result<Fetched, String>> {
    bodies
        .iter()
        .map(|body| Ok(answer(200, &body.to_string())))
        .collect()
}

/// The addresses of the requests `asked`.
fn addresses(asked: &[Fetch]) -> Vec<String> {
    asked.iter().map(|fetch| fetch.url().to_string()).collect()
}

/// The address of Open-Meteo's search for a place by `name`, as an address
/// writes it.
fn search(name: &str) -> String {
    format!(
        "https://geocoding-api.open-meteo.com/v1/search?name={name}&count=1&language=en&format=json"
    )
}

/// The address of Open-Meteo's forecast at a place, in `degrees`.
fn forecast(latitude: &str, longitude: &str, degrees: &str) -> String {
    format!(
        "https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}\
         &current=temperature_2m,weather_code&hourly=temperature_2m\
         &daily=weather_code,temperature_2m_max,temperature_2m_min\
         &timezone=auto&forecast_days=6&forecast_hours=6&temperature_unit={degrees}"
    )
}

/// Seattle, as Open-Meteo's search finds it.
fn seattle() -> Value {
    json!({"results": [{
        "name": "Seattle", "latitude": 47.60621, "longitude": -122.33207,
        "country": "United States", "admin1": "Washington",
        "timezone": "America/Los_Angeles", "country_code": "US",
    }]})
}

/// Seattle's forecast in Celsius, asked on Wednesday at 9:41 AM there: now,
/// the six hours from the one it is, and six days from today.
fn seattle_forecast() -> Value {
    json!({
        "latitude": 47.59556, "longitude": -122.32443,
        "timezone": "America/Los_Angeles", "utc_offset_seconds": -28_800,
        "current": {"time": "2026-11-11T09:30", "temperature_2m": 12.4, "weather_code": 61},
        "hourly": {
            "time": [
                "2026-11-11T09:00", "2026-11-11T10:00", "2026-11-11T11:00",
                "2026-11-11T12:00", "2026-11-11T13:00", "2026-11-11T14:00",
            ],
            "temperature_2m": [11.8, 12.3, 13.1, 13.8, 14.2, 13.4],
        },
        "daily": {
            "time": [
                "2026-11-11", "2026-11-12", "2026-11-13",
                "2026-11-14", "2026-11-15", "2026-11-16",
            ],
            "weather_code": [61, 3, 80, 2, 0, 63],
            "temperature_2m_max": [14.2, 12.4, 10.6, 9.8, 11.9, 9.2],
            "temperature_2m_min": [7.6, 7.2, 5.9, 4.8, 6.6, 5.7],
        },
    })
}

/// Portland, Maine, as Open-Meteo's search finds it.
fn portland() -> Value {
    json!({"results": [{
        "name": "Portland", "latitude": 43.65737, "longitude": -70.2589,
        "country": "United States", "admin1": "Maine",
        "timezone": "America/New_York", "country_code": "US",
    }]})
}

/// Portland's forecast in Fahrenheit, asked at 12:41 PM there, now with a
/// code Weather has no words for.
fn portland_forecast() -> Value {
    json!({
        "latitude": 43.6573, "longitude": -70.2583,
        "timezone": "America/New_York", "utc_offset_seconds": -18_000,
        "current": {"time": "2026-11-11T12:30", "temperature_2m": 45.3, "weather_code": 4},
        "hourly": {
            "time": [
                "2026-11-11T12:00", "2026-11-11T13:00", "2026-11-11T14:00",
                "2026-11-11T15:00", "2026-11-11T16:00", "2026-11-11T17:00",
            ],
            "temperature_2m": [44.6, 46.2, 47.1, 46.4, 44.9, 42.8],
        },
        "daily": {
            "time": [
                "2026-11-11", "2026-11-12", "2026-11-13",
                "2026-11-14", "2026-11-15", "2026-11-16",
            ],
            "weather_code": [3, 61, 2, 0, 1, 3],
            "temperature_2m_max": [47.8, 51.3, 44.2, 40.1, 42.6, 46.9],
            "temperature_2m_min": [36.4, 39.2, 33.8, 29.5, 31.7, 35.2],
        },
    })
}

fn no_place() -> Value {
    json!({"items": [{"kind": "text", "text": "No Place Looked Up"}]})
}

#[test]
fn a_look_up_finds_the_place_reads_its_forecast_and_keeps_and_shows_that_reading() {
    let mut files = installed();
    let (asked, came) = look_up(
        &mut files,
        &json!({"place": "Seattle"}),
        &answered(&[seattle(), seattle_forecast()]),
    );

    assert_eq!(
        addresses(&asked),
        [
            search("Seattle"),
            forecast("47.60621", "-122.33207", "celsius")
        ]
    );
    assert!(asked.iter().all(|fetch| fetch.method() == Method::Get
        && fetch.headers().is_empty()
        && fetch.body().is_none()
        && fetch.account().is_none()));
    assert_eq!(
        came,
        Some(Ok(json!({
            "place": "Seattle, Washington, United States",
            "now": {"temperature": "12°C", "sky": "Light Rain"},
            "today": {"low": "8°C", "high": "14°C"},
            "hours": [
                {"at": "10 AM", "temperature": "12°C"},
                {"at": "11 AM", "temperature": "13°C"},
                {"at": "12 PM", "temperature": "14°C"},
                {"at": "1 PM", "temperature": "14°C"},
                {"at": "2 PM", "temperature": "13°C"},
            ],
            "days": [
                {"day": "Today", "sky": "Light Rain", "low": "8°C", "high": "14°C"},
                {"day": "Thursday", "sky": "Cloudy", "low": "7°C", "high": "12°C"},
                {"day": "Friday", "sky": "Light Showers", "low": "6°C", "high": "11°C"},
                {"day": "Saturday", "sky": "Partly Cloudy", "low": "5°C", "high": "10°C"},
                {"day": "Sunday", "sky": "Clear", "low": "7°C", "high": "12°C"},
                {"day": "Monday", "sky": "Rain", "low": "6°C", "high": "9°C"},
            ],
        })))
    );
    // Each bar between 5°, the lowest low of the six days, and 14°, the
    // highest high.
    assert_eq!(
        look(&files, MORNING),
        json!({"items": [
            {"kind": "glance", "title": "Seattle", "text": "12°", "caption": "Light Rain",
             "detail": "H: 14°  L: 8°"},
            {"kind": "strip", "cells": [
                {"label": "Now", "value": "12°"},
                {"label": "10 AM", "value": "12°"},
                {"label": "11 AM", "value": "13°"},
                {"label": "12 PM", "value": "14°"},
                {"label": "1 PM", "value": "14°"},
                {"label": "2 PM", "value": "13°"},
            ]},
            {"kind": "ranges", "rows": [
                {"label": "Today", "low": "8°", "high": "14°", "from": 33, "to": 100},
                {"label": "Thu", "low": "7°", "high": "12°", "from": 22, "to": 78},
                {"label": "Fri", "low": "6°", "high": "11°", "from": 11, "to": 67},
                {"label": "Sat", "low": "5°", "high": "10°", "from": 0, "to": 56},
                {"label": "Sun", "low": "7°", "high": "12°", "from": 22, "to": 78},
                {"label": "Mon", "low": "6°", "high": "9°", "from": 11, "to": 44},
            ]},
            {"kind": "note", "text": "Updated 9:41 AM · Weather data by Open-Meteo.com"},
        ]})
    );
    assert_eq!(
        files.documents["apps/weather.json"],
        json!({"storage": {"weather": {
            "place": {"name": "Seattle", "region": "Washington", "country": "United States"},
            "degrees": "celsius",
            "read": millis(MORNING),
            "now": {"temperature": 12, "code": 61},
            "hours": [
                {"time": "2026-11-11T10:00", "temperature": 12},
                {"time": "2026-11-11T11:00", "temperature": 13},
                {"time": "2026-11-11T12:00", "temperature": 14},
                {"time": "2026-11-11T13:00", "temperature": 14},
                {"time": "2026-11-11T14:00", "temperature": 13},
            ],
            "days": [
                {"date": "2026-11-11", "code": 61, "low": 8, "high": 14},
                {"date": "2026-11-12", "code": 3, "low": 7, "high": 12},
                {"date": "2026-11-13", "code": 80, "low": 6, "high": 11},
                {"date": "2026-11-14", "code": 2, "low": 5, "high": 10},
                {"date": "2026-11-15", "code": 0, "low": 7, "high": 12},
                {"date": "2026-11-16", "code": 63, "low": 6, "high": 9},
            ],
        }}, "rings": []})
    );
}

#[test]
fn a_look_up_in_fahrenheit_says_its_degrees_and_the_next_one_reads_in_them_too() {
    let mut files = installed();
    let (asked, came) = look_up(
        &mut files,
        &json!({"place": "Portland, Maine", "degrees": "fahrenheit"}),
        &answered(&[portland(), portland_forecast()]),
    );
    let told = came.unwrap().unwrap();

    assert_eq!(
        addresses(&asked),
        [
            search("Portland%2C%20Maine"),
            forecast("43.65737", "-70.2589", "fahrenheit")
        ]
    );
    assert_eq!(told["place"], "Portland, Maine, United States");
    // A code it has no words for says nothing.
    assert_eq!(told["now"], json!({"temperature": "45°F"}));
    assert_eq!(told["today"], json!({"low": "36°F", "high": "48°F"}));
    // Its hours as a clock there reads them, three hours ahead of hers.
    assert_eq!(
        told["hours"][0],
        json!({"at": "1 PM", "temperature": "46°F"})
    );
    assert_eq!(
        look(&files, MORNING)["items"][0],
        json!({"kind": "glance", "title": "Portland", "text": "45°", "detail": "H: 48°  L: 36°"})
    );

    let (asked, came) = look_up(
        &mut files,
        &json!({"place": "Seattle"}),
        &answered(&[seattle()]),
    );

    assert_eq!(
        addresses(&asked)[1],
        forecast("47.60621", "-122.33207", "fahrenheit")
    );
    assert_eq!(came, None);
}

#[test]
fn a_look_up_that_finds_no_place_or_no_forecast_is_refused_and_keeps_nothing() {
    let mut files = installed();
    let written = files.writes;
    let place = |name: &str| json!({"place": name});
    let refused = |rule: &str| {
        format!(
            "Weather cannot take that: look_up input field \"place\" is refused: its value {rule}"
        )
    };
    let not_one_line = refused(r#"does not match "^[^\n\r]*\S[^\n\r]*$""#);
    let unanswered = || {
        "Weather: The weather service did not answer as it should. Try again in a while.".to_owned()
    };
    let mut without_days = seattle_forecast();

    without_days.as_object_mut().unwrap().remove("daily");

    for (given, answers, refusal) in [
        (place(" "), vec![], not_one_line.clone()),
        (place("Seattle\nWashington"), vec![], not_one_line),
        (
            place(&"a".repeat(101)),
            vec![],
            refused("is longer than 100 characters"),
        ),
        (
            place("Atlantis"),
            answered(&[json!({"generationtime_ms": 0.31})]),
            "Weather: No place called \"Atlantis\" was found. Its country after a comma may \
             help, as in \"Paris, France\"."
                .to_owned(),
        ),
        (
            place("Seattle"),
            vec![Ok(answer(
                200,
                "<!doctype html><title>Sign in to the Wi-Fi</title>",
            ))],
            unanswered(),
        ),
        (
            place("Seattle"),
            vec![Ok(answer(
                400,
                r#"{"error": true, "reason": "Parameter count must be between 1 and 100."}"#,
            ))],
            unanswered(),
        ),
        (
            place("Seattle"),
            answered(&[seattle(), without_days]),
            unanswered(),
        ),
        (
            place("Seattle"),
            vec![Err("Its server could not be reached.".to_owned())],
            "Weather: Its server could not be reached.".to_owned(),
        ),
    ] {
        assert_eq!(
            look_up(&mut files, &given, &answers).1,
            Some(Err(refusal)),
            "{given}"
        );
    }

    assert_eq!(files.writes, written);
    assert_eq!(look(&files, MORNING), no_place());
}

#[test]
fn before_any_look_up_its_screen_says_so_and_a_reading_of_another_day_says_its_day() {
    let mut files = installed();
    let note = |files: &Files, moment: &str| look(files, moment)["items"][3]["text"].clone();

    assert_eq!(look(&files, MORNING), no_place());

    look_up(
        &mut files,
        &json!({"place": "Seattle"}),
        &answered(&[seattle(), seattle_forecast()]),
    );

    for (moment, read) in [
        // A minute before midnight on her phone's clock, and at midnight.
        ("2026-11-12T07:59:00.000Z", "9:41 AM"),
        ("2026-11-12T08:00:00.000Z", "November 11, 9:41 AM"),
        ("2027-01-04T17:00:00.000Z", "November 11, 2026, 9:41 AM"),
    ] {
        assert_eq!(
            note(&files, moment),
            format!("Updated {read} · Weather data by Open-Meteo.com"),
            "{moment}"
        );
    }
}
