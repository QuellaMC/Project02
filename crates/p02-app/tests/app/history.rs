//! A conversation read back as one scrollback.

use p02_app::HistoryPage;
use serde_json::{Value, json};

use crate::support::{Round, World, line, open, wire};

fn page(before: Option<&str>, limit: Option<&str>) -> HistoryPage {
    HistoryPage {
        before: before.map(str::to_owned),
        limit: limit.map(str::to_owned),
    }
}

fn texts(page: &Value) -> Vec<&str> {
    page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["text"].as_str().unwrap())
        .collect()
}

/// History reads a stopped character's conversation as one scrollback
/// across her segments: newest page first and chronological within it, the
/// cursor walking back to the start, the person's lines with their stamps;
/// a limit that is no number, or a cursor no page handed out, is refused,
/// as is a conversation the home does not hold.
#[tokio::test(start_paused = true)]
async fn history_pages_back_across_her_segments() {
    let world = World::new();

    world.settings(json!({"project02": {"contextWindowTokens": 80}}));

    let daemon = world.daemon(Vec::new()).await;

    daemon.reconcile().await;

    let conversation = open(&daemon).await;

    for n in 1..=4 {
        world.model.script([Round::says(&[&format!("Reply {n}.")])]);
        daemon
            .deliver(line(
                &conversation,
                &format!("Line {n}."),
                &format!("line-{n}"),
            ))
            .await;
    }

    daemon.stop().await;

    let read = |before: Option<&str>, limit: Option<&str>| {
        let daemon = daemon.clone();
        let conversation = conversation.clone();
        let page = page(before, limit);

        async move { wire(&daemon.history(&conversation, page).await) }
    };
    let newest = read(None, Some("3")).await;
    let middle = read(Some("v1:1:5"), Some("3")).await;
    let oldest = read(Some("v1:1:2"), Some("3")).await;

    assert_eq!(texts(&newest), ["Reply 3.", "Line 4.", "Reply 4."]);
    assert_eq!(newest["earlier"], "v1:1:5");
    assert_eq!(
        newest["messages"][1],
        json!({
            "messageId": format!("{conversation}.2:message-1"),
            "role": "user",
            "speakerId": "local-user",
            "speakerName": "You",
            "text": "Line 4.",
            "committedAt": newest["messages"][1]["committedAt"],
            "source": "web",
            "clientMessageId": "line-4",
        })
    );
    assert_eq!(newest["messages"][2]["speakerName"], "Mira");
    assert_eq!(newest["messages"][2].get("source"), None);
    assert_eq!(texts(&middle), ["Line 2.", "Reply 2.", "Line 3."]);
    assert_eq!(middle["earlier"], "v1:1:2");
    assert_eq!(texts(&oldest), ["Line 1.", "Reply 1."]);
    assert_eq!(oldest.get("earlier"), None);
    assert_eq!(texts(&read(None, None).await).len(), 8);

    for (before, limit) in [
        (None, Some("ten")),
        (Some("v1:9:0"), None),
        (Some("v1:1:99"), None),
        (Some("1:5"), None),
    ] {
        assert_eq!(
            read(before, limit).await["reason"],
            "invalid_page",
            "{before:?} {limit:?}"
        );
    }

    for unknown in ["conv_missing", "not a conversation"] {
        assert_eq!(
            wire(&daemon.history(unknown, HistoryPage::default()).await)["reason"],
            "unknown_conversation"
        );
    }
}
