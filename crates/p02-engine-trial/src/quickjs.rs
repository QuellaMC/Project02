//! The app in `QuickJS`, through `rquickjs`.

use std::cell::Cell;
use std::fmt;
use std::rc::Rc;
use std::time::Instant;

use rquickjs::function::Async;
use rquickjs::promise::MaybePromise;
use rquickjs::{
    AsyncContext, AsyncRuntime, CatchResultExt, CaughtError, Coerced, Ctx, Exception, FromJs,
    Function, Object,
};
use serde_json::Value;

use crate::{AppError, Engine, Phone, TIME_LIMIT};

/// `QuickJS`: one context holding the app, in a runtime whose interrupt
/// handler stops whatever script runs past the deadline.
pub struct QuickJs {
    context: AsyncContext,
    deadline: Rc<Cell<Option<Instant>>>,
}

impl Engine for QuickJs {
    async fn load(script: &str, phone: Rc<Phone>) -> Result<Self, AppError> {
        let runtime = AsyncRuntime::new()?;
        let deadline = Rc::new(Cell::new(None));
        let watched = Rc::clone(&deadline);
        runtime
            .set_interrupt_handler(Some(Box::new(move || {
                watched
                    .get()
                    .is_some_and(|deadline| Instant::now() >= deadline)
            })))
            .await;
        let context = AsyncContext::full(&runtime).await?;
        let engine = Self { context, deadline };
        engine
            .limited(async |ctx| {
                install(&ctx, &phone)?;
                ctx.eval::<(), _>(script)?;
                Ok(None)
            })
            .await?;
        Ok(engine)
    }

    async fn call(&mut self, name: &str, input: &Value) -> Result<Value, AppError> {
        let returned = self
            .limited(async |ctx| {
                let function: Function<'_> = ctx.globals().get(name)?;
                let input = ctx.json_parse(input.to_string())?;
                let returned: MaybePromise<'_> = function.call((input,))?;
                let value: rquickjs::Value<'_> = returned.into_future().await?;
                ctx.json_stringify(value)?
                    .map(|json| json.to_string())
                    .transpose()
            })
            .await?;
        returned.map_or(Ok(Value::Null), |json| {
            serde_json::from_str(&json).map_err(|error| AppError::Failed(error.to_string()))
        })
    }
}

impl QuickJs {
    /// Runs `work` in the context until it ends or the deadline passes,
    /// driving the futures of asynchronous host functions meanwhile.
    async fn limited<F>(&self, work: F) -> Result<Option<String>, AppError>
    where
        F: for<'js> AsyncFnOnce(Ctx<'js>) -> rquickjs::Result<Option<String>>,
    {
        self.deadline.set(Some(Instant::now() + TIME_LIMIT));
        let outcome = self
            .context
            .async_with(async |ctx| {
                let result = work(ctx.clone()).await;
                result.catch(&ctx).map_err(|caught| failure(&ctx, caught))
            })
            .await;
        self.deadline.set(None);
        outcome
    }
}

/// Puts `phone` in the context as the global `phone`, the one thing the
/// script reaches beyond the language.
fn install<'js>(ctx: &Ctx<'js>, phone: &Rc<Phone>) -> rquickjs::Result<()> {
    let storage = Object::new(ctx.clone())?;
    let reader = Rc::clone(phone);
    storage.set(
        "get",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, key: String| match reader.get(&key) {
                Some(value) => ctx.json_parse(value.to_string()),
                None => Ok(rquickjs::Value::new_undefined(ctx)),
            },
        )?,
    )?;
    let writer = Rc::clone(phone);
    storage.set(
        "set",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, key: String, value: rquickjs::Value<'js>| {
                let json = ctx
                    .json_stringify(value)?
                    .map(|json| json.to_string())
                    .transpose()?;
                let value = match json {
                    Some(json) => serde_json::from_str(&json)
                        .map_err(|error| Exception::throw_message(&ctx, &error.to_string()))?,
                    None => Value::Null,
                };
                writer.set(key, value);
                rquickjs::Result::Ok(())
            },
        )?,
    )?;

    let object = Object::new(ctx.clone())?;
    object.set("storage", storage)?;
    let ringer = Rc::clone(phone);
    object.set(
        "ring",
        Function::new(ctx.clone(), move |at: String, label: String| {
            ringer.ring(at, label);
        })?,
    )?;
    let fetcher = Rc::clone(phone);
    object.set(
        "fetch",
        Function::new(
            ctx.clone(),
            Async(move |ctx: Ctx<'js>, url: String| {
                let answer = fetcher.fetch(url);
                async move {
                    answer
                        .await
                        .map_err(|message| Exception::throw_message(&ctx, &message))
                }
            }),
        )?,
    )?;
    ctx.globals().set("phone", object)
}

/// What the host shows for a call that threw: the interrupt handler's
/// uncatchable error is the time limit, anything else its text.
fn failure<'js>(ctx: &Ctx<'js>, caught: CaughtError<'js>) -> AppError {
    match caught {
        CaughtError::Exception(exception) if exception.as_value().is_uncatchable_error() => {
            AppError::TimedOut
        }
        CaughtError::Exception(exception) => AppError::Failed(shown(ctx, exception.into_value())),
        CaughtError::Value(value) => AppError::Failed(shown(ctx, value)),
        CaughtError::Error(error) => error.into(),
    }
}

/// The thrown value as `String(value)` gives it.
fn shown<'js>(ctx: &Ctx<'js>, value: rquickjs::Value<'js>) -> String {
    Coerced::<String>::from_js(ctx, value).map_or_else(|error| error.to_string(), |text| text.0)
}

impl From<rquickjs::Error> for AppError {
    fn from(error: rquickjs::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl fmt::Debug for QuickJs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("QuickJs")
            .field("deadline", &self.deadline)
            .finish_non_exhaustive()
    }
}
