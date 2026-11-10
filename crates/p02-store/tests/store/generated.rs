//! Logs written the way the runtime writes them, generated at random from
//! fixed seeds: each must read back as written, record for record and byte
//! for byte.

use std::path::PathBuf;

use p02_contracts::ModelOutput;
use p02_core::SessionId;
use p02_store::{LogRecord, SessionLog};

use crate::support::{Script, World, answer, conversation_named, lines_of};

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
/// replies, tool rounds, refused rounds, refusals, failures, turns a crash
/// cut short, which the next turn closes, and moments of hers that end in a
/// word, in tool work or in a thought; message numbers a failed write spent
/// are skipped.
fn generated_log(seed: u64, session: SessionId) -> Vec<LogRecord> {
    let mut random = Random(seed);
    let mut script = Script::new(session);

    for turn in 0..=random.below(7) {
        let line = random.sentence();
        let client = format!("line-{turn}");

        if random.chance(15) {
            script.skip_message();
        }

        match random.below(8) {
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
                    .round(Some(ModelOutput::default()))
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
            6 => {
                let said = random.sentences(2);
                let said: Vec<&str> = if random.chance(50) {
                    said.iter().map(String::as_str).collect()
                } else {
                    Vec::new()
                };
                let thought = random.sentence();
                let mut moment = script.moment();

                if random.chance(50) {
                    moment
                        .round(Some(answer(&[], &["curious"], None)))
                        .start_calls()
                        .finish_calls();
                }

                moment
                    .round(Some(answer(&said, &[], Some(&thought))))
                    .replies()
                    .completed();
            }
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
    let conversation = conversation_named(&format!("seed{seed}"));
    let mut writer = world.first_segment(&conversation).unwrap();
    let log = world.log_of(&conversation, 1);
    let records = generated_log(seed, log.session_id().clone());
    let path = world.path_of(log.session_id());

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
        let replay = log.read().unwrap();

        assert_eq!(replay.records(), records, "seed {seed}");
        assert!(replay.skipped_lines().is_empty(), "seed {seed}");
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
