//! Logs written the way the runtime writes them, generated at random from
//! fixed seeds: each must read back as written, record for record and byte
//! for byte, whatever a crash left after its last line, and a damaged line
//! before that is never read past.

use std::path::PathBuf;

use p02_core::{Conversation, SessionId};
use p02_store::{LogRecord, SessionLog, StorageError};

use crate::support::{Script, World, answer, lines_of};

/// A small generator of its own, so a failing seed is a seed to rerun.
struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);

        let mut mixed = self.0;

        mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        mixed ^ (mixed >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(bound).unwrap()).unwrap()
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }

    /// Text that is hard to spell in JSON and in UTF-8 alike.
    fn sentence(&mut self) -> String {
        const WORDS: [&str; 14] = [
            "tea",
            "rain",
            "keys",
            "Mira",
            "na\u{ef}ve",
            "\u{1f600}",
            "\u{65e5}\u{672c}",
            "\"quoted\"",
            "back\\slash",
            "tab\there",
            "line\u{2028}sep",
            "<b>bold</b>",
            "&amp;",
            "zero\u{200b}width",
        ];
        let words: Vec<&str> = (0..=self.below(6))
            .map(|_| WORDS[self.below(WORDS.len())])
            .collect();

        format!("{}.", words.join(" "))
    }

    fn sentences(&mut self, most: usize) -> Vec<String> {
        (0..=self.below(most)).map(|_| self.sentence()).collect()
    }
}

/// A session of turns of every shape the runtime writes, in random order:
/// replies, tool rounds, refused rounds, refusals, failures, and turns a
/// crash cut short, which the next turn closes; message numbers a failed
/// write spent are skipped.
fn generated_log(seed: u64, session: SessionId) -> Vec<LogRecord> {
    let mut random = Random(seed);
    let mut script = Script::new(session);

    for turn in 0..=random.below(7) {
        let line = random.sentence();
        let client = format!("line-{turn}");

        if random.chance(15) {
            script.skip_message();
        }

        match random.below(7) {
            0 => script.refused_input(" \t\r\n\u{3000}\u{2028} "),
            1 => {
                let mut cut_short = script.turn(&line);

                cut_short.user(&client);

                if random.chance(50) {
                    cut_short
                        .round(Some(answer(&[], &["curious"], None)))
                        .start_calls();
                }
            }
            2 => script
                .turn(&line)
                .user(&client)
                .round(None)
                .rejected_by_its_round(),
            3 => {
                let replies = random.sentences(3);
                let replies: Vec<&str> = replies.iter().map(String::as_str).collect();

                script
                    .turn(&line)
                    .user(&client)
                    .round(Some("I would rather not answer in JSON.".to_owned()))
                    .round(Some(answer(&replies, &[], None)))
                    .replies()
                    .completed();
            }
            4 => {
                let interim = random.sentences(2);
                let interim: Vec<&str> = interim.iter().map(String::as_str).collect();
                let replies = random.sentences(2);
                let replies: Vec<&str> = replies.iter().map(String::as_str).collect();
                let note = random.sentence();
                let after = random.chance(50);
                let mut with_tools = script.turn(&line);

                with_tools
                    .user(&client)
                    .round(Some(answer(&interim, &["curious", "calm"], Some(&note))))
                    .replies()
                    .start_calls()
                    .finish_calls()
                    .round(Some(answer(&replies, &[], None)))
                    .replies()
                    .completed();

                if after {
                    with_tools.after_commit();
                }
            }
            5 => script
                .turn(&line)
                .user(&client)
                .round(Some(answer(&[], &["tired"], None)))
                .rejected_by_its_round(),
            _ => {
                let replies = random.sentences(3);
                let replies: Vec<&str> = replies.iter().map(String::as_str).collect();

                script
                    .turn(&line)
                    .user(&client)
                    .round(Some(answer(&replies, &[], None)))
                    .replies()
                    .completed();
            }
        }
    }

    script.records
}

/// Seed `seed`'s log, written through its writer into a conversation of its
/// own.
fn written(world: &World, seed: u64) -> (SessionLog, PathBuf, Vec<LogRecord>) {
    let conversation: Conversation = world.conversation_named(&format!("seed{seed}"));
    let log = world.log_of(&conversation, 1);
    let records = generated_log(seed, log.session_id().clone());
    let path = world.path_of(log.session_id());
    let mut writer = log.clone().writer().unwrap();

    for record in &records {
        writer.append(record.clone()).unwrap();
    }

    writer.release();
    (log, path, records)
}

#[test]
fn every_generated_log_reads_back_as_written_and_every_line_re_encodes_to_its_own_bytes() {
    let world = World::new();

    for seed in 0..100 {
        let (log, path, records) = written(&world, seed);
        let lines = lines_of(&path);

        assert_eq!(log.read().unwrap().records(), records, "seed {seed}");
        assert_eq!(lines.len(), records.len(), "seed {seed}");

        for line in &lines {
            assert_eq!(
                &LogRecord::from_line(line.as_bytes()).unwrap().to_line(),
                line,
                "seed {seed}"
            );
        }
    }
}

#[test]
fn what_a_crash_left_of_the_last_line_is_dropped_and_the_next_append_cuts_it() {
    let world = World::new();

    for seed in [3, 11, 29, 47] {
        let (log, path, records) = written(&world, seed);
        let whole = std::fs::read(&path).unwrap();
        let last = whole[..whole.len() - 1]
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |at| at + 1);

        for cut in (last..whole.len()).step_by(41).chain([whole.len() - 1]) {
            std::fs::write(&path, &whole[..cut]).unwrap();

            assert_eq!(
                log.read().unwrap().records(),
                &records[..records.len() - 1],
                "seed {seed}, cut at {cut}"
            );
        }

        let mut writer = log.clone().writer().unwrap();

        writer.append(records.last().unwrap().clone()).unwrap();
        writer.release();
        assert_eq!(std::fs::read(&path).unwrap(), whole, "seed {seed}");
    }
}

#[test]
fn a_damaged_committed_line_fails_the_read_naming_its_line() {
    let world = World::new();
    let mut random = Random(5);

    for seed in 100..140 {
        let (log, path, _) = written(&world, seed);
        let lines = lines_of(&path);
        let at = random.below(lines.len());
        let mut damaged = lines.clone();

        damaged[at] = match random.below(3) {
            0 => lines[at][..lines[at].len() / 2].to_owned(),
            1 => r#"{"eventId": "evt_torn"}"#.to_owned(),
            _ => lines[at].replacen("\"kind\":\"", "\"kind\":\"x", 1),
        };
        std::fs::write(&path, damaged.join("\n") + "\n").unwrap();

        match log.read().map(|replay| replay.records().len()) {
            Err(StorageError::MalformedRecord { line, .. }) => {
                assert_eq!(line, at + 1, "seed {seed}");
            }
            other => panic!("seed {seed}: {other:?}"),
        }
    }
}
