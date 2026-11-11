//! Her phone's window as far as the app decides it on its own: which
//! address is her phone's, where the window opens, and what the app
//! remembers of it from one run to the next.

use std::io;
use std::path::Path;

use p02_shared::{create_directories, read_file, write_file_atomically};
use serde::{Deserialize, Serialize};
use tauri::Url;

/// Her phone's window, at the design's size, in logical pixels.
pub const WIDTH: f64 = 372.0;
pub const HEIGHT: f64 = 792.0;

/// The file, in the app's config folder, the app remembers her phone's
/// window in.
pub const REMEMBERED: &str = "phone-window.json";

/// How far right of the main window's edge, and how far above its top, her
/// phone's window opens beside it: the design's.
const BESIDE: Point = Point { x: 38.0, y: -16.0 };

/// What the app remembers of her phone's window from one run to the next.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Remembered {
    /// Whose phone the window showed, when the app ended with it open.
    pub open: Option<String>,
    /// Where the window was left: its top-left corner.
    pub place: Option<Point>,
    /// Whether it stayed on top of other windows.
    pub pinned: bool,
}

/// A point on the desktop, in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// A rectangle on the desktop, in logical pixels: a screen's work area, or
/// a window.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Remembered {
    /// What the file at `path` holds. One that is not there, cannot be read
    /// or holds anything else is no memory: the app starts as the first
    /// time, and its next write makes the file anew.
    #[must_use]
    pub fn read(path: &Path) -> Self {
        read_file(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Replaces the file at `path` with this, whole, making its folder when
    /// it is not there yet.
    ///
    /// # Errors
    ///
    /// The `io::Error` of the step that failed; the file is as it was.
    pub fn write(&self, path: &Path) -> io::Result<()> {
        if let Some(folder) = path.parent() {
            create_directories(folder)?;
        }

        write_file_atomically(path, &serde_json::to_vec_pretty(self)?)
    }
}

impl Area {
    fn holds(&self, point: Point) -> bool {
        (self.x..self.x + self.width).contains(&point.x)
            && (self.y..self.y + self.height).contains(&point.y)
    }

    /// `point` moved as little as keeps her phone's window inside this
    /// area, as far as the window fits in it.
    fn keeps(&self, point: Point) -> Point {
        Point {
            x: point.x.min(self.x + self.width - WIDTH).max(self.x),
            y: point.y.min(self.y + self.height - HEIGHT).max(self.y),
        }
    }
}

/// Where her phone's window opens: where it was `left`, while that is on
/// one of `screens`; else beside `main`, the main window, inside the screen
/// that holds it.
#[must_use]
pub fn place(left: Option<Point>, screens: &[Area], main: Area) -> Point {
    match left {
        Some(left) if screens.iter().any(|screen| screen.holds(left)) => left,
        _ => {
            let beside = Point {
                x: main.x + main.width + BESIDE.x,
                y: main.y + BESIDE.y,
            };
            let corner = Point {
                x: main.x,
                y: main.y,
            };

            screens
                .iter()
                .find(|screen| screen.holds(corner))
                .or_else(|| screens.first())
                .map_or(beside, |screen| screen.keeps(beside))
        }
    }
}

/// Whether `url` is her phone's address on the daemon at `daemon`: the
/// daemon's own origin and root, with `phone` naming her.
#[must_use]
pub fn is_phone_address(url: &Url, daemon: &Url) -> bool {
    url.origin() == daemon.origin() && url.path() == "/" && character_of(url).is_some()
}

/// The character the `phone` of `url`'s query names, as the page reads it.
#[must_use]
pub fn character_of(url: &Url) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == "phone")
        .map(|(_, character)| character.into_owned())
        .filter(|character| !character.is_empty())
}

/// Her phone's address on the daemon at `daemon`, naming `character`: the
/// daemon's own, its token kept in the fragment, as the page opens it.
#[must_use]
pub fn phone_address(daemon: &Url, character: &str) -> Url {
    let mut address = daemon.clone();

    address
        .query_pairs_mut()
        .clear()
        .append_pair("phone", character);
    address
}

#[cfg(test)]
mod tests {
    use p02_shared::{DanglingLinks, canonical_path};

    use super::*;

    #[test]
    fn the_app_remembers_her_phone_as_it_wrote_it_and_a_file_it_cannot_read_as_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let root = canonical_path(directory.path(), DanglingLinks::Keep).unwrap();
        let path = root.join("io.github.quellamc.project02").join(REMEMBERED);
        let remembered = Remembered {
            open: Some("mira".to_owned()),
            place: Some(Point {
                x: 1128.5,
                y: -74.0,
            }),
            pinned: true,
        };

        assert_eq!(Remembered::read(&path), Remembered::default());

        remembered.write(&path).unwrap();

        assert_eq!(Remembered::read(&path), remembered);

        for written in [
            &b"{\"open\": \"mira\", \"pinn"[..],
            b"[]",
            b"{\"pinned\": \"yes\"}",
        ] {
            write_file_atomically(&path, written).unwrap();

            assert_eq!(Remembered::read(&path), Remembered::default());
        }
    }

    #[test]
    fn her_phone_opens_where_it_was_left_while_a_screen_holds_that_else_beside_the_main_window() {
        let left = Area {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1040.0,
        };
        let right = Area {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 875.0,
        };
        let main = Area {
            x: 50.0,
            y: 90.0,
            width: 1040.0,
            height: 760.0,
        };
        let there = Point {
            x: -400.0,
            y: 120.0,
        };

        assert_eq!(place(Some(there), &[left, right], main), there);
        // The screen it was on is gone: beside the main window, kept on
        // the screen that holds it.
        assert_eq!(
            place(Some(there), &[right], main),
            Point { x: 1068.0, y: 74.0 }
        );
        // The first time, beside a main window that leaves room for it.
        assert_eq!(
            place(None, &[left, right], Area { x: -1700.0, ..main }),
            Point { x: -622.0, y: 74.0 }
        );
    }

    #[test]
    fn only_a_page_opening_her_phone_on_the_daemon_gets_her_phones_window() {
        let daemon: Url = "http://127.0.0.1:4310/#token=abc".parse().unwrap();
        let mira = phone_address(&daemon, "mira");

        assert_eq!(mira.as_str(), "http://127.0.0.1:4310/?phone=mira#token=abc");
        assert!(is_phone_address(&mira, &daemon));
        assert_eq!(character_of(&mira), Some("mira".to_owned()));

        for other in [
            "http://127.0.0.1:4311/?phone=mira#token=abc",
            "http://localhost:4310/?phone=mira#token=abc",
            "https://127.0.0.1:4310/?phone=mira",
            "http://127.0.0.1:4310/settings?phone=mira",
            "http://127.0.0.1:4310/?phone=#token=abc",
            "http://127.0.0.1:4310/#token=abc",
            "https://example.com/?phone=mira",
        ] {
            assert!(
                !is_phone_address(&other.parse().unwrap(), &daemon),
                "{other}"
            );
        }
    }
}
