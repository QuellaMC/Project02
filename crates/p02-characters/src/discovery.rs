use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use p02_shared::{Identifier, PathEntry, describe_entry, list_directory, read_at_most};

use crate::descriptor::{CharacterDefinition, MAX_DESCRIPTOR_BYTES, ParseDescriptorError};

/// The packages compiled into the daemon, each by the folder it was
/// authored in.
const BUNDLED: [(&str, &str); 1] = [(
    "mira",
    include_str!("../../../src/characters/packages/mira/project02.character.json"),
)];

/// Where a home keeps the packages its person added, a folder each.
const HOME_PACKAGES: &str = "characters";

const DESCRIPTOR: &str = "project02.character.json";

/// What discovery found: the characters it published, in id order, and a
/// diagnostic for each package it could not publish.
#[derive(Debug)]
pub struct Discovery {
    pub characters: Vec<CharacterDefinition>,
    pub diagnostics: Vec<PackageDiagnostic>,
}

/// A package discovery could not publish, and why.
#[derive(Debug)]
pub struct PackageDiagnostic {
    pub location: PackageLocation,
    /// The folder the package was found in, which names the character it
    /// was meant to be; none for a home packages folder that cannot be
    /// listed.
    pub folder: Option<String>,
    pub problem: PackageProblem,
}

/// Where a problem lies: in a package compiled into the daemon, or at a
/// path in the home.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PackageLocation {
    Bundled,
    Home(PathBuf),
}

