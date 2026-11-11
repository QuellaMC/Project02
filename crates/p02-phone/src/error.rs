use p02_contracts::{InputContractError, StoreError, ToolInputRejection};
use p02_shared::{BoundJsonError, Identifier};

/// Why an app's one file is not an app: the first rule it breaks.
#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    #[error("the app does not run: {0}")]
    Script(String),
    #[error("the app exports no manifest")]
    NoManifest,
    /// A manifest that does not survive as JSON, by where it stops being
    /// plain data: `manifest.views[0].icon`.
    #[error("{0} is not plain data: it does not survive as JSON")]
    NotPlainData(String),
    #[error("manifest is not an app manifest: {0}")]
    NotAManifest(serde_json::Error),
    #[error("manifest format must be \"project02.app.v1\"")]
    Format,
    #[error("manifest id must be in lowercase")]
    IdCase,
    /// A field that must hold words, by its place in the manifest.
    #[error("manifest {0} must not be blank")]
    Blank(String),
    /// A field that must hold one line of words, by its place in the
    /// manifest.
    #[error("manifest {0} must be one line that is not blank")]
    NotOneLine(String),
    #[error("manifest version must be three numbers with dots, such as 1.0.0")]
    Version,
    #[error("manifest views must hold one view at least")]
    NoViews,
    #[error("manifest names the view \"{0}\" more than once")]
    DuplicateView(Identifier),
    #[error("manifest opensOn \"{0}\" is none of its views")]
    OpensOn(String),
    #[error(
        "manifest action name \"{0}\" is refused: an action is named in lowercase letters, \
         digits and _, beginning with a letter, and never manifest, screen or rang"
    )]
    ActionName(String),
    #[error("manifest names the action \"{0}\" more than once")]
    DuplicateAction(String),
    #[error("manifest action \"{action}\" view \"{view}\" is none of its views")]
    ActionView { action: String, view: String },
    #[error("manifest action \"{action}\" input is refused: {problem}")]
    ActionInput {
        action: String,
        problem: InputContractError,
    },
    #[error("{app} exports no function {function}")]
    Export { app: String, function: String },
}

/// Why a call into the phone gave no answer, said naming the app by its
/// name. The store's own failure stays the store's.
#[derive(Debug, thiserror::Error)]
pub enum PhoneError {
    #[error("there is no app \"{0}\" on the phone")]
    NoApp(String),
    /// An app installed on the phone whose file is gone, or no longer
    /// makes it, in a few words.
    #[error("{app} cannot run: {why}")]
    CannotRun { app: String, why: String },
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
    /// A text to install that makes no app, in the words of the first
    /// rule it breaks.
    #[error("{0}")]
    NotAnApp(String),
    /// An app to install whose id is that of one the phone comes with, by
    /// that one's name.
    #[error("the phone comes with an app of the same id, {0}")]
    IdTaken(String),
    /// An app the phone comes with, by its name.
    #[error("{0} comes with the phone and cannot be removed")]
    ComesWithPhone(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}
