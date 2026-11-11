//! An app used: an action on its input, all or nothing, under the limits.

use std::sync::Arc;

use p02_contracts::{LeasedFiles, StoreError};
use p02_phone::{Phone, PhoneError, Screen};
use serde_json::{Value, json};

use crate::support::{Files, actions, app, bounded, input, now};

/// Notes, which keeps a list of what she writes down.
fn notes() -> Phone {
    let add = json!({
        "name": "add",
        "description": "Write a note down.",
        "view": "all",
        "input": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": false,
        },
    });

    Phone::new(vec![app(
        &json!({"actions": [add]}),
        "export function screen() {
            const notes = phone.storage.get('notes') ?? [];

            return {
                items: notes.length === 0
                    ? [{ kind: 'text', text: 'No notes' }]
                    : [{ kind: 'list', rows: notes.map((title) => ({ title })) }],
            };
        }

        export async function add({ text }) {
            await null;

            const notes = [...(phone.storage.get('notes') ?? []), text];

            phone.storage.set('notes', notes);
            return { count: notes.length };
        }",
    )])
}

/// The screen an action showed after it, as JSON.
fn shown(screen: &Result<Screen, PhoneError>) -> Value {
    serde_json::to_value(screen.as_ref().unwrap()).unwrap()
}

#[test]
fn an_action_runs_on_its_input_and_what_it_saved_is_there_at_the_next_call_and_in_its_file() {
    let phone = notes();
    let mut files = Files::default();
    let add = |files: &mut Files, text: &str| {
        phone
            .act(
                files,
                "notes",
                "add",
                &input(&json!({"text": text})),
                &now(),
            )
            .unwrap()
    };

    assert_eq!(
        serde_json::to_value(phone.open(&files, "notes", None, &now()).unwrap()).unwrap(),
        json!({"items": [{"kind": "text", "text": "No notes"}]})
    );

    let first = add(&mut files, "milk");

    assert_eq!(first.answer, json!({"count": 1}));
    assert_eq!(
        shown(&first.screen),
        json!({"items": [{"kind": "list", "rows": [{"title": "milk"}]}]})
    );
    assert_eq!(add(&mut files, "eggs").answer, json!({"count": 2}));
    assert_eq!(
        files.documents.keys().collect::<Vec<_>>(),
        ["apps/notes.json"]
    );
    assert_eq!(
        files.documents["apps/notes.json"],
        json!({"storage": {"notes": ["milk", "eggs"]}, "rings": []})
    );
    assert_eq!(files.writes, 2);
}

#[test]
fn input_is_judged_before_the_script_sees_it_and_what_is_not_there_is_refused() {
    let phone = notes();
    let mut files = Files::default();

    for (refused, sentence) in [
        (
            phone
                .act(&mut files, "notes", "add", &input(&json!({})), &now())
                .unwrap_err(),
            "Notes cannot take that: add input missing required field \"text\"",
        ),
        (
            phone
                .act(&mut files, "notes", "erase", &input(&json!({})), &now())
                .unwrap_err(),
            "Notes has no action \"erase\"",
        ),
        (
            phone
                .open(&files, "notes", Some("trash"), &now())
                .unwrap_err(),
            "Notes has no view \"trash\"",
        ),
        (
            phone.open(&files, "clock", None, &now()).unwrap_err(),
            "there is no app \"clock\" on the phone",
        ),
    ] {
        assert_eq!(refused.to_string(), sentence);
    }

    assert_eq!(files.writes, 0);
}

