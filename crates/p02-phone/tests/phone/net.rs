//! An app reaching the internet: `phone.net.fetch` in an action, answered
//! run by run from the exchanges its caller made, each run all or nothing.

use std::slice;

use p02_phone::{Account, Acted, Acting, App, Exchange, Fetch, Fetched, Method, Phone, PhoneError};
use serde_json::{Value, json};

use crate::support::{Files, actions, app, input, manifest, now, text};

/// The address of Open-Meteo's forecast, at a host that is no account's.
const FORECAST: &str = "https://api.open-meteo.com/v1/forecast";

/// Lookup, which reaches Tavily's host, on the person's Tavily account,
/// and Open-Meteo's, with these `fields` beside them and `script` beside
/// a screen that shows what it found.
fn lookup(fields: &Value, script: &str) -> Phone {
    let mut manifest = json!({
        "id": "lookup",
        "name": "Lookup",
        "reaches": ["api.tavily.com", "api.open-meteo.com"],
        "account": "tavily",
    });

    for (field, value) in fields.as_object().unwrap() {
        manifest[field] = value.clone();
    }

    Phone::new(vec![app(
        &manifest,
        &format!(
            "export function screen() {{
                return {{ items: [{{ kind: 'text', text: phone.storage.get('found') ?? 'Nothing' }}] }};
            }}
            {script}"
        ),
    )])
}

/// What Lookup's `action` came to on `given`, after `exchanges`.
fn run(
    phone: &Phone,
    files: &mut Files,
    action: &str,
    given: &Value,
    exchanges: &[Exchange],
) -> Result<Acting, PhoneError> {
    phone.act(files, "lookup", action, &input(given), exchanges, &now())
}

fn asks(acting: Result<Acting, PhoneError>) -> Fetch {
    match acting.unwrap() {
        Acting::Asks(fetch) => fetch,
        Acting::Acted(acted) => panic!("it acted: {}", acted.answer),
    }
}

fn acted(acting: Result<Acting, PhoneError>) -> Acted {
    match acting.unwrap() {
        Acting::Acted(acted) => acted,
        Acting::Asks(fetch) => panic!("it asks for {}", fetch.url()),
    }
}

/// `fetch` and its answer, of `status` and `body`.
fn answered(fetch: Fetch, status: u16, body: &str) -> Exchange {
    Exchange {
        fetch,
        fetched: Ok(Fetched {
            status,
            body: body.to_owned(),
        }),
    }
}

#[test]
fn an_action_asks_for_each_request_in_turn_and_keeps_what_it_did_only_once_it_answers() {
    let phone = lookup(
        &json!({"actions": actions(&["look_up"])}),
        "export function look_up({ query }) {
            phone.storage.set('asked', query);

            const found = phone.net.fetch({
                url: 'https://api.tavily.com/search',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query }),
            });
            const weather = phone.net.fetch({ url: 'https://api.open-meteo.com/v1/forecast?city=London' });

            phone.storage.set('found', JSON.parse(found.body).answer);
            return { found: found.status, weather: weather.body };
        }",
    );
    let mut files = Files::default();
    let tea = json!({"query": "tea"});
    let search = asks(run(&phone, &mut files, "look_up", &tea, &[]));

    assert_eq!(search.url().as_str(), "https://api.tavily.com/search");
    assert_eq!(search.host(), "api.tavily.com");
    assert_eq!(search.method(), Method::Post);
    assert_eq!(
        search.headers(),
        [("content-type", "application/json".to_owned())]
    );
    assert_eq!(search.body(), Some(r#"{"query":"tea"}"#));
    assert_eq!(search.account().map(Account::name), Some("Tavily"));

    let found = answered(search, 200, r#"{"answer": "Green tea"}"#);
    let forecast = asks(run(
        &phone,
        &mut files,
        "look_up",
        &tea,
        slice::from_ref(&found),
    ));

    assert_eq!(
        forecast.url().as_str(),
        "https://api.open-meteo.com/v1/forecast?city=London"
    );
    assert_eq!(forecast.method(), Method::Get);
    assert_eq!(forecast.headers(), []);
    assert_eq!(forecast.body(), None);
    assert_eq!(forecast.account(), None);
    assert_eq!(files.writes, 0);

    let both = [found, answered(forecast, 503, "Busy")];
    let done = acted(run(&phone, &mut files, "look_up", &tea, &both));

    assert_eq!(done.answer, json!({"found": 200, "weather": "Busy"}));
    assert_eq!(
        serde_json::to_value(done.screen.unwrap()).unwrap(),
        json!({"items": [{"kind": "text", "text": "Green tea"}]})
    );
    assert_eq!(
        files.documents["apps/lookup.json"],
        json!({"storage": {"asked": "tea", "found": "Green tea"}, "rings": []})
    );
    assert_eq!(files.writes, 2);
}

#[test]
fn a_request_that_failed_throws_its_sentence_which_the_script_catches_or_lets_through() {
    let phone = lookup(
        &json!({"actions": actions(&["careful", "careless"])}),
        &format!(
            "export function careful() {{
                try {{
                    phone.net.fetch({{ url: '{FORECAST}' }});
                }} catch (error) {{
                    return `${{error.name}}: ${{error.message}}`;
                }}
            }}
            export function careless() {{
                return phone.net.fetch({{ url: '{FORECAST}' }});
            }}"
        ),
    );
    let mut files = Files::default();
    let failed = |fetch| Exchange {
        fetch,
        fetched: Err("Its server could not be reached.".to_owned()),
    };
    let careful = asks(run(&phone, &mut files, "careful", &json!({}), &[]));
    let careless = asks(run(&phone, &mut files, "careless", &json!({}), &[]));

    assert_eq!(
        acted(run(
            &phone,
            &mut files,
            "careful",
            &json!({}),
            &[failed(careful)]
        ))
        .answer,
        "Error: Its server could not be reached."
    );
    assert_eq!(
        run(
            &phone,
            &mut files,
            "careless",
            &json!({}),
            &[failed(careless)]
        )
        .unwrap_err()
        .to_string(),
        "Lookup: Its server could not be reached."
    );
}

