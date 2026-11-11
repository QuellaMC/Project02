#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod boa;
mod quickjs;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::time::Duration;

use serde_json::Value;

pub use boa::Boa;
pub use quickjs::QuickJs;

/// How long one evaluation or call may run before the engine stops it.
pub const TIME_LIMIT: Duration = Duration::from_millis(250);

/// An app's script in one engine, reaching only the phone it was given.
#[expect(
    async_fn_in_trait,
    reason = "both engines are single-threaded, so no caller needs the futures to be Send"
)]
pub trait Engine: Sized {
    /// Evaluates `script` once, with `phone` as the only host it reaches.
    ///
    /// # Errors
    ///
    /// Fails when the script throws or runs past [`TIME_LIMIT`].
    async fn load(script: &str, phone: Rc<Phone>) -> Result<Self, AppError>;

    /// Calls the script's function `name` with `input`, awaiting what it
    /// returns.
    ///
    /// # Errors
    ///
    /// Fails when the function throws, its promise is rejected, or it runs
    /// past [`TIME_LIMIT`]; the engine answers the next call either way.
    async fn call(&mut self, name: &str, input: &Value) -> Result<Value, AppError>;
}

/// Why an evaluation or a call gave no value.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    /// The script threw, or the call could not be made; the text says what.
    #[error("{0}")]
    Failed(String),
    /// The script ran past [`TIME_LIMIT`] and was stopped.
    #[error("the app ran past its time limit and was stopped")]
    TimedOut,
}

/// What a web request comes back with: the body, or why there is none.
pub type Answer = Pin<Box<dyn Future<Output = Result<String, String>>>>;

/// What the phone offers an app: its own storage, ringing at a time, and
/// web requests the host makes for it.
pub struct Phone {
    storage: RefCell<BTreeMap<String, Value>>,
    rings: RefCell<Vec<Ring>>,
    web: Box<dyn Fn(String) -> Answer>,
}

/// A ring the app asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ring {
    pub at: String,
    pub label: String,
}

impl Phone {
    /// A phone with empty storage whose web requests `web` answers.
    pub fn new(web: impl Fn(String) -> Answer + 'static) -> Rc<Self> {
        Rc::new(Self {
            storage: RefCell::default(),
            rings: RefCell::default(),
            web: Box::new(web),
        })
    }

    /// The value the app stored under `key`.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<Value> {
        self.storage.borrow().get(key).cloned()
    }

    /// Stores `value` under `key` for the app.
    pub fn set(&self, key: String, value: Value) {
        self.storage.borrow_mut().insert(key, value);
    }

    /// Asks the phone to ring at `at`.
    pub fn ring(&self, at: String, label: String) {
        self.rings.borrow_mut().push(Ring { at, label });
    }

    /// The rings the app has asked for, oldest first.
    #[must_use]
    pub fn rings(&self) -> Vec<Ring> {
        self.rings.borrow().clone()
    }

    /// Makes a web request for the app.
    pub fn fetch(&self, url: String) -> Answer {
        (self.web)(url)
    }
}

impl fmt::Debug for Phone {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Phone")
            .field("storage", &self.storage)
            .field("rings", &self.rings)
            .finish_non_exhaustive()
    }
}
