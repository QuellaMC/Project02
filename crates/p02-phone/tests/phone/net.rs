//! An app asking its host for what her phone cannot do itself:
//! `phone.net.fetch` in an action, and `phone.ai.ask` beside it, answered
//! run by run from the exchanges its caller made, each run all or nothing.

use std::slice;

use p02_phone::{
    Account, Acted, Acting, Answer, App, Ask, Exchange, Fetch, Fetched, Method, Phone, PhoneError,
};
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

fn asked(acting: Result<Acting, PhoneError>) -> Ask {
    match acting.unwrap() {
        Acting::Asks(ask) => ask,
        Acting::Acted(acted) => panic!("it acted: {}", acted.answer),
    }
}

fn asks(acting: Result<Acting, PhoneError>) -> Fetch {
    match asked(acting) {
        Ask::Fetch(fetch) => fetch,
        Ask::Question(question) => panic!("it asks {}", question.input()),
    }
}

fn acted(acting: Result<Acting, PhoneError>) -> Acted {
    match acting.unwrap() {
        Acting::Acted(acted) => acted,
        Acting::Asks(ask) => panic!("it asks for {ask:?}"),
    }
}

/// `fetch` and its answer, of `status` and `body`.
fn answered(fetch: Fetch, status: u16, body: &str) -> Exchange {
    Exchange::Fetch {
        fetch,
        fetched: Ok(Fetched {
            status,
            body: body.to_owned(),
        }),
    }
}

/// `ask` and what came of it: `Sunny` for a request, `Yes.` for a question.
fn answering(ask: Ask) -> Exchange {
    match ask {
        Ask::Fetch(fetch) => answered(fetch, 200, "Sunny"),
        Ask::Question(question) => Exchange::Question {
            question,
            answer: Ok(Answer {
                text: "Yes.".to_owned(),
            }),
        },
    }
}

/// `ask` and why nothing came of it, in its caller's `sentence`.
fn failed(ask: Ask, sentence: &str) -> Exchange {
    match ask {
        Ask::Fetch(fetch) => Exchange::Fetch {
            fetch,
            fetched: Err(sentence.to_owned()),
        },
        Ask::Question(question) => Exchange::Question {
            question,
            answer: Err(sentence.to_owned()),
        },
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
fn what_its_caller_could_not_do_throws_its_sentence_which_the_script_catches_or_lets_through() {
    let phone = lookup(
        &json!({"account": "chatgpt", "actions": actions(&["careful", "careless", "curious"])}),
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
            }}
            export function curious() {{
                try {{
                    phone.ai.ask({{ input: 'Will it rain?' }});
                }} catch (error) {{
                    return `${{error.name}}: ${{error.message}}`;
                }}
            }}"
        ),
    );
    let mut files = Files::default();
    let unreached = "Its server could not be reached.";
    let unanswered = "ChatGPT could not be reached.";
    let careful = asked(run(&phone, &mut files, "careful", &json!({}), &[]));
    let careless = asked(run(&phone, &mut files, "careless", &json!({}), &[]));
    let curious = asked(run(&phone, &mut files, "curious", &json!({}), &[]));

    assert_eq!(
        acted(run(
            &phone,
            &mut files,
            "careful",
            &json!({}),
            &[failed(careful, unreached)]
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
            &[failed(careless, unreached)]
        )
        .unwrap_err()
        .to_string(),
        "Lookup: Its server could not be reached."
    );
    assert_eq!(
        acted(run(
            &phone,
            &mut files,
            "curious",
            &json!({}),
            &[failed(curious, unanswered)]
        ))
        .answer,
        "Error: ChatGPT could not be reached."
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
fn only_an_action_asks_its_host_never_a_screen_a_ring_or_the_making_of_an_app() {
    let offline = "TypeError: phone.net.fetch reaches nothing here: only an action reaches the \
                   internet";
    let unasked = "TypeError: phone.ai.ask asks nothing here: only an action asks a model";
    let fetch = format!("phone.net.fetch({{ url: '{FORECAST}' }});");
    let ask = "phone.ai.ask({ input: 'Will it rain?' });";
    // An app that may reach Open-Meteo and ask ChatGPT, in an action.
    let asks = json!({"reaches": ["api.open-meteo.com"], "account": "chatgpt"});
    let phone = Phone::new(vec![app(
        &json!({
            "id": "lookup",
            "name": "Lookup",
            "wakes": true,
            "reaches": asks["reaches"],
            "account": asks["account"],
            "actions": actions(&["remind"]),
        }),
        &format!(
            "function tried() {{
                return [() => {{ {fetch} }}, () => {{ {ask} }}].map((asks) => {{
                    try {{
                        asks();
                        return 'asked';
                    }} catch (error) {{
                        return String(error);
                    }}
                }});
            }}
            export function screen() {{
                return {{ items: tried().map((text) => ({{ kind: 'text', text }})) }};
            }}
            export function remind(ring) {{ phone.rings.set(ring); }}
            export function rang() {{ phone.storage.set('tried', tried()); }}"
        ),
    )]);
    let mut files = Files::default();

    assert_eq!(
        serde_json::to_value(phone.look(&files, "lookup", "all", &now()).unwrap()).unwrap(),
        json!({"items": [{"kind": "text", "text": offline}, {"kind": "text", "text": unasked}]})
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
        json!([offline, unasked])
    );

    for (asking, refusal) in [(fetch.as_str(), offline), (ask, unasked)] {
        let made = App::new(&text(
            &manifest(&asks),
            &format!("{asking}\nexport function screen() {{ return {{ items: [] }}; }}"),
        ));

        assert_eq!(
            made.unwrap_err().to_string(),
            format!("the app does not run: it threw {refusal}")
        );
    }
}

