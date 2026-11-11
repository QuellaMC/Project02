//! The `phone` a script reaches, the one thing it has beside the language:
//! its own app's storage and rings, and the time, all from the call it
//! runs in.

use std::cell::RefCell;
use std::rc::Rc;

use jiff::civil::Time;
use jiff::tz::TimeZone;
use p02_core::Timestamp;
use rquickjs::function::Rest;
use rquickjs::{Ctx, Exception, Function, Object, Value};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::data::{Kept, Ring};
use crate::time::{self, Now};

const GET: &str = "phone.storage.get takes a key, which is text";
const SET: &str = "phone.storage.set takes a key, which is text, and a value JSON can hold";
const REMOVE: &str = "phone.storage.remove takes a key, which is text";
const SET_RING: &str = "phone.rings.set takes {id, at, title, body}: an id that is not blank, \
                        at in whole milliseconds since the epoch, a title of one line that is \
                        not blank, of 40 characters at most, and, if it has one, a body of one \
                        line of 120 characters at most";
/// What a ring's title holds: what a notification's title shows.
const TITLE_LIMIT: usize = 40;
/// What a ring's body holds: a line or two of a notification.
const BODY_LIMIT: usize = 120;
const CANCEL_RING: &str = "phone.rings.cancel takes the id of a ring, which is text";
const LOCAL: &str = "phone.time.local takes a time in whole milliseconds since the epoch and \
                     the IANA name of a time zone, both optional";
const NEXT: &str = "phone.time.next takes {hour, minute, weekdays}: an hour from 0 to 23, a \
                    minute from 0 to 59 and, if it has them, weekdays, a list of days from 1 \
                    (Monday) to 7 (Sunday)";

/// Whether a call may change what its app keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    ReadOnly,
    ReadWrite,
}

/// What one call's `phone` works on: a copy of what its app keeps, which
/// the call's caller saves or drops, the moment of the call, and whether
/// the call may change the copy.
#[derive(Debug)]
pub(crate) struct Host {
    kept: RefCell<Kept>,
    now: Now,
    access: Access,
}

