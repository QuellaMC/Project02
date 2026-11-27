#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod definition;
mod kind;
mod living;

pub use definition::{WorldDefinition, WorldDefinitionError};
pub use kind::Kind;
pub use living::{
    Deed, Entry, Hand, Here, LeaveError, LivingWorld, Made, Named, Place, RemoveError, Thing, Used,
    View, Whereabouts, WorldError,
};

/// The plugin a character lives in her world through: her package switches
/// it on when it brings a world, and it runs for no character whose package
/// brings none.
pub const WORLD_PLUGIN: &str = "world";
