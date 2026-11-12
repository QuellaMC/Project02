//! The home's sign-in to a ChatGPT plan, as the daemon keeps it: whole,
//! owner-only, read forgivingly, and never shown.

use p02_shared::error_sentence;
use p02_store::{ChatgptTokens, StorageError};

use crate::support::World;

fn tokens(refresh_token: &str) -> ChatgptTokens {
    ChatgptTokens {
        access_token: "access-secret".to_owned(),
        refresh_token: refresh_token.to_owned(),
        id_token: "id-secret".to_owned(),
        account_id: "acct-sam".to_owned(),
        email: Some("sam@example.com".to_owned()),
        plan: Some("plus".to_owned()),
        expires_at: 2_000_000_000_000,
    }
}

#[test]
fn a_sign_in_is_kept_whole_and_owner_only_read_forgivingly_and_never_shown() {
    let (_directory, home) = World::empty();
    let file = home.root().join("chatgpt-sign-in.json");

    assert_eq!(home.chatgpt_sign_in().unwrap(), None);

    home.keep_chatgpt_sign_in(&tokens("refresh-1")).unwrap();
    home.keep_chatgpt_sign_in(&tokens("refresh-2")).unwrap();
    assert_eq!(home.chatgpt_sign_in().unwrap(), Some(tokens("refresh-2")));
    // Keeping one made the folder a home.
    assert!(home.root().join("schema.json").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let shown = format!("{:?}", tokens("refresh-secret"));

    assert!(shown.contains("sam@example.com"), "{shown}");
    assert!(!shown.contains("secret"), "{shown}");

    // A field this build does not know is passed over, and one it has no
    // value for is left out.
    std::fs::write(
        &file,
        r#"{"accessToken":"a","refreshToken":"r","accountId":"acct","expiresAt":1,"later":true}"#,
    )
    .unwrap();
    assert_eq!(
        home.chatgpt_sign_in().unwrap(),
        Some(ChatgptTokens {
            access_token: "a".to_owned(),
            refresh_token: "r".to_owned(),
            id_token: String::new(),
            account_id: "acct".to_owned(),
            email: None,
            plan: None,
            expires_at: 1,
        })
    );

    for damaged in [
        r#"{"accessToken":"half-secret""#,
        r#"{"expiresAt":"secret"}"#,
    ] {
        std::fs::write(&file, damaged).unwrap();

        let refused = home.chatgpt_sign_in().unwrap_err();

        assert!(matches!(refused, StorageError::MalformedSignIn { .. }));
        assert!(!error_sentence(&refused).contains("secret"), "{refused}");
    }

    home.forget_chatgpt_sign_in().unwrap();
    home.forget_chatgpt_sign_in().unwrap();
    assert_eq!(home.chatgpt_sign_in().unwrap(), None);
}