#[test]
fn a_request_that_breaks_a_rule_is_the_app_failing_saying_what_fetch_takes() {
    // A body longer than input holds is made here, `pad` characters long.
    let phone = lookup(
        &json!({"actions": actions(&["get"])}),
        "export function get({ pad, ...request }) {
            return phone.net.fetch(pad === undefined ? request : { ...request, body: 'x'.repeat(pad) });
        }",
    );
    let takes = "Lookup failed: TypeError: phone.net.fetch takes {url, method, headers, body}: an \
                 https:// url of 2,048 characters at most with no user, password, port or \
                 fragment, a method of GET or POST, headers accept and content-type as text, and \
                 with POST a body of 64 KiB at most";
    let unreached = "Lookup failed: TypeError: phone.net.fetch reaches only the hosts its app's \
                     manifest names in reaches";

    for (request, refusal) in [
        (
            json!({"url": "http://api.open-meteo.com/v1/forecast"}),
            takes,
        ),
        (
            json!({"url": "https://api.open-meteo.com:8443/v1/forecast"}),
            takes,
        ),
        (
            json!({"url": "https://sam:secret@api.open-meteo.com/"}),
            takes,
        ),
        (
            json!({"url": "https://api.open-meteo.com/v1/forecast#today"}),
            takes,
        ),
        (
            json!({"url": format!("{FORECAST}?city={}", "x".repeat(2_048))}),
            takes,
        ),
        (json!({"url": FORECAST, "method": "PUT"}), takes),
        (
            json!({"url": FORECAST, "headers": {"Authorization": "Bearer mine"}}),
            takes,
        ),
        (
            json!({"url": FORECAST, "headers": {"Accept": "text/plain", "accept": "text/html"}}),
            takes,
        ),
        (json!({"url": FORECAST, "headers": {"accept": 1}}), takes),
        (json!({"url": FORECAST, "body": "{}"}), takes),
        (
            json!({"url": FORECAST, "method": "POST", "pad": 64 * 1_024 + 1}),
            takes,
        ),
        (json!({"url": FORECAST, "timeout": 5}), takes),
        (
            json!({"url": "https://api.openai.com/v1/responses"}),
            unreached,
        ),
        (json!({"url": "https://127.0.0.1/"}), unreached),
    ] {
        let mut files = Files::default();

        assert_eq!(
            run(&phone, &mut files, "get", &request, &[])
                .unwrap_err()
                .to_string(),
            refusal,
            "{request}"
        );
        assert_eq!(files.writes, 0);
    }

    let largest = asks(run(
        &phone,
        &mut Files::default(),
        "get",
        &json!({
            "url": "https://API.open-meteo.com:443/v1/forecast",
            "method": "POST",
            "headers": {"ACCEPT": "application/json"},
            "pad": 64 * 1_024,
        }),
        &[],
    ));

    assert_eq!(largest.url().as_str(), FORECAST);
    assert_eq!(
        largest.headers(),
        [("accept", "application/json".to_owned())]
    );
    assert_eq!(largest.body().map(str::len), Some(64 * 1_024));
}

