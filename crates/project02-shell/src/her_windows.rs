//! The windows of hers, her phone's and her world's, as far as the app
//! decides them on its own: which address is which window, where each
//! opens, and what the app remembers of each from one run to the next.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use p02_shared::{create_directories, read_file, write_file_atomically};
use serde::{Deserialize, Serialize};
use tauri::Url;

/// A window of hers, which the app opens beside the main window at the
/// page's address that names her by the window's name. There is one of
/// each: another character's takes it to her address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HerWindow {
    Phone,
    World,
}

/// How far out from the main window's side, and how far above its top, a
/// window of hers opens beside it: the design's, for her phone.
const BESIDE: Point = Point { x: 38.0, y: -16.0 };

impl HerWindow {
    /// Every window of hers.
    pub const ALL: [Self; 2] = [Self::Phone, Self::World];

    /// How tall each is, at the design's size, in logical pixels.
    pub const HEIGHT: f64 = 792.0;

    /// The word that names it: the key by which its page's address names
    /// her, and its label, by which the capability `her-windows` in
    /// `tauri.conf.json` gives it its window calls.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Phone => "phone",
            Self::World => "world",
        }
    }

    /// Its title, until its page says its own.
    #[must_use]
    pub const fn title(self) -> &'static str {
        match self {
            Self::Phone => "Her Phone",
            Self::World => "Her World",
        }
    }

    /// How wide it is, at the design's size, in logical pixels.
    #[must_use]
    pub const fn width(self) -> f64 {
        match self {
            Self::Phone => 372.0,
            Self::World => 420.0,
        }
    }

    /// The file, in the app's config folder, the app remembers it in.
    const fn file(self) -> &'static str {
        match self {
            Self::Phone => "phone-window.json",
            Self::World => "world-window.json",
        }
    }

    /// The window of hers labelled `label`, when one is.
    #[must_use]
    pub fn labelled(label: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|hers| hers.name() == label)
    }

    /// Which window of hers `url` is on the daemon at `daemon`: the
    /// daemon's own origin and root, with the name of one naming her.
    #[must_use]
    pub fn of(url: &Url, daemon: &Url) -> Option<Self> {
        if url.origin() != daemon.origin() || url.path() != "/" {
            return None;
        }

        Self::ALL
            .into_iter()
            .find(|hers| hers.character_of(url).is_some())
    }

    /// The character its name names in `url`'s query, as the page reads it.
    #[must_use]
    pub fn character_of(self, url: &Url) -> Option<String> {
        url.query_pairs()
            .find(|(key, _)| key == self.name())
            .map(|(_, character)| character.into_owned())
            .filter(|character| !character.is_empty())
    }

    /// Its address on the daemon at `daemon`, naming `character`: the
    /// daemon's own, its token kept in the fragment, as the page opens it.
    #[must_use]
    pub fn address(self, daemon: &Url, character: &str) -> Url {
        let mut address = daemon.clone();

        address
            .query_pairs_mut()
            .clear()
            .append_pair(self.name(), character);
        address
    }

    /// Where it opens: where it was `left`, while that is on one of
    /// `screens`; else beside `main`, the main window, inside the screen
    /// that holds it.
    #[must_use]
    pub fn place(self, left: Option<Point>, screens: &[Area], main: Area) -> Point {
        match left {
            Some(left) if screens.iter().any(|screen| screen.holds(left)) => left,
            _ => {
                let beside = self.beside(main);
                let corner = Point {
                    x: main.x,
                    y: main.y,
                };

                screens
                    .iter()
                    .find(|screen| screen.holds(corner))
                    .or_else(|| screens.first())
                    .map_or(beside, |screen| screen.keeps(self, beside))
            }
        }
    }

    /// Where it opens beside `main`: her phone right of it and her world
    /// left of it, as far out, so that the two do not open on top of each
    /// other.
    fn beside(self, main: Area) -> Point {
        let x = match self {
            Self::Phone => main.x + main.width + BESIDE.x,
            Self::World => main.x - BESIDE.x - self.width(),
        };

        Point {
            x,
            y: main.y + BESIDE.y,
        }
    }
}

