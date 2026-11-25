//! Her translator, for a character whose package names her language: one
//! plain completion of the model she speaks with puts the person's line
//! into her language, or her message into the person's, and its answer
//! comes to the translation, the message as it was, or why none came.

use std::borrow::Cow;
use std::num::NonZeroUsize;

use p02_contracts::{RoleModelAdapter, TextCompletion, TextCompletionRequest};
use p02_core::{BlankTextError, LanguageTag, SpeakerName, VisibleMessageRole, VisibleText};
use p02_role_model::Person;
use p02_runtime::{Said, Translation};
use p02_shared::sentence;

/// The most a translation is asked to hold.
const MAX_OUTPUT_CHARS: NonZeroUsize = NonZeroUsize::new(16_384).expect("16,384 is not zero");

/// How much of a message the translator reads for context.
const CONTEXT_CHARS: usize = 500;

/// Why a translation came to nothing, when the service answered blank.
const BLANK: &str = "the AI service answered with nothing.";

/// Why a translation came to nothing, when her model has no plain
/// completion.
const UNSUPPORTED: &str = "this AI model cannot translate.";

/// What a request calls a person who has chosen no name: the one they go
/// by until then would read as the translator itself.
const UNNAMED: &str = "User";

/// Who a translation is between, as its request names them, and her
/// language as her package writes its tag.
#[derive(Debug)]
pub(crate) struct Between {
    person: String,
    her: SpeakerName,
    language: LanguageTag,
}

impl Between {
    /// Between the person, by the name they go by, `person`, and `her`, by
    /// her display name, who speaks `language`.
    pub(crate) fn new(person: &SpeakerName, her: SpeakerName, language: LanguageTag) -> Self {
        Self {
            person: match Person::of(person) {
                Person::Named(name) => name.to_string(),
                Person::Unnamed => UNNAMED.to_owned(),
            },
            her,
            language,
        }
    }

