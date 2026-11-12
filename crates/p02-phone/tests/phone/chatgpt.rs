//! ChatGPT, an app of the App Store's catalog: its one file installed on
//! her phone as the store installs it, used through the phone's own calls,
//! each question she asks answered as her phone's caller answers it through
//! a connection of the person's.

use p02_phone::{Acting, Answer, Ask, Exchange, Phone, Question, Source, it_may};
use serde_json::{Value, json};

use crate::support::{Files, at, input, took};

/// ChatGPT as the catalog serves it.
const CHATGPT: &str = include_str!("../../catalog/chatgpt.js");
/// Wednesday 11 November 2026, 12:41 PM in New York.
const NOON: &str = "2026-11-11T17:41:00.000Z";
/// An hour after it.
const LATER: &str = "2026-11-11T18:41:00.000Z";
/// What the model is told of whom it helps and how to answer her.
const INSTRUCTIONS: &str = "You are helping a character think something through. She asks you \
                            a question of her own and will put your answer in her own words, so \
                            answer it clearly and to the point, in plain text without Markdown. \
                            Any questions she asked you before come first, each with your \
                            answer, so that you can follow on from them.";
/// What she asks, and what the model answers, as the design has them.
const WAKE: &str = "What is a gentle way to wake someone who hates mornings?";
const SOFT: &str = "Start soft and give them time. Open with something warm and short, let a \
                    few minutes pass, then offer one small reason to get up, such as coffee or \
                    sunlight.";

fn phone() -> &'static Phone {
    Phone::bundled().unwrap()
}

/// Her phone's files, with ChatGPT installed on it from the catalog.
fn installed() -> Files {
    let mut files = Files::default();

    phone()
        .install(&mut files, CHATGPT, Source::Catalog)
        .unwrap();
    files
}

/// Her question `given` at `moment`, its question to the model answered
/// `answer`, the model's words or the sentence of why there are none: the
/// question it asked, none when it asked none, and what it answered or the
/// sentence it was refused in.
fn ask(
    files: &mut Files,
    given: &str,
    answer: Result<&str, &str>,
    moment: &str,
) -> (Option<Question>, Result<Value, String>) {
    let mut asked = None;
    let mut exchanges = Vec::new();

    loop {
        match phone().act(
            files,
            "chatgpt",
            "ask",
            &input(&json!({"question": given})),
            &exchanges,
            &at(moment),
        ) {
            Ok(Acting::Asks(Ask::Question(question))) => {
                asked = Some(question.clone());
                exchanges.push(Exchange::Question {
                    question,
                    answer: answer
                        .map(|text| Answer {
                            text: text.to_owned(),
                        })
                        .map_err(str::to_owned),
                });
            }
            Ok(Acting::Asks(ask)) => panic!("it asks for {ask:?}"),
            Ok(Acting::Acted(acted)) => return (asked, Ok(acted.answer)),
            Err(refused) => return (asked, Err(refused.to_string())),
        }
    }
}

/// What ChatGPT shows.
fn look(files: &Files) -> Value {
    serde_json::to_value(
        phone()
            .look(files, "chatgpt", "chatgpt", &at(NOON))
            .unwrap(),
    )
    .unwrap()
}

/// The questions of the exchanges it keeps, oldest first.
fn questions(files: &Files) -> Vec<String> {
    files.documents["apps/chatgpt.json"]["storage"]["conversation"]
        .as_array()
        .unwrap()
        .iter()
        .map(|exchange| exchange["question"].as_str().unwrap().to_owned())
        .collect()
}

fn no_questions() -> Value {
    json!({"items": [{"kind": "text", "text": "No Questions"}]})
}

#[test]
fn chatgpt_is_taken_from_its_file_and_asks_a_model_through_a_connection_of_the_persons() {
    let installed = phone()
        .install(&mut Files::default(), CHATGPT, Source::Catalog)
        .unwrap();

    assert_eq!(
        serde_json::to_value(&installed.app).unwrap(),
        json!({
            "id": "chatgpt",
            "name": "ChatGPT",
            "summary": "Ask a stronger model for help",
            "version": "1.0.0",
            "icon": "bulb",
            "tint": "indigo",
            "wakes": false,
            "account": "chatgpt",
            "views": [{"id": "chatgpt", "title": "ChatGPT", "icon": "bulb"}],
            "opensOn": "chatgpt",
            "source": "catalog",
        })
    );
    assert_eq!(
        it_may(&installed.app.asks),
        [
            "Keep its own data",
            "Ask ChatGPT with a connection of yours, once you allow it"
        ]
    );
}

#[test]
fn a_question_is_asked_through_the_persons_connection_and_kept_with_its_answer_as_bubbles() {
    let mut files = installed();

    assert_eq!(look(&files), no_questions());

    // White space at the ends of her question and of the answer goes.
    let (asked, came) = ask(
        &mut files,
        &format!(" {WAKE}\n"),
        Ok(&format!("\n\n{SOFT} ")),
        NOON,
    );
    let asked = asked.unwrap();

    assert_eq!(asked.instructions(), Some(INSTRUCTIONS));
    assert_eq!(asked.input(), format!("Her question: {WAKE}"));
    assert_eq!(asked.account().id(), "chatgpt");
    assert_eq!(came, Ok(json!({"question": WAKE, "answer": SOFT})));
    assert_eq!(
        files.documents["apps/chatgpt.json"],
        json!({"storage": {"conversation": [
            {"question": WAKE, "answer": SOFT},
        ]}, "rings": []})
    );
    assert_eq!(
        look(&files),
        json!({"items": [
            {"kind": "bubble", "from": "her", "text": WAKE},
            {"kind": "bubble", "from": "them", "text": SOFT},
        ]})
    );
}

