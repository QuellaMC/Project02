//! A character's package as a person adds and removes her: removed with her
//! folder, unless the folder holds something of the person's.

use std::time::Duration;

use p02_store::HeldPackage;

use crate::layout::snapshot;
use crate::support::{World, id};

/// Finder's metadata and the temporary a writer that died left are no part
/// of a package, and keep nothing behind; any other file in her folder is
/// the person's, and stays.
#[test]
fn a_removal_takes_her_folder_unless_it_holds_something_of_the_persons() {
    for (extra, kept) in [
        (".DS_Store", false),
        (
            ".project02.character.json.0b2f7a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.tmp",
            false,
        ),
        ("portrait.png", true),
    ] {
        let (_directory, home) = World::empty();
        let nova = id("nova");
        let wait = Duration::from_secs(1);

        home.ensure().unwrap();
        home.with_package(&nova, wait, |package| package.write(b"{}"))
            .unwrap()
            .unwrap();
        std::fs::write(home.root().join("characters").join("nova").join(extra), "x").unwrap();
        home.with_package(&nova, wait, HeldPackage::remove)
            .unwrap()
            .unwrap();

        let left = snapshot(&home.root().join("characters"));

        if kept {
            assert_eq!(
                left.into_iter().collect::<Vec<_>>(),
                [(format!("nova/{extra}"), "x".to_owned())]
            );
        } else {
            assert!(left.is_empty(), "{extra}: {left:?}");
        }
    }
}