/// Why a package was not published.
#[derive(Debug, thiserror::Error)]
pub enum PackageProblem {
    #[error("character package source is unavailable")]
    SourceUnavailable(#[source] io::Error),
    #[error("character package directories must be real directories")]
    LinkedDirectory,
    #[error("character package directory could not be read")]
    UnreadableDirectory(#[source] io::Error),
    #[error("character package descriptor must be a regular file")]
    DescriptorNotAFile,
    #[error("character package descriptor is unreadable")]
    UnreadableDescriptor(#[source] io::Error),
    #[error(transparent)]
    Descriptor(#[from] ParseDescriptorError),
    #[error("character package folder must match its identity.id \"{claimed}\"")]
    IdMismatch { claimed: Identifier },
    #[error("{}", duplicated(.ids))]
    DuplicateId { ids: Vec<Identifier> },
}

impl PackageProblem {
    /// The code the problem is reported under.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::SourceUnavailable(_) => "package_source_unavailable",
            Self::LinkedDirectory | Self::UnreadableDirectory(_) => "invalid_package_directory",
            Self::DescriptorNotAFile | Self::UnreadableDescriptor(_) => "invalid_descriptor",
            Self::Descriptor(error) => error.code(),
            Self::IdMismatch { .. } => "package_id_mismatch",
            Self::DuplicateId { .. } => "duplicate_character_id",
        }
    }
}

fn duplicated(ids: &[Identifier]) -> String {
    let quoted = ids
        .iter()
        .map(|id| format!("\"{id}\""))
        .collect::<Vec<_>>()
        .join(" and ");

    if ids.len() == 1 {
        format!(
            "character package id {quoted} is defined in more than one place; remove or rename \
             one of the packages"
        )
    } else {
        format!(
            "character package ids {quoted} differ only by case and would share one \
             character-data directory; remove or rename one of the packages"
        )
    }
}

/// The character packages of `home`: those compiled into the daemon, and
/// those the person put in folders under `<home>/characters/`. A package is
/// published when its descriptor reads, its folder is named by her id, and
/// no other package has her id, or one differing only by case: the two
/// would share one data directory, so neither is published.
#[must_use]
pub fn discover(home: &Path) -> Discovery {
    let mut diagnostics = Vec::new();
    let mut candidates = Vec::new();
    let found = BUNDLED
        .into_iter()
        .map(|(folder, descriptor)| {
            judge(
                PackageLocation::Bundled,
                folder.to_owned(),
                descriptor.as_bytes(),
            )
        })
        .chain(home_packages(home));

    for package in found {
        match package {
            Ok(candidate) => candidates.push(candidate),
            Err(diagnostic) => diagnostics.push(diagnostic),
        }
    }

    let characters = publish(candidates, &mut diagnostics);

    diagnostics.sort_by(|left, right| {
        (&left.location, &left.folder).cmp(&(&right.location, &right.folder))
    });

    Discovery {
        characters,
        diagnostics,
    }
}

/// A package that read whole, from the folder her id names.
struct Candidate {
    location: PackageLocation,
    definition: CharacterDefinition,
}

/// The entries of `<home>/characters/` that could be packages, in name
/// order: each folder is read, a link or an entry that cannot be told
/// apart is refused, and anything else is ignored. The folder may itself be
/// a link. When nothing is there the home has no packages of its own, and
/// anything there that does not list, a link leading nowhere among them,
/// leaves the source unavailable.
fn home_packages(home: &Path) -> Vec<Result<Candidate, PackageDiagnostic>> {
    let root = home.join(HOME_PACKAGES);

    if matches!(describe_entry(&root), PathEntry::Absent) {
        return Vec::new();
    }

    let mut entries = match list_directory(&root) {
        Ok(entries) => entries,
        Err(error) => {
            return vec![Err(PackageDiagnostic {
                location: PackageLocation::Home(root),
                folder: None,
                problem: PackageProblem::SourceUnavailable(error),
            })];
        }
    };

    entries.sort_by(|(left, _), (right, _)| left.cmp(right));
    entries
        .into_iter()
        .filter_map(|(name, entry)| {
            let directory = root.join(&name);
            let folder = name.to_string_lossy().into_owned();
            let problem = match entry {
                PathEntry::Directory => return Some(read_package(&directory, folder)),
                PathEntry::Link => PackageProblem::LinkedDirectory,
                PathEntry::Unreadable(error) => PackageProblem::UnreadableDirectory(error),
                PathEntry::File | PathEntry::Other | PathEntry::Absent => return None,
            };

            Some(Err(PackageDiagnostic {
                location: PackageLocation::Home(directory),
                folder: Some(folder),
                problem,
            }))
        })
        .collect()
}

/// A descriptor is the package's own file, so a link is refused as a
/// package folder is; one past the size limit is read only far enough to
/// tell.
fn read_package(directory: &Path, folder: String) -> Result<Candidate, PackageDiagnostic> {
    let path = directory.join(DESCRIPTOR);
    let read = match describe_entry(&path) {
        PathEntry::File => read_at_most(&path, MAX_DESCRIPTOR_BYTES + 1)
            .map_err(PackageProblem::UnreadableDescriptor),
        PathEntry::Unreadable(error) => Err(PackageProblem::UnreadableDescriptor(error)),
        PathEntry::Absent | PathEntry::Directory | PathEntry::Link | PathEntry::Other => {
            Err(PackageProblem::DescriptorNotAFile)
        }
    };
    let location = PackageLocation::Home(path);

    match read {
        Ok(bytes) => judge(location, folder, &bytes),
        Err(problem) => Err(PackageDiagnostic {
            location,
            folder: Some(folder),
            problem,
        }),
    }
}

fn judge(
    location: PackageLocation,
    folder: String,
    descriptor: &[u8],
) -> Result<Candidate, PackageDiagnostic> {
    let problem = match CharacterDefinition::from_descriptor(descriptor) {
        Ok(definition) if definition.profile.id.as_str() == folder => {
            return Ok(Candidate {
                location,
                definition,
            });
        }
        Ok(definition) => PackageProblem::IdMismatch {
            claimed: definition.profile.id,
        },
        Err(error) => error.into(),
    };

    Err(PackageDiagnostic {
        location,
        folder: Some(folder),
        problem,
    })
}

/// Each candidate whose id no other candidate shares, even by case, in id
/// order; the others are diagnosed together.
fn publish(
    candidates: Vec<Candidate>,
    diagnostics: &mut Vec<PackageDiagnostic>,
) -> Vec<CharacterDefinition> {
    let mut by_key: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();

    for candidate in candidates {
        by_key
            .entry(candidate.definition.profile.id.collision_key())
            .or_default()
            .push(candidate);
    }

    let mut characters = Vec::new();

    for group in by_key.into_values() {
        match <[Candidate; 1]>::try_from(group) {
            Ok([sole]) => characters.push(sole.definition),
            Err(group) => {
                let mut ids: Vec<Identifier> = group
                    .iter()
                    .map(|candidate| candidate.definition.profile.id.clone())
                    .collect();

                ids.sort();
                ids.dedup();
                diagnostics.extend(group.into_iter().map(|candidate| PackageDiagnostic {
                    location: candidate.location,
                    folder: Some(candidate.definition.profile.id.to_string()),
                    problem: PackageProblem::DuplicateId { ids: ids.clone() },
                }));
            }
        }
    }

    characters
}

#[cfg(test)]
mod tests {
    use p02_shared::{DanglingLinks, canonical_path};
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    /// A home spelled canonically: macOS reaches its temporary directory
    /// through a link, and Windows through short names.
    struct Home {
        _directory: TempDir,
        root: PathBuf,
    }

    impl Home {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = canonical_path(directory.path(), DanglingLinks::Keep).unwrap();

            Self {
                _directory: directory,
                root,
            }
        }

        fn path(&self, relative: &str) -> PathBuf {
            relative
                .split('/')
                .fold(self.root.clone(), |path, name| path.join(name))
        }

        #[expect(
            clippy::disallowed_methods,
            reason = "a test lays out the home discovery reads"
        )]
        fn write(&self, relative: &str, content: &[u8]) -> &Self {
            let path = self.path(relative);

            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
            self
        }

