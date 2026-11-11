//! The same tiny app run through each engine, for what the phone needs of one.
#![expect(
    clippy::unwrap_used,
    reason = "a test, and the world it builds, fail by panicking"
)]

use std::rc::Rc;
use std::time::{Duration, Instant};

use boa_engine::builtins::promise::PromiseState;
use boa_engine::{Source, js_string};
use p02_engine_trial::{Answer, AppError, Boa, Engine, Phone, QuickJs, Ring, TIME_LIMIT};
use serde_json::{Value, json};

/// The app, and what the test adds to look inside the engine.
const SCRIPT: &str = concat!(
    include_str!("../../app/tiny.js"),
    r#"
function spin() {
  while (true) {}
}

function globals() {
  return Object.getOwnPropertyNames(globalThis).sort();
}

async function load_module(specifier) {
  try {
    await import(specifier);
    return "loaded";
  } catch (error) {
    return String(error);
  }
}
"#
);

/// The globals the script defines, and `phone`, the one the host gives.
const GIVEN: [&str; 7] = [
    "globals",
    "load_module",
    "phone",
    "screen",
    "set_alarm",
    "spin",
    "weather",
];

/// Every global of a full `QuickJS` context, as a script sorts them.
const QUICKJS_GLOBALS: &str = "
    AggregateError Array ArrayBuffer AsyncDisposableStack Atomics BigInt BigInt64Array
    BigUint64Array Boolean DOMException DataView Date DisposableStack Error EvalError
    FinalizationRegistry Float16Array Float32Array Float64Array Function Infinity Int16Array
    Int32Array Int8Array InternalError Iterator JSON Map Math NaN Number Object Promise Proxy
    RangeError ReferenceError Reflect RegExp Set SharedArrayBuffer String SuppressedError
    Symbol SyntaxError TypeError URIError Uint16Array Uint32Array Uint8Array
    Uint8ClampedArray WeakMap WeakRef WeakSet atob btoa decodeURI decodeURIComponent
    encodeURI encodeURIComponent escape eval globalThis isFinite isNaN parseFloat parseInt
    performance queueMicrotask undefined unescape
";

/// Every global of a Boa context without default features, as a script
/// sorts them.
const BOA_GLOBALS: &str = "
    AggregateError Array ArrayBuffer Atomics BigInt BigInt64Array BigUint64Array Boolean
    DataView Date Error EvalError FinalizationRegistry Float32Array Float64Array Function
    Infinity Int16Array Int32Array Int8Array Iterator JSON Map Math NaN Number Object Promise
    Proxy RangeError ReferenceError Reflect RegExp Set SharedArrayBuffer String Symbol
    SyntaxError TypeError TypedArray URIError Uint16Array Uint32Array Uint8Array
    Uint8ClampedArray WeakMap WeakRef WeakSet decodeURI decodeURIComponent encodeURI
    encodeURIComponent eval globalThis isFinite isNaN parseFloat parseInt undefined
";

#[tokio::test]
async fn quickjs_runs_the_app() {
    runs_the_app::<QuickJs>(
        QUICKJS_GLOBALS,
        "ReferenceError: could not load module 'app/tiny.js'",
    )
    .await;
}

#[tokio::test]
async fn boa_runs_the_app() {
    runs_the_app::<Boa>(
        BOA_GLOBALS,
        "TypeError: module resolution is disabled for this context",
    )
    .await;

    // Out of the box, Boa loads modules from the working directory.
    let mut bare = boa_engine::Context::default();
    let loaded = bare
        .eval(Source::from_bytes(
            "import('app/tiny.js').then(() => 'loaded', String)",
        ))
        .unwrap();
    bare.run_jobs().unwrap();
    assert_eq!(
        loaded.as_promise().unwrap().state(),
        PromiseState::Fulfilled(js_string!("loaded").into())
    );
}

/// Runs the app through `E`, whose bare globals are `bare` and which
/// refuses `import()` with `refusal`.
async fn runs_the_app<E: Engine>(bare: &str, refusal: &str) {
    let phone = Phone::new(web);
    let mut app = E::load(SCRIPT, Rc::clone(&phone)).await.unwrap();

    // Actions by name, JSON in and out, state kept in the phone's storage.
    assert_eq!(
        app.call("set_alarm", &json!({"time": "07:30", "label": "Run"}))
            .await,
        Ok(json!({"set": {"time": "07:30", "label": "Run"}, "count": 1}))
    );
    assert_eq!(
        app.call("set_alarm", &json!({"time": "22:00", "label": "Sleep"}))
            .await,
        Ok(json!({"set": {"time": "22:00", "label": "Sleep"}, "count": 2}))
    );
    assert_eq!(
        phone.get("alarms"),
        Some(json!([
            {"time": "07:30", "label": "Run"},
            {"time": "22:00", "label": "Sleep"}
        ]))
    );
    assert_eq!(
        phone.rings(),
        [ring("07:30", "Run"), ring("22:00", "Sleep")]
    );
    let screen = json!({"title": "Alarms", "rows": ["07:30 Run", "22:00 Sleep"]});
    assert_eq!(app.call("screen", &Value::Null).await, Ok(screen.clone()));

    // An asynchronous host function, its promise settled from tokio.
    assert_eq!(
        app.call("weather", &json!({"city": "Lisbon"})).await,
        Ok(json!({"city": "Lisbon", "summary": "Sunny"}))
    );

    // A throw, and a rejection, as text the host can show.
    assert_eq!(
        app.call("set_alarm", &json!({"label": "No time"})).await,
        Err(AppError::Failed(
            "TypeError: set_alarm needs a time like 07:30".to_owned()
        ))
    );
    assert_eq!(
        app.call("weather", &json!({"city": "Atlantis"})).await,
        Err(AppError::Failed(
            "Error: no weather at https://weather.example/today?city=Atlantis".to_owned()
        ))
    );

    // A runaway, stopped by the time limit; the app answers afterwards.
    let started = Instant::now();
    assert_eq!(
        app.call("spin", &Value::Null).await,
        Err(AppError::TimedOut)
    );
    assert!(started.elapsed() >= TIME_LIMIT);
    assert_eq!(app.call("screen", &Value::Null).await, Ok(screen));

    // Nothing reached but what the host gave.
    let names: Vec<String> =
        serde_json::from_value(app.call("globals", &Value::Null).await.unwrap()).unwrap();
    let (given, engine): (Vec<&str>, Vec<&str>) = names
        .iter()
        .map(String::as_str)
        .partition(|name| GIVEN.contains(name));
    assert_eq!(given, GIVEN);
    assert_eq!(engine, bare.split_whitespace().collect::<Vec<_>>());
    assert_eq!(
        app.call("load_module", &json!("app/tiny.js")).await,
        Ok(json!(refusal))
    );
}

/// The host's web: an answer for Lisbon after a real wait on tokio's timer.
fn web(url: String) -> Answer {
    Box::pin(async move {
        tokio::time::sleep(Duration::from_millis(10)).await;
        if url == "https://weather.example/today?city=Lisbon" {
            Ok(r#"{"city": "Lisbon", "today": {"summary": "Sunny", "high": 24}}"#.to_owned())
        } else {
            Err(format!("no weather at {url}"))
        }
    })
}

fn ring(at: &str, label: &str) -> Ring {
    Ring {
        at: at.to_owned(),
        label: label.to_owned(),
    }
}
