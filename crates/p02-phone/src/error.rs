use p02_contracts::{InputContractError, StoreError, ToolInputRejection};
use p02_shared::{BoundJsonError, Identifier};

/// Why an app's two files are not an app: the first rule they break.
#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    #[error("app.json is not an app manifest: {0}")]
    NotAManifest(serde_json::Error),
    #[error("app.json format must be \"project02.app.v1\"")]
    Format,
    #[error("app.json name must not be blank")]
    Name,
    #[error("app.json summary must be one line that is not blank")]
    Summary,
    #[error("app.json views must hold one view at least")]
    NoViews,
    #[error("app.json names the view \"{0}\" more than once")]
    DuplicateView(Identifier),
    #[error("app.json opensOn \"{0}\" is none of its views")]
    OpensOn(String),
    #[error(
        "app.json action name \"{0}\" is refused: an action is named in lowercase letters, \
         digits and _, beginning with a letter, and never screen or rang"
    )]
    ActionName(String),
    #[error("app.json names the action \"{0}\" more than once")]
    DuplicateAction(String),
    #[error("app.json action \"{action}\" view \"{view}\" is none of its views")]
    ActionView { action: String, view: String },
    #[error("app.json action \"{action}\" input is refused: {problem}")]
    ActionInput {
        action: String,
        problem: InputContractError,
    },
    #[error("{app}'s app.js does not run: {failure}")]
    Script { app: String, failure: String },
    #[error("{app}'s app.js exports no function {function}")]
    Export { app: String, function: String },
}

/// Why a call into the phone gave no answer, said naming the app by its
/// name. The store's own failure stays the store's.
#[derive(Debug, thiserror::Error)]
pub enum PhoneError {
    #[error("there is no app \"{0}\" on the phone")]
    NoApp(String),
    #[error("{app} has no view \"{view}\"")]
    NoView { app: String, view: String },
    #[error("{app} has no action \"{action}\"")]
    NoAction { app: String, action: String },
    #[error("{app} cannot take that: {rejection}")]
    Input {
        app: String,
        rejection: ToolInputRejection,
    },
    /// The app refused, in its own words.
    #[error("{app}: {words}")]
    Refused { app: String, words: String },
    #[error("{app} failed: {thrown}")]
    Threw { app: String, thrown: String },
    #[error("{app} took too long and was stopped")]
    TookTooLong { app: String },
    #[error("{app} ran out of memory and was stopped")]
    OutOfMemory { app: String },
    #[error("{app} answered what the phone does not take: {problem}")]
    Answer { app: String, problem: String },
    #[error("{app} showed a screen the phone does not take: {problem}")]
    Screen { app: String, problem: String },
    #[error("{app} would keep more than the phone holds: {problem}")]
    KeepsTooMuch {
        app: String,
        problem: BoundJsonError,
    },
    #[error(transparent)]
    Store(#[from] StoreError),
}