#[test]
fn a_follow_up_is_asked_after_the_exchanges_before_it() {
    let mut files = installed();
    let again = "And if they still will not get up?";
    let curtains = "Then let the light do it:\nopen the curtains a little.";

    ask(&mut files, WAKE, Ok(SOFT), NOON).1.unwrap();

    let (asked, came) = ask(&mut files, again, Ok(curtains), LATER);

    assert_eq!(
        asked.unwrap().input(),
        format!("Her question: {WAKE}\n\nYour answer: {SOFT}\n\nHer question: {again}")
    );
    assert_eq!(came, Ok(json!({"question": again, "answer": curtains})));
    assert_eq!(
        files.documents["apps/chatgpt.json"]["storage"],
        json!({"conversation": [
            {"question": WAKE, "answer": SOFT},
            {"question": again, "answer": curtains},
        ]})
    );
    // Oldest first, each line of the answer as it was written.
    assert_eq!(
        look(&files),
        json!({"items": [
            {"kind": "bubble", "from": "her", "text": WAKE},
            {"kind": "bubble", "from": "them", "text": SOFT},
            {"kind": "bubble", "from": "her", "text": again},
            {"kind": "bubble", "from": "them", "text": curtains},
        ]})
    );
}

#[test]
fn it_keeps_her_newest_twenty_exchanges_and_fewer_when_their_words_take_more_than_32_kib() {
    let mut files = installed();
    let numbered = |number: usize| format!("Question {number}?");

    for number in 1..=21 {
        ask(
            &mut files,
            &numbered(number),
            Ok(&format!("Answer {number}.")),
            NOON,
        )
        .1
        .unwrap();
    }

    // The twenty-first pushed the first out.
    assert_eq!(
        questions(&files),
        (2..=21).map(numbered).collect::<Vec<_>>()
    );

    // Answers of 4,000 characters of three bytes each, 12,000 bytes: two of
    // them fit within 32 KiB with their questions, and a third would not,
    // so nothing older than the newest two is kept.
    let long = "あ".repeat(4_000);

    for number in 22..=24 {
        ask(&mut files, &numbered(number), Ok(&long), NOON)
            .1
            .unwrap();
    }

    assert_eq!(questions(&files), [numbered(23), numbered(24)]);
    assert_eq!(look(&files)["items"].as_array().unwrap().len(), 4);
}

#[test]
fn a_question_refused_or_that_could_not_be_asked_says_why_and_keeps_nothing() {
    let mut files = installed();

    ask(&mut files, WAKE, Ok(SOFT), NOON).1.unwrap();

    let written = files.writes;
    let shown = look(&files);
    let refused = |rule: &str| {
        format!(
            "ChatGPT cannot take that: ask input field \"question\" is refused: its value {rule}"
        )
    };
    let not_signed_in = "This app is not signed in on this phone. Ask Sam to let you sign in, \
                         with phone.sign_in.";
    let failed = "ChatGPT provider error: The server had an error while processing your request.";
    let says = |sentence: &str| format!("ChatGPT: {sentence}");

    for (given, answer, refusal) in [
        (
            " \n ".to_owned(),
            Ok(SOFT),
            refused(r#"does not match "\S""#),
        ),
        (
            "a".repeat(2_001),
            Ok(SOFT),
            refused("is longer than 2000 characters"),
        ),
        (WAKE.to_owned(), Err(not_signed_in), says(not_signed_in)),
        (WAKE.to_owned(), Err(failed), says(failed)),
        (
            WAKE.to_owned(),
            Ok(" \n "),
            says("It answered nothing. Try asking again."),
        ),
    ] {
        assert_eq!(
            ask(&mut files, &given, answer, LATER).1,
            Err(refusal),
            "{given}"
        );
    }

    assert_eq!(files.writes, written);
    assert_eq!(look(&files), shown);
}

#[test]
fn clear_forgets_the_conversation_and_the_next_question_starts_a_new_one() {
    let mut files = installed();
    let fresh = "What is a good first line for a letter?";

    ask(&mut files, WAKE, Ok(SOFT), NOON).1.unwrap();

    assert_eq!(
        took(
            phone(),
            &mut files,
            "chatgpt",
            "clear",
            &json!({}),
            &at(LATER)
        )
        .unwrap()
        .answer,
        json!({"cleared": true})
    );
    assert_eq!(look(&files), no_questions());

    let (asked, _) = ask(
        &mut files,
        fresh,
        Ok("Start with the reason you are writing."),
        LATER,
    );

    assert_eq!(asked.unwrap().input(), format!("Her question: {fresh}"));
}
