#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod descriptor;
mod discovery;

pub use descriptor::{
    CharacterDefinition, CharacterVersion, ParseCharacterVersionError, ParseDescriptorError,
    Persona, PluginExpectations,
};
pub use discovery::{
    Discovery, FindCharacterError, HOME_PACKAGES, IdTaken, PACKAGE_DESCRIPTOR, PackageDiagnostic,
    PackageLocation, PackageProblem, Standing, discover, is_bundled,
};
