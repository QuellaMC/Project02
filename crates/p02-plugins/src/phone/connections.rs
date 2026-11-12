//! The person's connections to their AI services, as an app on her phone
//! asks a model through them: the seam the daemon hands her phone, as it
//! hands it the App Store's catalog and the internet her apps reach, since
//! the daemon alone reaches those services and holds what signs in to
//! them. An app's question is asked through the connection the person
//! signed that app in with, of the model they chose or the one that
//! connection starts with, with no lease held; nothing of the connection
//! reaches the app.

use std::fmt;
use std::num::NonZeroUsize;
use std::time::Duration;

use async_trait::async_trait;
use p02_contracts::TextCompletionRequest;
use p02_core::SpeakerName;
use p02_phone::{Account, Answer, Question, SignedIn};
use p02_wire::AppConnection;
use tokio_util::sync::CancellationToken;

use super::sign_in::SIGN_IN;
use super::{whom, whose};

/// How long a question waits for its answer, of its own, beside the time
/// the requests of a call share: a model's answer may take a minute.
const QUESTION: Duration = Duration::from_secs(90);

/// The most characters of an answer an app is handed: at four bytes each
/// at most, they keep within a string of the phone's JSON limits, 16 KiB.
const ANSWER_CHARS: NonZeroUsize = NonZeroUsize::new(4_096).expect("4,096 is not zero");

const STOPPED: &str = "The question was stopped before it was answered.";

/// The person's connections to their AI services, as her phone's apps ask
/// through them.
#[async_trait]
pub trait Connections: Send + Sync + fmt::Debug {
    /// The connections of the person's that an app whose account is
    /// `account` signs in with and that are connected now, in the AI Model
    /// page's order.
    async fn connected(&self, account: &'static Account) -> Vec<AppConnection>;

    /// The model's words for `request`, asked through `connection`, by the
    /// id the AI Model page knows it by, one an app whose account is
    /// `account` signs in with, of `model`, or of the one it starts with
    /// when none was chosen; or why there are none.
    async fn ask(
        &self,
        account: &'static Account,
        connection: &str,
        model: Option<&str>,
        request: &TextCompletionRequest,
    ) -> Result<String, Unanswered>;
}

/// Why a question has no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unanswered {
    /// The connection, by the name its page calls it, is not connected
    /// now: nothing was asked.
    NotConnected(String),
    /// Her stop came first.
    Stopped,
    /// The service's sentence, which holds nothing that signs in to it.
    Failed(String),
}

/// What came of `question`, which an app asks: asked through the
/// connection the app is signed in with as `signed_in` says, within its own
/// time and until `cancellation`; or the sentence the app is told instead,
/// naming `person` as her notes do, which says when it is not signed in, or
/// is signed in with a connection no longer connected, and to ask them. Her
/// phone says a sentence an app does not catch after the app's name, so
/// none of these names the app.
pub(super) async fn answered(
    connections: &dyn Connections,
    question: &Question,
    signed_in: Option<&SignedIn>,
    person: Option<&SpeakerName>,
    cancellation: &CancellationToken,
) -> Result<Answer, String> {
    let Some(signed_in) = signed_in else {
        return Err(format!(
            "This app is not signed in on this phone. Ask {} to let you sign in, with {SIGN_IN}.",
            whom(person)
        ));
    };
    let request = TextCompletionRequest {
        instructions: instructions(question),
        input: question.input().to_owned(),
        max_output_chars: ANSWER_CHARS,
    };
    let asked = tokio::time::timeout(
        QUESTION,
        connections.ask(
            question.account(),
            signed_in.connection.as_str(),
            signed_in.model.as_deref(),
            &request,
        ),
    );
    let answered = tokio::select! {
        answered = asked => answered,
        () = cancellation.cancelled() => return Err(STOPPED.to_owned()),
    };

    match answered {
        Ok(Ok(text)) => Ok(Answer {
            text: bounded(text),
        }),
        Ok(Err(Unanswered::NotConnected(connection))) => Err(format!(
            "This app is signed in with {} {connection}, which is no longer connected. Ask {} \
             to connect it again.",
            whose(person),
            whom(person)
        )),
        Ok(Err(Unanswered::Stopped)) => Err(STOPPED.to_owned()),
        Ok(Err(Unanswered::Failed(sentence))) => Err(sentence),
        Err(_elapsed) => Err(format!(
            "{} took too long to answer.",
            question.account().name()
        )),
    }
}

/// How the model is to answer `question`: as its app says, when it says,
/// and within what an app is handed.
fn instructions(question: &Question) -> String {
    let within = format!("Answer in {ANSWER_CHARS} characters at most.");

    match question.instructions() {
        Some(own) => format!("{own}\n\n{within}"),
        None => within,
    }
}

/// `text` as an app is handed it: whole, or, since a service may answer
/// more than it was asked for, cut to what an app is handed, an ellipsis
/// where it was cut.
fn bounded(text: String) -> String {
    if text.chars().count() <= ANSWER_CHARS.get() {
        return text;
    }

    let mut cut: String = text.chars().take(ANSWER_CHARS.get() - 1).collect();

    cut.push('…');
    cut
}
