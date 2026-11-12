//! An app's script in QuickJS: a runtime and a context of its own for each
//! call, the language and `phone` all it reaches, and the limits it runs
//! under.

use std::cell::Cell;
use std::fmt;
use std::rc::Rc;
use std::time::{Duration, Instant};

use rquickjs::context::intrinsic::{
    Date, Eval, Json, MapSet, Promise, Proxy, RegExp, TypedArrays, WeakRef,
};
use rquickjs::{Coerced, Context, Ctx, FromJs, Function, Module, Object, Runtime, Value};

use crate::host::Host;

/// How long a call may run, from making its engine to its answer.
const TIME_LIMIT: Duration = Duration::from_secs(1);
/// How much memory a call's engine may hold.
const MEMORY_LIMIT: usize = 16 * 1024 * 1024;
/// How deep a call may reach into its thread's stack.
const STACK_LIMIT: usize = 256 * 1024;

/// The language: QuickJS's base objects and ECMAScript's intrinsics, and
/// none of what it offers beside them (`atob`, `btoa`, `performance` and
/// `DOMException`).
type Language = (
    Date,
    Eval,
    RegExp,
    Json,
    Proxy,
    MapSet,
    TypedArrays,
    Promise,
    WeakRef,
);

/// What a call answered: a JSON value, or why its answer is none.
pub(crate) type Answer = Result<serde_json::Value, String>;

/// Why a call gave no answer.
#[derive(Debug)]
pub(crate) enum Failure {
    /// The script refused, in its own words: the message of a plain
    /// `Error` it threw.
    Refused(String),
    /// What else the script threw, as `String(value)` gives it.
    Threw(String),
    TookTooLong,
    OutOfMemory,
}

/// Why a call stopped short, before it is said as a [`Failure`].
enum Stop {
    /// The engine's error; a value thrown waits in the context.
    Engine(rquickjs::Error),
    /// A promise that did not settle in time, or can never settle.
    Unsettled,
}

impl From<rquickjs::Error> for Stop {
    fn from(error: rquickjs::Error) -> Self {
        Self::Engine(error)
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(words) => write!(formatter, "it threw Error: {words}"),
            Self::Threw(thrown) => write!(formatter, "it threw {thrown}"),
            Self::TookTooLong => formatter.write_str("it took too long and was stopped"),
            Self::OutOfMemory => formatter.write_str("it ran out of memory and was stopped"),
        }
    }
}

/// The names of the functions `script` exports, once it ran.
pub(crate) fn exported_functions(script: &str, host: &Rc<Host>) -> Result<Vec<String>, Failure> {
    run(script, host, |_, exports, _| {
        let mut functions = Vec::new();

        for name in exports.keys::<String>() {
            let name = name?;

            if exports.get::<_, Value<'_>>(name.as_str())?.is_function() {
                functions.push(name);
            }
        }

        Ok(functions)
    })
}

/// What `script`'s exported `function` answers `argument`, its `phone`
/// working on `host`.
pub(crate) fn call(
    script: &str,
    host: &Rc<Host>,
    function: &str,
    argument: &serde_json::Value,
) -> Result<Answer, Failure> {
    run(script, host, |ctx, exports, deadline| {
        let function: Function<'_> = exports.get(function)?;
        let argument = ctx.json_parse(argument.to_string())?;
        let answer = settled(ctx, function.call((argument,))?, deadline)?;

        if answer.is_undefined() {
            return Ok(Ok(serde_json::Value::Null));
        }

        let Some(text) = ctx.json_stringify(answer)? else {
            return Ok(Err("it is not JSON".to_owned()));
        };

        Ok(serde_json::from_str(&text.to_string()?).map_err(|problem| problem.to_string()))
    })
}

/// Makes the runtime and the context of one call, puts `phone` in it,
/// runs `script` and hands `work` its exports, under the limits. A call
/// the time limit stopped anywhere fails, whatever it went on to do.
fn run<T, F>(script: &str, host: &Rc<Host>, work: F) -> Result<T, Failure>
where
    F: for<'js> FnOnce(&Ctx<'js>, &Object<'js>, Instant) -> Result<T, Stop>,
{
    let deadline = Instant::now() + TIME_LIMIT;
    let runtime = Runtime::new().map_err(|_| Failure::OutOfMemory)?;
    let stopped = Rc::new(Cell::new(false));
    let watching = Rc::clone(&stopped);

    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(STACK_LIMIT);
    runtime.set_interrupt_handler(Some(Box::new(move || {
        let past = Instant::now() >= deadline;

        if past {
            watching.set(true);
        }

        past
    })));

    let context = Context::custom::<Language>(&runtime).map_err(|_| Failure::OutOfMemory)?;

    context.with(|ctx| {
        let outcome = (|| {
            host.install(&ctx)?;

            let (module, evaluated) = Module::declare(ctx.clone(), "app.js", script)?.eval()?;

            settled(&ctx, evaluated.into_value(), deadline)?;
            work(&ctx, &module.namespace()?, deadline)
        })();

        match outcome {
            _ if stopped.get() => Err(Failure::TookTooLong),
            Ok(done) => Ok(done),
            Err(stop) => Err(failure(&ctx, stop)),
        }
    })
}

/// `value`, or what it settles to when it is a promise: the jobs it waits
/// on run until it does. One that is not settled by `deadline`, or that
/// nothing is left to settle, stops the call.
fn settled<'js>(ctx: &Ctx<'js>, value: Value<'js>, deadline: Instant) -> Result<Value<'js>, Stop> {
    let Some(promise) = value.as_promise() else {
        return Ok(value);
    };

    loop {
        if let Some(result) = promise.result::<Value<'js>>() {
            return Ok(result?);
        }
        if Instant::now() >= deadline || !ctx.execute_pending_job() {
            return Err(Stop::Unsettled);
        }
    }
}

/// What `stop` says of the call.
fn failure(ctx: &Ctx<'_>, stop: Stop) -> Failure {
    match stop {
        Stop::Engine(rquickjs::Error::Exception) => thrown(ctx, ctx.catch()),
        Stop::Engine(rquickjs::Error::Allocation) => Failure::OutOfMemory,
        Stop::Engine(error) => Failure::Threw(error.to_string()),
        Stop::Unsettled => Failure::TookTooLong,
    }
}

/// What a thrown `value` says. Out of memory, QuickJS throws its own
/// error, or `null` when it has no memory left to make that error.
fn thrown<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> Failure {
    if value.is_null() {
        return Failure::OutOfMemory;
    }
    if let Some(words) = refusal(&value) {
        return Failure::Refused(words);
    }

    match Coerced::<String>::from_js(ctx, value) {
        Ok(Coerced(text)) if text == "InternalError: out of memory" => Failure::OutOfMemory,
        Ok(Coerced(text)) => Failure::Threw(text),
        Err(_) => Failure::Threw("a value that has no text".to_owned()),
    }
}

/// The words of a plain `Error` the script threw, which is how an app
/// refuses; an error of any other name is the script failing.
fn refusal(value: &Value<'_>) -> Option<String> {
    let error = value.as_object().filter(|_| value.is_error())?;
    let name: String = error.get("name").ok()?;
    let words: String = error.get("message").ok()?;

    (name == "Error" && !words.trim().is_empty()).then_some(words)
}