        #[expect(
            clippy::disallowed_methods,
            reason = "a test lays out the home discovery reads"
        )]
        fn folder(&self, relative: &str) -> &Self {
            std::fs::create_dir_all(self.path(relative)).unwrap();
            self
        }

        #[expect(
            clippy::disallowed_methods,
            reason = "a test lays out the home discovery reads"
        )]
        fn link(&self, relative: &str, target: &Path) -> &Self {
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, self.path(relative)).unwrap();
            #[cfg(windows)]
            {
                let link = self.path(relative);
                let made = if matches!(describe_entry(target), PathEntry::Directory) {
                    std::os::windows::fs::symlink_dir(target, link)
                } else {
                    std::os::windows::fs::symlink_file(target, link)
                };

                made.unwrap();
            }
            self
        }

        fn package(&self, folder: &str, id: &str, display_name: &str) -> &Self {
            let descriptor = json!({
                "format": "project02.character.v1",
                "identity": {"id": id, "displayName": display_name},
                "persona": {"system": [format!("You are {display_name}.")]},
                "meta": {"version": "1.0.0"},
            });

            self.write(
                &format!("characters/{folder}/{DESCRIPTOR}"),
                descriptor.to_string().as_bytes(),
            )
        }

        fn descriptor(&self, folder: &str) -> PackageLocation {
            PackageLocation::Home(self.path(&format!("characters/{folder}/{DESCRIPTOR}")))
        }
    }

    fn ids(discovery: &Discovery) -> Vec<&str> {
        discovery
            .characters
            .iter()
            .map(|character| character.profile.id.as_str())
            .collect()
    }

    fn reported(discovery: &Discovery) -> Vec<(PackageLocation, Option<&str>, &'static str)> {
        discovery
            .diagnostics
            .iter()
            .map(|diagnostic| {
                (
                    diagnostic.location.clone(),
                    diagnostic.folder.as_deref(),
                    diagnostic.problem.code(),
                )
            })
            .collect()
    }

    #[test]
    fn the_bundled_mira_is_there_in_any_home_as_her_descriptor_defines_her() {
        let discovery = discover(&Home::new().root);
        let [mira] = discovery.characters.as_slice() else {
            panic!("{discovery:?}");
        };

        assert!(discovery.diagnostics.is_empty());
        assert_eq!(mira.profile.id.as_str(), "mira");
        assert_eq!(mira.profile.display_name.as_str(), "Mira");
        assert_eq!(mira.version.as_str(), "1.1.0");
        assert!(mira.persona.sections()[0].starts_with("You are Mira"));
        assert_eq!(
            mira.plugins
                .required()
                .iter()
                .map(Identifier::as_str)
                .collect::<Vec<_>>(),
            ["character-state"]
        );
        assert!(mira.plugins.recommended().is_empty() && mira.plugins.config().is_empty());
    }

    #[test]
    fn every_folder_of_the_bundled_source_is_compiled_in() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/characters/packages");
        let mut folders: Vec<String> = list_directory(&source)
            .unwrap()
            .into_iter()
            .filter(|(_, entry)| matches!(entry, PathEntry::Directory))
            .map(|(name, _)| name.into_string().unwrap())
            .collect();

        folders.sort();

        assert_eq!(folders, BUNDLED.map(|(folder, _)| folder));
    }

    #[test]
    fn packages_in_the_home_are_listed_beside_the_bundled_ones_in_id_order() {
        let home = Home::new();

        home.package("zeta", "zeta", "Zeta")
            .package("alpha", "alpha", "Alpha")
            .write("characters/notes.txt", b"Not a package.");

        let discovery = discover(&home.root);

        assert_eq!(ids(&discovery), ["alpha", "mira", "zeta"]);
        assert!(discovery.diagnostics.is_empty());
    }

    #[test]
    fn a_broken_package_is_diagnosed_with_its_code_its_folder_and_where_it_lies() {
        let home = Home::new();

        home.write(
            "characters/malformed/project02.character.json",
            b"{not json",
        )
        .package("nameless", "nameless", " ")
        .package("misfiled", "elsewhere", "Elsewhere")
        .folder("characters/empty")
        .folder("characters/nested/project02.character.json")
        .write(
            "characters/huge/project02.character.json",
            &vec![b' '; MAX_DESCRIPTOR_BYTES + 1],
        );

        let discovery = discover(&home.root);

        assert_eq!(ids(&discovery), ["mira"]);
        assert_eq!(
            reported(&discovery),
            [
                (
                    home.descriptor("empty"),
                    Some("empty"),
                    "invalid_descriptor"
                ),
                (home.descriptor("huge"), Some("huge"), "invalid_descriptor"),
                (
                    home.descriptor("malformed"),
                    Some("malformed"),
                    "invalid_descriptor"
                ),
                (
                    home.descriptor("misfiled"),
                    Some("misfiled"),
                    "package_id_mismatch"
                ),
                (
                    home.descriptor("nameless"),
                    Some("nameless"),
                    "invalid_identity"
                ),
                (
                    home.descriptor("nested"),
                    Some("nested"),
                    "invalid_descriptor"
                ),
            ]
        );

        let said: Vec<String> = discovery
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.problem.to_string())
            .collect();

        assert_eq!(
            said[0],
            "character package descriptor must be a regular file"
        );
        assert!(said[1].contains("size limit"), "{}", said[1]);
        assert!(said[3].contains("\"elsewhere\""), "{}", said[3]);
        assert!(said[4].contains("identity.displayName"), "{}", said[4]);
    }

    #[test]
    fn one_id_in_two_places_or_two_differing_only_by_case_are_both_refused() {
        for (id, shared) in [
            ("mira", "id \"mira\" is defined in more than one place"),
            ("Mira", "ids \"Mira\" and \"mira\" differ only by case"),
        ] {
            let home = Home::new();

            home.package(id, id, "Mira Two");

            let discovery = discover(&home.root);

            assert!(discovery.characters.is_empty(), "{id}");
            assert_eq!(
                reported(&discovery),
                [
                    (
                        PackageLocation::Bundled,
                        Some("mira"),
                        "duplicate_character_id"
                    ),
                    (home.descriptor(id), Some(id), "duplicate_character_id"),
                ]
            );

            for diagnostic in &discovery.diagnostics {
                let said = diagnostic.problem.to_string();

                assert!(
                    said.contains(shared) && said.ends_with("remove or rename one of the packages"),
                    "{said}"
                );
            }
        }
    }

    #[test]
    fn a_linked_folder_of_packages_is_followed_but_a_linked_package_or_descriptor_is_refused() {
        let elsewhere = Home::new();
        let shelf = Home::new();
        let home = Home::new();

        elsewhere
            .package("linked", "linked", "Linked")
            .package("pointer", "pointer", "Pointer");
        shelf
            .package("zeta", "zeta", "Zeta")
            .link("characters/linked", &elsewhere.path("characters/linked"))
            .folder("characters/pointer")
            .link(
                "characters/pointer/project02.character.json",
                &elsewhere.path("characters/pointer/project02.character.json"),
            );
        home.link("characters", &shelf.path("characters"));

        let discovery = discover(&home.root);

        assert_eq!(ids(&discovery), ["mira", "zeta"]);
        assert_eq!(
            reported(&discovery),
            [
                (
                    PackageLocation::Home(home.path("characters/linked")),
                    Some("linked"),
                    "invalid_package_directory"
                ),
                (
                    home.descriptor("pointer"),
                    Some("pointer"),
                    "invalid_descriptor"
                ),
            ]
        );
    }

    #[test]
    fn a_folder_of_packages_that_is_there_but_cannot_be_listed_is_diagnosed() {
        let file = Home::new();
        let dangling = Home::new();

        file.write("characters", b"not a folder");
        dangling.link("characters", &dangling.path("moved-away"));

        for home in [file, dangling] {
            let discovery = discover(&home.root);

            assert_eq!(ids(&discovery), ["mira"]);
            assert_eq!(
                reported(&discovery),
                [(
                    PackageLocation::Home(home.path("characters")),
                    None,
                    "package_source_unavailable"
                )]
            );
        }
    }
}