#[test]
fn a_fifth_ask_or_a_third_question_fails_the_call_whether_or_not_the_script_catches_it() {
    let phone = lookup(
        &json!({"account": "chatgpt", "actions": actions(&["three", "five"])}),
        &format!(
            "function caught(asks) {{
                try {{
                    asks();
                }} catch (error) {{
                    phone.storage.set('caught', String(error));
                }}
            }}
            export function three() {{
                for (let n = 1; n <= 3; n += 1) {{
                    caught(() => phone.ai.ask({{ input: `Will it rain on day ${{n}}?` }}));
                }}
                return 'all three';
            }}
            export function five() {{
                for (let n = 1; n <= 5; n += 1) {{
                    caught(() =>
                        n % 2 === 0
                            ? phone.ai.ask({{ input: `Will it rain on day ${{n}}?` }})
                            : phone.net.fetch({{ url: `{FORECAST}?day=${{n}}` }}),
                    );
                }}
                return 'all five';
            }}"
        ),
    );

    for (action, answered, failure) in [
        (
            "three",
            2,
            "Lookup failed: phone.ai.ask was called a third time, and an action asks 2 questions \
             at most",
        ),
        (
            "five",
            4,
            "Lookup failed: phone.net.fetch was called for a fifth request or question, and an \
             action asks for 4 at most",
        ),
    ] {
        let mut files = Files::default();
        let mut exchanges = Vec::new();
        let failed = loop {
            match run(&phone, &mut files, action, &json!({}), &exchanges) {
                Ok(Acting::Asks(ask)) => exchanges.push(answering(ask)),
                Ok(Acting::Acted(acted)) => panic!("{action} acted: {}", acted.answer),
                Err(failure) => break failure,
            }
        };

        assert_eq!(exchanges.len(), answered, "{action}");
        assert_eq!(failed.to_string(), failure);
        assert_eq!(files.writes, 0, "{action}");
    }
}

#[test]
fn a_script_that_tries_to_catch_the_end_of_a_run_keeps_nothing_of_it() {
    let grab = |awaits: &str, asks: &str| {
        format!(
            "{awaits}
            try {{
                {asks};
            }} catch (error) {{
                phone.storage.set('caught', String(error));
                return 'caught';
            }} finally {{
                phone.storage.set('finally', true);
            }}
            return 'answered';"
        )
    };
    let fetch = format!("phone.net.fetch({{ url: '{FORECAST}' }})");
    let ask = "phone.ai.ask({ input: 'Will it rain?' })";
    let phone = lookup(
        &json!({
            "account": "chatgpt",
            "actions": actions(&["grab", "grab_later", "wonder", "wonder_later"]),
        }),
        &format!(
            "export function grab() {{ {} }}
            export async function grab_later() {{ {} }}
            export function wonder() {{ {} }}
            export async function wonder_later() {{ {} }}",
            grab("", &fetch),
            grab("await null;", &fetch),
            grab("", ask),
            grab("await null;", ask),
        ),
    );

    for action in ["grab", "grab_later", "wonder", "wonder_later"] {
        let mut files = Files::default();
        let ask = asked(run(&phone, &mut files, action, &json!({}), &[]));

        assert_eq!(files.writes, 0, "{action}");

        let done = acted(run(
            &phone,
            &mut files,
            action,
            &json!({}),
            &[answering(ask)],
        ));

        assert_eq!(done.answer, "answered", "{action}");
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
        &json!({"account": "chatgpt", "actions": actions(&["today", "tomorrow", "wonder"])}),
        &format!(
            "export function today() {{ return phone.net.fetch({{ url: '{FORECAST}?day=0' }}); }}
            export function tomorrow() {{ return phone.net.fetch({{ url: '{FORECAST}?day=1' }}); }}
            export function wonder() {{ return phone.ai.ask({{ input: 'Will it rain today?' }}); }}"
        ),
    );
    let mut files = Files::default();
    let today = asks(run(&phone, &mut files, "today", &json!({}), &[]));
    let before = [answered(today, 200, "Sunny")];
    let other = |function: &str| {
        format!(
            "Lookup failed: {function} asked for other than the action asked at that place \
             before, and an action asks for the same requests and questions each time it runs"
        )
    };

    for (action, function) in [("tomorrow", "phone.net.fetch"), ("wonder", "phone.ai.ask")] {
        assert_eq!(
            run(&phone, &mut files, action, &json!({}), &before)
                .unwrap_err()
                .to_string(),
            other(function)
        );
    }

    assert_eq!(files.writes, 0);
}
