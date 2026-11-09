#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod descriptor;
mod discovery;

pub use descriptor::{
    CharacterDefinition, CharacterRef, CharacterVersion, ParseCharacterVersionError,
    ParseDescriptorError, Persona, PluginExpectations,
};
pub use discovery::{
    Discovery, FindCharacterError, HOME_PACKAGES, PackageDiagnostic, PackageLocation,
    PackageProblem, discover,
};