/// A function of `phone`, given the arguments it was called with.
type Method = for<'js> fn(&Host, &Ctx<'js>, &[Value<'js>]) -> rquickjs::Result<Value<'js>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RingArgument {
    id: String,
    at: i64,
    title: String,
    body: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NextArgument {
    hour: i8,
    minute: i8,
    weekdays: Option<Vec<i8>>,
}

impl Host {
    pub(crate) fn new(kept: Kept, now: Now, access: Access) -> Rc<Self> {
        Rc::new(Self {
            kept: RefCell::new(kept),
            now,
            access,
        })
    }

    /// What the call leaves its app keeping.
    pub(crate) fn kept(&self) -> Kept {
        self.kept.borrow().clone()
    }

    /// Puts `phone` among the context's globals.
    pub(crate) fn install(self: &Rc<Self>, ctx: &Ctx<'_>) -> rquickjs::Result<()> {
        let phone = Object::new(ctx.clone())?;

        phone.set(
            "storage",
            self.object(
                ctx,
                &[
                    ("get", Self::get),
                    ("set", Self::set),
                    ("remove", Self::remove),
                ],
            )?,
        )?;
        phone.set(
            "rings",
            self.object(
                ctx,
                &[
                    ("set", Self::set_ring),
                    ("cancel", Self::cancel_ring),
                    ("list", Self::list_rings),
                ],
            )?,
        )?;
        phone.set(
            "time",
            self.object(
                ctx,
                &[
                    ("now", Self::now),
                    ("local", Self::local),
                    ("next", Self::next),
                ],
            )?,
        )?;
        ctx.globals().set("phone", phone)
    }

    /// An object whose functions are `methods` of this host.
    fn object<'js>(
        self: &Rc<Self>,
        ctx: &Ctx<'js>,
        methods: &[(&str, Method)],
    ) -> rquickjs::Result<Object<'js>> {
        let object = Object::new(ctx.clone())?;

        for &(name, method) in methods {
            let host = Rc::clone(self);
            let function = Function::new(
                ctx.clone(),
                move |ctx: Ctx<'js>, arguments: Rest<Value<'js>>| method(&host, &ctx, &arguments.0),
            )?;

            object.set(name, function)?;
        }

        Ok(object)
    }

    fn get<'js>(&self, ctx: &Ctx<'js>, arguments: &[Value<'js>]) -> rquickjs::Result<Value<'js>> {
        let key: String = argument(ctx, arguments.first(), GET)?;
        let value = self.kept.borrow().storage.get(&key).cloned();

        to_script(ctx, &value)
    }

    fn set<'js>(&self, ctx: &Ctx<'js>, arguments: &[Value<'js>]) -> rquickjs::Result<Value<'js>> {
        self.writes(ctx, "phone.storage.set")?;

        let key: String = argument(ctx, arguments.first(), SET)?;
        let value: serde_json::Value = argument(ctx, arguments.get(1), SET)?;

        self.kept.borrow_mut().storage.insert(key, value);
        Ok(Value::new_undefined(ctx.clone()))
    }

    fn remove<'js>(
        &self,
        ctx: &Ctx<'js>,
        arguments: &[Value<'js>],
    ) -> rquickjs::Result<Value<'js>> {
        self.writes(ctx, "phone.storage.remove")?;

        let key: String = argument(ctx, arguments.first(), REMOVE)?;

        self.kept.borrow_mut().storage.remove(&key);
        Ok(Value::new_undefined(ctx.clone()))
    }

    fn set_ring<'js>(
        &self,
        ctx: &Ctx<'js>,
        arguments: &[Value<'js>],
    ) -> rquickjs::Result<Value<'js>> {
        self.writes(ctx, "phone.rings.set")?;

        let RingArgument {
            id,
            at,
            title,
            body,
        } = argument(ctx, arguments.first(), SET_RING)?;
        let at = Timestamp::from_unix_millis(at)
            .filter(|_| {
                !id.trim().is_empty()
                    && !title.trim().is_empty()
                    && one_line(&title, TITLE_LIMIT)
                    && body
                        .as_deref()
                        .is_none_or(|body| one_line(body, BODY_LIMIT))
            })
            .ok_or_else(|| Exception::throw_type(ctx, SET_RING))?;

        self.kept
            .borrow_mut()
            .set_ring(Ring::new(id, at, title, body));
        Ok(Value::new_undefined(ctx.clone()))
    }

    fn cancel_ring<'js>(
        &self,
        ctx: &Ctx<'js>,
        arguments: &[Value<'js>],
    ) -> rquickjs::Result<Value<'js>> {
        self.writes(ctx, "phone.rings.cancel")?;

        let id: String = argument(ctx, arguments.first(), CANCEL_RING)?;

        self.kept.borrow_mut().cancel_ring(&id);
        Ok(Value::new_undefined(ctx.clone()))
    }

    fn list_rings<'js>(&self, ctx: &Ctx<'js>, _: &[Value<'js>]) -> rquickjs::Result<Value<'js>> {
        let rings: Vec<serde_json::Value> =
            self.kept.borrow().rings().iter().map(Ring::shown).collect();

        to_script(ctx, &rings)
    }

    fn now<'js>(&self, ctx: &Ctx<'js>, _: &[Value<'js>]) -> rquickjs::Result<Value<'js>> {
        to_script(ctx, &self.now.millis())
    }

    fn local<'js>(&self, ctx: &Ctx<'js>, arguments: &[Value<'js>]) -> rquickjs::Result<Value<'js>> {
        let at: Option<i64> = argument(ctx, arguments.first(), LOCAL)?;
        let zone: Option<String> = argument(ctx, arguments.get(1), LOCAL)?;
        let at = match at {
            Some(at) => jiff::Timestamp::from_millisecond(at)
                .map_err(|_| Exception::throw_type(ctx, LOCAL))?,
            None => self.now.moment(),
        };
        let zone = match zone {
            Some(name) => TimeZone::get(&name).map_err(|_| {
                Exception::throw_type(
                    ctx,
                    &format!(
                        "phone.time.local knows no time zone \"{name}\": it takes an IANA \
                         name such as \"Europe/London\""
                    ),
                )
            })?,
            None => self.now.zone().clone(),
        };

        to_script(ctx, &time::reading(at, zone))
    }

    fn next<'js>(&self, ctx: &Ctx<'js>, arguments: &[Value<'js>]) -> rquickjs::Result<Value<'js>> {
        let NextArgument {
            hour,
            minute,
            weekdays,
        } = argument(ctx, arguments.first(), NEXT)?;
        let weekdays = weekdays.unwrap_or_else(|| (1..=7).collect());
        let wanted = Time::new(hour, minute, 0, 0)
            .ok()
            .filter(|_| !weekdays.is_empty() && weekdays.iter().all(|day| (1..=7).contains(day)))
            .ok_or_else(|| Exception::throw_type(ctx, NEXT))?;
        let next =
            time::next(self.now.moment(), self.now.zone(), wanted, &weekdays).ok_or_else(|| {
                Exception::throw_range(ctx, "phone.time.next has no such time to give")
            })?;

        to_script(ctx, &next.as_millisecond())
    }

    /// Refuses `function` when the call only reads.
    fn writes(&self, ctx: &Ctx<'_>, function: &str) -> rquickjs::Result<()> {
        match self.access {
            Access::ReadWrite => Ok(()),
            Access::ReadOnly => Err(Exception::throw_type(
                ctx,
                &format!("{function} changes nothing here: a screen only reads"),
            )),
        }
    }
}

/// Whether `text` is one line of `limit` characters at most.
fn one_line(text: &str, limit: usize) -> bool {
    !text.contains(['\n', '\r']) && text.chars().count() <= limit
}

/// The argument as `T` reads it from JSON, an absent or undefined one as
/// `null`; one JSON cannot hold, or `T` does not take, is refused with
/// `takes`, which says what the function takes.
fn argument<'js, T: DeserializeOwned>(
    ctx: &Ctx<'js>,
    value: Option<&Value<'js>>,
    takes: &str,
) -> rquickjs::Result<T> {
    let text = match value {
        Some(value) if !value.is_undefined() => ctx
            .json_stringify(value.clone())?
            .map(|text| text.to_string())
            .transpose()?,
        _ => Some("null".to_owned()),
    };

    text.and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| Exception::throw_type(ctx, takes))
}

/// `value` as the script meets it.
fn to_script<'js>(ctx: &Ctx<'js>, value: &impl Serialize) -> rquickjs::Result<Value<'js>> {
    ctx.json_parse(serde_json::to_string(value).expect("the phone's own values are JSON"))
}
