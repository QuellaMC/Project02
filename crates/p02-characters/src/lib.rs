#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod descriptor;
mod discovery;

pub use descriptor::{
    CharacterDefinition, CharacterVersion, DescriptorPart, ParseCharacterVersionError,
    ParseDescriptorError, Persona, PluginExpectations, PluginList,
};
pub use discovery::{Discovery, PackageDiagnostic, PackageLocation, PackageProblem, discover};
