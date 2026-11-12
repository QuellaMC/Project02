//! An app asking a model: `phone.ai.ask` in an action of an app whose
//! manifest names a connection of the person's, the question handed to its
//! caller as a request is, in the order the action asks them.

use std::slice;

use p02_phone::{Acting, Answer, Ask, Exchange, Fetched, Phone, PhoneError, Question};
use serde_json::{Value, json};

use crate::support::{Files, actions, app, input, now};

/// Advice, which reaches Open-Meteo's host and asks a model through the
/// person's ChatGPT, with these `fields` beside them and `script` beside a
/// screen that shows its last advice.
fn advice(fields: &Value, script: &str) -> Phone {
    let mut manifest = json!({
        "id": "advice",
        "name": "Advice",
        "reaches": ["api.open-meteo.com"],
        "account": "chatgpt",
    });

    for (field, value) in fields.as_object().unwrap() {
        manifest[field] = value.clone();
    }

    Phone::new(vec![app(
        &manifest,
        &format!(
            "export function screen() {{
                return {{ items: [{{ kind: 'text', text: phone.storage.get('advice') ?? 'No Advice' }}] }};
            }}
            {script}"
        ),
    )])
}

/// What Advice's `action` came to on `given`, after `exchanges`.
fn run(
    phone: &Phone,
    files: &mut Files,
    action: &str,
    given: &Value,
    exchanges: &[Exchange],
) -> Result<Acting, PhoneError> {
    phone.act(files, "advice", action, &input(given), exchanges, &now())
}

/// The question Advice's `ask` asks of its host on `given`.
fn asked(phone: &Phone, given: &Value) -> Question {
    match run(phone, &mut Files::default(), "ask", given, &[]).unwrap() {
        Acting::Asks(Ask::Question(question)) => question,
        acting => panic!("it did not ask its question: {acting:?}"),
    }
}

#[test]
fn an_action_asks_its_request_then_its_question_and_keeps_what_it_did_once_both_are_answered() {
    let phone = advice(
        &json!({"actions": actions(&["dress"])}),
        "export function dress({ city }) {
            const forecast = phone.net.fetch({ url: `https://api.open-meteo.com/v1/forecast?city=${city}` });
            const answer = phone.ai.ask({
                instructions: 'Answer in one short sentence.',
                input: `The forecast in ${city}: ${forecast.body}. What should I wear?`,
            });

            phone.storage.set('advice', answer.text);
            return answer;
        }",
    );
    let mut files = Files::default();
    let london = json!({"city": "London"});
    let Acting::Asks(Ask::Fetch(forecast)) =
        run(&phone, &mut files, "dress", &london, &[]).unwrap()
    else {
        panic!("it did not ask for the forecast first");
    };
    let fetched = Exchange::Fetch {
        fetch: forecast,
        fetched: Ok(Fetched {
            status: 200,
            body: "4°C and rain".to_owned(),
        }),
    };
    let Acting::Asks(Ask::Question(question)) = run(
        &phone,
        &mut files,
        "dress",
        &london,
        slice::from_ref(&fetched),
    )
    .unwrap() else {
        panic!("it did not ask its question once it had the forecast");
    };

    assert_eq!(
        question.instructions(),
        Some("Answer in one short sentence.")
    );
    assert_eq!(
        question.input(),
        "The forecast in London: 4°C and rain. What should I wear?"
    );
    assert_eq!(
        (question.account().id(), question.account().name()),
        ("chatgpt", "ChatGPT")
    );
    assert_eq!(files.writes, 0);

    let wear = "A warm coat and an umbrella.";
    let both = [
        fetched,
        Exchange::Question {
            question,
            answer: Ok(Answer {
                text: wear.to_owned(),
            }),
        },
    ];
    let Acting::Acted(done) = run(&phone, &mut files, "dress", &london, &both).unwrap() else {
        panic!("it did not act on both answers");
    };

    assert_eq!(done.answer, json!({"text": wear}));
    assert_eq!(
        serde_json::to_value(done.screen.unwrap()).unwrap(),
        json!({"items": [{"kind": "text", "text": wear}]})
    );
    assert_eq!(
        files.documents["apps/advice.json"],
        json!({"storage": {"advice": wear}, "rings": []})
    );
    assert_eq!(files.writes, 2);
}

#[test]
fn a_question_that_breaks_a_rule_or_has_no_connection_is_the_app_failing_saying_why() {
    // Texts longer than input holds are made here, `pad` characters long.
    let script = "export function ask({ input_pad, instructions_pad, ...question }) {
        return phone.ai.ask({
            ...question,
            ...(input_pad === undefined ? {} : { input: 'x'.repeat(input_pad) }),
            ...(instructions_pad === undefined ? {} : { instructions: 'x'.repeat(instructions_pad) }),
        });
    }";
    let takes = "Advice failed: TypeError: phone.ai.ask takes {instructions, input}: input, the \
                 question, as text that is not blank, and, if it has them, instructions on how \
                 to answer, as text, each of 64 KiB at most";
    let unconnected = "Advice failed: TypeError: phone.ai.ask asks nothing for this app: an app \
                       asks a model only through a connection of the person's that its manifest \
                       names as its account, chatgpt";
    let most = 64 * 1_024;
    let connected = advice(&json!({"actions": actions(&["ask"])}), script);
    let unconnected_apps = [
        advice(
            &json!({"account": null, "actions": actions(&["ask"])}),
            script,
        ),
        advice(
            &json!({
                "reaches": ["api.open-meteo.com", "api.tavily.com"],
                "account": "tavily",
                "actions": actions(&["ask"]),
            }),
            script,
        ),
    ];
    let rain = || json!({"input": "Will it rain?"});

    for (phone, question, refusal) in [
        (&connected, json!({}), takes),
        (&connected, json!({"input": " \n "}), takes),
        (&connected, json!({"input": 7}), takes),
        (
            &connected,
            json!({"input": "Will it rain?", "instructions": ["Be brief."]}),
            takes,
        ),
        (
            &connected,
            json!({"input": "Will it rain?", "model": "gpt-6"}),
            takes,
        ),
        (&connected, json!({"input_pad": most + 1}), takes),
        (
            &connected,
            json!({"input": "Will it rain?", "instructions_pad": most + 1}),
            takes,
        ),
        (&unconnected_apps[0], rain(), unconnected),
        (&unconnected_apps[1], rain(), unconnected),
    ] {
        let mut files = Files::default();

        assert_eq!(
            run(phone, &mut files, "ask", &question, &[])
                .unwrap_err()
                .to_string(),
            refusal,
            "{question}"
        );
        assert_eq!(files.writes, 0);
    }

    let largest = asked(
        &connected,
        &json!({"input_pad": most, "instructions_pad": most}),
    );
    let plain = asked(&connected, &rain());

    assert_eq!(
        (largest.input().len(), largest.instructions().map(str::len)),
        (most, Some(most))
    );
    assert_eq!(
        (plain.input(), plain.instructions()),
        ("Will it rain?", None)
    );
}
