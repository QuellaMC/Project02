#![doc = include_str!("../README.md")]
#![forbid(unsafe_code)]

mod canonical_json;
mod daemon_record;
mod fs;
#[cfg(feature = "http")]
mod http;
mod identifier;
mod json_boundary;
mod redaction;
mod sse;

pub use canonical_json::{Fingerprint, canonical_json};
pub use daemon_record::{
    DEFAULT_HOME, DaemonRecord, DaemonRun, DaemonToken, ParseDaemonTokenError,
    ReadDaemonRecordError, read_daemon_record,
};
pub use fs::{
    DanglingLinks, PathEntry, ResolvePathError, canonical_path, create_new_file, describe_entry,
    read_text_lossy, relative_path_if_contained, write_file_atomically,
};
#[cfg(feature = "http")]
pub use http::{
    BASE_URL_RULE, BaseUrl, InvalidCredentialError, ParseBaseUrlError, credential_header,
    http_client,
};
pub use identifier::{Identifier, ParseIdentifierError};
pub use json_boundary::{BoundJsonError, Credentials, JsonLimits, bound_json, bound_json_object};
pub use redaction::is_credential_key;
pub use sse::{SseFrame, SseFrameSplitter};