/// What the app remembers of a window of hers from one run to the next.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Remembered {
    /// Whose phone or world the window showed, when the app ended with it
    /// open.
    pub open: Option<String>,
    /// Where the window was left: its top-left corner.
    pub place: Option<Point>,
    /// Whether it stayed on top of other windows.
    pub pinned: bool,
}

/// What the app remembers of the windows of hers, each in a file of its
/// own in one folder, the app's config folder.
#[derive(Debug)]
pub struct Memory {
    folder: PathBuf,
    remembered: HashMap<HerWindow, Remembered>,
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
    /// or holds anything else is no memory: the window opens as the first
    /// time, and the next write makes the file anew.
    fn read(path: &Path) -> Self {
        read_file(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Replaces the file at `path` with this, whole, making its folder when
    /// it is not there yet.
    fn write(&self, path: &Path) -> io::Result<()> {
        if let Some(folder) = path.parent() {
            create_directories(folder)?;
        }

        write_file_atomically(path, &serde_json::to_vec_pretty(self)?)
    }
}

impl Memory {
    /// What the files in `folder` hold, a window's as [`Remembered`] reads
    /// it.
    #[must_use]
    pub fn read(folder: PathBuf) -> Self {
        let remembered = HerWindow::ALL
            .into_iter()
            .map(|hers| (hers, Remembered::read(&folder.join(hers.file()))))
            .collect();

        Self { folder, remembered }
    }

    /// What it remembers of `hers`.
    #[must_use]
    pub fn of(&self, hers: HerWindow) -> Remembered {
        self.remembered.get(&hers).cloned().unwrap_or_default()
    }

    /// Remembers `now` of `hers`, and once that changed replaces its file
    /// with it, whole, making the folder when it is not there yet.
    ///
    /// # Errors
    ///
    /// The `io::Error` of the step that failed; the file is as it was,
    /// while the app remembers `now` until it ends.
    pub fn keep(&mut self, hers: HerWindow, now: Remembered) -> io::Result<()> {
        if self.of(hers) == now {
            return Ok(());
        }

        let written = now.write(&self.folder.join(hers.file()));

        self.remembered.insert(hers, now);
        written
    }
}

impl Area {
    fn holds(&self, point: Point) -> bool {
        (self.x..self.x + self.width).contains(&point.x)
            && (self.y..self.y + self.height).contains(&point.y)
    }

    /// `point` moved as little as keeps the window of hers `hers` inside
    /// this area, as far as the window fits in it.
    fn keeps(&self, hers: HerWindow, point: Point) -> Point {
        Point {
            x: point.x.min(self.x + self.width - hers.width()).max(self.x),
            y: point
                .y
                .min(self.y + self.height - HerWindow::HEIGHT)
                .max(self.y),
        }
    }
}

#[cfg(test)]
mod tests {
    use p02_shared::{DanglingLinks, canonical_path};

    use super::*;

    /// A window of hers the capability does not name gets no answer to its
    /// bar, its pin or its cross, which only the app itself would show.
    #[test]
    fn what_a_window_of_hers_may_ask_is_granted_to_exactly_her_windows() {
        let configuration: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let granted: Vec<&str> = configuration
            .pointer("/app/security/capabilities")
            .and_then(serde_json::Value::as_array)
            .unwrap()
            .iter()
            .find(|capability| capability.get("identifier") == Some(&"her-windows".into()))
            .and_then(|capability| capability.get("windows"))
            .and_then(serde_json::Value::as_array)
            .unwrap()
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect();

        assert_eq!(granted, HerWindow::ALL.map(HerWindow::name));
    }

    #[test]
    fn each_window_is_remembered_in_its_own_file_her_phones_as_before_and_a_bad_one_as_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let root = canonical_path(directory.path(), DanglingLinks::Keep).unwrap();
        let folder = root.join("io.github.quellamc.project02");
        let phone = Remembered {
            open: Some("mira".to_owned()),
            place: Some(Point {
                x: 1128.5,
                y: -74.0,
            }),
            pinned: true,
        };
        let world = Remembered {
            open: Some("mira".to_owned()),
            place: Some(Point { x: 12.0, y: 40.0 }),
            pinned: false,
        };
        let mut memory = Memory::read(folder.clone());

        for hers in HerWindow::ALL {
            assert_eq!(memory.of(hers), Remembered::default(), "{hers:?}");
        }

        memory.keep(HerWindow::World, world.clone()).unwrap();
        // Her phone's, as the app wrote it while she had no other window.
        write_file_atomically(
            &folder.join("phone-window.json"),
            br#"{
  "open": "mira",
  "place": {
    "x": 1128.5,
    "y": -74.0
  },
  "pinned": true
}"#,
        )
        .unwrap();

        let memory = Memory::read(folder.clone());

        assert_eq!(memory.of(HerWindow::Phone), phone);
        assert_eq!(memory.of(HerWindow::World), world);

        for written in [
            &b"{\"open\": \"mira\", \"pinn"[..],
            b"[]",
            b"{\"pinned\": \"yes\"}",
        ] {
            write_file_atomically(&folder.join("phone-window.json"), written).unwrap();

            assert_eq!(
                Memory::read(folder.clone()).of(HerWindow::Phone),
                Remembered::default()
            );
        }
    }