#[test]
fn a_call_that_fails_saves_nothing_and_the_next_call_works() {
    let stopped = "Notes took too long and was stopped";
    let out_of_memory = "Notes ran out of memory and was stopped";
    let failing = [
        (
            "refuses",
            "throw new Error('There is no paper left.');",
            "Notes: There is no paper left.",
        ),
        (
            "throws",
            "throw new TypeError('no paper');",
            "Notes failed: TypeError: no paper",
        ),
        ("spins", "while (true) {}", stopped),
        ("spins_after_await", "await null; while (true) {}", stopped),
        (
            "catches_the_stop",
            "try { while (true) {} } catch { phone.storage.set('caught', true); }",
            stopped,
        ),
        ("never_settles", "return new Promise(() => {});", stopped),
        (
            "fills_memory",
            "const all = []; while (true) all.push({ n: all.length });",
            out_of_memory,
        ),
        (
            "fills_memory_at_once",
            "const all = []; while (true) all.push(new Array(100000).fill(0));",
            out_of_memory,
        ),
        (
            "recurses",
            "const deeper = (n) => deeper(n + 1); deeper(0);",
            "Notes failed: RangeError: Maximum call stack size exceeded",
        ),
        (
            "answers_a_function",
            "return () => 'done';",
            "Notes answered what the phone does not take: it is not JSON",
        ),
        (
            "answers_too_much",
            "return { items: new Array(300).fill(0) };",
            "Notes answered what the phone does not take: answer.items exceeds the JSON \
             container entry limit",
        ),
        (
            "keeps_too_much",
            "phone.storage.set('all', new Array(300).fill(0));",
            "Notes would keep more than the phone holds: phone.storage.all exceeds the JSON \
             container entry limit",
        ),
    ];
    let script = failing.iter().fold(
        "export function screen() { return { items: [] }; }
        export function write() { phone.storage.set('written', true); }"
            .to_owned(),
        |script, (name, body, _)| {
            format!(
                "{script}
                export async function {name}() {{ phone.storage.set('touched', true); {body} }}"
            )
        },
    );
    let names: Vec<&str> = failing.iter().map(|(name, _, _)| *name).collect();
    let phone = Arc::new(Phone::new(vec![app(
        &json!({"actions": actions(&[names.as_slice(), &["write"]].concat())}),
        &script,
    )]));

    for (action, _, sentence) in failing {
        let phone = Arc::clone(&phone);
        let (refused, files) = bounded(move || {
            let mut files = Files::default();
            let refused = phone.act(&mut files, "notes", action, &input(&json!({})), &now());

            phone
                .act(&mut files, "notes", "write", &input(&json!({})), &now())
                .unwrap();
            (refused.unwrap_err().to_string(), files)
        });

        assert_eq!(refused, sentence, "{action}");
        assert_eq!(
            files.documents["apps/notes.json"],
            json!({"storage": {"written": true}, "rings": []}),
            "{action}"
        );
        assert_eq!(files.writes, 1, "{action}");
    }
}

#[test]
fn a_store_that_fails_is_the_stores_failure() {
    #[derive(Debug)]
    struct Unreadable;

    impl LeasedFiles for Unreadable {
        fn read_json(&self, _: &str) -> Result<Option<Value>, StoreError> {
            Err(StoreError::Store("the disk is gone".into()))
        }

        fn read_jsonl(&self, _: &str) -> Result<Vec<Value>, StoreError> {
            unreachable!("the phone keeps no log")
        }

        fn count_jsonl(&self, _: &str) -> Result<u64, StoreError> {
            unreachable!("the phone keeps no log")
        }

        fn write_json(&mut self, _: &str, _: &Value) -> Result<(), StoreError> {
            unreachable!("nothing is written to a store that cannot be read")
        }

        fn append_jsonl(&mut self, _: &str, _: &Value) -> Result<(), StoreError> {
            unreachable!("the phone keeps no log")
        }
    }

    let phone = notes();

    assert!(matches!(
        phone.open(&Unreadable, "notes", None, &now()),
        Err(PhoneError::Store(StoreError::Store(_)))
    ));
    assert!(matches!(
        phone.act(
            &mut Unreadable,
            "notes",
            "add",
            &input(&json!({"text": "milk"})),
            &now()
        ),
        Err(PhoneError::Store(StoreError::Store(_)))
    ));
    assert!(phone.rings(&Unreadable).is_err());
}