    /// The person's `line`, after `before`, put into her language by
    /// `model`.
    pub(crate) async fn for_her(
        &self,
        model: &dyn RoleModelAdapter,
        line: &VisibleText,
        before: &[Said<'_>],
    ) -> Translation {
        translation(
            model.complete_text(&self.line_request(line, before)).await,
            line,
        )
    }

    /// Her `message`, after `before`, put by `model` into the language of
    /// the person's newest message as they wrote it, `newest`, or into
    /// English, the app's own, while they never wrote.
    pub(crate) async fn for_person(
        &self,
        model: &dyn RoleModelAdapter,
        message: &VisibleText,
        before: &[Said<'_>],
        newest: Option<&VisibleText>,
    ) -> Translation {
        translation(
            model
                .complete_text(&self.message_request(message, before, newest))
                .await,
            message,
        )
    }

    /// What the person is told of a message of hers that could not be put
    /// into their language, for `reason`.
    pub(crate) fn untranslated(&self, reason: &str) -> String {
        sentence(&format!(
            "A message of {}'s was not translated: {reason}",
            self.her
        ))
    }

    fn line_request(&self, line: &VisibleText, before: &[Said<'_>]) -> TextCompletionRequest {
        let Self {
            person,
            her,
            language,
        } = self;

        self.request(
            &format!(
                "Put {person}'s message into {her}'s language, the one with the language tag \
                 \"{language}\"."
            ),
            self.input(before, None, VisibleMessageRole::User, line),
        )
    }

    fn message_request(
        &self,
        message: &VisibleText,
        before: &[Said<'_>],
        newest: Option<&VisibleText>,
    ) -> TextCompletionRequest {
        let Self { person, her, .. } = self;
        let into = match newest {
            Some(_) => format!(
                "Put {her}'s message into the language {person} writes in, which {person}'s \
                 newest message shows."
            ),
            None => format!("Put {her}'s message into English."),
        };
        let newest =
            newest.map(|newest| format!("{person}'s newest message:\n\n{}", cut(newest.as_str())));

        self.request(
            &into,
            self.input(before, newest, VisibleMessageRole::Character, message),
        )
    }

    /// A request to put a message into another language as `into` says,
    /// the translator reading `input`.
    fn request(&self, into: &str, input: String) -> TextCompletionRequest {
        let Self { person, her, .. } = self;

        TextCompletionRequest {
            instructions: format!(
                "You translate one message in a private conversation between two people, \
                 {person} and {her}. They write in different languages, and each reads the other \
                 through you. Neither of them sees you.\n\n{into}\n\nTranslate all of it and \
                 nothing else: add nothing, leave nothing out, explain nothing, and do not answer \
                 it. Keep its line breaks, its emoji and its tone.\n\nIf the message is already in \
                 that language, give it back unchanged. Answer with the translation alone."
            ),
            input,
            max_output_chars: MAX_OUTPUT_CHARS,
        }
    }

    /// What the translator reads, a part with nothing to say left out: the
    /// conversation `before` the message, each message under the name of
    /// whose it is, then the person's `newest` message, then the message
    /// to translate, whose author is `author`, whole.
    fn input(
        &self,
        before: &[Said<'_>],
        newest: Option<String>,
        author: VisibleMessageRole,
        message: &VisibleText,
    ) -> String {
        let conversation = (!before.is_empty()).then(|| {
            let said: Vec<String> = before
                .iter()
                .map(|said| format!("{}: {}", self.name(said.role), cut(said.text.as_str())))
                .collect();

            format!(
                "The conversation so far, for context only:\n\n{}",
                said.join("\n")
            )
        });
        let translated = format!(
            "The message to translate, from {}:\n\n{message}",
            self.name(author)
        );

        conversation
            .into_iter()
            .chain(newest)
            .chain([translated])
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// What the request calls the author of a message of `role`.
    fn name(&self, role: VisibleMessageRole) -> &str {
        match role {
            VisibleMessageRole::User => &self.person,
            VisibleMessageRole::Character => self.her.as_str(),
        }
    }
}

/// `text` whole while it holds at most [`CONTEXT_CHARS`] characters, else
/// its first [`CONTEXT_CHARS`] and an ellipsis.
fn cut(text: &str) -> Cow<'_, str> {
    match text.char_indices().nth(CONTEXT_CHARS) {
        Some((end, _)) => Cow::Owned(format!("{}…", &text[..end])),
        None => Cow::Borrowed(text),
    }
}

/// What `answer` comes to for the message `written`: made into a message's
/// text, the translation, or the message already in that language when it
/// is what was written; or why none came.
fn translation(answer: TextCompletion, written: &VisibleText) -> Translation {
    match answer {
        TextCompletion::Completed { text, .. } => match VisibleText::normalize(&text) {
            Ok(translated) if translated == *written => Translation::Already,
            Ok(translated) => Translation::Translated(translated),
            Err(BlankTextError) => Translation::Failed(BLANK.to_owned()),
        },
        TextCompletion::Failed { reason } => Translation::Failed(reason),
        TextCompletion::Unsupported => Translation::Failed(UNSUPPORTED.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use p02_contracts::ProviderName;

    use super::*;

    fn name(name: &str) -> SpeakerName {
        SpeakerName::new(name).unwrap()
    }

    fn text(text: &str) -> VisibleText {
        VisibleText::normalize(text).unwrap()
    }

    /// Between Sam and Kana, who speaks Japanese.
    fn between() -> Between {
        Between::new(
            &name("Sam"),
            name("Kana"),
            LanguageTag::parse("ja").unwrap(),
        )
    }

    /// A message of the person's, as written.
    fn theirs(text: &VisibleText) -> Said<'_> {
        Said {
            role: VisibleMessageRole::User,
            text,
        }
    }

    /// A message of hers.
    fn hers(text: &VisibleText) -> Said<'_> {
        Said {
            role: VisibleMessageRole::Character,
            text,
        }
    }

    /// The instructions of a request, putting a message into another
    /// language as `into` says.
    fn instructions(into: &str) -> String {
        [
            "You translate one message in a private conversation between two people, Sam and \
             Kana. They write in different languages, and each reads the other through you. \
             Neither of them sees you.",
            into,
            "Translate all of it and nothing else: add nothing, leave nothing out, explain \
             nothing, and do not answer it. Keep its line breaks, its emoji and its tone.",
            "If the message is already in that language, give it back unchanged. Answer with the \
             translation alone.",
        ]
        .join("\n\n")
    }

    /// A line is asked for in her language by her tag, after the messages
    /// before it, none in a conversation's first; her message in the
    /// language of the person's newest message, which the request quotes,
    /// or in English while they never wrote; each whole, of at most 16,384
    /// characters. Each message is under the name of whose it is, whatever
    /// name it was said under, and a person who has chosen no name is
    /// called User, not the name that would read as the translator itself.
    #[test]
    fn a_request_says_into_which_language_after_what_word_for_word() {
        let (line, answer) = (text("Tea?\nNow?"), text("いただきます。"));
        let before = [theirs(&line), hers(&answer)];
        let first = between().line_request(&line, &[]);
        let answered = between().message_request(&answer, &before, Some(&line));
        let unprompted = between().message_request(&answer, &[], None);
        let unnamed = Between::new(
            &name("You"),
            name("Kana"),
            LanguageTag::parse("ja").unwrap(),
        )
        .message_request(&answer, &before, Some(&line));

        assert_eq!(
            first,
            TextCompletionRequest {
                instructions: instructions(
                    "Put Sam's message into Kana's language, the one with the language tag \
                     \"ja\"."
                ),
                input: "The message to translate, from Sam:\n\nTea?\nNow?".to_owned(),
                max_output_chars: NonZeroUsize::new(16_384).unwrap(),
            }
        );
        assert_eq!(
            answered.instructions,
            instructions(
                "Put Kana's message into the language Sam writes in, which Sam's newest message \
                 shows."
            )
        );
        assert_eq!(
            answered.input,
            "The conversation so far, for context only:\n\nSam: Tea?\nNow?\nKana: \
             いただきます。\n\nSam's newest message:\n\nTea?\nNow?\n\nThe message to translate, \
             from Kana:\n\nいただきます。"
        );
        assert_eq!(
            unprompted.instructions,
            instructions("Put Kana's message into English.")
        );
        assert_eq!(
            unprompted.input,
            "The message to translate, from Kana:\n\nいただきます。"
        );
        assert_eq!(
            unnamed.instructions,
            instructions(
                "Put Kana's message into the language User writes in, which User's newest \
                 message shows."
            )
            .replace("Sam and Kana", "User and Kana")
        );
        assert_eq!(
            unnamed.input,
            "The conversation so far, for context only:\n\nUser: Tea?\nNow?\nKana: \
             いただきます。\n\nUser's newest message:\n\nTea?\nNow?\n\nThe message to translate, \
             from Kana:\n\nいただきます。"
        );
    }

    /// A message of the conversation and the person's newest one are read
    /// for context to their first 500 characters, an ellipsis where one
    /// was cut; the message to translate is given whole.
    #[test]
    fn what_is_read_for_context_is_cut_to_500_characters_and_the_message_is_whole() {
        let (fits, long) = (text(&"茶".repeat(500)), text(&"茶".repeat(501)));
        let before = [theirs(&fits), theirs(&long)];
        let request = between().message_request(&long, &before, Some(&long));
        let kept = format!("{}…", "茶".repeat(500));

        assert_eq!(
            request.input,
            format!(
                "The conversation so far, for context only:\n\nSam: {fits}\nSam: {kept}\n\nSam's \
                 newest message:\n\n{kept}\n\nThe message to translate, from Kana:\n\n{long}"
            )
        );
    }

    /// An answer is made into a message's text: the translation, unless it
    /// is what was written, when the message is in that language already;
    /// a blank answer, a failed request and a model with no plain
    /// completion come to nothing, each saying why, and the person is told
    /// of her message in one sentence.
    #[test]
    fn an_answer_is_the_translation_the_message_already_or_why_none_came() {
        let written = text("お茶？");
        let completed = |text: &str| TextCompletion::Completed {
            text: text.to_owned(),
            provider: ProviderName::Nvidia,
            model: None,
        };

        assert_eq!(
            translation(completed(" Tea?\r\n"), &written),
            Translation::Translated(text("Tea?"))
        );
        assert_eq!(
            translation(completed("お茶？\n"), &written),
            Translation::Already
        );
        assert_eq!(
            translation(completed(" \n"), &written),
            Translation::Failed("the AI service answered with nothing.".to_owned())
        );
        assert_eq!(
            translation(
                TextCompletion::Failed {
                    reason: "NVIDIA provider error: No translations today.".to_owned(),
                },
                &written
            ),
            Translation::Failed("NVIDIA provider error: No translations today.".to_owned())
        );
        assert_eq!(
            translation(TextCompletion::Unsupported, &written),
            Translation::Failed("this AI model cannot translate.".to_owned())
        );
        assert_eq!(
            between().untranslated("this AI model cannot translate."),
            "A message of Kana's was not translated: this AI model cannot translate."
        );
        assert_eq!(
            between().untranslated("NVIDIA provider HTTP 502"),
            "A message of Kana's was not translated: NVIDIA provider HTTP 502."
        );
    }
}