#[test]
fn only_an_action_reaches_the_internet_never_a_screen_a_ring_or_the_making_of_an_app() {
    let offline = "TypeError: phone.net.fetch reaches nothing here: only an action reaches the \
                   internet";
    let fetch = format!("phone.net.fetch({{ url: '{FORECAST}' }});");
    let phone = Phone::new(vec![app(
        &json!({
            "id": "lookup",
            "name": "Lookup",
            "wakes": true,
            "reaches": ["api.open-meteo.com"],
            "actions": actions(&["remind"]),
        }),
        &format!(
            "export function screen() {{
                try {{
                    {fetch}
                    return {{ items: [] }};
                }} catch (error) {{
                    return {{ items: [{{ kind: 'text', text: String(error) }}] }};
                }}
            }}
            export function remind(ring) {{ phone.rings.set(ring); }}
            export function rang() {{
                try {{
                    {fetch}
                }} catch (error) {{
                    phone.storage.set('tried', String(error));
                }}
            }}"
        ),
    )]);
    let mut files = Files::default();

    assert_eq!(
        serde_json::to_value(phone.look(&files, "lookup", "all", &now()).unwrap()).unwrap(),
        json!({"items": [{"kind": "text", "text": offline}]})
    );

    acted(phone.act(
        &mut files,
        "lookup",
        "remind",
        &input(&json!({"id": "tea", "at": 0, "title": "Tea"})),
        &[],
        &now(),
    ));

    let rings = phone.rings(&files).unwrap();

    assert_eq!(phone.told(&mut files, &rings, &now()).unwrap().len(), 0);
    assert_eq!(
        files.documents["apps/lookup.json"]["storage"]["tried"],
        offline
    );

    let made = App::new(&text(
        &manifest(&json!({"reaches": ["api.open-meteo.com"]})),
        &format!("{fetch}\nexport function screen() {{ return {{ items: [] }}; }}"),
    ));

    assert_eq!(
        made.unwrap_err().to_string(),
        format!("the app does not run: it threw {offline}")
    );
}

#[test]
fn a_fifth_request_fails_the_call_whether_or_not_the_script_catches_it() {
    let phone = lookup(
        &json!({"actions": actions(&["five"])}),
        &format!(
            "export function five() {{
                for (let n = 1; n <= 5; n += 1) {{
                    try {{
                        phone.net.fetch({{ url: `{FORECAST}?day=${{n}}` }});
                    }} catch (error) {{
                        phone.storage.set('caught', String(error));
                    }}
                }}
                return 'all five';
            }}"
        ),
    );
    let mut files = Files::default();
    let mut exchanges = Vec::new();
    let failed = loop {
        match run(&phone, &mut files, "five", &json!({}), &exchanges) {
            Ok(Acting::Asks(fetch)) => exchanges.push(answered(fetch, 200, "Sunny")),
            Ok(Acting::Acted(acted)) => panic!("it acted: {}", acted.answer),
            Err(failure) => break failure,
        }
    };

    assert_eq!(exchanges.len(), 4);
    assert_eq!(
        failed.to_string(),
        "Lookup failed: phone.net.fetch was called a fifth time, and an action reaches the \
         internet 4 times at most"
    );
    assert_eq!(files.writes, 0);
}

#[test]
fn a_script_that_tries_to_catch_the_end_of_a_run_keeps_nothing_of_it() {
    let grab = |awaits: &str| {
        format!(
            "{awaits}
            try {{
                phone.net.fetch({{ url: '{FORECAST}' }});
            }} catch (error) {{
                phone.storage.set('caught', String(error));
                return 'caught';
            }} finally {{
                phone.storage.set('finally', true);
            }}
            return 'fetched';"
        )
    };
    let phone = lookup(
        &json!({"actions": actions(&["grab", "grab_later"])}),
        &format!(
            "export function grab() {{ {} }}
            export async function grab_later() {{ {} }}",
            grab(""),
            grab("await null;")
        ),
    );

    for action in ["grab", "grab_later"] {
        let mut files = Files::default();
        let forecast = asks(run(&phone, &mut files, action, &json!({}), &[]));

        assert_eq!(files.writes, 0, "{action}");

        let done = acted(run(
            &phone,
            &mut files,
            action,
            &json!({}),
            &[answered(forecast, 200, "Sunny")],
        ));

        assert_eq!(done.answer, "fetched", "{action}");
        assert_eq!(
            files.documents["apps/lookup.json"],
            json!({"storage": {"finally": true}, "rings": []}),
            "{action}"
        );
    }
}

#[test]
fn a_run_that_asks_for_other_than_it_asked_before_fails_the_call() {
    let phone = lookup(
        &json!({"actions": actions(&["today", "tomorrow"])}),
        &format!(
            "export function today() {{ return phone.net.fetch({{ url: '{FORECAST}?day=0' }}); }}
            export function tomorrow() {{ return phone.net.fetch({{ url: '{FORECAST}?day=1' }}); }}"
        ),
    );
    let mut files = Files::default();
    let today = asks(run(&phone, &mut files, "today", &json!({}), &[]));

    assert_eq!(
        run(
            &phone,
            &mut files,
            "tomorrow",
            &json!({}),
            &[answered(today, 200, "Sunny")]
        )
        .unwrap_err()
        .to_string(),
        "Lookup failed: phone.net.fetch asked for other than it asked before, and an action asks \
         for the same requests each time it runs"
    );
    assert_eq!(files.writes, 0);
}
