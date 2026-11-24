//! Her inbox as the daemon left it in an earlier build.

use p02_core::Timestamp;

use crate::support::World;

/// A line an earlier build queued says nothing of when it was sent: it is
/// read whole, and counts as sent as it is read, which is as her turn takes
/// it.
#[test]
fn a_line_queued_without_its_time_is_taken_as_sent_when_read() {
    let world = World::new();
    let line = format!(
        r#"{{"conversationId":"{}","source":"web","clientMessageId":"tea","text":"Tea?"}}"#,
        world.conversation.id()
    );

    std::fs::write(world.data.root().join("inbox.jsonl"), line + "\n").unwrap();

    let inbox = world.data.inbox().unwrap();
    let waited = Timestamp::now().unix_millis() - inbox.lines[0].sent_at.unix_millis();

    assert!(inbox.skipped.is_empty());
    assert_eq!(inbox.lines[0].text, "Tea?");
    // Within a minute either way, since a clock may step back between two
    // readings.
    assert!(waited.abs() < 60_000, "{waited} ms");
}
