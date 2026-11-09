//! What a plugin may reach and contribute, decided from its manifest
//! alone: every plugin is compiled into the daemon, so what it requests is
//! what it is granted once its character enables it.

pub(crate) mod access;
pub(crate) mod trusted_context;
