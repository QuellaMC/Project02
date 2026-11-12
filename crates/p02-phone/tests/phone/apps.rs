//! Apps as their one file makes them: refused for the first rule they
//! break, and run reaching nothing but the language and `phone`.

use p02_phone::{App, Phone};
use serde_json::{Value, json};

use crate::support::{Files, actions, app, input, manifest, now, text, view};

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
#[expect(
    clippy::too_many_lines,
    reason = "a row for each rule a manifest keeps"
)]
fn a_manifest_that_breaks_a_rule_is_refused_saying_which() {
    let notes = |fields: Value| text(&manifest(&fields), SCREEN);
    let add = actions(&["add"]);
    let action = |fields: Value| {
        let mut action = add[0].clone();

        for (field, value) in fields.as_object().unwrap() {
            action[field] = value.clone();
        }

        notes(json!({"actions": [action, actions(&["erase"])[0]]}))
    };
    let named = "is refused: an action is named in lowercase letters, digits and _, beginning \
                 with a letter, and never manifest, screen or rang";

    for (file, refusal) in [
        (
            notes(json!({"colour": "red"})),
            "manifest is not an app manifest: unknown field `colour`".to_owned(),
        ),
        (
            notes(json!({"summary": null})),
            "manifest is not an app manifest: missing field `summary`".to_owned(),
        ),
        (
            notes(json!({"id": "2b"})),
            "manifest is not an app manifest: not an identifier".to_owned(),
        ),
        (
            notes(json!({"version": null})),
            "manifest is not an app manifest: missing field `version`".to_owned(),
        ),
        (
            notes(json!({"wakes": null})),
            "manifest is not an app manifest: missing field `wakes`".to_owned(),
        ),
        (
            notes(json!({"wakes": "yes"})),
            "manifest is not an app manifest: invalid type: string \"yes\", expected a boolean"
                .to_owned(),
        ),
        (
            notes(json!({"format": "project02.app.v2"})),
            "manifest format must be \"project02.app.v1\"".to_owned(),
        ),
        (
            notes(json!({"id": "Notes"})),
            "manifest id must be in lowercase".to_owned(),
        ),
        (
            notes(json!({"name": " "})),
            "manifest name must not be blank".to_owned(),
        ),
        (
            notes(json!({"summary": "Two\nlines"})),
            "manifest summary must be one line that is not blank".to_owned(),
        ),
        (
            notes(json!({"version": "1.0"})),
            "manifest version must be three numbers with dots, such as 1.0.0".to_owned(),
        ),
        (
            notes(json!({"icon": " "})),
            "manifest icon must not be blank".to_owned(),
        ),
        (
            notes(json!({"tint": ""})),
            "manifest tint must not be blank".to_owned(),
        ),
        (
            notes(json!({"views": []})),
            "manifest views must hold one view at least".to_owned(),
        ),
        (
            notes(json!({"views": [view("all", "All"), view("all", "Again")]})),
            "manifest names the view \"all\" more than once".to_owned(),
        ),
        (
            notes(json!({"views": [{"id": "all", "title": "All", "icon": " "}]})),
            "manifest view \"all\" icon must not be blank".to_owned(),
        ),
        (
            notes(json!({"opensOn": "alarms"})),
            "manifest opensOn \"alarms\" is none of its views".to_owned(),
        ),
        (
            action(json!({"name": "Add"})),
            format!("manifest action name \"Add\" {named}"),
        ),
        (
            action(json!({"name": "manifest"})),
            format!("manifest action name \"manifest\" {named}"),
        ),
        (
            action(json!({"name": "erase"})),
            "manifest names the action \"erase\" more than once".to_owned(),
        ),
        (
            action(json!({"did": "Wrote it\ndown"})),
            "manifest action \"add\" did must be one line that is not blank".to_owned(),
        ),
        (
            action(json!({"view": "alarms"})),
            "manifest action \"add\" view \"alarms\" is none of its views".to_owned(),
        ),
        (
            action(json!({"input": {"type": "array"}})),
            "manifest action \"add\" input is refused: a tool inputContract must declare root \
             type \"object\""
                .to_owned(),
        ),
    ] {
        let refused = App::new(&file).unwrap_err().to_string();

        assert!(refused.starts_with(&refusal), "{refused}");
    }
}

#[test]
fn a_script_that_does_not_run_or_export_what_an_app_does_is_refused_saying_why() {
    let manifest = manifest(&json!({"actions": actions(&["add"])}));
    let notes = |script: &str| text(&manifest, script);
    // Notes's manifest, its one view with no icon to draw.
    let unplain = format!(
        "export const manifest = {{...{manifest}, views: [{{id: 'all', title: 'All', icon: \
         undefined}}]}};
        {SCREEN}"
    );

    for (file, refusal) in [
        (
            notes("export function screen( {"),
            "the app does not run: it threw SyntaxError: ",
        ),
        (
            notes("throw new Error('not today');"),
            "the app does not run: it threw Error: not today",
        ),
        (
            notes("import { tea } from 'kitchen'; export function screen() {}"),
            "the app does not run: it threw ReferenceError: could not load module 'kitchen'",
        ),
        (
            notes("phone.storage.set('opened', true);"),
            "the app does not run: it threw TypeError: phone.storage.set changes nothing here: \
             a screen only reads",
        ),
        (SCREEN.to_owned(), "the app exports no manifest"),
        (
            unplain,
            "manifest.views[0].icon is not plain data: it does not survive as JSON",
        ),
        (
            notes("export const screen = 'All';"),
            "Notes exports no function screen",
        ),
        (notes(SCREEN), "Notes exports no function add"),
    ] {
        let refused = App::new(&file).unwrap_err().to_string();

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
                ["time", ["now", "local", "at", "next"]],
            ],
            "imported": "ReferenceError: could not load module 'notes.js'",
        })
    );
}