    #[test]
    fn each_window_opens_where_it_was_left_while_a_screen_holds_that_else_beside_the_main_window() {
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

        for hers in HerWindow::ALL {
            assert_eq!(hers.place(Some(there), &[left, right], main), there);
        }
        // The first time, beside a main window that leaves room for it:
        // her phone right of it, her world left of it.
        assert_eq!(
            HerWindow::Phone.place(None, &[left, right], Area { x: -1700.0, ..main }),
            Point { x: -622.0, y: 74.0 }
        );
        assert_eq!(
            HerWindow::World.place(None, &[left, right], Area { x: -1000.0, ..main }),
            Point {
                x: -1458.0,
                y: 74.0
            }
        );
        // The screen it was on is gone, and the main window leaves it no
        // room on its side: as near as keeps it on the screen that holds
        // the main window.
        assert_eq!(
            HerWindow::Phone.place(Some(there), &[right], main),
            Point { x: 1068.0, y: 74.0 }
        );
        assert_eq!(
            HerWindow::World.place(Some(there), &[right], main),
            Point { x: 0.0, y: 74.0 }
        );
    }

    #[test]
    fn only_a_page_opening_her_phone_or_her_world_on_the_daemon_gets_that_window_of_hers() {
        let daemon: Url = "http://127.0.0.1:4310/#token=abc".parse().unwrap();

        for (hers, address) in [
            (
                HerWindow::Phone,
                "http://127.0.0.1:4310/?phone=mira#token=abc",
            ),
            (
                HerWindow::World,
                "http://127.0.0.1:4310/?world=mira#token=abc",
            ),
        ] {
            let mira = hers.address(&daemon, "mira");

            assert_eq!(mira.as_str(), address);
            assert_eq!(HerWindow::of(&mira, &daemon), Some(hers));
            assert_eq!(hers.character_of(&mira), Some("mira".to_owned()));
            assert_eq!(HerWindow::labelled(hers.name()), Some(hers));
        }

        for other in [
            "http://127.0.0.1:4311/?phone=mira#token=abc",
            "http://localhost:4310/?world=mira#token=abc",
            "https://127.0.0.1:4310/?phone=mira",
            "http://127.0.0.1:4310/settings?world=mira",
            "http://127.0.0.1:4310/?phone=#token=abc",
            "http://127.0.0.1:4310/?world=#token=abc",
            "http://127.0.0.1:4310/?clock=mira#token=abc",
            "http://127.0.0.1:4310/#token=abc",
            "https://example.com/?world=mira",
        ] {
            assert_eq!(
                HerWindow::of(&other.parse().unwrap(), &daemon),
                None,
                "{other}"
            );
        }
    }
}
