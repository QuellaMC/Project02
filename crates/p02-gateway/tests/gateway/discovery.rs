//! The claim on a home and the record clients find the daemon by.

use std::net::TcpListener;
use std::num::NonZeroU16;
use std::path::Path;

use p02_gateway::{Claim, ClaimOutcome, Page, Server};
use p02_shared::{DaemonRecord, read_daemon_record};
use serde_json::json;

use crate::support::{Model, World, daemon, waits, write};

fn claimed(world: &World) -> Claim {
    match Claim::take(&world.home).unwrap() {
        ClaimOutcome::Claimed(claim) => claim,
        ClaimOutcome::Held { .. } => panic!("the home is held"),
    }
}

fn record(home: &Path) -> DaemonRecord {
    read_daemon_record(home).unwrap().unwrap()
}

/// Binds a server for `claim` as the binary does, publishes where it
/// listens, and hands back the port it got and the port it moved from.
async fn serve(world: &World, claim: &mut Claim) -> (NonZeroU16, Option<NonZeroU16>, Server) {
    let model = std::sync::Arc::new(Model::default());
    let daemon = daemon(world, &model, waits(|_| {})).await;
    let server = Server::bind(daemon, claim.token(), claim.port(), Page::built())
        .await
        .unwrap();
    let moved = claim.publish(server.port()).unwrap();

    (server.port(), moved, server)
}

/// A first claim mints a token and binds a free port; while it serves the
/// record holds the protocol, the token, the port and the run, owner-only,
/// and a clean release drops only the run.
#[tokio::test]
async fn a_first_claim_mints_a_token_and_its_record_outlives_the_run() {
    let world = World::new();
    let mut claim = claimed(&world);

    assert_eq!(claim.port(), None);
    assert!(claim.unreadable_record().is_none());

    let token = claim.token().clone();
    let (port, moved, server) = serve(&world, &mut claim).await;
    let serving = record(world.home.root());

    assert_eq!(token.as_str().len(), 43);
    assert_eq!(moved, None);
    assert_eq!(
        serde_json::to_value(&serving).unwrap(),
        json!({
            "protocolVersion": 7,
            "token": token.as_str(),
            "port": port.get(),
            "running": {
                "pid": std::process::id(),
                "startedAt": serving.running.as_ref().unwrap().started_at,
            },
        })
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;

        #[expect(
            clippy::disallowed_methods,
            reason = "a test reads the record's mode as a person would"
        )]
        let mode = std::fs::metadata(world.path("daemon.json"))
            .unwrap()
            .permissions()
            .mode();

        assert_eq!(mode & 0o777, 0o600);
    }

    server.close().await;
    claim.release();
    assert_eq!(
        serde_json::to_value(record(world.home.root())).unwrap(),
        json!({"protocolVersion": 7, "token": token.as_str(), "port": port.get()})
    );
}

/// A later claim on the home answers on the same address: the token and
/// the port the record kept.
#[tokio::test]
async fn a_later_claim_keeps_the_address() {
    let world = World::new();
    let mut first = claimed(&world);
    let (port, _, server) = serve(&world, &mut first).await;
    let token = first.token().clone();

    server.close().await;
    first.release();

    let mut later = claimed(&world);

    assert_eq!(later.token(), &token);
    assert_eq!(later.port(), Some(port));

    let (again, moved, server) = serve(&world, &mut later).await;

    assert_eq!((again, moved), (port, None));
    server.close().await;
    later.release();
}

/// When another program holds the home's port, the server binds a free
/// one, the publish says the port moved, and the record keeps the new one
/// for the next run.
#[tokio::test]
async fn a_port_another_program_holds_moves_the_address() {
    let world = World::new();
    let holder = TcpListener::bind("127.0.0.1:0").unwrap();
    let taken = holder.local_addr().unwrap().port();

    write(
        &world.path("daemon.json"),
        &json!({"protocolVersion": 7, "token": "kept", "port": taken}).to_string(),
    );

    let mut claim = claimed(&world);
    let (port, moved, server) = serve(&world, &mut claim).await;

    assert_ne!(port.get(), taken);
    assert_eq!(moved.map(NonZeroU16::get), Some(taken));
    assert_eq!(record(world.home.root()).port, port);
    server.close().await;
    claim.release();
    assert_eq!(claimed(&world).port(), Some(port));
}

/// A record a killed run left still names it, and the next claim takes the
/// home over on the same address: the kernel let the dead run's lease go.
#[tokio::test]
async fn a_record_a_killed_run_left_is_reclaimed() {
    let world = World::new();

    write(
        &world.path("daemon.json"),
        &json!({
            "protocolVersion": 7,
            "token": "left-by-the-dead",
            "port": 4310,
            "running": {"pid": 999_999_999_u32, "startedAt": "2026-10-17T09:00:00.000Z"},
        })
        .to_string(),
    );

    let claim = claimed(&world);

    assert_eq!(claim.token().as_str(), "left-by-the-dead");
    assert_eq!(claim.port(), NonZeroU16::new(4310));
    claim.release();
}

/// A record that cannot be read, cut short or without its token, is
/// replaced with a fresh token, and the claim says which file it was.
#[tokio::test]
async fn an_unreadable_record_is_replaced_with_a_fresh_token() {
    for unreadable in [
        r#"{"protocolVersion":7,"token":"old-token","port":4"#.to_owned(),
        json!({"protocolVersion": 7, "port": 4242}).to_string(),
    ] {
        let world = World::new();

        write(&world.path("daemon.json"), &unreadable);

        let mut claim = claimed(&world);
        let said = claim.unreadable_record().unwrap().to_string();

        assert!(
            said.contains(&world.path("daemon.json").display().to_string()),
            "{said}"
        );
        assert_ne!(claim.token().as_str(), "old-token");
        assert_eq!(claim.port(), None);

        let (port, _, server) = serve(&world, &mut claim).await;

        assert_eq!(record(world.home.root()).port, port);
        server.close().await;
        claim.release();
    }
}

/// A home that refuses its record fails the publish, writes nothing and,
/// once released, lets the next claim take it.
#[cfg(unix)]
#[tokio::test]
async fn a_home_that_refuses_the_record_fails_the_publish_and_lets_go() {
    use crate::support::{mode, names};

    let world = World::new();
    let mut claim = claimed(&world);

    mode(world.home.root(), 0o500);

    let refused = claim.publish(NonZeroU16::new(4310).unwrap());

    mode(world.home.root(), 0o755);
    assert!(refused.is_err());
    assert_eq!(names(world.home.root()), [".locks"]);
    claim.release();
    claimed(&world).release();
}

/// A home another claim holds is answered held, with its record.
#[tokio::test]
async fn a_held_home_is_answered_with_its_record() {
    let world = World::new();
    let mut holder = claimed(&world);
    let (_, _, server) = serve(&world, &mut holder).await;

    match Claim::take(&world.home).unwrap() {
        ClaimOutcome::Held { record: held } => {
            assert_eq!(held, Some(record(world.home.root())));
        }
        ClaimOutcome::Claimed(_) => panic!("the home was claimed twice"),
    }

    server.close().await;
    holder.release();
}
