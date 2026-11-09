//! What closing a thread lets go.

use p02_runtime::Conversation;

use crate::support::{Chat, mira};

/// Closing a thread lets both its leases go, so the thread opens again.
#[tokio::test]
async fn closing_a_thread_lets_it_open_again() {
    let mut chat = Chat::new(&[]);
    let refused = Conversation::open(&chat.world.home, mira()).unwrap_err();

    assert_eq!(refused.code(), "storage_busy");
    assert_eq!(chat.reopen().await, None);
}
