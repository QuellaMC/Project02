//! What an action asks its host for that her phone cannot do itself: a
//! request on the internet, by `phone.net.fetch`, or a question to a model,
//! by `phone.ai.ask`. The phone does neither. A run of an action answers
//! each ask from the exchanges of the runs before it, in the order asked.
//! An ask none answers yet ends the run, which keeps nothing; the caller
//! does what it asks, with no lease held, and runs the action again from
//! its start, at the same moment, with what came of it. So the script reads
//! `fetch` and `ask` as calls that answer at once, and an action asks for
//! the same things in the same order on every run.

use std::cell::{Cell, RefCell};

use crate::ai::{Answer, Question};
use crate::asks::Asks;
use crate::net::{Fetch, Fetched};

/// The most an action asks its host for in one call, requests and
/// questions together.
const MOST_ASKS: usize = 4;
/// The most questions an action asks in one call.
const MOST_QUESTIONS: usize = 2;
/// The largest text an action hands its host to send, in bytes: a
/// request's body, and a question's instructions and its input, each.
pub(crate) const TEXT_BYTES: usize = 64 * 1_024;

const THIRD: &str = "phone.ai.ask was called a third time, and an action asks 2 questions at most";

/// What an action asks its host for: a request to make, or a question to
/// ask, each as the phone took it from the script.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ask {
    Fetch(Fetch),
    Question(Question),
}

/// What an action asked and what came of it: the answer, or why there was
/// none, in a sentence its caller gives, which the script's `fetch` or
/// `ask` throws as a plain `Error`.
#[derive(Clone, Debug)]
pub enum Exchange {
    Fetch {
        fetch: Fetch,
        fetched: Result<Fetched, String>,
    },
    Question {
        question: Question,
        answer: Result<Answer, String>,
    },
}

/// What one run of an action asks its host with: what its app asks of her
/// phone, the exchanges of the runs before it, how many times this run
/// asked and how many of those were questions, and how it ended, when it
/// ended at an ask.
#[derive(Debug)]
pub(crate) struct Asking {
    asks: Asks,
    exchanges: Vec<Exchange>,
    asked: Cell<usize>,
    questions: Cell<usize>,
    end: RefCell<Option<End>>,
}

/// How a run of an action ended at an ask, before its answer.
#[derive(Debug)]
pub(crate) enum End {
    /// It asks for what no exchange answers yet.
    Asks(Ask),
    /// It fails the call, in these words: it asked a fifth time, or a
    /// third question, or for other than it asked at that place before.
    Fails(String),
}

impl Ask {
    /// The script's function that asks it.
    fn function(&self) -> &'static str {
        match self {
            Self::Fetch(_) => "phone.net.fetch",
            Self::Question(_) => "phone.ai.ask",
        }
    }
}

impl Exchange {
    /// Whether it is what came of `ask`: what it asked is `ask`.
    fn answers(&self, ask: &Ask) -> bool {
        match (self, ask) {
            (Self::Fetch { fetch, .. }, Ask::Fetch(asked)) => fetch == asked,
            (Self::Question { question, .. }, Ask::Question(asked)) => question == asked,
            _ => false,
        }
    }
}

impl Asking {
    /// A run of an action of the app that `asks` so, answered from
    /// `exchanges`, those of the runs before it.
    pub(crate) fn new(asks: &Asks, exchanges: &[Exchange]) -> Self {
        Self {
            asks: asks.clone(),
            exchanges: exchanges.to_vec(),
            asked: Cell::new(0),
            questions: Cell::new(0),
            end: RefCell::new(None),
        }
    }

    /// What the run's app asks of her phone, which says what it may
    /// request and whether it may ask a question.
    pub(crate) fn asks(&self) -> &Asks {
        &self.asks
    }

    /// The exchange at the place of `ask`, the run's next. None ends the
    /// run, as [`Asking::end`] then says: it asks for `ask`, which no
    /// exchange answers yet, or it fails the call, by a fifth ask, a third
    /// question, or one other than it asked at that place before.
    pub(crate) fn answer(&self, ask: Ask) -> Option<&Exchange> {
        let place = self.asked.get();
        let question = matches!(ask, Ask::Question(_));

        if place == MOST_ASKS {
            self.ends(End::Fails(format!(
                "{} was called for a fifth request or question, and an action asks for 4 at most",
                ask.function()
            )));
            return None;
        }

        if question && self.questions.get() == MOST_QUESTIONS {
            self.ends(End::Fails(THIRD.to_owned()));
            return None;
        }

        self.asked.set(place + 1);
        self.questions
            .set(self.questions.get() + usize::from(question));

        match self.exchanges.get(place) {
            None => {
                self.ends(End::Asks(ask));
                None
            }
            Some(exchange) if !exchange.answers(&ask) => {
                self.ends(End::Fails(format!(
                    "{} asked for other than the action asked at that place before, and an \
                     action asks for the same requests and questions each time it runs",
                    ask.function()
                )));
                None
            }
            Some(exchange) => Some(exchange),
        }
    }

    /// Whether the run ended at an ask.
    pub(crate) fn ended(&self) -> bool {
        self.end.borrow().is_some()
    }

    /// How the run ended at an ask, taken once it is over.
    pub(crate) fn end(&self) -> Option<End> {
        self.end.borrow_mut().take()
    }

    fn ends(&self, end: End) {
        *self.end.borrow_mut() = Some(end);
    }
}
