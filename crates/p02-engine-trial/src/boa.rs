//! The app in Boa, through `boa_engine`.

use std::cell::RefCell;
use std::fmt;
use std::rc::Rc;

use boa_engine::builtins::promise::PromiseState;
use boa_engine::job::{JobExecutor, SimpleJobExecutor};
use boa_engine::module::IdleModuleLoader;
use boa_engine::object::ObjectInitializer;
use boa_engine::property::Attribute;
use boa_engine::{
    Context, JsArgs, JsError, JsNativeError, JsResult, JsString, JsValue, NativeFunction, Script,
    Source, js_string,
};
use serde_json::Value;

use crate::{AppError, Engine, Phone, TIME_LIMIT};

/// How many of Boa's cycles run between two returns to tokio, which is when
/// the time limit can stop a script.
const BUDGET: u32 = 256;

/// Boa: one context holding the app, replaced by a fresh one when a script
/// runs past the time limit, since the old one is left mid-script.
pub struct Boa {
    context: Context,
    executor: Rc<SimpleJobExecutor>,
    script: String,
    phone: Rc<Phone>,
}

impl Engine for Boa {
    async fn load(script: &str, phone: Rc<Phone>) -> Result<Self, AppError> {
        let executor = Rc::new(SimpleJobExecutor::new());
        let mut context = Context::builder()
            .job_executor(Rc::clone(&executor))
            .module_loader(Rc::new(IdleModuleLoader))
            .build()
            .map_err(|error| AppError::Failed(error.to_string()))?;
        install(&mut context, &phone).map_err(|error| AppError::Failed(error.to_string()))?;
        let mut engine = Self {
            context,
            executor,
            script: script.to_owned(),
            phone,
        };
        engine.run(script).await?;
        Ok(engine)
    }

    async fn call(&mut self, name: &str, input: &Value) -> Result<Value, AppError> {
        // Boa's time limit reaches only a script's evaluation, so a call is a
        // one-line script; `name` is one of the app's own functions.
        let result = self.run(&format!("{name}({input})")).await;
        if result == Err(AppError::TimedOut) {
            let fresh = Self::load(&self.script, Rc::clone(&self.phone)).await?;
            *self = fresh;
        }
        result
    }
}

impl Boa {
    /// Evaluates `source` in the context within the time limit, and hands
    /// back what it settles to as JSON.
    async fn run(&mut self, source: &str) -> Result<Value, AppError> {
        let settled = tokio::time::timeout(
            TIME_LIMIT,
            settle(&mut self.context, &self.executor, source),
        )
        .await
        .map_err(|_elapsed| AppError::TimedOut)?;
        settled
            .and_then(|value| value.to_json(&mut self.context))
            .map(Option::unwrap_or_default)
            .map_err(|error| AppError::Failed(shown(error, &mut self.context)))
    }
}

/// Evaluates `source`, yielding to tokio every [`BUDGET`] cycles, then runs
/// the jobs it queued, the host's futures among them, and settles what it
/// returned.
async fn settle(
    context: &mut Context,
    executor: &Rc<SimpleJobExecutor>,
    source: &str,
) -> JsResult<JsValue> {
    let script = Script::parse(Source::from_bytes(source), None, context)?;
    let value = script.evaluate_async_with_budget(context, BUDGET).await?;
    Rc::clone(executor)
        .run_jobs_async(&RefCell::new(&mut *context))
        .await?;
    match value.as_promise().map(|promise| promise.state()) {
        None => Ok(value),
        Some(PromiseState::Fulfilled(value)) => Ok(value),
        Some(PromiseState::Rejected(reason)) => Err(JsError::from_opaque(reason)),
        Some(PromiseState::Pending) => Err(JsNativeError::error()
            .with_message("the call never finished")
            .into()),
    }
}

/// Puts `phone` in the context as the global `phone`, the one thing the
/// script reaches beyond the language.
fn install(context: &mut Context, phone: &Rc<Phone>) -> JsResult<()> {
    context.insert_data(Rc::clone(phone));
    let storage = ObjectInitializer::new(context)
        .function(NativeFunction::from_fn_ptr(get), js_string!("get"), 1)
        .function(NativeFunction::from_fn_ptr(set), js_string!("set"), 2)
        .build();
    let object = ObjectInitializer::new(context)
        .property(js_string!("storage"), storage, Attribute::all())
        .function(NativeFunction::from_fn_ptr(ring), js_string!("ring"), 2)
        .function(NativeFunction::from_async_fn(fetch), js_string!("fetch"), 1)
        .build();
    context.register_global_property(js_string!("phone"), object, Attribute::all())
}

/// The phone `install` put in the context; host functions reach it here
/// because Boa takes them as plain functions or `Copy` closures.
fn phone(context: &Context) -> Rc<Phone> {
    Rc::clone(
        context
            .get_data::<Rc<Phone>>()
            .expect("install puts the phone in the context"),
    )
}

fn text(value: &JsValue, context: &mut Context) -> JsResult<String> {
    Ok(value.to_string(context)?.to_std_string_escaped())
}

fn get(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let key = text(args.get_or_undefined(0), context)?;
    match phone(context).get(&key) {
        Some(value) => JsValue::from_json(&value, context),
        None => Ok(JsValue::undefined()),
    }
}

fn set(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let key = text(args.get_or_undefined(0), context)?;
    let value = args
        .get_or_undefined(1)
        .to_json(context)?
        .unwrap_or_default();
    phone(context).set(key, value);
    Ok(JsValue::undefined())
}

fn ring(_: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let at = text(args.get_or_undefined(0), context)?;
    let label = text(args.get_or_undefined(1), context)?;
    phone(context).ring(at, label);
    Ok(JsValue::undefined())
}

async fn fetch(
    _: &JsValue,
    args: &[JsValue],
    context: &RefCell<&mut Context>,
) -> JsResult<JsValue> {
    let answer = {
        let context = &mut context.borrow_mut();
        let url = text(args.get_or_undefined(0), context)?;
        phone(context).fetch(url)
    };
    let body = answer
        .await
        .map_err(|message| JsNativeError::error().with_message(message))?;
    Ok(JsString::from(body).into())
}

/// The thrown value as `String(value)` gives it.
fn shown(error: JsError, context: &mut Context) -> String {
    match error.into_opaque(context) {
        Ok(value) => value.to_string(context).map_or_else(
            |error| error.to_string(),
            |text| text.to_std_string_escaped(),
        ),
        Err(error) => error.to_string(),
    }
}

impl fmt::Debug for Boa {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Boa")
            .field("phone", &self.phone)
            .finish_non_exhaustive()
    }
}
