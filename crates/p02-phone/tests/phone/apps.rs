//! Apps as their two files make them: refused for the first rule they
//! break, and run reaching nothing but the language and `phone`.

use p02_phone::{App, Phone};
use serde_json::{Value, json};

use crate::support::{Files, actions, app, input, manifest, now};

const SCREEN: &str = "export function screen() { return { items: [] }; }";

/// The globals of a script beside `phone`: the language as QuickJS has it.
const LANGUAGE: &str = "
    AggregateError Array ArrayBuffer AsyncDisposableStack Atomics BigInt BigInt64Array
    BigUint64Array Boolean DataView Date DisposableStack Error EvalError FinalizationRegistry
    Float16Array Float32Array Float64Array Function Infinity Int16Array Int32Array Int8Array
    InternalError Iterator JSON Map Math NaN Number Object Promise Proxy RangeError
    ReferenceError Reflect RegExp Set SharedArrayBuffer String SuppressedError Symbol
    SyntaxError TypeError URIError Uint16Array Uint32Array Uint8Array Uint8ClampedArray WeakMap
    WeakRef WeakSet decodeURI decodeURIComponent encodeURI encodeURIComponent escape eval
    globalThis isFinite isNaN parseFloat parseInt queueMicrotask undefined unescape
";

#[test]
fn a_manifest_that_breaks_a_rule_is_refused_saying_which() {
    let add = actions(&["add"]);
    let action = |fields: Value| {
        let mut action = add[0].clone();

        for (field, value) in fields.as_object().unwrap() {
            action[field] = value.clone();
        }

        manifest(&json!({"actions": [action, actions(&["erase"])[0]]}))
    };
    let named = "is refused: an action is named in lowercase letters, digits and _, beginning \
                 with a letter, and never screen or rang";

    for (manifest, refusal) in [
        (
            "{".to_owned(),
            "app.json is not an app manifest: EOF while parsing an object at line 1 column 1"
                .to_owned(),
        ),
        (
            manifest(&json!({"colour": "red"})),
            "app.json is not an app manifest: unknown field `colour`".to_owned(),
        ),
        (
            manifest(&json!({"summary": null})),
            "app.json is not an app manifest: missing field `summary`".to_owned(),
        ),
        (
            manifest(&json!({"id": "2b"})),
            "app.json is not an app manifest: not an identifier".to_owned(),
        ),
        (
            manifest(&json!({"format": "project02.app.v2"})),
            "app.json format must be \"project02.app.v1\"".to_owned(),
        ),
        (
            manifest(&json!({"name": " "})),
            "app.json name must not be blank".to_owned(),
        ),
        (
            manifest(&json!({"summary": "Two\nlines"})),
            "app.json summary must be one line that is not blank".to_owned(),
        ),
        (
            manifest(&json!({"views": []})),
            "app.json views must hold one view at least".to_owned(),
        ),
        (
            manifest(
                &json!({"views": [{"id": "all", "title": "All"}, {"id": "all", "title": "Again"}]}),
            ),
            "app.json names the view \"all\" more than once".to_owned(),
        ),
        (
            manifest(&json!({"opensOn": "alarms"})),
            "app.json opensOn \"alarms\" is none of its views".to_owned(),
        ),
        (
            action(json!({"name": "Add"})),
            format!("app.json action name \"Add\" {named}"),
        ),
        (
            action(json!({"name": "rang"})),
            format!("app.json action name \"rang\" {named}"),
        ),
        (
            action(json!({"name": "erase"})),
            "app.json names the action \"erase\" more than once".to_owned(),
        ),
        (
            action(json!({"view": "alarms"})),
            "app.json action \"add\" view \"alarms\" is none of its views".to_owned(),
        ),
        (
            action(json!({"input": {"type": "array"}})),
            "app.json action \"add\" input is refused: a tool inputContract must declare root \
             type \"object\""
                .to_owned(),
        ),
    ] {
        let refused = App::new(&manifest, SCREEN).unwrap_err().to_string();

        assert!(refused.starts_with(&refusal), "{refused}");
    }
}

#[test]
fn a_script_that_does_not_run_or_export_its_functions_is_refused_saying_why() {
    let manifest = manifest(&json!({"actions": actions(&["add"])}));

    for (script, refusal) in [
        (
            "export function screen( {",
            "Notes's app.js does not run: it threw SyntaxError: ",
        ),
        (
            "throw new Error('not today');",
            "Notes's app.js does not run: it threw Error: not today",
        ),
        (
            "import { tea } from 'kitchen'; export function screen() {}",
            "Notes's app.js does not run: it threw ReferenceError: could not load module \
             'kitchen'",
        ),
        (
            "phone.storage.set('opened', true);",
            "Notes's app.js does not run: it threw TypeError: phone.storage.set changes \
             nothing here: a screen only reads",
        ),
        (
            "export const screen = 'All';",
            "Notes's app.js exports no function screen",
        ),
        (SCREEN, "Notes's app.js exports no function add"),
    ] {
        let refused = App::new(&manifest, script).unwrap_err().to_string();

        assert!(refused.starts_with(refusal), "{refused}");
    }
}

#[test]
fn a_script_reaches_the_language_and_phone_and_nothing_else() {
    let phone = Phone::new(vec![app(
        &json!({"actions": actions(&["look"])}),
        &format!(
            "{SCREEN}
            export async function look() {{
                return {{
                    globals: Object.getOwnPropertyNames(globalThis).sort(),
                    phone: Object.entries(phone).map(([name, part]) => [name, Object.keys(part)]),
                    imported: await import('./notes.js').then(() => 'loaded', String),
                }};
            }}"
        ),
    )]);
    let mut globals: Vec<&str> = LANGUAGE.split_whitespace().chain(["phone"]).collect();

    globals.sort_unstable();

    assert_eq!(
        phone
            .act(
                &mut Files::default(),
                "notes",
                "look",
                &input(&json!({})),
                &now()
            )
            .unwrap()
            .answer,
        json!({
            "globals": globals,
            "phone": [
                ["storage", ["get", "set", "remove"]],
                ["rings", ["set", "cancel", "list"]],
                ["time", ["now", "local", "next"]],
            ],
            "imported": "ReferenceError: could not load module 'notes.js'",
        })
    );
}
